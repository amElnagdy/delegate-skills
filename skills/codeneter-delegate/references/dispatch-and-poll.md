# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `codeneter run`, feeds it the brief on stdin,
captures the `stream-json` event stream, and writes a structured `result.json`. Your job collapses to:
run one command, then read one file. Everything CodeNeter-specific lives in the helper, which is what
keeps the loop portable across orchestrators.

## Before the first run: check the binary

```bash
codeneter --version   # the relay records this in result.json
codeneter whoami      # prints the signed-in account; "Not authenticated." means run `codeneter login`
codeneter models      # exact Model IDs and their supported effort levels
```

A signed-out run fails with the CLI's own result event (`errorKind: "sign_in_required"`), and the
relay's summary points at `codeneter login`. On native Windows the npm install is a `codeneter.cmd`
shim, which the relay launches through `cmd.exe` with the brief on stdin, every variable argument a
validated token, and the one path (`--workspace`) quoted; that launch is contract-tested only, and a
live Windows run is unverified.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). A brief starting with `/` is refused: the CLI would replace it with a saved command. |
| `--cd <dir>` | Workspace for CodeNeter (default: current directory). It is the child's working directory and is passed as `--workspace`; with no sandbox it is a starting point, not a boundary. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials (`model`, `effort`, `timeout`); fails if the lane's `implementer` is not this relay. Explicit flags win. |
| `--model <id>` | A `Model ID` from `codeneter models` (default: the CLI's configured model, or the session's saved model when resuming). `resolvedModel` shows what actually ran. |
| `--effort <level>` | An effort level `codeneter models` lists for that model. Sent as `<id>?effort=<level>`; requires `--model`. |
| `--mode <mode>` | `agent`, `plan`, or `ask`. An instruction to the agent, not a restriction: edits run in every mode. The relay rejects other values, which the CLI would otherwise run as `agent` without saying so. |
| `--auto` | Approve terminal commands, file deletions, and MCP calls for this run. No sandbox. Not remembered by a resumed session. |
| `--session <id>` | Continue one saved session by id (the `sessionId` from a prior `result.json`); send only the delta brief. The CLI refuses a session saved under a different `--cd`. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child's process tree is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh private dir under the system temp dir). |

Artifacts default to the system temp dir so relay-created files stay out of the target repository.
On POSIX, that directory is mode `0700` and its files are created as `0600`.

## What the helper is doing

```bash
codeneter run --output-format stream-json --workspace <cd> \
    [--resume <sessionId>] [--model <id>[?effort=<level>]] [--mode <mode>] [--auto] < brief.txt
```

The brief goes in on stdin, never in argv. `--workspace` repeats the child's working directory so a
resumed session saved under another folder is refused instead of quietly running there. Before
launching, the relay runs a bounded `codeneter --version` preflight and reads the `autoApprove` key of
`~/.codeneter/config.json`: when that key is on, every run approves everything whatever the flags say,
so the relay refuses to launch without `--auto`. The file holds no credentials. The environment is
inherited unchanged, so the CLI's own sign-in works as it does at your terminal.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `timeout` | `aborted` | `codeneter_unavailable`
- `exitCode` — preserves `codeneter`'s non-zero exit code (1 for a failed run); a zero exit without an
  ok `result` event becomes 1; `128` plus the signal number if the child was killed; `127` if the binary
  isn't found; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the
  watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `codeneterVersion` — the binary that actually ran
- `sessionId` — feed this to a later `--session <id>` for rework in the same session
- `resolvedModel` / `resolvedMode` — the model and mode from the CLI's `init` event
- `errorKind` — the CLI's own classification of a sign-in failure: `sign_in_required`,
  `access_denied`, or `auth_unavailable`; otherwise `null`
- `limit` — the usage-limit payload when the run stopped at one (`title`, `message`); otherwise `null`
- `tools` — `started`, `failed`, and `refused` counts from the event stream. `refused` counts actions
  the CLI turned down because approvals were off ("User rejected …"); above zero on a run without
  `--auto`, the implementer could not run what the brief asked for
- `finalMessage` — CodeNeter's own final report (the `<structured_output_contract>` you asked for),
  from the `result` event's `response`, or the last assistant message when that is empty; written to
  `finalPath` only when non-empty
- `touchedFiles` — `git status --porcelain` lines in the workspace: your review starting point. `null`
  (not `[]`) when git can't report — `git` missing, or a non-repo workspace; `[]` means git ran and the
  tree is clean
- `auto` / `configAutoApprove` / `autonomy` — whether `--auto` was passed, what the CLI's config said
  at launch, and the resulting posture in plain words
- `briefPath` / `eventsPath` / `finalPath` — the exact brief the relay sent, the raw event stream, and
  the final-message file; `finalPath` is `null` when `finalMessage` is empty
- `workdir`, `tool`, `model`, `effort`, `mode`, `session`, `resumed`, `lane`, `laneSource`,
  `startedAt`, `finishedAt` — `model`, `effort`, and `mode` are what you asked for
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`,
  `timeout`, `aborted`), absent on `completed`, `codeneter_unavailable`, and launch failures
- `error` — present on a launch failure, on `timeout` and `aborted` runs, and whenever the CLI did not
  report an ok result

`status: "completed"` requires exit 0 **and** a `result` event with `ok: true`. The helper also prints
a summary to stdout and exits with that exit code, so a wrapping script can branch on success/failure
directly.

## Waiting for completion

The helper blocks until CodeNeter finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh. A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief, a `/` brief, `autoApprove` on without `--auto`) exits with code 2
  *before* writing any file — so check the exit code too, don't only watch for the file. (A missing
  binary exits 127 but *does* write a `result.json` with status `codeneter_unavailable`.)

## When a run misbehaves

- **`status: codeneter_unavailable` (exit 127):** the binary wasn't found on the relay's PATH. Install
  the CLI (`npm install -g @codeneter/cli`), then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `codeneter --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so CodeNeter was never dispatched. Run `codeneter --version` yourself.
- **`status: failed` with `errorKind`:** the sign-in, not the work. `sign_in_required` → run
  `codeneter login`; `access_denied` → signing in again will not help; `auth_unavailable` → the
  service did not answer, retry later.
- **`status: failed` with `limit`:** the account reached a usage limit. The tree may hold a partial
  change; inspect it before resuming.
- **`status: failed` with `codeneter reported a failure` in the `error`:** the CLI's own result event
  said the run failed and why — for example `Session not found`, a session that `belongs to` another
  folder (resume it with the `--cd` it was saved under), or a provider error.
- **`status: failed` with `without a result event` in the `error`:** the stream ended without the
  closing event, so nothing proves the task finished — the CLI crashed, was killed from outside, or
  rejected its command line. `stderrTail` usually names the cause; read `eventsPath` and the diff
  before deciding.
- **`tools.refused` above zero:** approvals were off and the CLI turned down commands or deletions.
  Run the gates yourself, or re-dispatch with `--auto` only if the user accepts unattended commands.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief, or a
  resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a closed
  terminal) and forwarded the kill to `codeneter`. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable, so this status may never get written — a relay process that is gone without a
  `result.json` is an aborted run.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer or
  a supervisor timeout, not an implementer error.

## Known limits

- Each launch may start the CLI's background update check about a second in (skipped in CI). It runs
  in its own process and does not touch the workspace, but it can install a newer CLI between two
  dispatches; `codeneterVersion` records what each run used.
- The `autoApprove` check is a snapshot: the CLI reads its config itself a moment later, and the file
  can change in between.

## Recovering lost work

`events.jsonl` records every event CodeNeter streamed — each tool call as it started and finished, and
every assistant message. If finished work is lost — the run killed late, or the tree damaged afterward
— read the event log before re-dispatching: it is the map of what the run did. The log contains
whatever the run read or wrote, so treat it as sensitive as the repo itself.

## The commit boundary

The helper never commits — by design, not omission. With `--auto`, CodeNeter *can* write `.git`, which
is the reason: a run that commits itself is a run you must unpick before you can review it. The robust
contract is: CodeNeter edits the working tree, the orchestrator reviews and commits. See
[review-and-land.md](review-and-land.md).
