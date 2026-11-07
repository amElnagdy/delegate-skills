# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `traecli exec`, runs the brief in a sandbox,
captures everything, and writes a structured `result.json`. Your job collapses to: run one command,
then read one file. Everything traecli-specific lives in the helper, which is what keeps the loop
portable across orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v traecli      # the active binary; a stale or bundled copy can shadow a current one
traecli --version       # an old binary predates `exec --json`, `-o`, and `exec resume`
traecli login status    # must be authenticated (prints to stderr; must not say "Not logged in")
```

TRAE CLI moves fast and behavior shifts between versions, so the helper records the version it
actually ran into `result.json` (as `traeVersion`) — if something behaves oddly, check which binary
answered. A benign `WARNING: proceeding, even though we could not update PATH` line is always on
stderr and is not a failure.

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
| `--cd <dir>` | Working root for traecli (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | traecli model (default: traecli's own configured default). |
| `--permission-mode <mode>` | Permission preset, passed to traecli as `--permission-mode`: `default`, `bypass_permissions` or `auto` (default: traecli's own configured default). Applies to fresh and resumed runs. |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (default: `workspace-write`). |
| `--read-only` | Shortcut for `--sandbox read-only` — review/diagnosis with no edits. |
| `--ephemeral` | Run without persisting session files to disk, passed to traecli as `--ephemeral`. |
| `--resume-last` | Continue the most recent traecli session; send only the delta brief (see review-and-land). "Most recent" is global, so an unrelated traecli run can steal it — prefer `--session`. |
| `--session <id>` | Continue one specific thread by id (the `threadId` from a prior `result.json`); send only the delta brief. Mutually exclusive with `--resume-last`; an empty id is rejected. |
| `--output-schema <file>` | Path to a JSON Schema file describing the model's final response shape, passed to traecli as `--output-schema`. |
| `--clean-env` | Pass only runtime basics (`PATH`, home, locale, temp, `TRAE_HOME`, and Windows equivalents) to traecli and its version preflight. This changes inherited variables only; it does not protect files or other same-user secrets. |
| `--keep-env <name>` | Keep one additional variable under `--clean-env`; repeat for each required environment-backed auth, custom-provider credential, proxy, certificate, or MCP variable. The name must be set and use portable environment-variable syntax. |
| `--skip-git-repo-check` | Allow running outside a git repo. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only traecli's edits and nothing of the helper's own.

`--clean-env` is not a broader security boundary: traecli can still access files and other same-user
secrets available through `HOME`, `TRAE_HOME`, OS facilities, and the selected sandbox. File- or
OS-backed auth and normal configuration still load, but direct environment-backed auth or any
credential passed through an environment variable needs that variable named with `--keep-env`. The
same filtered environment is used for preflight and dispatch. (Because traecli is a Codex fork, some
of its own help text still refers to `CODEX_HOME`; the relay keeps both `TRAE_HOME` and `CODEX_HOME`
under `--clean-env` so either config root still loads.)

On Windows, a sandboxed run (`read-only` or `workspace-write`) receives a `PATH` with every
`WindowsApps` entry removed, again for both preflight and dispatch. The Microsoft Store installs
apps — PowerShell 7 included — under a folder whose ACLs deny execution to the restricted token
traecli's sandbox runs commands with. traecli prefers a `pwsh` found on `PATH`, so a Store-installed
`pwsh` makes every sandboxed command fail with `0xC0070005` while the model keeps working blind:
it cannot run a single gate and either gives up or reports work it never verified. Without those
entries traecli falls back to System32 `powershell.exe`, which the sandbox can launch.
`--sandbox danger-full-access` runs without the restricted token and gets `PATH` unchanged. To
see whether a machine is affected: `(Get-Command pwsh -All).Source` — any result under a
`WindowsApps` folder would hit this.

`--permission-mode` selects traecli's approval preset (`default`: workspace read/edit with approval to
reach the internet or edit outside the workspace; `bypass_permissions`: edit outside the workspace and
reach the internet without asking; `auto`: workspace-write with eligible approvals routed through an
auto-reviewer). It is orthogonal to `--sandbox`, which governs the shell-command sandbox policy. Leave
it unset to use traecli's own configured default.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `timeout` | `aborted` | `trae_unavailable`
- `exitCode` — mirrors traecli's exit code; `128` plus the signal number if the child was killed; `127` if `traecli` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `traeVersion` — the binary version that actually ran (the first stdout line of `traecli --version`)
- `threadId` — feed this to a later `--session <id>` (exact thread; preferred) or `--resume-last` (global "most recent", which another traecli run can steal)
- `finalMessage` — traecli's own final report (the `<structured_output_contract>` you asked for)
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report — `git` missing, or a non-repo run under `--skip-git-repo-check`; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSONL event stream, and the final-message file
- `stderrPath` — the complete stderr stream in `stderr.txt`, including diagnostics omitted from the summary
- `workdir`, `sandbox`, `model`, `permissionMode`, `ephemeral`, `outputSchema`, `resumeLast`, `session`, `cleanEnv`, `keepEnv`, `startedAt`, `finishedAt` — `sandbox` is the applied mode, or a note that traecli used its active config on an unqualified resume; `session` is the explicit session id, or `null` for fresh and `--resume-last` runs; `keepEnv` records names only, never values
- `stderrTail` — up to 20 nonblank lines from the final 64 KiB of stderr; a partial first line is marked as truncated. Present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed`, `trae_unavailable`, and launch failures. Read `stderrPath` for the complete diagnostics.
- `error` — present on a launch failure, and on `timeout` and `aborted` runs

The helper also prints a summary to stdout and exits with traecli's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until traecli finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `traecli` binary exits 127 but *does* write a
  `result.json` with status `trae_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: trae_unavailable` (exit 127):** `traecli` isn't on PATH or isn't found. Install TRAE CLI
  2.0 and `traecli login`, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `traecli --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter), so
  traecli was never dispatched; only the relay's own artifacts may already exist under `--out-dir`.
  Check the install by running `traecli --version` yourself.
- **`status: failed`:** read `result.json`'s `stderrTail`, the full `stderrPath` log, and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse (a headless run against the hosted provider fails until authenticated;
  see `traecli login status`), an invalid `--model` or `--permission-mode`, or a sandbox that
  blocked something the task needed (a network call needs a sandbox that permits it, or
  `--sandbox danger-full-access`). Fix the cause and re-dispatch; don't paper over it by doing the
  work yourself unless that's what the user wants.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to traecli. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **Empty `finalMessage`:** traecli exited before producing a final message. Treat as a failed run;
  the events log usually shows where it stopped.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. It cannot rebuild the changes themselves — traecli's JSON stream currently
reports a file change as its path and kind only, without the diff contents — so when the tree
still holds the work, preserve the tree, and otherwise re-dispatch with the log as the map of
what was lost.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
traecli exec --json -o <final.txt> -s workspace-write [-m model] [--permission-mode <mode>] [--ephemeral] [--output-schema <file>] - < brief.txt   # fresh run
traecli exec [-s mode] resume --last --json -o <final.txt> [-m model] [--permission-mode <mode>] [--ephemeral] [--output-schema <file>] - < delta-brief.txt  # resume
```

On resume, the helper places an explicit `--sandbox`/`--read-only` or fleet-lane sandbox before the
`resume` subcommand so traecli applies it to the resumed turn. Without one, traecli uses its active
config. The helper sets the child process's working directory instead of forwarding `-C`.

One alternative exists if you ever want it, but the helper is the recommended path:

- **Raw `traecli exec`** — fine for one-offs; you give up the captured `result.json`, touched-files
  summary, and thread-id extraction the helper does for you.

## The commit boundary

The helper never commits — by design, not omission. Whether traecli's sandbox can write `.git` varies by
version, OS, and execution path, so relying on it is a coin flip. The robust contract is: traecli edits
the working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
