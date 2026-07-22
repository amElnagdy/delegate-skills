# delegate-skills

[![skills.sh](https://skills.sh/b/amElnagdy/delegate-skills)](https://skills.sh/amElnagdy/delegate-skills)

Skills for **delegating coding work to a separate CLI agent and landing it yourself**. Your agent (the
orchestrator) writes a self-contained brief, hands it to an implementer CLI, then reviews the diff and
commits — staying the reviewer the whole way.

Six skills ship today — same loop, different implementer:

| Skill | Drives | Autonomy | Resume |
| --- | --- | --- | --- |
| `codex-delegate` | [OpenAI Codex CLI](https://github.com/openai/codex) | Codex `--sandbox` enum (`workspace-write` default) | `--resume-last` |
| `opencode-delegate` | [OpenCode CLI](https://opencode.ai) | agent: `build` (write) / `plan` (read-only) | `--resume-last`, `--session <id>` |
| `agy-delegate` | Google Antigravity CLI (`agy`) | Antigravity's own permission policy; bypass is opt-in | `--resume-last`, `--conversation <id>` |
| `grok-delegate` | Grok Build CLI (`grok`) | explicit: default workspace-scoped, `--read-only` best-effort with violation detection, `--full-access` opt-in | `--resume-last`, `--session <id>` |
| `kimi-delegate` | Kimi Code CLI (`kimi`) | headless runs always use Kimi's auto permission mode | `--resume-last`, `--session <id>` |
| `vibe-delegate` | [Mistral Vibe CLI](https://github.com/mistralai/mistral-vibe) (`vibe`) | `auto-approve` agent by default; `--plan-only` uses `plan` agent (best-effort read-only) | `--resume-last`, `--session <id>` |

## Install

Browse first:

```bash
npx skills add amElnagdy/delegate-skills --list
```

Install the package, or just one skill (any name from the table above):

```bash
npx skills add amElnagdy/delegate-skills
npx skills add amElnagdy/delegate-skills --skill codex-delegate
```

Install for a specific agent, or globally:

```bash
npx skills add amElnagdy/delegate-skills --skill codex-delegate --agent claude-code
npx skills add amElnagdy/delegate-skills --global
```

Works with any orchestrating agent the [Skills CLI](https://github.com/vercel-labs/skills) supports.

## What it does

The loop:

1. **Write a brief** — a self-contained task spec; the implementer sees only what you send.
2. **Dispatch** it with the bundled `relay.mjs`.
3. **Wait** for completion — the helper writes a structured `result.json`.
4. **Review** the diff — re-run the project's gates yourself; pair with [guard skills](https://github.com/amElnagdy/guard-skills).
5. **Land** it — *you* commit, because committing belongs to the reviewer.

```text
Use $codex-delegate to have Codex implement the refactor in services/billing/, then review and commit it.
Use $kimi-delegate to have Kimi implement the UI cleanup, then review and commit it.
Use $codex-delegate to run this queue of migration tasks through Codex while I review each one.
```

Every relay speaks the same `delegate-relay.result.v1` contract: `status`, `exitCode`, `signal`
(with a host-killed hint when the OOM killer ends a run), the implementer's own final report,
`touchedFiles`, and a session/conversation id for delta briefs. Learn the loop once, swap the
implementer freely.

## The skills

### codex-delegate

Drive the OpenAI Codex CLI as a background implementer. Ships four references (writing the brief,
dispatch/poll, review/land, multi-task queues) loaded only when needed, and one small helper script.

**You'll feel it when:** a bounded task — a migration, a mechanical refactor, a removal sweep — gets
handed to Codex, comes back as a clean diff with a structured report, and you commit it after re-running
the gates yourself instead of typing it all by hand.

### opencode-delegate

Same loop for the OpenCode CLI. Autonomy is set by the **agent** rather than a sandbox enum — `build`
(write-capable) by default, `plan` (read-only) for review/diagnosis — and the brief is piped to
`opencode run` on stdin so multi-line XML briefs need no quoting. `--model` is required: OpenCode has
no safe default, so you name a model you actually pay for.

### agy-delegate

Same loop for the Google Antigravity CLI (`agy`). Fresh runs start a new Antigravity project and
explicitly add the target repo as the workspace; Antigravity's permission bypass
(`--dangerously-skip-permissions`) is opt-in, never the default, and combining it with `--sandbox`
must be treated as full access.

### grok-delegate

Same loop for the Grok Build CLI. Autonomy is always set explicitly because Grok's headless default
would hang a pipe: workspace-scoped by default, `--full-access` as the opt-in, and `--read-only` as
**best-effort** — Grok cannot be prevented from writing headlessly, so the relay snapshots the tree
and flags `readOnlyViolation: true` when a read-only run wrote anyway.

### kimi-delegate

Same loop for the Kimi Code CLI (`kimi`). Headless `kimi -p` always runs in Kimi's auto permission
mode (it rejects `--yolo`/`--auto`/`--plan` outright), so the skill is blunt about it: there is no
CLI-enforced read-only mode — `touchedFiles` and the diff, not a flag, are the guarantee.

### vibe-delegate

Same loop for the Mistral Vibe CLI (`vibe`). The `auto-approve` agent is the default for headless
implementation work — it auto-approves all tool executions. `--plan-only` selects the `plan` agent
(exploration and planning, auto-approves only safe read tools) as a best-effort read-only mode.
`--trust` is always passed to prevent interactive directory-trust prompts in headless runs. `--max-turns`
is available for cost control. Vibe works on Windows but officially targets UNIX environments.

### gemini-delegate

*Planned.* A delegate skill for the Gemini CLI, if and when it gains a comparable non-interactive mode.
Reserved so the umbrella can grow without a rename.

## How this differs from the OpenAI Codex plugin

The official openai-codex Claude Code plugin is excellent and **complementary** — `codex-delegate`
builds on the same `codex` CLI, it doesn't replace the plugin. They point in different directions:

- The plugin's `codex:codex-rescue` agent is a **forwarder**: it hands one task to Codex and returns
  the output. It deliberately does not poll, review, or commit.
- The plugin's review command and stop-review gate run the **inverse** direction: **Codex reviews your work**.
- `codex-delegate` is the **orchestration loop in the other direction**: *you* drive Codex to
  implement across one task or a queue, and *you* review and land each result. That loop — brief →
  dispatch → poll → review → commit, with the orchestrator owning the commit — is what the plugin
  leaves to you, and what this skill encodes.

If you have the plugin installed, its companion CLI is an optional alternative dispatch backend; the
bundled `relay.mjs` is the default because it needs nothing but the `codex` binary.

## Requirements

- The implementer CLI for the skill you install, authenticated as you would at the terminal:
  [`codex`](https://github.com/openai/codex) (`codex login`) · [`opencode`](https://opencode.ai)
  (`opencode auth login`) · `agy` (Antigravity's first-launch setup) ·
  `grok` (`npm i -g @xai-official/grok`, then `grok login`) ·
  [`kimi`](https://moonshotai.github.io/kimi-code/en/) (`brew install kimi-code`, then `kimi login`) ·
  [`vibe`](https://github.com/mistralai/mistral-vibe) (`uv tool install mistral-vibe`, then configure
  `MISTRAL_API_KEY`).
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus exactly **one** executable per skill — each a `scripts/relay.mjs`.
- Each `relay.mjs` makes no network calls, reads or writes no credentials, sends no telemetry, and has
  no dependencies (Node built-ins only). It shells out only to its implementer CLI and `git`. That CLI
  authenticates exactly as you do at the terminal. Read the script before you run it.
- None of the relays ever commit — committing is always the orchestrator's job, after review.

**Verification status** — claims here are backed by runs, not assumptions:

- Every relay's mechanics are verified: argument handling, exit codes, `result.json`, resume, signal
  reporting, and the implementer-specific guards.
- `agy-delegate` — verified end-to-end on macOS against `agy` 1.0.16 (headless edit run, `--print=`
  delivery, absolute `--add-dir` workspace pin).
- `grok-delegate` — verified end-to-end on macOS against `grok` 0.2.101 (streaming-json report capture,
  file-based brief delivery, resume; read-only is best-effort by measurement, hence the violation flag).
- `kimi-delegate` — verified end-to-end on macOS against `kimi` 0.24.0 (headless `-p` edit run,
  stream-json parsing, `--session`/`--continue` resume).
- `opencode-delegate` — requires `--model`, since OpenCode has no safe default.
- `vibe-delegate` — argument handling, exit codes, `result.json` shape, and the relay watchdog
  validated locally (`node relay.mjs --help` confirmed; end-to-end run against a live `vibe` binary
  not performed in this environment).
- Windows: the codex/opencode launches handle the `.cmd` shim (`shell:true` + quoting); native Windows
  launch smokes for `agy`/`grok`/`kimi` are still pending. Vibe officially targets UNIX environments;
  consult the Mistral Vibe documentation for Windows guidance.
- The full delegate → review → commit loop is designed for and run on Claude Code; other orchestrators
  (Cursor, …) are designed-for but unproven.

## Repository shape

Every skill has the same shape — a lean `SKILL.md`, four references that load only when needed, and
one inspectable script:

```text
skills/
└── <name>-delegate/
    ├── SKILL.md
    ├── scripts/relay.mjs
    └── references/
        ├── writing-the-brief.md
        ├── dispatch-and-poll.md
        ├── review-and-land.md
        └── multi-task-queues.md
```

## License

MIT — see [LICENSE](LICENSE).
