# Setup dialogue details

Load this when running a configure / reconfigure session. The `SKILL.md` flow is authoritative; this page expands edge cases.

## Effective map (do not dump both files)

When loading existing config:

1. Run `node <skill-dir>/scripts/config.mjs load --cwd <dir>` (use the user’s cwd, or omit `--cwd`).
2. If `globalPresent` and `projectPresent` are both false → say “No lanes configured yet.”
3. Otherwise show a **table of effective lanes** from the `lanes` object. Include a Source column (`global` / `project`).
4. If `projectPresent` is true and `projectTrusted` is false, mark project lanes untrusted and explain
   that they cannot dispatch until the user approves a project write.
5. If `projectError` is set, the project file exists but could not be read (bad JSON, wrong schema,
   not a regular file, too large). The listed lanes are global-only, and **no lane can dispatch** —
   relays fail closed here, because an unreadable project file may have been replacing the very lane
   being asked for. Report the reason, then offer to fix or remove the file and write it again.
6. Paste both raw JSON files only if the user asks.

## Scope

| User said / situation | Scope |
| --- | --- |
| “global”, “all projects”, “outside the repo/project” | `global` — do not re-ask |
| Not inside a git repository | Default `global` and say so |
| Inside a git repo, scope unspecified | Ask once: global vs this repo only |
| “this repo only” / “project” | `project` |

Never create `.delegate/config.json` merely because cwd is a git repo.

## Writing

1. Build the JSON document for **one scope only**. Start from that scope’s raw file
   (`config.mjs` paths: global or project), or `{ "version": "delegate-fleet.v1", "lanes": {} }`
   if it does not exist yet. Apply the approved edits there.
2. Do **not** write the effective merged map (stripping `source` from `load`). That would copy
   lanes across scopes: a project write would shadow global-only names, and a global write would
   promote project-only lanes everywhere. `write` replaces the chosen file wholesale.
3. Validate dials against [schema.md](schema.md) (or `config.mjs validate`).
4. Show table + full JSON again after every tweak.
5. On explicit approval, write via:

```bash
# Write the approved JSON to a uniquely named platform temp file first, then:
# global
node <skill-dir>/scripts/config.mjs write --scope global "$LANES_JSON"

# project
node <skill-dir>/scripts/config.mjs write --scope project --cwd <repo> "$LANES_JSON"
```

Use the `config.mjs write` command above so project approval is recorded correctly. Re-read with
`load` and confirm the path. A project write stores an approval hash under the worktree's
Git metadata; any later content change invalidates it and project lane dispatch fails closed until
re-approved. Remove the temp file after the write attempt, whether it succeeds or fails. Do not
hard-code `/tmp` (breaks on native Windows).

## Auth and models

- `authenticated: null` means unknown, not “logged out.”
- Prefer not binding a lane to a CLI discover reports as `authenticated: false`.
- Do not invent model ids. Use `models.values` when `status` is `reported`, or ask the user, or omit `model` when the CLI has a safe default (OpenCode does **not** — require a model for opencode lanes).

## After write

Tell the user the path and active lane names. Remind them: later, pick the `*-delegate` skill matching the lane’s `implementer` and dispatch with `--lane <name>` (explicit `--model` / `--effort` / `--variant` still win). Do not start a delegate task unless they ask.
