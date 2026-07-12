# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `agy --print`, runs the brief in the working root's
workspace, captures the output, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file. Everything Antigravity-specific lives in the helper, which is what keeps
the loop portable across orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v agy    # the active binary on PATH
agy --version     # the relay records this in result.json too
```

If `agy` has never been run, its first invocation opens a Google sign-in flow — do that once
interactively before dispatching headless runs.

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
| `--cd <dir>` | Working root for agy (default: current directory). The relay passes it to agy as `--add-dir` **and** uses it as the working directory — both are load-bearing (see below). |
| `--model <name>` | Antigravity model (default: agy's configured default; `agy models` lists the choices). |
| `--no-skip-permissions` | The relay passes agy's `--dangerously-skip-permissions` **by default** so a headless run doesn't block on a prompt; `--no-skip-permissions` drops it and relies on agy's own defaults (which allow workspace file edits and safe commands headlessly, but may refuse riskier commands). |
| `--timeout <duration>` | agy's `--print-timeout` budget, Go duration format (e.g. `45m`, `2h`). Default `60m` — agy's own 5m default is too short for real delegated tasks. |
| `--resume-last` | Continue the working root's most recent agy conversation; send only the delta brief (see review-and-land). |
| `--conversation <id>` | Continue a specific conversation id; send only the delta brief. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

There is **no `--read-only` flag, on purpose**: agy has no enforced read-only mode (`--mode plan` was
verified to still write the working tree), so the relay refuses the flag with an explanation rather
than offer a false promise. Treat every dispatch as write-capable.

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only agy's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `agy`
- `status` — `completed` | `failed` | `agy_unavailable`
- `exitCode` — mirrors agy's exit code; `127` if `agy` isn't on PATH
- `agyVersion` — the binary that actually ran
- `conversationId` — feed this to a later `--conversation <id>` (or use `--resume-last`). Best-effort:
  the relay reads it from agy's local per-directory conversation cache after the run; `null` if the
  cache is absent or reshaped
- `finalMessage` — agy's printed response, plain text (agy has no JSON output mode). Thin if the run
  ended without a written summary — ask for the report explicitly
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report — `git` missing, or a non-repo run; `[]` means git ran and
  the tree is clean
- `briefPath` / `finalPath` — the exact brief relay sent and the final-message file
- `workdir`, `model`, `skipPermissions`, `timeout`, `resumeLast`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present **only** on a failed run
- `error` — present **only** if agy failed to launch

The helper also prints a summary to stdout and exits with agy's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until agy finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `agy` binary exits 127 but *does* write a
  `result.json` with status `agy_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: agy_unavailable` (exit 127):** `agy` isn't on PATH or isn't found. Install
  (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), sign in on first run, then
  re-dispatch.
- **`status: failed` with "timeout waiting for response" in `stderrTail` or `finalMessage`:** the run
  exceeded its `--print-timeout` budget (relay default 60m). Re-dispatch with a bigger `--timeout`, or
  split the brief into smaller tasks.
- **`status: failed`, other:** read `result.json`'s `stderrTail` for the cause. Common causes: an auth
  lapse (run `agy` interactively once to re-sign-in) or an unknown `--model`. Fix the cause and
  re-dispatch; don't paper over it by doing the work yourself unless that's what the user wants.
- **The repo didn't change but the report claims work was done:** check whether the report's file links
  point at agy's scratch directory instead of the repo. The relay always passes `--add-dir` for the
  working root precisely to prevent this, but a brief that names no target directory can still steer
  agy to scratch — name the working root in the brief (see
  [writing-the-brief.md](writing-the-brief.md)).
- **Thin `finalMessage`:** the run ended without a written closing summary. The edits may still be
  correct — check `touchedFiles` and the diff. To get a report next time, add a
  `<structured_output_contract>` block.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
agy --add-dir /path/to/repo --print-timeout 60m --dangerously-skip-permissions --print "<brief>"                      # fresh run
agy --add-dir /path/to/repo --print-timeout 60m --dangerously-skip-permissions --continue --print "<delta brief>"     # resume most recent
agy --add-dir /path/to/repo --print-timeout 60m --dangerously-skip-permissions --conversation <id> --print "<delta>"  # resume a specific conversation
```

Two mechanics worth knowing:

- **The brief travels as the `--print` value** — agy's non-interactive mode takes the prompt as an
  argument and does not read stdin (the relay still accepts the brief on *its own* stdin or via
  `--brief`, then hands it to agy as a single argv entry, so multi-line XML briefs need no quoting; no
  shell is involved on any platform). One consequence: a brief that runs to tens of kilobytes can
  exceed a platform's argument-length limit (Windows is the tightest) — keep briefs task-sized, which
  they should be anyway.
- **The working directory is load-bearing twice.** `--add-dir` puts the repo in agy's workspace (without
  it agy works in its own scratch directory — verified), and the process working directory is what agy
  keys its per-directory conversation history on, which is what makes `--resume-last` pick up *this*
  repo's conversation. The relay sets both from `--cd`.

If you ever want it, raw `agy --print` is fine for one-offs — you just give up the captured
`result.json`, touched-files summary, and conversation-id lookup the helper does for you.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: agy edits the working tree,
the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
