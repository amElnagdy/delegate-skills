# Dispatch and poll

Use the bundled relay from the installed skill directory:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo --timeout 30m
```

The brief is piped to `gemini --output-format stream-json` through stdin. A non-TTY stdin stream
triggers Gemini's documented headless mode without placing the brief in argv. The child working
directory is pinned to `--cd`; the relay also records `git status --porcelain` before and after the
run. `--model`, `--approval-mode`, `--sandbox`, `--resume`, and repeated
`--include-directories` (or the singular relay alias) flags are validated before dispatch and passed only as documented Gemini CLI
arguments. `--read-only` overrides approval mode to `plan`.

Every dispatched run creates an artifact directory before the version probe. `result.json` is written
atomically for completed, failed, unavailable, timeout, and aborted outcomes. Usage errors exit 2
without a result. A missing `gemini` binary exits 127 and writes `status: "gemini_unavailable"`.

The stream parser accepts the documented JSONL event types (`init`, `message`, `tool_use`,
`tool_result`, `error`, `result`) and preserves bounded raw events in `events.jsonl`. It extracts the
final response, session id, model, token statistics, and stop/error reason when present. Unknown
events are retained but do not imply success. Oversized prompts, lines, stderr, and final reports
are rejected or truncated deterministically.

The relay watchdog is independent of Gemini's own turn limits. On timeout or a signal to the relay it
terminates the entire process tree, refreshes `touchedFiles`, and records `status: "timeout"` or
`"aborted"`. Do not poll indefinitely; inspect the result once the process exits.
