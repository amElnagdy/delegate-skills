# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `dsh --profile headless`, runs the brief as a
pointer task, captures everything, and writes a structured `result.json`. Your job collapses to: run
one command, then read one file. Everything `dsh`-specific lives in the helper, which is what keeps
the loop portable across orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v dsh    # the active binary on PATH
dsh --version     # the relay records this in result.json too
# no auth subcommand — set DEEPSEEK_API_KEY (or the provider's key) in the
# environment or in $DSH_HOME/.credentials.yaml / .env
```

`dsh` has no `dsh auth` or credential-listing command. Credentials resolve from the inherited
environment, then `$DSH_HOME/.credentials.yaml`, then the invoking directory's `.env`, then
`$DSH_HOME/.env`. `DEEPSEEK_API_KEY` is the ordinary one for the default provider.

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
| `--cd <dir>` | Working root for `dsh` (default: current directory). Becomes the child `cwd` and the harness's `workspaceRoot`; there is no workspace flag. |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Model for the generated `agent-default-model` patch overlay that overrides the composed default. A stored selection in `$DSH_HOME/settings.yaml` layers over that entry and wins (`packages/core/agent-default-model/README.md`: "That composition entry is the base of the `agent-default-model` Settings section; a mounted settings provider layers the user's choice over it"), so this is a request, not a guarantee; the effective model is not observable from the run. `modelOverlay` in `result.json` records what was requested. `--provider` defaults to `deepseek-official` (the harness's own default provider id). |
| `--provider <name>` | Provider for that overlay. Requires `--model`; pass both or neither. Same precedence as `--model`: a stored `$DSH_HOME` selection outranks it, and `modelOverlay` records the request. |
| `--permission-mode <mode>` | `DSH_PERMISSION_MODE` for the child: `read-only` \| `workspace-write` \| `danger-full-access`. Default: leave the variable unset so the harness's composed default (`workspace-write` + `ask`) applies. |
| `--read-only` | Sugar for `--permission-mode read-only`, and arms the Git tripwire. Rejected if combined with a conflicting `--permission-mode`. |
| `--patch <file>` | Extra `--patch` overlay, repeatable, passed straight through as `dsh --patch <file>` in argv order. Launcher flags (`--profile`, `--patch`) precede the positional, always. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. `dsh` has no timeout flag of its own, so the watchdog is relay-only. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only `dsh`'s edits and nothing of the helper's own. The briefing file
itself (`<out-dir>/brief.md`) also lives there, which is safe: the `workspace-write` sandbox
confines filesystem **mutations** but leaves reads and the platform temporary roots unrestricted, so
`dsh` can read it.

### The pointer-file mechanic and why

`dsh --profile headless` takes the task **only as a positional argv value** — there is no
`--message-file`, no prompt flag, and no stdin for the task. `dsh --profile headless --help`
documents that positional as `[task...]` — multiple words are joined by spaces — which is a second,
independent reason a multi-line brief cannot ride argv: it would be space-joined. Passing it as a
shell token would also be mangled by `cmd.exe` under `shell: true` on win32 (the relay uses
`shell: true` on win32 to resolve the `dsh.cmd` npm shim). With an empty positional the harness
exits 1 with `error: a task is required, for example: dsh --profile headless "run the tests"`. So
the relay writes the brief verbatim to `<out-dir>/brief.md` and passes a short, single-line,
ASCII-only pointer as the positional:

```text
Read the task brief at /tmp/delegate-relay/.../brief.md and execute it fully.
```

It contains no quotes, newlines, or shell metacharacters beyond the path itself, and is quoted
only where `shell: true` requires it. The brief file is readable because reads are not confined by
the sandbox and the system temp dir is among the platform temporary roots the sandbox allows writing.

Quoting is not a boundary on win32: `cmd.exe` expands `%` inside double quotes, expands `!`
under delayed expansion, and still reads `&`, `|`, `^`, `<`, and `>`. A `.cmd` shim cannot be
launched without a shell, so the relay rejects rather than escapes — `--patch`, `--out-dir`, and
the resolved run directory (which borrows `basename(--cd)`) are checked for those characters on
win32 and exit 2 with the offending character named. POSIX spawns argv directly and skips the
check.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `timeout` | `aborted` | `dsh_unavailable`
- `exitCode` — mirrors `dsh`'s exit code; `128` plus the signal number if the child was killed; `127` if `dsh` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `dshVersion` — the binary that actually ran (from a bounded `dsh --version` preflight)
- `permissionMode` — the `DSH_PERMISSION_MODE` the run actually used, or `null` when the variable was left unset so the harness default applied
- `readOnly` — whether this was a read-only run (`--read-only` / `read-only` mode)
- `sessionId` — always `null`; the headless surface exposes none and has no resume or continue flag
- `finalMessage` — `dsh`'s assembled final stdout text (the `<structured_output_contract>` you asked for). Empty if `dsh` stopped without emitting a closing summary — ask for the report explicitly
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report — `git` missing, or a non-repo run; `[]` means git ran and the tree is clean
- `readOnlyViolation` — tri-state: `true` if the Git tripwire saw a write during a `--read-only` run, `false` if it proved clean, `null` when it could not be determined (only meaningful on read-only runs; `null` otherwise)
- `briefPath` / `outputPath` / `finalPath` — the exact brief, the raw stdout capture, and the final-message file
- `patches` — the user-supplied `--patch` files passed through (does not include the generated model overlay)
- `modelOverlay` — `{ provider, model }` the relay requested via the generated `agent-default-model` overlay, or `null` if no `--model` was given. This is what was requested, not the effective model — a stored selection in `$DSH_HOME/settings.yaml` outranks the overlay and the relay cannot observe which model actually served the request, so no field reports "the model that ran."
- `workdir`, `lane`, `laneSource`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed` and `dsh_unavailable`
- `error` — present on a launch failure, and on `timeout` and `aborted` runs

The helper also prints a summary to stdout and exits with `dsh`'s exit code, so a wrapping script can
branch on success/failure directly. `finalMessage` is also written to `<out-dir>/final.txt` and echoed
in full between report markers.

There is **no resume path**. `dsh --profile headless` creates one fresh persisted Agent, prints no
session id, and offers no `--resume-last` or `--session`. Rework is a fresh, fully self-contained
brief — the next dispatch starts from a clean session and remembers nothing from the previous run.

## Waiting for completion

The helper blocks until `dsh` finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief, conflicting flags) exits with code 2 *before* writing any file — so
  check the exit code too, don't only watch for the file. (A missing `dsh` binary exits 127 but *does*
  write a `result.json` with status `dsh_unavailable`.)
- **No resume:** `result.json` always carries `sessionId: null`; don't look for a resume id.

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## The SIGTERM-exits-0 trap

`dsh` gives the plugin tree up to five seconds to dispose and **`SIGTERM` exits 0 on every surface**
(`SIGINT` reports 130; a second signal forces immediate exit). This is a trap for the watchdog: a
timed-out or aborted run can exit 0. The relay therefore classifies `timeout` (the `--timeout`
watchdog fired) and `aborted` (the relay itself was killed and forwarded the kill) **from its own
state, never from the child's exit code**, and never reports `completed` for a run it killed.

## When a run misbehaves

- **`status: dsh_unavailable` (exit 127):** `dsh` isn't on PATH or isn't found. Install
  (`npm i -g @deepseek-ai/dsh`, or `npx @deepseek-ai/dsh`) and set a provider credential, then
  re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `dsh --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so `dsh` was never dispatched; only the relay's own artifacts may already exist under
  `--out-dir`. Check the install by running `dsh --version` yourself.
- **`status: failed`:** read `result.json`'s `stderrTail` and `finalMessage` for the cause. Common
  causes: a missing credential, an unknown model/provider, or a patch file that failed to parse. Fix
  the cause and re-dispatch; don't paper over it by doing the work yourself unless that's what the
  user wants.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a fresh dispatch.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to `dsh`. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written —
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **Empty `finalMessage`:** `dsh` finished without emitting a closing text summary (common when it
  completes purely through tool calls). The edits may still be correct — check `touchedFiles` and the
  diff. To get a report next time, add a `<structured_output_contract>` block (see
  [writing-the-brief.md](writing-the-brief.md)).
- **A run hangs:** `dsh` headlessly does **not** hang on a permission prompt — the approval seam
  fails closed when no answerer is composed, so an escalation beyond the sandbox is rejected rather
  than left awaiting input. A hang therefore means the `dsh` process itself is stuck, not a prompt;
  use the `--timeout` watchdog and inspect the tree.

## Recovering lost work

`output.txt` in the run directory records the raw stdout. The working tree itself is the
authoritative copy — `touchedFiles` and `git diff` show what was actually written.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
dsh --profile headless --patch <generated-model-overlay> --patch ./overlay.yml "Read the task brief at /tmp/.../brief.md and execute it fully."
```

Launcher flags (`--profile`, `--patch`) come first and end at the first token the launcher does not
recognize; everything after that is the headless app's positional task text. The brief file travels
outside argv; the positional is only the pointer. `DSH_PERMISSION_MODE` is set in the child's
environment when `--permission-mode` / `--read-only` was given, otherwise left unset. The invoking
directory (`--cd` / `process.cwd()`) is the workspace root — there is no workspace flag.

If you ever want it, raw `dsh --profile headless "…"` is fine for one-offs — you just give up the
captured `result.json`, touched-files summary, and version capture the helper does for you.

There is **no `--resume-last` or `--session`** — the headless surface has no resume. Every dispatch
is a fresh Agent; rework means a fresh, fully self-contained brief.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: `dsh` edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
