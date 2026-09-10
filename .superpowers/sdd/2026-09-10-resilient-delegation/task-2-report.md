# Task 2 report: resilient controller

## Status

Implemented the local-first `resilient-delegate` utility controller. It invokes
existing sibling relays, never commits, requires a clean Git tree by default,
and writes one atomic aggregate result.

## Files

- `skills/resilient-delegate/scripts/resilient.mjs`
- `skills/resilient-delegate/SKILL.md`
- `skills/resilient-delegate/references/configuration.md`
- `test/relay/package-shape.mjs` — excludes utility names from the suffix-based
  implementer list so `resilient-delegate` remains a utility carve-out.

## Contract implemented

- Built-in routine profile starts with Aider using
  `openai/qwen3-coder:30b` via Ollama at `http://127.0.0.1:11434/v1`, then
  falls back across Agy, Copilot, and Codex.
- Complex and critical profiles remain provider-diverse; GPT-6 Astra is only
  configured at medium effort.
- Codex candidates receive an explicit medium default when omitted and reject
  any effort other than `low` or `medium`.
- Only capacity/infrastructure classifications advance: rate limit, missing
  implementer, unauthenticated CLI, service unavailable, overloaded,
  connection failure, and watchdog timeout. Permission, invalid arguments,
  malformed results, project failure, and implementation failure stop with
  their exact `stopReason`.
- Fixture result fields are accepted only for the smoke process (`SMOKE_NODE`
  bound to the running Node executable) and only in the `smoke` profile.

## Commit

`2bddf88887187ad3774affc28969dfa6d8dd6ff0` — current Task 2 head, including
the terminal-classification and no-result regression fixes.

## Evidence

1. `node --check skills/resilient-delegate/scripts/resilient.mjs` exited 0.
2. `node test/relay-smoke.mjs --only resilient-delegate` exited 0 with all 26
   focused checks green, including unavailable-status semantic-precedence and
   missing-result watchdog, connection, and malformed-output regressions.
3. `node test/relay-smoke.mjs --only package-shape` exited 0.
4. `git diff --check` exited 0 before committing.

## Concern

The deterministic test seam is intentionally narrow but remains an
environment-based smoke fixture. A future dedicated fixture-relay mechanism
could remove that seam entirely while preserving the same behavioral coverage.

## Review follow-up

Classification now checks permission denial, invalid arguments/configuration,
malformed output, and project/test/gate failures before unavailable or capacity
signals. If a child leaves no `result.json`, its `spawnSync` status, error code,
stdout, and stderr are inspected: watchdog evidence becomes `timeout`, known
connection errors become a connection failure, and all remaining no-output
outcomes stop as `malformed_result`.
