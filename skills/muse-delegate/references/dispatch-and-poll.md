# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `muse exec`, captures everything, and writes a
structured `result.json`. Your job collapses to: run one command, then read one file. Everything
Muse-specific lives in the helper, which is what keeps the loop portable across orchestrators.

Headless Muse is `muse exec` only. `muse resume` is the interactive TUI and is never invoked.

## Before the first run: check the binary

```bash
command -v muse    # the active launcher on PATH
muse --version     # the relay records this in result.json too
```

Authenticate with `muse login` or `META_API_KEY`. Do not read Muse's `auth.json`.

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
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). Delivered as `--prompt-file`, never on argv. |
| `--cd <dir>` | Working root for Muse (default: current directory). Passed as spawn cwd **and** `--workspace`. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Muse model id. Optional — Muse has a configured default. |
| `--effort <level>` | Passed as `--reasoning-effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`. |
| `--provider echo\|meta` | Relay-only. Omit to use Muse's default (`meta`). Not a fleet dial. `echo` is for tests. |
| `--read-only` | Adds `--disable-write` and `--disable-shell`. Keeps `--disable-approval`. |
| `--session <id>` | Continue a specific session via `--session-id`; send only the delta brief. |
| `--resume-last` | **Rejected** (exit 2, no result file). `muse resume --last` is TUI-only. Use `--session <id>`. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Muse's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `muse`
- `status` — `completed` | `failed` | `timeout` | `aborted` | `muse_unavailable`
- `exitCode` — mirrors Muse's exit code; `128` plus the signal number if the child was killed; `127` if `muse` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM; exit 0 without `run.terminal.completed` is reported `failed` with a non-zero relay code
- `signal` — the signal that killed the child, otherwise `null`
- `museVersion` — the binary that actually ran
- `sessionId` — from `stream.kind == "session"` → `stream.id`; feed this to a later `--session <id>`
- `finalMessage` — text from `run.terminal.completed` → `payload.text`. Empty if Muse never emitted that event
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report — `git` missing, or a non-repo run; `[]` means git ran and
  the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSONL event stream, and
  the final-message file
- `workdir`, `model`, `effort`, `provider`, `readOnly`, `resumed`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed`,
  `muse_unavailable`, and launch failures
- `error` — present on a launch failure, and on `timeout` and `aborted` runs; also when Muse exits 0
  without `run.terminal.completed`

The helper also prints a summary to stdout and exits with Muse's exit code (or 1 when Muse exited 0
without a terminal event), so a wrapping script can branch on success/failure directly.

## Waiting for completion

The helper blocks until Muse finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh. A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief, `--resume-last`) exits with code 2 *before* writing any file — so check
  the exit code too, don't only watch for the file. (A missing `muse` binary exits 127 but *does* write a
  `result.json` with status `muse_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: muse_unavailable` (exit 127):** `muse` isn't on PATH or isn't found. Install Muse Code
  and `muse login`, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `muse --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so muse was never dispatched; only the relay's own artifacts may already exist under
  `--out-dir`. Check the install by running `muse --version` yourself.
- **`status: failed` with `muse exited 0 without a run.terminal.completed event`:** Muse returned
  success without a terminal MSP event. Treat it as unfinished; inspect the tree and `events.jsonl`
  before re-dispatching.
- **`status: failed`:** read `result.json`'s `stderrTail` and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse, an unknown `--model`, or a permission the sandbox refused. Fix the
  cause and re-dispatch; don't paper over it by doing the work yourself unless that's what the user
  wants.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume with `--session`.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to muse. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **Empty `finalMessage`:** Muse finished without `payload.text` on the terminal event. The edits may
  still be correct — check `touchedFiles` and the diff. To get a report next time, add a
  `<structured_output_contract>` block (see [writing-the-brief.md](writing-the-brief.md)).

## Recovering lost work

`events.jsonl` in the run directory records every JSONL event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. Whether it also carries the edit contents depends on what the CLI streams,
so treat any reconstruction as unverified until it matches a working-tree diff — when the tree
still holds the work, preserve the tree rather than replaying the log.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
muse exec --json --prompt-file <brief> --disable-approval --trust-workspace \
  --workspace <cd> --user-input-auto-resolve
# read-only adds: --disable-write --disable-shell
# resume adds:    --session-id <id>
```

The brief is delivered with `--prompt-file`, never as an argument — which is why a multi-line,
XML-tagged brief needs no quoting. Spawn cwd and `--workspace` are both set to `--cd` so Muse cannot
resolve the orchestrator's directory from an inherited `PWD`. The `--json` stream is MSP JSONL; the
relay takes `sessionId` from `stream.kind == "session"` and `finalMessage` from
`run.terminal.completed`. `--yolo` is not passed.

If you ever want it, raw `muse exec` is fine for one-offs — you just give up the captured
`result.json`, touched-files summary, and session-id extraction the helper does for you.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: Muse edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
