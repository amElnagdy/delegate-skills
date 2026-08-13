# Working on delegate-skills

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **delegation skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. Twelve implementer skills ship today: `claude-delegate` (Claude Code),
`cline-delegate` (Cline CLI), `codex-delegate` (OpenAI Codex), `opencode-delegate` (OpenCode),
`agy-delegate` (Google Antigravity), `grok-delegate` (Grok Build), `kimi-delegate` (Kimi Code),
`qoder-delegate` (Qoder CLI), `vibe-delegate` (Mistral Vibe), `cursor-delegate` (Cursor Agent CLI),
`pi-delegate` (Pi CLI), and `aider-delegate` (Aider); siblings like `gemini-delegate` can be added
later without renaming the repo. One **utility** skill
ships alongside them: `delegate-setup` (configure fleet lanes — setup only, never dispatches).

## Vocabulary

One controlled vocabulary keeps the docs from drifting and stops edits (human or AI) from coining new
jargon. Use these terms; don't invent synonyms.

| Use | For | Not |
| --- | --- | --- |
| **delegate** / **delegation** | the activity, and this skill family | "relay" (as the activity), "hand-off", "offload" |
| **orchestrator** | the driving agent (Claude Code, …) | "controller", "driver" |
| **implementer** | the separate agent (Claude, Cline, Codex, OpenCode, Antigravity, Grok, Kimi, Qoder, Vibe, Cursor, Pi, Aider) | "worker", "sub-agent", "executor" |
| **brief** | the self-contained task spec sent to the implementer | "task file", "the prompt", "the spec" |
| **gates** | the project's test/lint/build commands | "checks", "CI" |
| **dispatch** | sending the brief to the implementer | "fire off", "kick off" |
| **land** | commit the verified work yourself | — |
| **relay** / `relay.mjs` | the dispatch **script** only | never a *category* of skills |
| **usage limit** | the provider-imposed quota or rate cap that ends a run through no fault of the brief | "budget", "credits", "out of tokens" |
| **capture bundle** | the committed fixture proving a CLI's usage-limit signature, with its provenance | "sample", "fixture" (bare) |
| **lane** | a named fleet binding: implementer + optional dials (`model`, `effort` / `variant`, …) | "route", "profile" |
| **fleet** | the user's set of lanes (which CLI handles which kind of work) | — |
| **setup skill** / `delegate-setup` | utility that discovers CLIs and writes the lane map after approval | a `*-delegate` skill |
| `exec`, `sandbox`, `resume`, `session` | Codex's own terms — use verbatim | don't paraphrase them |
| `run`, `agent` (`build`/`plan`), `session` | OpenCode's own terms — use verbatim | "sandbox" (OpenCode has no sandbox enum; autonomy is the agent) |
| `project`, `conversation`, `model`, `permissions`, `sandbox`, `TUI`, `tasks`, `subagents` | Antigravity's own terms — use verbatim when discussing `agy` | don't use `subagents` as a generic synonym for implementer |
| `session`, `sandbox` (`workspace`/`read-only`/`off`), `permission-mode`, `effort`, `streaming-json` | Grok Build's own terms — use verbatim when discussing `grok` | don't paraphrase them |
| `session`, `--continue`, `model alias`, `auto permission mode`, `plan mode`, `--yolo` | Kimi Code's own terms — use verbatim when discussing `kimi` | don't paraphrase them |
| `session`, `--continue`, `--resume`, `plan mode`, `--force`, `--sandbox` (`enabled`/`disabled`), `--trust`, `models` | Cursor Agent's own terms — use verbatim when discussing `cursor-agent` | don't paraphrase them |
| `session`, `--continue`, `--resume`, `permission mode` (`acceptEdits`/`plan`/`bypassPermissions`), `sandbox`, `subagents`, `agent teams`, `background sessions` | Claude Code's own terms — use verbatim when discussing Claude | never use `subagents` as a generic synonym for implementer |
| `session`, `--json`, `-v` (verbose), `--auto-approve`, `--cwd`, `--model`, `--provider`, `--id` (unsupported by the JSON relay), `--plan`, `--data-dir` / `CLINE_SANDBOX` (sandbox), `-t`/`--timeout` (CLI's own flag) | Cline's own terms — use verbatim when discussing `cline`. The relay's `--timeout` watchdog is a different flag with the same spelling | don't invent a Cline permission-mode enum |
| `session`, `-c`, `--resume`, `permission mode` (`default`/`accept_edits`/`auto`/`bypass_permissions`/`dont_ask`/`plan`), `print mode`, `stream-json`, `model`, `context window` | Qoder CLI's own terms — use verbatim when discussing Qoder | don't paraphrase them |
| `--prompt`, `--output` (`streaming`/`json`/`text`), `--agent` (`plan`/`accept-edits`/`auto-approve`), `--max-turns`, `--max-price`, `--max-tokens`, `--trust`, `--resume`, `--continue`, `--enabled-tools`, `--disabled-tools` | Mistral Vibe's own terms — use verbatim when discussing `vibe` | don't invent a Vibe sandbox enum; `--trust` is not a permission mode |
| `session`, `--continue`, `--session`, `print mode`, `--mode json`, `tools`, `context files`, `project trust` | Pi's own terms — use verbatim when discussing `pi` | don't paraphrase them |
| `--message-file`, `--yes-always`, `--suggest-shell-commands`, `--auto-commits`/`--dirty-commits`, `--dry-run`, `--edit-format`, `--architect`, `--file`/`--read`, `chat history` | Aider's own terms — use verbatim when discussing `aider` | Aider has no sandbox, no permission modes, and no session ids; don't imply any. `--file`/`--read` scope the chat context — never call them a boundary |

Banned on sight: coined umbrella terms in user-facing surfaces (README headings, `skills.sh.json`
titles); any reference to the author's local machine or config; model/version pins (`GPT-5.x` →
version-neutral) everywhere except the README's "Verification status" list, where the exact CLI
version a run was made against is what makes the claim checkable; and claims that can't be verified
("verified" without a run → hedge or cut). Every
CLI flag, field, and command in the docs must match the installed implementer CLI (`claude` /
`cline` / `codex` / `opencode` / `agy` / `grok` / `kimi` / `qodercli` / `vibe` / `cursor-agent` / `pi` /
`aider`) and the skill's `relay.mjs`.

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
- **Result contract:** [`docs/relay-result-contract.md`](docs/relay-result-contract.md) is the source
  of truth for `delegate-relay.result.v1` — the closed `status` set, the additive `failureClass` /
  `limit` fields, the fail-closed classification rule, and the outcome-precedence table. Each skill's
  `dispatch-and-poll.md` restates what its users need (skills install standalone and cannot depend on
  a repo-level doc); when the two disagree, the canonical doc is right. **`status` is a closed enum —
  adding a value is a breaking change requiring `delegate-relay.result.v2`.** Express new outcome
  detail as additive optional fields instead.
- **Usage-limit evidence:** a relay may set `failureClass: "usage_limit"` on exactly two evidence
  paths, and on nothing else.
  - *Terminal-event matchers* — reading a limit out of the CLI's own terminal failure. These
    require a committed capture bundle under `test/fixtures/usage-limit/<cli>.json` recording the
    signature, the transport it appears in, the CLI version, and its provenance (`live-captured`,
    or version-pinned source of the real transport — never prose docs alone). No bundle → no
    matcher → that relay keeps reporting an unclassified `failed`, and the README says so. Never
    add an unverified code or message to a signature table: a false classification tells the
    orchestrator not to investigate a real bug. Relays enrolled here must pass the shared matrix
    in `test/relay/usage-limit.mjs`.
  - *Preflight exhaustion* — a CLI with a verified headless quota query (today only `agy`, whose
    `/usage` reply is structured data, not an error message) may refuse to dispatch when that
    query reports every bucket exhausted. The query's own reply is the evidence, so no
    terminal-error capture bundle applies; the requirement instead is that the query is verified
    to spend nothing, the raw reply is written to the out-dir and named by `evidence.source`, and
    only total exhaustion blocks. A probe that fails, times out, or returns an unfamiliar shape
    must never block a dispatch. Coverage lives with that relay's own suite, not the shared matrix,
    because nothing was dispatched to compare.

  Both paths obey the same fail-closed rule: ambiguous evidence stays an unclassified `failed`.
- **Executables:** keep them minimal and inspectable. Each `*-delegate` skill has one
  `scripts/relay.mjs`. Utility skills may ship other scripts (e.g. `discover.mjs`, `config.mjs`) under
  the same trust line: Node built-ins only, no dependencies, no network calls of their own, no
  credentials, no telemetry. The README's trust section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Smoke-test any changed script directly (e.g. `node skills/<skill>/scripts/relay.mjs --help`, and a
  no-write or read-only run against a throwaway repo) before relying on it.
- If you touch how a `relay.mjs` launches its implementer CLI, smoke-test on Windows too (native
  PowerShell/cmd, not just Git Bash/WSL): the `codex`, `opencode`, `grok`, `pi`, and `cline` launches
  need `shell:true` on win32 to resolve the `.cmd` shim. Cline streams its brief on stdin and uses the
  child process cwd; the other launches quote spaceable args, and all value flags are token-validated.
  The `claude` and `cursor-agent` launches serialize a pre-joined
  command string through the shell on win32 for the same shim reason; `agy`, `kimi`, current
  `qodercli`, `vibe`, and `aider` installs use native binaries (pip puts a real `aider.exe` in
  Scripts, so that launch needs no `shell:true`). Each changed launch still needs its own Windows
  smoke before claiming support. Upstream Vibe works on Windows but officially supports and targets
  UNIX; this repository's native Windows Cline stdin launch and Vibe relay launch are unverified.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md` (macOS/Linux, or Windows Git
Bash/WSL). On native Windows PowerShell use `New-Item -ItemType SymbolicLink -Target AGENTS.md -Path
CLAUDE.md`, or just copy it with `cp`/`copy` if you don't need a live link.
