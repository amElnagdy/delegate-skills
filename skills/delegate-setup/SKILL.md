---
name: delegate-setup
description: >-
  Configure delegation fleet lanes: which implementer CLI handles which kind of work,
  with optional model and effort (or variant) dials. Discovers installed CLIs, proposes
  a lane map for user approval, and writes global or project config only after explicit
  yes. Use when the user asks to set up, configure, or reconfigure delegation lanes,
  a fleet of lanes, or which implementer handles feature/tests/ui work — not for
  dispatching a coding task to an implementer.
license: MIT
compatibility: Requires Node 18+. No implementer CLIs are required — the skill discovers what is available.
metadata:
  version: 0.2.0
---

# Delegate Setup

You are the **orchestrator** in **setup mode**. Discover installed implementer CLIs, propose a
**fleet of lanes**, and write configuration only after the user approves.

This skill does **not** dispatch coding work. It only authors the lane map.

One concept: **lanes**. Never say “routes.”

Example lane: **feature** → implementer `opencode`, model `opencode/grok`, variant `high`
(OpenCode uses `variant` for reasoning intensity, not `effort`).

## When NOT to use this

- The user wants a task implemented — use the matching `*-delegate` skill instead.
- A one-off model change on a single dispatch — pass `--model` / `--effort` / `--variant` on that relay.

## Hard rules

1. Every lane **must** include `implementer`.
2. Put dials on the same object (`model`, `effort` or `variant`, …) only if that implementer supports them — see [references/schema.md](references/schema.md).
3. Show a human-readable lane table **and** the full JSON before every write; re-show after every tweak.
4. Write **only** after an explicit approval (“yes”, “approve”, “write it”).
5. Ask scope unless already clear: **global** (all projects) vs **this repo only**. Never create a project file just because cwd is a git repo. If there is no git repo, default to global and say so.
6. Do not invent model identifiers.
7. Prefer 3–5 useful lanes over a kitchen-sink map.
8. Never edit `AGENTS.md`, `CLAUDE.md`, or other user agent-instruction files.
9. Never run a `*-delegate` relay from this skill.

(`<skill-dir>` is this skill’s install directory — the folder that contains this `SKILL.md`.)

## Flow

### 1. Discover

```bash
node "<skill-dir>/scripts/discover.mjs"
```

Summarize installed vs missing, auth (`true` / `false` / `null` = unknown), and whether models were
`reported`, `unsupported`, or `failed`.

### 2. Load existing (effective map)

```bash
node "<skill-dir>/scripts/config.mjs" load --cwd "$PWD"
```

- Neither present → “No lanes configured yet.”
- Otherwise → table of **effective** lanes with a Source column (`global` / `project`). Do not paste
  both raw files unless asked.
- If `projectPresent` is true and `projectTrusted` is false, label the project lanes **untrusted**.
  They cannot dispatch until the user reviews and approves a project write.
- If `projectError` is set, the project file exists but is unreadable. The map shown is global-only
  and **nothing can dispatch** until the file is fixed or removed — report the reason and offer to
  rewrite it.

Details: [references/setup-dialogue.md](references/setup-dialogue.md).

### 3. Propose

Propose a compact set of lanes from discovery + what the user cares about. Starters when useful:
`feature`, `tests`, `ui`, `fast`, `complex` — only for installed implementers.

Show:

| Lane | Implementer | Model | Effort / variant | Source (if updating) |
| --- | --- | --- | --- | --- |
| feature | opencode | opencode/grok | variant: high | — |

Then the **complete** JSON (`version`: `delegate-fleet.v1`). One line of why per lane; flag auth or
model uncertainty.

Schema and dial table: [references/schema.md](references/schema.md).

### 4. Scope

- User said global / all projects / outside the project → `global`.
- No git repo → `global` (say so).
- Else ask once: global vs this repo only.

### 5. Approve and write

On explicit yes, write **only** the chosen scope (validate first). Build the payload from that
scope’s raw file (or an empty `lanes` object if new) — not from the effective merged `load` view,
or a project write will shadow global-only lanes and a global write will promote project-only ones.

Create a uniquely named file under the platform temporary directory (`$TMPDIR`, `%TEMP%`, or Node
`os.tmpdir()`), write the **exact approved JSON** into it with the orchestrator's file-writing tool,
and use that populated path as `<lanes-json>` below. Never validate an empty temp file. Remove the
temp file after the validation/write attempt, whether it succeeds or fails.

```bash
node "<skill-dir>/scripts/config.mjs" validate "<lanes-json>"
node "<skill-dir>/scripts/config.mjs" write --scope global "<lanes-json>"
# or:  write --scope project --cwd /path/to/repo "<lanes-json>"
```

Confirm the path written and the active lane names. Project writes bind approval to the exact config
content; later changes fail closed until re-approved. On update, a short before/after is enough.

### 6. Ready to delegate

Stop after confirming. Tell the user the map is ready. For later work: read the lane’s
`implementer`, load that `*-delegate` skill, and dispatch with `--lane <name>` (explicit
`--model` / `--effort` / `--variant` still win when passed). Do not start a delegate task
unless they ask.

## Reconfigure

Same flow. Show the effective current map, propose changes, approve, write one scope’s file.
Reinstalling the skills package must not rewrite these files — they live outside the package.
