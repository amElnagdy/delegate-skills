# Resilient Local-First Delegation Design

## Goal

Add a local-first delegation workflow that uses Qwen3-Coder 30B through Aider and Ollama, falls through to independent cloud CLIs only for capacity or availability failures, and keeps review and commit ownership with the orchestrator.

## Runtime roles

- Hermes Agent is the user-facing orchestrator. Its configured primary model remains `qwen3-coder:30b` on the local custom endpoint.
- `aider-delegate` is the local implementer path because the upstream package already supports OpenAI-compatible endpoints and disables Aider's automatic commits.
- `agy-delegate`, `copilot-delegate`, and `codex-delegate` are ordered cloud fallbacks.
- Project gates and a separate reviewer judge the resulting diff. No implementer or fallback controller commits.

## Profiles

### Routine

1. Aider: `ollama_chat/qwen3-coder:30b`, native local Ollama provider, whole-file edit format.
2. Agy: `gemini-3.8-flash-medium`, medium effort.
3. Copilot: `auto`, medium effort, only when authenticated.
4. Codex: `gpt-5.6-terra`, medium effort.

### Complex

1. Codex: `gpt-5.6-sol`, medium effort.
2. Agy: `claude-sonnet-4-6`, medium effort.
3. Copilot: `auto`, medium effort.
4. Aider/Qwen: high local reasoning as a recovery implementer.

### Critical

1. Codex: `gpt-6-astra`, medium effort.
2. Agy: `claude-opus-4-6-thinking`, medium effort.
3. Copilot: `auto`, medium effort.
4. Aider/Qwen: high local reasoning for a bounded recovery attempt.

`gpt-6-astra` must never be configured above medium effort in this workflow. Routine Codex work uses low or medium effort; high and xhigh are not part of the configured Codex profiles.

## Failover contract

The controller advances only for infrastructure or capacity outcomes:

- HTTP 429, 503, or 529;
- quota, usage-limit, rate-limit, billing-capacity, or overloaded errors;
- missing or unauthenticated implementer CLI;
- connection failures;
- relay watchdog timeout.

It stops on implementation, validation, permission, or project-gate failures. Those failures require correction by the same implementer or orchestrator review; switching providers must not hide a bad change.

Each attempt receives the original brief plus a compact continuation note naming earlier infrastructure failures and instructing it to inspect the existing working-tree diff before continuing. Cross-provider session IDs are never reused.

## Safety boundaries

- Start only in a Git repository.
- Require a clean working tree by default; an explicit flag is required to accept pre-existing changes.
- Relays write artifacts outside the repository unless the caller supplies an output directory.
- The controller never commits, pushes, installs dependencies, or changes credentials.
- The final aggregate result records every attempt, the selected implementer, the stop reason, and the final touched-file set.

## Review matrix

- Aider/Qwen implementation: Codex auto-review or Codex read-only review.
- Codex implementation: Agy or Copilot read-only cross-review.
- Agy/Copilot implementation: Codex read-only review.
- Automated project gates remain the final authority.

If all cloud providers are exhausted, Hermes remains usable on local Qwen and records the task as waiting for a quota reset rather than looping indefinitely.

## Installation scope

- Keep the upstream repository clone under the task workspace.
- Install the upstream delegation skills globally for supported orchestrators.
- Install Aider as an isolated user tool when a suitable tool manager is available.
- Install the custom resilient skill only after its script and behavioral contract pass tests.
- Configure Hermes/Codex authentication interactively only where OAuth requires human interaction; never copy or print credential values.
