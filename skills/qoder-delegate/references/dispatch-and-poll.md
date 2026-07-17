# Dispatch and poll

`scripts/relay.mjs` wraps `qodercli -p --output-format stream-json`, captures raw output, and writes a
stable `result.json`.

## Before the first run

```bash
command -v qodercli
qodercli --version
qodercli --list-models
```

Install and authenticate using Qoder's
[official Quick Start](https://docs.qoder.com/en/cli/quick-start). Use `qodercli login` interactively or
`QODER_PERSONAL_ACCESS_TOKEN` for automation.

## Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path; omit to read stdin. |
| `--cd <dir>` | Primary working root and child cwd; defaults to current directory. |
| `--model <name>` | Exact live model value from `qodercli --list-models`; omit for Qoder's default. |
| `--context-window <n>` | Positive integer requested for models that support explicit sizing. |
| `--session <id>` | Resume one Qoder session with a delta brief. |
| `--resume-last` | Continue the most recent Qoder session for this cwd with a delta brief. |
| `--add-dir <dir>` | Add a workspace directory; repeatable. |
| `--permission-mode <mode>` | `default`, `accept_edits`, `bypass_permissions`, `dont_ask`, or `auto`; defaults to `accept_edits`. |
| `--timeout <dur>` | Relay watchdog; defaults to `30m`, using h/m/s syntax. |
| `--out-dir <dir>` | Artifact directory; defaults to a fresh system-temp directory. |
| `-h`, `--help` | Print relay help. |

`--session` and `--resume-last` are mutually exclusive. Relative `--add-dir` values resolve against
`--cd`.

## Model and context behavior

Qoder's catalog is account- and time-dependent. The relay deliberately accepts a model string rather
than maintaining a stale allowlist. It validates only that the value is non-empty; Qoder remains the
authority on availability.

The relay validates context windows as positive integers and forwards the value unchanged. Qoder
remains the authority on whether the selected model supports it. An omitted value uses Qoder's normal
model behavior.

## Permission behavior

Print mode cannot ask for approval. `accept_edits` is the implementation default: safe workspace edits
can proceed, while riskier actions still follow Qoder's rules. Use `dont_ask` to fail closed. Use
`bypass_permissions` only after the human explicitly accepts a trusted broad run. No mode replaces diff
review.

## Artifacts and result fields

Artifacts default outside the repository:

- `brief.txt` - exact dispatched brief.
- `events.jsonl` - raw Qoder stdout events.
- `final.txt` - final report when captured.
- `stderr.txt` - complete stderr.
- `result.json` - `delegate-relay.result.v1`.

Important `result.json` fields:

- `tool` (`"qoder"`), `status` (`completed`, `failed`, or `qoder_unavailable`), `exitCode`, `signal`.
- Requested `model`, `contextWindow`, and `permissionMode`; observed `actualModel` and
  `actualPermissionMode` from Qoder's init event.
- `qoderVersion`, `sessionId`, `resumed`, `startedAt`, and `finishedAt`.
- `usage`, `resultSubtype`, `qoderErrors`, and `permissionDenials` from Qoder's result event.
- `finalMessage` from the result event, falling back to assistant text.
- `touchedFiles` from final `git status --porcelain` under the primary `--cd` only. Existing dirty
  entries are included; `--add-dir` changes are not. `null` means git could not report; `[]` means the
  tree is clean.
- Artifact paths, plus `stderrTail` and `error` on failures.

## Waiting

The relay blocks. Use the orchestrator's background facility or run it in the foreground for short
tasks. A valid run is done when the process exits and `result.json` exists. A usage error exits 2 before
creating artifacts; missing Qoder exits 127 with `qoder_unavailable`.

## Failures

- **`qoder_unavailable`:** install Qoder CLI, authenticate, and re-dispatch.
- **`failed`:** read `qoderErrors`, `permissionDenials`, `stderrTail`, `stderr.txt`, and the tail of
  `events.jsonl`. Fix auth, model/context compatibility, permissions, or the brief, then re-dispatch.
- **Watchdog:** increase `--timeout` or split the task. The relay sends SIGTERM, then SIGKILL after ten
  seconds if needed.
- **Empty final message:** inspect the diff; require a structured report in the next delta brief.

## What the relay runs

```bash
qodercli -p --output-format stream-json --permission-mode accept_edits \
  [--model <name>] [--context-window <n>] [--resume <id> | --continue] \
  [--add-dir <dir> ...] -- <brief>
```

The relay spawns `qodercli` directly without a shell, never commits, and makes no network calls of its
own. Continue with [review-and-land.md](review-and-land.md).
