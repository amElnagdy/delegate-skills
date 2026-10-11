# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `codebuddy -p`, runs the brief under the chosen
mode, captures everything, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file. Everything WorkBuddy-specific lives in the helper, which is what keeps the
loop portable across orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v codebuddy    # the active binary on PATH
codebuddy --version     # the relay records this in result.json too
codebuddy config list   # verify configuration is present
```

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --model <model-name> --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. On Claude
Code it's the printed "Base directory for this skill"; on other orchestrators substitute that install
path. See [`SKILL.md`](../SKILL.md) if you need to locate it.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root for WorkBuddy (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags still win. |
| `--model <name>` | Model name (e.g., `gpt-5`, `gpt-4o-mini`). **Required on a fresh run** — WorkBuddy has no safe default without a model; a resumed run inherits its session's model. |
| `--read-only` | Review/diagnosis mode with no edits (passes a restrictive system prompt). |
| `--no-auto` | The relay passes `codebuddy`'s `-y` (auto-approve file operations) **by default** so a headless run doesn't hang on a prompt; `--no-auto` drops it and honors the agent's own permission config instead. A `--read-only` run never gets `-y`, so it can't be auto-approved into edits. |
| `--resume-last` | Continue the most recent WorkBuddy session; send only the delta brief (see review-and-land). |
| `--session <id>` | Continue a specific session id; send only the delta brief. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only WorkBuddy's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `workbuddy`
- `status` — `completed` | `failed` | `timeout` | `aborted` | `codebuddy_unavailable`
- `exitCode` — mirrors WorkBuddy's exit code; `128` plus the signal number if the child was killed; `127` if `codebuddy` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `codebuddyVersion` — the binary that actually ran
- `agent` — the agent selected for this dispatch (`implement`, `review`, …)
- `sessionId` — feed this to a later `--session <id>` (or use `--resume-last`)
- `finalMessage` — WorkBuddy's assembled final text (the `<structured_output_contract>` you asked for).
  Empty if WorkBuddy stopped without emitting a closing summary — ask for the report explicitly
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report — `git` missing, or a non-repo run; `[]` means git ran and
  the tree is clean
- `cost` — total run cost in USD (`null` — WorkBuddy CLI doesn't report cost)
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSON event stream, and
  the final-message file
- `workdir`, `model`, `auto`, `resumed`, `resumeLast`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed`, `codebuddy_unavailable`, and launch failures
- `error` — present on a launch failure, and on `timeout` and `aborted` runs

The helper also prints a summary to stdout and exits with WorkBuddy's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until WorkBuddy finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `codebuddy` binary exits 127 but *does* write a
  `result.json` with status `codebuddy_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: codebuddy_unavailable` (exit 127):** `codebuddy` isn't on PATH or isn't found. Install
  (see quickstart) and run `codebuddy` to authenticate, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `codebuddy --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so WorkBuddy was never dispatched; only the relay's own artifacts may already exist under
  `--out-dir`. Check the install by running `codebuddy --version` yourself.
- **`status: failed`:** read `result.json`'s `stderrTail` and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse, an unknown `--model`, or a permission the run needed but the agent
  didn't grant. Fix the cause and re-dispatch; don't paper over it by doing the work yourself unless
  that's what the user wants.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to WorkBuddy. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written —
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **Empty `finalMessage`:** WorkBuddy finished without emitting a closing text summary (common when it
  completes purely through tool calls). The edits may still be correct — check `touchedFiles` and the
  diff. To get a report next time, add a `<structured_output_contract>` block (see
  [writing-the-brief.md](writing-the-brief.md)).
- **A run hangs:** an agent with an `ask` permission can block waiting for approval that never comes in
  headless mode. Runs pass `-y` by default precisely to avoid this — so a hang almost always means
  you passed `--no-auto`. Either drop it, or set the agent's permissions to *allow* (not ask) the
  actions the task needs.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. Whether it also carries the edit contents depends on what the CLI streams,
so treat any reconstruction as unverified until it matches a working-tree diff — when the tree
still holds the work, preserve the tree rather than replaying the log.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
# Fresh run
codebuddy -p -y --model gpt-5 "brief content here"

# Fresh run with stdin (multi-line brief)
cat brief.txt | codebuddy -p -y --model gpt-5

# Resume most recent session
codebuddy -c -p -y "delta brief here"

# Resume specific session
codebuddy -r ses_abc123 -p -y "delta brief here"

# Read-only mode
codebuddy -p --system-prompt "You are in read-only review mode..." "review query"
```

The brief is fed on **stdin** for multi-line content, or as a positional argument for short prompts —
which is why a multi-line, XML-tagged brief needs no quoting. The stdout stream is captured as
`finalMessage` and the session ID is extracted from the output.

If you ever want it, raw `codebuddy -p` is fine for one-offs — you just give up the captured
`result.json`, touched-files summary, and session-id extraction the helper does for you.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: WorkBuddy edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).