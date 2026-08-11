---
name: gemini-delegate
description: >-
  Delegate a bounded coding task to Google's Gemini CLI (`gemini`) as a separate implementer,
  then review its working-tree diff and land it yourself. Use when the user asks to have Gemini
  implement, fix, refactor, or test code, or to run a queue through Gemini while the orchestrator
  remains the reviewer. Do not use for inline work or when the user wants code written directly.
license: MIT
compatibility: Requires the `gemini` CLI from `@google/gemini-cli` and an authenticated Gemini account or API key.
metadata:
  version: 0.4.2
---

# Gemini Delegate

You are the **orchestrator**. Delegate one bounded coding task to Google's Gemini CLI, inspect the
working-tree diff, rerun the project's gates, and land the verified change yourself. Gemini edits the
workspace; the relay never commits.

## When not to use this

- The task is small enough to do inline.
- `gemini` is not installed or is not authenticated.
- You need a hard read-only guarantee. Gemini's `--approval-mode plan` is intended for planning, but
  the relay reports the Git diff so you can verify that no files changed.

## Prerequisites

1. Install the official CLI: `npm install -g @google/gemini-cli`.
2. Authenticate through Gemini's normal login flow or an API-key environment variable.
3. Confirm `gemini --version` succeeds (the relay performs a bounded preflight too).
4. Run in the target Git repository or pass it with `--cd`.

The relay targets the documented headless interface in Gemini CLI v0.54.4: `-p/--prompt` and
`--output-format stream-json`. The prompt is sent through stdin, never placed in the host process
list. Gemini's own provider traffic, authentication, and telemetry are outside this Node relay.

## Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a model:       add --model <id from gemini --help>
# plan/read-only run:   add --read-only
# sandboxed run:        add --sandbox
# resume a session:     add --resume latest  (or --resume <index>)
# add workspace roots:  repeat --include-directories <path>
# watchdog:             add --timeout 30m
# all options:          node "<skill-dir>/scripts/relay.mjs" --help
```

The relay writes `result.json`, `events.jsonl`, `stderr.txt`, and the final report under a fresh
temporary directory (or `--out-dir`). It never commits, pushes, writes `.gitignore`, or reads or
writes credentials. Keep secrets out of briefs and model output artifacts.

## Autonomy and safety

- Normal runs use Gemini's `--approval-mode auto_edit`: edits are allowed while approval-sensitive
  operations remain under Gemini's policy engine.
- `--read-only` uses `--approval-mode plan`; this is best-effort and must be checked via
  `touchedFiles`/`readOnlyViolation` after the run.
- `--full-access` is intentionally not exposed. If unrestricted execution is needed, invoke Gemini
  directly with the owner's explicit judgment rather than weakening this relay.
- `--sandbox` forwards Gemini's documented `--sandbox` flag. Availability depends on the host's
  sandbox provider (Docker/Podman/Seatbelt/etc.); the relay does not install one.
- The relay kills the whole Gemini process tree on timeout or abort and records the outcome.
- `--resume`/`--resume-last` map to Gemini's documented `--resume` (`latest` or an index). A resume
  id is optional because Gemini may not expose one in every JSON event.

## Review and land

Read `result.json`, inspect `git diff` and `touchedFiles`, rerun the project's actual gates, and
commit only after the result is trustworthy. The shared result contract is
`delegate-relay.result.v1`; a branch or result file is not a substitute for review.

See the four references for brief writing, dispatch/polling, review/landing, and queues.
