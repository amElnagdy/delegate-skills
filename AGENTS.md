# Working on delegate-skills

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **delegation skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. Three skills ship today: `codex-delegate` (OpenAI Codex), `opencode-delegate`
(OpenCode), and `kimi-delegate` (Kimi Code); siblings like `gemini-delegate` can be added later without
renaming the repo.

## Vocabulary

One controlled vocabulary keeps the docs from drifting and stops edits (human or AI) from coining new
jargon. Use these terms; don't invent synonyms.

| Use | For | Not |
| --- | --- | --- |
| **delegate** / **delegation** | the activity, and this skill family | "relay" (as the activity), "hand-off", "offload" |
| **orchestrator** | the driving agent (Claude Code, …) | "controller", "driver" |
| **implementer** | the worker agent (Codex, OpenCode, Kimi) | "worker", "sub-agent", "executor" |
| **brief** | the self-contained task spec sent to the implementer | "task file", "the prompt", "the spec" |
| **gates** | the project's test/lint/build commands | "checks", "CI" |
| **dispatch** | sending the brief to the implementer | "fire off", "kick off" |
| **land** | commit the verified work yourself | — |
| **relay** / `relay.mjs` | the dispatch **script** only | never a *category* of skills |
| `exec`, `sandbox`, `resume`, `session` | Codex's own terms — use verbatim | don't paraphrase them |
| `run`, `agent` (`build`/`plan`), `session` | OpenCode's own terms — use verbatim | "sandbox" (OpenCode has no sandbox enum; autonomy is the agent) |
| `session`, `--continue`, `model alias`, `auto permission mode`, `plan mode`, `--yolo` | Kimi Code's own terms — use verbatim when discussing `kimi` | don't paraphrase them |

Banned on sight: coined umbrella terms in user-facing surfaces (README headings, `skills.sh.json`
titles); any reference to the author's local machine or config; model/version pins (`GPT-5.x` →
version-neutral); and claims that can't be verified ("verified" without a run → hedge or cut). Every
CLI flag, field, and command in the docs must match the installed implementer CLI (`codex` /
`opencode` / `kimi`) and the skill's `relay.mjs`.

## Conventions

- **One skill per directory** under `skills/<name>/`, each with a `SKILL.md` plus optional
  `references/` and `scripts/`. The verb is the repo (`delegate`); the target agent is the skill name
  (`codex-delegate`), mirroring `guard-skills` → `clean-code-guard`.
- **`SKILL.md` frontmatter:** `name` (must equal the directory), `description`, and optionally
  `license`, `compatibility`, `metadata.version`, `allowed-tools`. The **`description` is the only
  triggering signal** — keep it to what the skill does and when to use it, phrased to trigger reliably.
  Provenance, status caveats, and how-it-works detail go in the body or here, never in the description.
  Keep `description` **under 1024 characters** — some orchestrators (e.g. ZCode) hard-cap it and reject
  the skill otherwise.
- **Progressive disclosure:** keep `SKILL.md` lean; push depth into `references/*.md` that load only
  when needed.
- **Executables:** keep them minimal and inspectable. Today there is one per skill —
  `skills/codex-delegate/scripts/relay.mjs`, `skills/opencode-delegate/scripts/relay.mjs`, and
  `skills/kimi-delegate/scripts/relay.mjs` — each Node built-ins only, no dependencies, no network
  calls of its own, no credentials, no telemetry. New scripts must hold the same line, and the README's
  trust section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Smoke-test any changed script directly (e.g. `node skills/<skill>/scripts/relay.mjs --help`, and a
  no-write or read-only run against a throwaway repo) before relying on it.
- If you touch how a `relay.mjs` launches its implementer CLI, smoke-test on Windows too (native
  PowerShell/cmd, not just Git Bash/WSL): both the `codex` and `opencode` launches need `shell:true` on
  win32 to resolve the `.cmd` shim; `kimi` uses a native binary and still needs its own native Windows
  smoke before claiming support.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md` (macOS/Linux, or Windows Git
Bash/WSL). On native Windows PowerShell use `New-Item -ItemType SymbolicLink -Target AGENTS.md -Path
CLAUDE.md`, or just copy it with `cp`/`copy` if you don't need a live link.
