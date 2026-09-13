# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `devin --print` (print mode), runs the brief
under an explicit permission mode, captures everything, and writes a structured `result.json`.
Your job collapses to: run one command, then read one file. Everything Devin-specific lives in
the helper, which is what keeps the loop portable across orchestrators.

This is the **local** `devin` binary, not Devin Cloud.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v devin      # the active binary
devin version         # or `devin --version`; recorded into result.json
devin auth status     # expect: Logged in (via Devin).
```

List available models with `devin models list` (JSON is `devin models list --format json`). `--model`
accepts fuzzy names and aliases (e.g. `opus`).

The relay strips inherited `WINDSURF_API_KEY` from the child environment (Windsurf terminals inject
it; Devin's ACP agent prefers it over the stored `devin auth` login and then fails). Running `devin`
by hand from a Windsurf terminal needs `unset WINDSURF_API_KEY` (or
`env -u WINDSURF_API_KEY devin ...`).

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. On Claude
Code it's the printed "Base directory for this skill"; on other orchestrators substitute that install
path. See [`SKILL.md`](../SKILL.md) if you need to locate it.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root for Devin (default: current directory). The child process cwd pins the workspace. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Devin model (default: Devin's own configured default). Fuzzy names and aliases are accepted. |
| `--permission-mode <m>` | Direct passthrough: `normal` \| `accept-edits` \| `smart` \| `dangerous`. Canonical names only. |
| `--read-only` | Review/diagnosis (`--permission-mode normal`). Headless `normal` rejects writes and exec. The relay also reports a tri-state Git-visible change tripwire. |
| `--full-access` | Unrestricted auto-approve (`--permission-mode dangerous`); opt-in. |
| `--resume-last` | Continue the most recent Devin session for this cwd (`devin --continue`); send only the delta brief. |
| `--session <id>` | Continue a specific session id (`devin --resume <id>`); mutually exclusive with `--resume-last`. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Default autonomy (neither `--read-only` nor `--full-access`) is **`--permission-mode smart`**. Devin's
native default is `normal`, which rejects every write and exec under `--print`; the relay always
sets the mode explicitly.

`--sandbox` is never passed. It forces `autonomous` mode, and in autonomous sessions the `edit` /
`write` tools still prompt — a `--print` run cannot answer, so those tools are rejected and the run
continues having changed nothing. `--permission-mode autonomous` and the aliases `auto` / `yolo` /
`bypass` are rejected the same way: use the canonical names.

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Devin's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `"devin"`
- `status` — `completed` | `failed` | `timeout` | `aborted` | `devin_unavailable`
- `exitCode` — mirrors Devin's exit code; `128` plus the signal number if the child was killed; `127` if `devin` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `devinVersion` — the binary that actually ran
- `sessionId` — from the ATIF export's `session_id` after the run (or the `--session` id you passed, if the export is missing). Feed this to a later `--session <id>` (or use `--resume-last`)
- `finalMessage` — Devin's own final report (the `<structured_output_contract>` you asked for): trimmed `--print` stdout
- `usage` — always `null`; `--print` has no token event stream, and sessions live in a sqlite `sessions.db` with no honest per-session file count
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report; `[]` means git ran and the tree is clean
- `briefPath` / `finalPath` / `stderrPath` / `exportPath` — the exact brief relay sent, the captured `--print` stdout, stderr, and the ATIF export (`session.atif.json`) when Devin wrote one
- `workdir`, `autonomy`, `permissionMode`, `model`, `resumeLast`, `startedAt`, `finishedAt`
- `readOnlyViolation` — present on dispatched `--read-only` (and `--permission-mode normal`) runs: `true` when parsed git porcelain or the working-tree/index fingerprint of an already-dirty Git-visible path proves a change; `false` when coverage is complete and detects none; `null` when coverage is incomplete. Ignored paths, submodule internals, perfect restores, and attribution remain outside it — the diff review, not this flag, is the guarantee
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed`, `devin_unavailable`, and launch failures
- `error` — present on a launch failure, and on `timeout` and `aborted` runs

There is **no** `events.jsonl`. `--print` emits only the final assistant response as plain text.

The helper also prints a summary to stdout and exits with Devin's exit code, so a wrapping script
can branch on success/failure directly.

## Waiting for completion

The helper blocks until Devin finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `devin` binary exits 127 but *does* write a
  `result.json` with status `devin_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: devin_unavailable` (exit 127):** `devin` isn't on PATH or isn't found. Install via the
  Devin CLI installer and `devin auth login`, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `devin version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter), so
  Devin was never dispatched; only the relay's own artifacts may already exist under `--out-dir`.
  Check the install by running `devin version` yourself.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to Devin. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `stderr.txt` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail` and `stderr.txt` for the cause.
  Common causes: an auth lapse (`devin auth status`), `failed to start ACP agent session` from an
  inherited `WINDSURF_API_KEY` when Devin is launched outside the relay, an untrusted workspace
  (the relay already passes `--respect-workspace-trust false`), an invalid `--model`, or a
  permission-mode rejection (look for `rejected a tool call that requires confirmation` — that run
  needed `smart` or `dangerous`, not `accept-edits`). Fix the cause and re-dispatch; don't paper
  over it by doing the work yourself unless that's what the user wants.
- **Empty `finalMessage`:** Devin exited before printing a final response. Treat as a failed run;
  `stderr.txt` usually shows where it stopped.
- **`sessionId` is `null`:** `--print` does not print a session id on stdout. The relay always
  passes `--export <outDir>/session.atif.json` and reads `session_id` from that file. If the file
  is missing or unparseable, the id is null (unless you passed `--session`). Do not guess from
  `devin list` — concurrent runs in the same workdir make newest-entry guessing wrong.

## Recovering lost work

`--print` has no event stream to reconstruct from. If finished work is lost — the run killed late,
or the working tree damaged afterward — inspect the working tree and `stderr.txt` before
re-dispatching. The ATIF export (`session.atif.json`) records `session_id`, `steps`, and
`final_metrics` when Devin wrote it; treat any reconstruction as unverified until it matches a
working-tree diff. When the tree still holds the work, preserve the tree rather than replaying
anything.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
# fresh run (default smart permission mode)
devin --print --respect-workspace-trust false --permission-mode smart \
  --export <out>/session.atif.json --prompt-file <brief.txt>

# resume most recent session for this cwd
devin --print --respect-workspace-trust false -c --permission-mode smart \
  --export <out>/session.atif.json --prompt-file <delta.txt>

# resume a specific session
devin --print --respect-workspace-trust false -r <id> --permission-mode smart \
  --export <out>/session.atif.json --prompt-file <delta.txt>
```

No positional prompt is passed: bare positionals are parsed as `[PATH]...` and conflict with
`--print`'s optional `PROMPT` argument. The brief is always `--prompt-file`. Autonomy flags are
re-passed on resume because headless permission mode may not inherit.

**Prompt delivery:** `--prompt-file`, never argv and never stdin — so the brief stays out of the host
process list, isn't bounded by the OS argument-length cap, and a brief that begins with `-` can't
be misread as a flag. The relay writes the brief you pass (via `--brief` or stdin) to a file and
points `--prompt-file` at it.

Two alternatives exist if you ever want them, but the helper is the recommended path:

- **Raw `devin --print --prompt-file`** — fine for one-offs; you give up the captured `result.json`,
  touched-files summary, ATIF session-id extraction, and the `--respect-workspace-trust false` pin
  the helper does for you.
- **Interactive `devin`** — the TUI. Out of scope for this skill; print mode is the path the relay
  drives.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: Devin edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
