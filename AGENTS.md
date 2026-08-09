# Working on delegate-skills

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **delegation skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. Ten implementer skills ship today: `claude-delegate` (Claude Code),
`codex-delegate` (OpenAI Codex), `opencode-delegate` (OpenCode), `agy-delegate` (Google Antigravity),
`grok-delegate` (Grok Build), `kimi-delegate` (Kimi Code), `qoder-delegate` (Qoder CLI),
`vibe-delegate` (Mistral Vibe), `cursor-delegate` (Cursor Agent CLI), and `pi-delegate` (Pi CLI);
siblings like `gemini-delegate` can be added later without renaming the repo. One **utility** skill
ships alongside them: `delegate-setup` (configure fleet lanes — setup only, never dispatches).

## Vocabulary

One controlled vocabulary keeps the docs from drifting and stops edits (human or AI) from coining new
jargon. Use these terms; don't invent synonyms.

| Use | For | Not |
| --- | --- | --- |
| **delegate** / **delegation** | the activity, and this skill family | "relay" (as the activity), "hand-off", "offload" |
| **orchestrator** | the driving agent (Claude Code, …) | "controller", "driver" |
| **implementer** | the separate agent (Claude, Codex, OpenCode, Antigravity, Grok, Kimi, Qoder, Vibe, Cursor, Pi) | "worker", "sub-agent", "executor" |
| **brief** | the self-contained task spec sent to the implementer | "task file", "the prompt", "the spec" |
| **gates** | the project's test/lint/build commands | "checks", "CI" |
| **dispatch** | sending the brief to the implementer | "fire off", "kick off" |
| **land** | commit the verified work yourself | — |
| **relay** / `relay.mjs` | the dispatch **script** only | never a *category* of skills |
| **lane** | a named fleet binding: implementer + optional dials (`model`, `effort` / `variant`, …) | "route", "profile" |
| **fleet** | the user's set of lanes (which CLI handles which kind of work) | — |
| **setup skill** / `delegate-setup` | utility that discovers CLIs and writes the lane map after approval | a `*-delegate` skill |
| `exec`, `sandbox`, `resume`, `session` | Codex's own terms — use verbatim | don't paraphrase them |
| `run`, `agent` (`build`/`plan`), `session` | OpenCode's own terms — use verbatim | "sandbox" (OpenCode has no sandbox enum; autonomy is the agent) |
| `project`, `conversation`, `model`, `permissions`, `sandbox`, `TUI`, `tasks`, `subagents` | Antigravity's own terms — use verbatim when discussing `agy` | don't use `subagents` as a generic synonym for implementer |
| `session`, `sandbox` (`workspace`/`read-only`/`off`), `permission-mode`, `effort`, `streaming-json` | Grok Build's own terms — use verbatim when discussing `grok` | don't paraphrase them |
| `session`, `--continue`, `model alias`, `auto permission mode`, `plan mode`, `--yolo` | Kimi Code's own terms — use verbatim when discussing `kimi` | don't paraphrase them |
| `session`, `--continue`, `--resume`, `plan mode`, `--force`, `--trust`, `models` | Cursor Agent's own terms — use verbatim when discussing `cursor-agent` | don't paraphrase them |
| `session`, `--continue`, `--resume`, `permission mode` (`acceptEdits`/`plan`/`bypassPermissions`), `sandbox`, `subagents`, `agent teams`, `background sessions` | Claude Code's own terms — use verbatim when discussing Claude | never use `subagents` as a generic synonym for implementer |
| `session`, `-c`, `--resume`, `permission mode` (`default`/`accept_edits`/`auto`/`bypass_permissions`/`dont_ask`/`plan`), `print mode`, `stream-json`, `model`, `context window` | Qoder CLI's own terms — use verbatim when discussing Qoder | don't paraphrase them |
| `--prompt`, `--output` (`streaming`/`json`/`text`), `--agent` (`plan`/`accept-edits`/`auto-approve`), `--max-turns`, `--max-price`, `--max-tokens`, `--trust`, `--resume`, `--continue`, `--enabled-tools`, `--disabled-tools` | Mistral Vibe's own terms — use verbatim when discussing `vibe` | don't invent a Vibe sandbox enum; `--trust` is not a permission mode |
| `session`, `--continue`, `--session`, `print mode`, `--mode json`, `tools`, `context files`, `project trust` | Pi's own terms — use verbatim when discussing `pi` | don't paraphrase them |

Banned on sight: coined umbrella terms in user-facing surfaces (README headings, `skills.sh.json`
titles); any reference to the author's local machine or config; model/version pins (`GPT-5.x` →
version-neutral) everywhere except the README's "Verification status" list, where the exact CLI
version a run was made against is what makes the claim checkable; and claims that can't be verified
("verified" without a run → hedge or cut). Every
CLI flag, field, and command in the docs must match the installed implementer CLI (`claude` /
`codex` / `opencode` / `agy` / `grok` / `kimi` / `qodercli` / `vibe` / `cursor-agent` / `pi`) and
the skill's `relay.mjs`.

## Conventions

- **One skill per directory** under `skills/<name>/`, each with a `SKILL.md` plus optional
  `references/` and `scripts/`. Implementer skills are named `<cli>-delegate` (the verb is the repo;
  the target agent is the skill name), mirroring `guard-skills` → `clean-code-guard`.
- **Utility skills** (today: `delegate-setup`) are the exception to the implementer shape: they are
  not `<cli>-delegate`, they do not ship `scripts/relay.mjs` or the four brief/dispatch/review/queue
  references, and they never dispatch coding work. They still use Node built-ins only, no network of
  their own, no credentials, no telemetry. Document any new utility in `CONTRIBUTING.md` and register
  it in `skills.sh.json` and the smoke suite's utility carve-out.
- **`SKILL.md` frontmatter:** `name` (must equal the directory), `description`, and optionally
  `license`, `compatibility`, `metadata.version`, `allowed-tools`. The **`description` is the only
  triggering signal** — keep it to what the skill does and when to use it, phrased to trigger reliably.
  Provenance, status caveats, and how-it-works detail go in the body or here, never in the description.
  Keep `description` **under 1024 characters** — some orchestrators (e.g. ZCode) hard-cap it and reject
  the skill otherwise.
- **Package versioning:** release with an annotated git tag `vMAJOR.MINOR.PATCH` on `master`. Bump
  every skill's `metadata.version` to the same semver in that release (informational only — installers
  pin via `@v…`, not frontmatter). Wire/schema ids (`delegate-fleet.v1`, `delegate-relay.result.v1`)
  are separate; bump those only when the JSON contract breaks.
- **Progressive disclosure:** keep `SKILL.md` lean; push depth into `references/*.md` that load only
  when needed.
- **Executables:** keep them minimal and inspectable. Each `*-delegate` skill has one
  `scripts/relay.mjs`. Utility skills may ship other scripts (e.g. `discover.mjs`, `config.mjs`) under
  the same trust line: Node built-ins only, no dependencies, no network calls of their own, no
  credentials, no telemetry. The README's trust section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Smoke-test any changed script directly (e.g. `node skills/<skill>/scripts/relay.mjs --help`, and a
  no-write or read-only run against a throwaway repo) before relying on it.
- If you touch how a `relay.mjs` launches its implementer CLI, smoke-test on Windows too (native
  PowerShell/cmd, not just Git Bash/WSL): the `codex`, `opencode`, `grok`, and `pi` launches need
  `shell:true` on win32 to resolve the `.cmd` shim (which is why their spaceable args are quoted and
  value flags token-validated); the `claude` and `cursor-agent` launches serialize a pre-joined
  command string through the shell on win32 for the same shim reason; `agy`, `kimi`, current
  `qodercli`, and `vibe` installs use native binaries. Each changed launch still needs its own Windows
  smoke before claiming support. Upstream Vibe works on Windows but officially supports and targets
  UNIX; this repository's native Windows relay launch is unverified.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md` (macOS/Linux, or Windows Git
Bash/WSL). On native Windows PowerShell use `New-Item -ItemType SymbolicLink -Target AGENTS.md -Path
CLAUDE.md`, or just copy it with `cp`/`copy` if you don't need a live link.
