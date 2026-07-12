# Working on delegate-skills

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **delegation skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. Four skills ship today: `codex-delegate` (OpenAI Codex), `opencode-delegate`
(OpenCode), `cursor-delegate` (Cursor CLI), and `antigravity-delegate` (Google Antigravity CLI);
siblings like `gemini-delegate` can be added later without renaming the repo.

## Vocabulary

One controlled vocabulary keeps the docs from drifting and stops edits (human or AI) from coining new
jargon. Use these terms; don't invent synonyms.

| Use | For | Not |
| --- | --- | --- |
| **delegate** / **delegation** | the activity, and this skill family | "relay" (as the activity), "hand-off", "offload" |
| **orchestrator** | the driving agent (Claude Code, …) | "controller", "driver" |
| **implementer** | the worker agent (Codex, OpenCode, Cursor, Antigravity) | "worker", "sub-agent", "executor" |
| **brief** | the self-contained task spec sent to the implementer | "task file", "the prompt", "the spec" |
| **gates** | the project's test/lint/build commands | "checks", "CI" |
| **dispatch** | sending the brief to the implementer | "fire off", "kick off" |
| **land** | commit the verified work yourself | — |
| **relay** / `relay.mjs` | the dispatch **script** only | never a *category* of skills |
| `exec`, `sandbox`, `resume`, `session` | Codex's own terms — use verbatim | don't paraphrase them |
| `run`, `agent` (`build`/`plan`), `session` | OpenCode's own terms — use verbatim | "sandbox" (OpenCode has no sandbox enum; autonomy is the agent) |
| `--print`, `--force`, `--trust`, `--mode` (`plan`/`ask`), `session` | Cursor CLI's own terms — use verbatim; the binary is `cursor-agent` | "yolo" (an alias; docs use `--force`) |
| `--print`, `--add-dir`, `workspace`, `conversation`, `--dangerously-skip-permissions` | Antigravity CLI's own terms — use verbatim; the binary is `agy` | "session" (agy's term is conversation); any claim that `--mode plan` is read-only (verified: it is not enforced) |

Banned on sight: coined umbrella terms in user-facing surfaces (README headings, `skills.sh.json`
titles); any reference to the author's local machine or config; model/version pins (`GPT-5.x` →
version-neutral); and claims that can't be verified ("verified" without a run → hedge or cut). Every
CLI flag, field, and command in the docs must match the installed implementer CLI (`codex` /
`opencode`) and the skill's `relay.mjs`.

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
- **Executables:** keep them minimal and inspectable. Today there is one per skill — each skill's
  `scripts/relay.mjs` — each Node built-ins only, no dependencies, no network calls of its own, no
  credentials, no telemetry. (The `antigravity-delegate` relay additionally reads agy's local
  conversation-id cache; any such read must be disclosed in the relay header and the README's trust
  section.) New scripts must hold the same line, and the README's trust section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Smoke-test any changed script directly (e.g. `node skills/<skill>/scripts/relay.mjs --help`, and a
  `--read-only` run against a throwaway repo) before relying on it.
- If you touch how a `relay.mjs` launches its implementer CLI, smoke-test on Windows too (native
  PowerShell/cmd, not just Git Bash/WSL): the `codex` and `opencode` launches need `shell:true` on
  win32 to resolve the `.cmd` shim, and the `cursor-agent` launch keeps `shell:true` on win32 too (its
  official installer ships a real binary, but the flag also resolves any shim-wrapped install; its argv
  is guarded against whitespace on win32 for that reason). The `agy` launch must **never** get
  `shell:true` — the brief travels in argv (agy takes the prompt as the `--print` value, not on
  stdin), and agy is a real native binary on every platform.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md` (macOS/Linux, or Windows Git
Bash/WSL). On native Windows PowerShell use `New-Item -ItemType SymbolicLink -Target AGENTS.md -Path
CLAUDE.md`, or just copy it with `cp`/`copy` if you don't need a live link.
