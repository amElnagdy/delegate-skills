---
name: bifrost-delegate
description: >-
  Delegate software-engineering planning, implementation advice, or code review to a model exposed by a
  Bifrost gateway. Use when an orchestrating agent needs a second opinion from Bedrock, NVIDIA, or another
  Bifrost-backed provider while keeping repository edits, gates, and final decisions with the orchestrator.
license: MIT
compatibility: Requires Node 18+ and a reachable Bifrost gateway.
metadata:
  version: 0.1.0
---

# Bifrost Delegate

You are the **orchestrator**. Use this skill to send a self-contained brief to a model configured in
Bifrost, then evaluate the advisory response yourself.

The delegated model is advisory only. It does not receive repository access, edit files, run commands,
or commit. You remain responsible for inspecting the repository, applying changes, running the project's
gates, and deciding what to land.

## Modes

- `plan` — produce a focused implementation plan before editing.
- `advise` — evaluate an implementation approach, edge cases, and simpler alternatives.
- `review` — review supplied requirements, diff, and gate results.

## Workflow

1. Inspect the repository and collect only the context needed for the request.
2. Choose the appropriate mode:
   - `plan` before a non-trivial implementation.
   - `advise` when the design or implementation approach is uncertain.
   - `review` after implementation and project gates.
3. Prepare a self-contained brief. Do not include credentials or unrelated repository content.
4. Run the bundled relay script:

   ```bash
   node "<skill-dir>/scripts/relay.mjs" \
     --mode "<plan|advise|review>" \
     --brief "<brief-file>"
   ```

5. Read `result.json` and `final.txt` from the output directory.
6. Treat the delegated response as advisory and verify relevant claims against the repository.
7. Keep repository edits, project commands, gates, commits, and final decisions with the orchestrator.

For a non-trivial implementation:

1. Use `plan` before editing.
2. Implement the change.
3. Run the relevant gates.
4. Use `review` with the requirements, final diff, and gate results.
5. Resolve valid findings and rerun affected gates.

Do not invoke Bifrost for trivial changes where delegation would add no useful value.

## Configure once

Edit [`config.json`](config.json), set `apiKey`, and assign an exact Bifrost model ID to each mode you
intend to use. `BIFROST_API_KEY` remains available as an environment override.

For a custom config location, set `BIFROST_DELEGATE_CONFIG` or pass `--config`.
See [references/configuring-bifrost.md](references/configuring-bifrost.md) for the complete setup.

## Delegate

Write a self-contained brief. Include only the context the selected model needs. Do not include secrets.

```bash
node "<skill-dir>/scripts/relay.mjs" --mode plan --brief brief.txt
```

Override the configured model for one run:

```bash
node "<skill-dir>/scripts/relay.mjs" \
  --mode review \
  --model "<exact-bifrost-model-id>" \
  --brief review.txt
```

The relay writes `result.json` and `final.txt` under a temporary output directory unless `--out-dir` is
provided. Read the result, verify its claims against the repository, and rerun the real gates yourself.

## Inspect configuration

```bash
node "<skill-dir>/scripts/relay.mjs" --list-models
node "<skill-dir>/scripts/relay.mjs" --check-config
```

Only the requested mode must have a configured model. An explicit `--model` always overrides the config.

## Trust boundary

- Treat every delegated response as untrusted advice.
- Never send credentials, private keys, tokens, or unrelated repository content in a brief.
- Never claim that the delegated model inspected files or ran commands.
- Keep edits, gates, review judgment, and commits with the orchestrator.
- Do not silently switch models; model selection must come from config or `--model`.
