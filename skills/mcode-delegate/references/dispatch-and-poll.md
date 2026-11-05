# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `mcode exec`, feeds it the brief on stdin, captures
the `stream-json` event stream, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file. Everything MiniMax Code-specific lives in the helper, which is what keeps
the loop portable across orchestrators.

## Before the first run: check the binary

```bash
command -v mcode      # empty? the installer's ~/.minimax-code/bin is only on PATH via your shell profile
mcode --version       # the relay records this in result.json
```

Sign-in has no headless status command; open `mcode` and run `/status`, or just dispatch — a signed-out
run fails and the relay's summary points at `mcode login`.

When `mcode` is not on the relay's PATH, pass `--mcode-path <file>` or set `MCODE_CLI`. The relay never
guesses an install directory. On native Windows the npm install is an `mcode.cmd` shim, which the relay
launches through `cmd.exe` with the brief on stdin and every variable argument a validated token; that
launch is contract-tested only, and a live Windows run is unverified. On Windows `--mcode-path` /
`MCODE_CLI` must be absolute.

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
| `--cd <dir>` | Working root for MiniMax Code (default: current directory). It is the child's working directory, which `mcode exec` uses as its workspace; with no sandbox it is a starting point, not a boundary. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials (`model`, `effort`, `timeout`, `readOnly`); fails if the lane's `implementer` is not this relay. Explicit flags win. |
| `--model <ref>` | Model for this run as `provider/model` or `provider/model#variant` (default: MiniMax Code's own). The run's `resolvedModel` shows what actually answered. |
| `--effort <level>` | Reasoning effort. Levels are model-specific; `mcode` rejects one the model does not offer (exit 2) and lists the valid set in stderr. |
| `--permission <policy>` | `smart` (default) or `full`. `off` is refused. Neither is a sandbox — see `SKILL.md`. |
| `--read-only` | Advisory read-only: an appended system prompt forbids edits, `smart` stays, and a Git-visible `readOnlyViolation` tripwire checks afterwards. Cannot be combined with `--permission full`. |
| `--session <id>` | Continue one specific session by id (the `sessionId` from a prior `result.json`); send only the delta brief. |
| `--mcode-path <file>` | The `mcode` executable to launch; overrides PATH. `MCODE_CLI` does the same. |
| `--clean-env` | Pass only runtime basics (`PATH`, home, locale, temp, `MINIMAX_DATA_DIR`, and Windows equivalents) to MiniMax Code and its version preflight. This changes inherited variables only; it does not protect files or other same-user secrets. |
| `--keep-env <name>` | Keep one additional variable under `--clean-env`; repeat for each — `MCODE_PROVIDER_API_KEY`, proxies, certificates, MCP settings. The name must be set and use portable environment-variable syntax. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh private dir under the system temp dir). |

Artifacts default to the system temp dir so relay-created files stay out of the target repository.
On POSIX, that directory is mode `0700` and its files are created as `0600`. The touched-files report
then shows MiniMax Code's Git-visible edits without the helper's artifacts.

`--clean-env` is not a security boundary: MiniMax Code still reaches files and other same-user secrets
through `HOME` (its own state lives in `~/.minimax`) and OS facilities. Its OAuth sign-in is
file-backed, so a `--clean-env` run stays signed in; an API-key or custom-provider setup that reads
a stripped variable needs it named with `--keep-env`. The same filtered environment is used for
preflight and dispatch.

## What the helper is doing

```bash
mcode exec --input - --output-format stream-json --permission smart \
    [--session <id>] [--model <ref>] [--effort <level>] < brief.txt            # implementation run
mcode exec --input - --output-format stream-json --permission smart \
    --append-system-prompt-file <out-dir>/read-only-prompt.txt … < brief.txt   # --read-only
```

The brief goes in on stdin (`--input -`), never in argv, and the workspace is the child's working
directory rather than `--cwd`, so no free text or repository path reaches a command line. The relay
does not pass `mcode`'s own `--timeout` or `--max-steps`; its watchdog is the time limit.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `timeout` | `aborted` | `mcode_unavailable`
- `exitCode` — preserves `mcode`'s non-zero exit code (observed: 2 for a rejected argument, 4 for a
  failed run, 7 at the step limit); a zero exit without a succeeded `exec.completed` becomes 1; `128`
  plus the signal number if the child was killed; `127` if the binary isn't found; on a `timeout` the
  relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `mcodeVersion` — the binary that actually ran
- `sessionId` — feed this to a later `--session <id>` for rework in the same session
- `runId` — `mcode`'s id for this one run
- `execStatus` / `execError` — straight from `mcode`'s closing `exec.completed` event: `succeeded`,
  `failed`, `limit_exceeded`, or `timeout`, and the error message it gave. `null` when that event never
  arrived
- `resolvedModel` — the model that answered, as `provider/model#variant`
- `usage` / `durationMs` — token counts and wall-clock from `exec.completed`
- `finalMessage` — MiniMax Code's own final report (the `<structured_output_contract>` you asked for),
  from `exec.completed`'s `output`, or the last completed agent message when that is empty; written to
  `finalPath` only when non-empty
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report — `git` missing, or a non-repo working root; `[]` means git
  ran and the tree is clean
- `readOnlyViolation` — only meaningful under `--read-only`: `false` when the Git-visible detector
  saw no change beyond the relay's own artifacts; it does not cover ignored or outside-repository
  paths. `true` when the detector saw a change, `null` when git couldn't snapshot either side.
  `null` on write-capable runs, where the question doesn't apply
- `permission` / `autonomy` — the policy the run actually got, in MiniMax Code's terms
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw event stream, and the
  final-message file; `finalPath` is `null` when `finalMessage` is empty
- `workdir`, `readOnly`, `model`, `effort`, `session`, `cleanEnv`, `keepEnv`, `startedAt`,
  `finishedAt` — `model` and `effort` are what you asked for; `keepEnv` records names only, never values
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`,
  `timeout`, `aborted`), absent on `completed`, `mcode_unavailable`, and launch failures
- `error` — present on a launch failure, on `timeout` and `aborted` runs, and whenever `mcode` did not
  report `succeeded`

`status: "completed"` requires exit 0 **and** an `exec.completed` event with status `succeeded`. The
helper also prints a summary to stdout and exits with that exit code, so a wrapping script can branch on
success/failure directly.

## Waiting for completion

The helper blocks until MiniMax Code finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh, or your shell's equivalent (`Start-Job` in PowerShell). A run is done when
  `result.json` exists with a `status`. **But** a pre-run usage error (bad args, empty brief) exits with
  code 2 *before* writing any file — so check the exit code too, don't only watch for the file. (A
  missing binary exits 127 but *does* write a `result.json` with status `mcode_unavailable`.)

## When a run misbehaves

- **`status: mcode_unavailable` (exit 127):** the binary wasn't found. Install MiniMax Code, or pass
  `--mcode-path` / set `MCODE_CLI` when it is installed but off the relay's PATH, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `mcode --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter), so
  MiniMax Code was never dispatched; only the relay's own artifacts may already exist under
  `--out-dir`. Check the install by running `mcode --version` yourself.
- **`status: failed` at exit 2 with `execStatus: null`:** `mcode` rejected an argument before the run
  started — most often an `--effort` level the model does not offer. `stderrTail` names the valid set.
- **`status: failed` at exit 4:** the run failed; `execError` says why — an unavailable `--model`, an
  unknown `--session`, or a provider error. A sign-in problem gets its own hint in the summary: run
  `mcode login`, then re-dispatch.
- **`status: failed` with `execStatus: limit_exceeded` (exit 7):** the run hit MiniMax Code's step limit
  mid-task. The tree may hold a half-applied change. Inspect it, then split the brief.
- **`status: failed` with `exec.completed event` in the `error`:** the stream ended without the closing
  event, so nothing proves the task finished. Read `eventsPath` and the diff before deciding.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a closed
  terminal) and forwarded the kill to `mcode`. The result is written before the relay exits; inspect the
  working tree before re-dispatching. On native Windows a hard kill of the relay is uncatchable (Node
  supports no `SIGTERM` handler there), so this status may never get written — a relay process that is
  gone without a `result.json` is an aborted run; inspect the working tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer or
  a supervisor timeout, not an implementer error. Free up host memory or split the task into smaller
  briefs, then re-dispatch.
- **`readOnlyViolation: true`:** the tripwire detected a Git-visible change during a `--read-only`
  run. It cannot attribute a concurrent change to MiniMax Code, but the read-only state was only a
  prompt. Review the diff and report the warning before doing anything else.

## Recovering lost work

`events.jsonl` records every event MiniMax Code streamed — each tool call as it started and finished,
and every agent message. If finished work is lost — the run killed late, or the tree damaged afterward —
read the event log before re-dispatching: it is the map of what the run did. The log contains whatever
the run read or wrote, so treat it as sensitive as the repo itself.

## The commit boundary

The helper never commits — by design, not omission. With no sandbox, MiniMax Code *can* write `.git`,
which is the reason: a run that commits itself is a run you must unpick before you can review it. The
robust contract is: MiniMax Code edits the working tree, the orchestrator reviews and commits. See
[review-and-land.md](review-and-land.md).
