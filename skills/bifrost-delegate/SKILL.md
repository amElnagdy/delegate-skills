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
2. Choose the mode that best fits the question:
	- `plan` when an independent implementation plan would be useful.
	- `advise` when a design or implementation decision would benefit from a second opinion.
	- `review` when implemented changes would benefit from an independent review.
3. Prepare a self-contained brief. Use [writing-the-brief.md](references/writing-the-brief.md) as optional guidance. Do not include credentials or unrelated repository content.
4. Run the bundled relay script:

   ```bash
   node "<skill-dir>/scripts/relay.mjs" \
     --mode "<plan|advise|review>" \
     --brief "<brief-file>"
   ```

5. Read `result.json` and `final.txt` from the output directory.
6. Treat the delegated response as advisory. Use [reviewing-the-result.md](references/reviewing-the-result.md) as optional guidance when evaluating it.
7. Keep repository edits, project commands, gates, commits, and final decisions with the orchestrator.

For a non-trivial implementation, one useful pattern is to consult `plan` before editing and `review` after the relevant project gates. Adapt or skip those steps when they do not fit the task or the project's normal development process.

Do not invoke Bifrost for trivial changes where delegation would add no useful value.

## Relay execution

The bundled relay requires Node.js 18+ regardless of the target project's programming language.

- Use `node` from the current shell when available.
- If `node` is not on `PATH`, locate an existing compatible Node.js executable and use its absolute path.
- Do not install Node.js or modify shell configuration unless the user requests it.
- If no compatible Node.js executable is available, report the delegation failure and stop.

## Project environment

The relay runtime is independent from the project runtime. A delegated task may concern PHP, Python,
Java, Node.js, or another stack.

Use the project's existing tools and development workflow only when repository inspection, validation,
or tests are needed. Do not install or reconfigure project runtimes merely to perform delegation.

## Delegation success

Treat delegation as successful only when:

- the relay exits with status `0`;
- `result.json` exists;
- the result status is `completed`.

Otherwise, report the actual failure and stop. Do not generate a substitute delegated response or claim
that the configured model was used.

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
