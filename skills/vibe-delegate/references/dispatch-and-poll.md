# Dispatch and poll

`scripts/relay.mjs` wraps Vibe's headless `--prompt` mode, captures its structured stream, and writes
a `result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v vibe
vibe --version
```

Install on Linux/macOS with the one-line installer:

```bash
curl -LsSf https://mistral.ai/vibe/install.sh | bash
```

Or with uv: `uv tool install mistral-vibe`. Then configure your API key:

```bash
vibe --setup                    # interactive setup
export MISTRAL_API_KEY="..."    # or set it in the environment
```

Mistral Vibe works on Windows, but the upstream project officially targets UNIX environments. Consult
the [official Mistral Vibe documentation](https://github.com/mistralai/mistral-vibe) for Windows
guidance.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--max-turns <n>` | Maximum number of Vibe agent turns (`--max-turns`). Useful for cost control. |
| `--session <id>` | Resume a specific Vibe session (`--resume SESSION_ID`); send only the delta brief. |
| `--resume-last` | Resume the most recent Vibe session (`--continue`); send only the delta brief. |
| `--plan-only` | Use Vibe's `plan` agent (exploration/planning, best-effort read-only — verify `touchedFiles`). |
| `--enabled-tools <tool>` | Enable only this tool (`--enabled-tools`). Repeatable. |
| `--disabled-tools <tool>` | Disable this tool (`--disabled-tools`). Repeatable. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). Vibe has no timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--session` and `--resume-last` are mutually exclusive. The relay always passes `--trust` to Vibe so
headless runs do not prompt for directory trust.

Default mode uses Vibe's `auto-approve` agent, which auto-approves all tool executions. `--plan-only`
uses the `plan` agent (auto-approves safe read tools only). Inspect `touchedFiles` and the diff after
every run.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an `--out-dir`
inside the worktree can make the artifacts appear there:

- `brief.txt` — the exact brief.
- `events.jsonl` — raw Vibe stdout in streaming JSON format.
- `final.txt` — assistant text joined with a blank line between chunks; absent if none was emitted.
- `stderr.txt` — complete stderr.
- `result.json` — the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"vibe"`), `status` (`completed` | `failed` | `vibe_unavailable`), `exitCode`,
  and `signal` (`null` unless the child died on a signal).
- `workdir`, `agent` (`"auto-approve"` or `"plan"`), `maxTurns`, `resumed`, `vibeVersion`,
  `sessionId`, `startedAt`, and `finishedAt`.
- `briefPath`, `finalPath`, `eventsPath`, and `stderrPath`.
- `finalMessage` — assistant content strings joined with `"\n\n"`; tool calls and tool results are
  excluded.
- `touchedFiles` — `git status --porcelain` lines for the **final working tree under `--cd`**. Not
  an attribution of Vibe's edits: anything already dirty before dispatch shows up too. Dispatch from
  a clean tree when you want the list to read as "what Vibe changed". `null` means git could not
  report; `[]` means git ran and the tree is clean.
- `stderrTail` — the last 20 non-empty stderr lines on failure.
- `error` — present for launch failures or when the relay watchdog fires.

Note: `sessionId` is extracted from Vibe's streaming output on a best-effort basis. If `sessionId`
is `null`, use `--resume-last` to continue the most recent session without a specific ID.

## Waiting for completion

The helper blocks. Use the orchestrator's background-command facility, or background it in a shell and
poll for `result.json`. The run is done only when the process exits and the file contains a `status`.

A pre-run usage error exits 2 and writes no result. A missing `vibe` exits 127 and writes
`status: "vibe_unavailable"`.

## When a run misbehaves

- **`status: "vibe_unavailable"` (exit 127):** `vibe` isn't on PATH. Install with
  `uv tool install mistral-vibe` and configure `MISTRAL_API_KEY`, then re-dispatch.
- **`status: "failed"`:** read `stderrTail`, `stderrPath`, and the tail of `events.jsonl`. Common
  causes: an unconfigured or expired API key, an invalid model, or a trust-folder prompt that was
  not suppressed (the relay passes `--trust`, but check that the binary supports it).
- **`status: "failed"` with `signal: "SIGKILL"`:** the host killed the process, commonly through the
  OOM killer or a supervisor timeout. This is not a Vibe error; check host memory and re-dispatch, or
  split the task into smaller briefs.
- **Watchdog failure:** `error` reads
  `vibe did not finish within --timeout <dur>; killed by the relay watchdog`. Increase `--timeout` or
  split the task. The relay sends SIGTERM, waits 10 seconds, then sends SIGKILL if needed.
- **Empty `finalMessage`:** inspect `touchedFiles` and the diff. Add a
  `<structured_output_contract>` to the next brief to require a closing report. The streaming events
  in `events.jsonl` are the source of truth for diagnosing missing messages.

## What the relay runs

The argv is equivalent to:

```bash
vibe --output streaming --agent auto-approve --trust \
  [--max-turns <n>] [--resume SESSION_ID | --continue] \
  [--enabled-tools TOOL ...] [--disabled-tools TOOL ...] \
  --prompt=<brief>
```

The prompt rides argv and is visible in the host process list. The relay rejects briefs over 120 KB
before launch because the OS caps a single argument. It spawns `vibe` directly with `--cd` as cwd;
no shell or Vibe timeout flag is involved.

## The commit boundary

The relay never commits. Vibe edits the working tree; the orchestrator reviews, re-runs the gates, and
commits. See [review-and-land.md](review-and-land.md).
