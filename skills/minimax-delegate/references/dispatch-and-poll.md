# Dispatch and poll

`scripts/relay.mjs` wraps `mcode exec`, captures its `stream-json` events, and writes a `result.json`.
Run one command, then read one file.

## Before the first run

```bash
mcode --version
mcode login --region global   # or: mcode login  (mainland China account)
```

Install with `npm install -g @minimax-ai/code` (Node 22.19+ or 24-26), or the official installer from
the [MiniMax Code CLI docs](https://agent.minimax.io/docs/cli/quick-start). Sign-in finishes in the
browser. A machine signed in to the MiniMax desktop app may already be authenticated. mcode has no
auth-status command, so the first dispatch is the auth check.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Workspace: the child process cwd, which `mcode exec` uses as its workspace (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not `minimax`. Explicit flags win. |
| `--model <provider/model>` | Model for this run only, e.g. `minimax/MiniMax-M3`. Default: mcode's configured model. |
| `--effort <level>` | Reasoning effort for this run. MiniMax-M3.1-Flash takes `default`, `low`, `medium`, `high`, `xhigh`, `max`; MiniMax-M3 takes none. |
| `--permission <policy>` | `smart` (mcode's default), `full`, or `off`. `ask` needs a human and is rejected. |
| `--max-steps <n>` | Cap on assistant steps. |
| `--session <id>` | Continue that session; send only the delta brief. |
| `--resume-last` | Continue the latest session in `--cd`, failed runs included; send only the delta brief. |
| `--timeout <dur>` | Relay watchdog (default `30m`; h/m/s strings). |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--session` and `--resume-last` are mutually exclusive.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`:

- `brief.txt` - the exact brief.
- `events.jsonl` - raw mcode `stream-json` events.
- `final.txt` - the final report; absent if none was emitted.
- `stderr.txt` - complete stderr.
- `result.json` - the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"minimax"`), `status` (`completed` | `failed` | `timeout` | `aborted` |
  `mcode_unavailable`), `exitCode`, and `signal`.
- `workdir`, `model`, `effort`, `permission` (what was requested, `null` for mcode's default),
  `resolvedModel` (what mcode actually ran, e.g. `minimax/MiniMax-M3.1-Flash`), `usage` (token counts),
  `resumed`, `mcodeVersion`, `sessionId`, `startedAt`, `finishedAt`.
- `briefPath`, `finalPath`, `eventsPath`, `stderrPath`.
- `finalMessage` - the `output` of mcode's `exec.completed` result, falling back to the last
  `agent_message` when the run died first.
- `mcodeError` - mcode's own `{category, message, retryable}` when it reports the run failed.
- `touchedFiles` - `git status --porcelain` for the final tree under `--cd`. Pre-existing dirt shows up
  too, so dispatch from a clean tree. `null` means git could not report.
- `stderrTail` - the last 20 stderr lines on any run that did not complete.
- `error` - launch failures, watchdog timeouts, and aborted runs.

A run mcode reports as failed is `failed` even if mcode exits 0.

## Waiting for completion

The helper blocks. Use the orchestrator's background-command facility, or background it and poll for
`result.json`. The run is done only when the process exits and the file contains a `status`.

## When a run misbehaves

- **`mcode_unavailable` (exit 127):** install the CLI and sign in.
- **`version preflight` in `error`:** `mcode --version` failed or hung; mcode was never dispatched.
- **`failed` with `mcodeError`:** read its `message`. A bad model id reads
  `Model "<x>" is not available for the "configured_provider" route`. An unsupported effort fails
  before the run with `<model> does not support reasoning effort selection` in `stderrTail`.
- **`timeout`:** the watchdog killed the run. Raise `--timeout` or split the task.
- **`aborted`:** the relay itself was killed and took mcode with it. On native Windows a hard kill of
  the relay cannot be caught, so a relay that is gone without a `result.json` is an aborted run;
  inspect the tree and `events.jsonl`.
- **Empty `finalMessage`:** inspect the diff, and add a `<structured_output_contract>` next time.

`events.jsonl` records every tool call with its input, including edit patches, so it scopes what a
lost run touched. Treat any reconstruction as unverified until it matches the working tree.

## What the relay runs

```bash
cd <dir> && mcode exec --input - --output-format stream-json [--model <m>] [--effort <e>] \
  [--permission <p>] [--max-steps <n>] [--session <id> | --continue]   # brief on stdin
```

On Windows npm installs `mcode` as a `.cmd` shim, so the relay launches it with `shell:true` there.
The brief rides stdin and the workspace is the child cwd, so cmd.exe sees only flag names and
token-validated values.

## The commit boundary

The relay never commits. See [review-and-land.md](review-and-land.md).
