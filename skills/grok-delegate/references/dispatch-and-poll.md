# Dispatch and result contract

## Common commands

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
node "<skill-dir>/scripts/relay.mjs" --brief review.txt --cd /path/to/repo --read-only
node "<skill-dir>/scripts/relay.mjs" --brief fixes.txt --cd /path/to/repo --session <session-id>
```

The relay uses Grok Build headless mode with `--output-format streaming-json` and
`--no-auto-update`. Fresh implementation runs pass `--always-approve` by default so they cannot block
on an unattended permission prompt. Use `--no-auto-approve` when local permission policy should remain
in control.

`--read-only` removes the `write` and `edit` tools, adds an explicit non-mutation rule, avoids automatic
approval, and compares git porcelain before and after the run. This is defense in depth, not a claim that
all future Grok tool names or shell behavior are sandboxed: independently inspect the working tree.

## Artifacts

Unless `--out-dir` is supplied, artifacts are stored under the system temp directory:

- `brief.txt` — exact dispatched brief
- `events.jsonl` — raw stdout event stream, preserved even when an event cannot be parsed
- `stderr.txt` — Grok stderr
- `final.txt` — last assistant text extracted from the stream
- `result.json` — stable relay result

## `result.json`

The result uses schema `delegate-relay.result.v1` and includes:

- `tool: "grok"`
- `status`: `completed`, `failed`, or `grok_unavailable`
- `exitCode` and `signal`
- `grokVersion`
- `sessionId` when discovered or supplied
- `finalMessage`
- `touchedFiles` from `git status --porcelain`, or `null` when git cannot report
- `readOnlyViolation`
- paths to all run artifacts and start/finish timestamps

A bad argument or empty brief exits 2 before a result is written. A missing Grok binary exits 127 and
writes `grok_unavailable`. A read-only status change produces exit 3. Other exits mirror Grok; a signal
uses the conventional `128 + signal number` code when available.

## Recovery

- Authentication failure: run `grok login` or `grok login --device-auth`, then redispatch.
- Invalid model or effort: inspect `stderr.txt`, correct the option, and redispatch.
- Empty final message: inspect `events.jsonl`; judge the working tree rather than assuming failure.
- Killed process: inspect `signal` and host resources; split an oversized brief before retrying.
- Parser mismatch after a Grok update: the raw stream is authoritative evidence for adapting the parser.
