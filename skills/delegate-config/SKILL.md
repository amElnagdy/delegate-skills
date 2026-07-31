---
name: delegate-config
description: >-
  Configure default settings and task-specific model routes for delegate skills.
  Discovers installed implementer CLIs, authentication, and reported models, then
  proposes a configuration for frontend, backend, fast, medium, complex, or other
  task types for the user to approve or adjust before writing. Use when the user
  asks to configure delegation models, routing, or preferences, or before the
  first delegation when no config exists.
license: MIT
compatibility: Requires Node 18+. No implementer CLIs are required — the skill discovers what is available.
metadata:
  version: 0.2.0
---

# Delegate Config

You are the **orchestrator**. Discover the available implementer CLIs, propose task-specific model
routes, and write configuration only after the user approves or adjusts the proposal.

This utility does not dispatch work to an implementer. It configures how later delegation runs select
models and other defaults.

## Trigger

Use this skill when the user:

- asks to configure delegation models, task routes, or preferences;
- asks which implementer CLIs or models are available; or
- is about to delegate for the first time and neither project nor global config exists.

For the last case, suggest configuration without forcing it.

Do not use this skill for a one-off model change. Pass `--model` directly to that relay instead.

## Configuration flow

### 1. Discover implementers

Run:

```bash
node <skill-path>/scripts/discover.mjs
```

The report includes installed binaries, versions, paths, authentication when a bounded headless probe
exists, supported config fields, and model reporting:

- `reported` — the CLI returned model identifiers;
- `unsupported` — the CLI has no bounded model-list command used by this skill;
- `failed` — a supported model probe failed or timed out.

Treat `authenticated: null` as unknown, not unauthenticated. A reported model catalog can include
models for providers the user has not authenticated with.

### 2. Load existing configuration

Check:

1. the Git repository root at `.delegate/config.json`;
2. `~/.config/delegate-skills/config.json`.

Relays also support the earlier `delegate-config.v1` single-default shape. New or updated
configuration uses `delegate-config.v2`.

### 3. Propose routes

Use the discovered models and the user's stated work to propose a compact set of routes. Start with
routes that are useful now, commonly:

- `frontend`
- `backend`
- `fast`
- `medium`
- `complex`

Add a combined route such as `frontend-complex` only when it needs settings different from both
existing routes. Route names are user-owned and may describe other task types.

For each route, show:

- implementer and model;
- effort or equivalent setting when supported;
- why the route fits that task type;
- any uncertainty, such as unknown authentication or a model catalog that may include unavailable
  providers.

Do not invent unavailable model identifiers. If the CLI cannot report models, use the CLI's current
default or ask the user for a model identifier.

### 4. Ask for approval

Present the complete proposed JSON before writing. Ask the user to approve it or name adjustments.
Do not create or overwrite a config file until approval is explicit.

### 5. Choose scope

Ask whether to save:

- for the current repository at `.delegate/config.json`; or
- globally at `~/.config/delegate-skills/config.json`.

### 6. Write and confirm

Create parent directories as needed, write JSON atomically, re-read it, and show:

- the path written;
- the diff when updating a file;
- the routes and defaults now configured.

## Version 2 schema

Each implementer can have shared `defaults` plus named `routes`.

```json
{
  "version": "delegate-config.v2",
  "implementers": {
    "codex": {
      "defaults": {
        "sandbox": "workspace-write",
        "timeout": "30m"
      },
      "routes": {
        "frontend": {
          "model": "provider/frontend-model",
          "effort": "medium"
        },
        "backend": {
          "model": "provider/backend-model",
          "effort": "medium"
        },
        "fast": {
          "model": "provider/fast-model",
          "effort": "low"
        },
        "complex": {
          "model": "provider/complex-model",
          "effort": "high"
        }
      }
    }
  }
}
```

All settings are optional. Use duration strings such as `90s`, `30m`, or `2h`. For version 1
compatibility, positive integer timeouts are interpreted as seconds. Qoder's version 1 `sandbox`
field is read as `permissionMode`; new configuration uses `permissionMode`.

Dispatch a configured route with:

```bash
node <delegate-skill-path>/scripts/relay.mjs --route frontend --brief <brief-file> --cd <repo>
```

An explicit `--model`, `--timeout`, or permission flag still wins over route configuration.

## Per-field precedence

Relays resolve each field independently:

1. explicit relay flag;
2. project route;
3. project implementer defaults;
4. global route;
5. global implementer defaults;
6. implementer CLI default.

Project config is located from the Git repository root even when `--cd` names a subdirectory.
Selecting a route that exists nowhere is an error rather than a silent fallback.

## Supported fields

| Implementer key | Skill | Supported config fields |
| --- | --- | --- |
| `claude` | claude-delegate | model, effort, timeout, readOnly |
| `codex` | codex-delegate | model, sandbox, effort, timeout, readOnly |
| `opencode` | opencode-delegate | model, timeout, readOnly |
| `agy` | agy-delegate | model, timeout |
| `grok` | grok-delegate | model, sandbox, effort, timeout, readOnly |
| `kimi` | kimi-delegate | model, timeout |
| `qodercli` | qoder-delegate | model, permissionMode, timeout, readOnly |
| `vibe` | vibe-delegate | timeout, readOnly |
| `cursor-agent` | cursor-delegate | model, sandbox, force, timeout, readOnly |
| `pi` | pi-delegate | provider, model, timeout, readOnly |

Fields unsupported by an implementer are configuration errors. Dangerous permission bypasses remain
explicit relay flags and are not configurable defaults.
