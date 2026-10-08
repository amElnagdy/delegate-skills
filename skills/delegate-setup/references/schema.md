# Fleet schema (`delegate-fleet.v1`)

One concept: **lanes**. A lane names an implementer and optional dials. A global config can also
carry **per-orchestrator fleets**: the same lane shape, scoped to one orchestrator agent.

## Document

```json
{
  "version": "delegate-fleet.v1",
  "lanes": {
    "feature": {
      "implementer": "opencode",
      "model": "opencode/grok",
      "variant": "high"
    },
    "tests": {
      "implementer": "grok",
      "effort": "medium"
    },
    "complex": {
      "implementer": "claude",
      "effort": "high"
    }
  }
}
```

- `version` must be `delegate-fleet.v1`.
- `lanes` is an object keyed by lane name (`[A-Za-z0-9][A-Za-z0-9._-]*`) and is always required —
  shared lanes remain the plain fleet even when per-orchestrator fleets exist.
- Every lane **requires** `implementer` (a key from the registry below).
- Other fields are dials; only dials listed for that implementer are allowed.

## Per-orchestrator fleets (`agents`, global scope only)

The global config may also carry a top-level `agents` object keyed by an **orchestrator identity** —
a free label for the seat that dispatches (the orchestrating agent's name, e.g. `claude`, `cursor`,
or any custom name like `main` or `review-ide`). An identity is **not** an implementer key, and it
must never be derived from one; each fleet entry holds its own `lanes` object in the same shape:

```json
{
  "version": "delegate-fleet.v1",
  "lanes": {
    "feature": { "implementer": "opencode", "model": "opencode/grok", "variant": "high" }
  },
  "agents": {
    "claude": {
      "lanes": {
        "feature": { "implementer": "claude", "effort": "high" }
      }
    }
  }
}
```

Identity names follow the lane-name shape (`[A-Za-z0-9][A-Za-z0-9._-]*`) so a selector can never
smuggle shell or path syntax. Only `lanes` is allowed inside an agent entry — other fields fail
validation, so future schema additions are always explicit rather than silent. Because whole-lane
replacement applies at every layer, an agent fleet lane replaces the same-name shared lane
**wholesale** (dials never merge across layers).

Precedence for the same lane name, highest first:

| # | Layer |
| --- | --- |
| 1 | project `.delegate/config.json` `lanes` (trusted at dispatch only) |
| 2 | global `agents[<identity>].lanes` |
| 3 | shared global `lanes` |

Agent-only lanes (absent from the shared `lanes`) are invisible to dispatches that pass no
orchestrator identity — the resolver reports the exact selectors that could reach them.

**Selectors** (fail closed; both are validated, `--agent` wins):

- `--agent <identity>` on `config.mjs load` and `lane.mjs resolve`.
- Otherwise, when the flag is absent, `DELEGATE_ORCHESTRATOR` if non-empty. Relays pass their
  environment through to lane resolution, so export the variable per seat (e.g.
  `DELEGATE_ORCHESTRATOR=claude node relay.mjs --lane feature …`).
- When a lane is overridden by any agent fleet, dispatch without a selector fails instead of
  silently using the shared lane. Set `DELEGATE_ORCHESTRATOR=__shared__` to deliberately choose
  that shared lane; the reserved value cannot be used as an agent identity. A `load` without a
  selector still previews shared lanes.
- A selector naming an identity with no `agents` fleet exits 2 rather than silently applying the
  shared fleet — the shared fleet surprising the dispatcher is exactly what per-orchestrator lanes
  prevent.

Agents stay **global-only**: a `write --scope project` payload containing `agents` is refused, and
an `agents` key inside a project file fails load and resolution. Tradeoff: one fleet is
project-scoped and shared by every seat; differentiating by seat is a global config concern. This
keeps project trust (one approved hash per repo) free of identity algebra.

## Paths

| Scope | Path |
| --- | --- |
| Global | `$XDG_CONFIG_HOME/delegate-skills/config.json` when `XDG_CONFIG_HOME` is set; otherwise `~/.config/delegate-skills/config.json` (`os.homedir()` → `HOME` / `USERPROFILE`) |
| Project | `<git-root>/.delegate/config.json` |

Project overlays global by **whole-lane replace** (same lane name in project fully replaces the global lane).
Relays apply a project lane only when its exact config content matches the approval hash written under
that worktree's Git metadata by an explicitly approved `config.mjs write --scope project`. Cloned or
later-edited project config fails closed until it is reviewed and written again through `delegate-setup`.

## Implementer keys and dials

| Key | Skill | Binary | Supported dials |
| --- | --- | --- | --- |
| `claude` | claude-delegate | `claude` | model, effort, timeout, readOnly |
| `cline` | cline-delegate | `cline` | provider, model, timeout |
| `codex` | codex-delegate | `codex` | model, effort, sandbox, timeout, readOnly |
| `commandcode` | commandcode-delegate | `cmd` | model, effort, timeout, readOnly |
| `opencode` | opencode-delegate | `opencode` | model, **variant**, timeout, readOnly |
| `agy` | agy-delegate | `agy` | model, effort, timeout, readOnly |
| `grok` | grok-delegate | `grok` | model, effort, sandbox, timeout, readOnly |
| `kimi` | kimi-delegate | `kimi` | model, timeout |
| `qoder` | qoder-delegate | `qodercli` | model, permissionMode, timeout, readOnly |
| `vibe` | vibe-delegate | `vibe` | timeout, readOnly |
| `cursor` | cursor-delegate | `cursor-agent` | model, force, timeout, readOnly |
| `pi` | pi-delegate | `pi` | provider, model, timeout, readOnly |
| `omp` | omp-delegate | `omp` | provider, model, **effort** (`--thinking`), timeout, readOnly |
| `aider` | aider-delegate | `aider` | model, timeout, readOnly |
| `copilot` | copilot-delegate | `copilot` | model, effort, timeout, readOnly |
| `warp` | warp-delegate | `oz` | model, timeout |
| `zcode` | zcode-delegate | `zcode` | permissionMode, timeout, readOnly |

ZCode carries its `--mode` as `permissionMode`, and only `plan` and `yolo` are accepted: ZCode also
documents `build` and `edit`, but a headless run has no permission client, so those two block every
write tool and exit 0 having changed nothing. ZCode has no `--model` flag — the model is chosen in
the CLI's own config file — so `model` is not a dial for `zcode` lanes. ZCode also ships its CLI
inside the desktop app rather than on PATH, so discovery falls back to the installed app bundle.

OpenCode uses `variant` for reasoning intensity, not `effort`. Do not write `effort` on an `opencode` lane.
Oh My Pi (`omp`) uses the lane `effort` dial for omp's `--thinking` (`off`, `auto`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Do not write `thinking` as a lane field.
OpenCode lanes **require** `model` in `provider/model` form, with a non-empty provider before the first
`/` and at least one non-`/` character after it. Cline accepts `provider` and `model` as separate
dials and does not impose that shape.

Boolean dials: `readOnly`, `force`. All other dials are non-empty strings. Duration strings for
`timeout` use `h`/`m`/`s` (e.g. `30m`) and must fit the relay watchdog ceiling (~24.8 days).
Do not combine `readOnly: true` with a write-capable `sandbox` / `permissionMode` / `force`.
`model` / `provider` / OpenCode `variant` must match the bound relay’s token rules (e.g. Claude
rejects spaces; Grok/Pi/Oh My Pi/OpenCode/Codex/Command Code use a shell-safe token set — Windows `shell:true`
launches, and Oh My Pi's flag-injection defense even without a shell).

## Helpers

```bash
node <skill-dir>/scripts/discover.mjs
node <skill-dir>/scripts/config.mjs load [--cwd <dir>] [--agent <identity>]
node <skill-dir>/scripts/config.mjs validate <file>
node <skill-dir>/scripts/config.mjs write --scope global|project [--cwd <dir>] [--allow-agent-removal] <file>
node <skill-dir>/scripts/lane.mjs resolve --cwd <dir> --lane <name> --implementer <key> [--agent <identity>]
```

`load` prints the **effective** map (each lane includes a `source` of `global` or `project` — the
agent overlay stays inside `global` scope), `projectTrusted`, which reports whether the current
project content matches its local approval hash, and `agentFleets`, the orchestrator identities with
a fleet in the global config. With a selector, `agent` echoes the identity the lanes were resolved
for. Without one, `agent` is `null` and every agent-only lane is hidden: existing callers get the
same map as before `agents` existed. `config.mjs write` keeps replacing the whole document for a
scope, so a per-orchestrator write includes every fleet that should survive.
Global writes refuse to remove existing agent fleets unless `--allow-agent-removal` is supplied
after explicit user approval; read the raw global config first when updating shared lanes.
`lane.mjs resolve` is what `*-delegate` relays call for `--lane`: it fails loud on a missing lane,
untrusted project config, or implementer mismatch, and prints relay-native dials (e.g. grok
`sandbox` → `autonomy`). An invalid or unconfigured `--agent` / `DELEGATE_ORCHESTRATOR` also fails
loud there, and relays surface the same error before their implementer starts.
