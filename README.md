# delegate-skills

[![skills.sh](https://skills.sh/b/amElnagdy/delegate-skills)](https://skills.sh/amElnagdy/delegate-skills)

Skills for **delegating coding work to a separate CLI agent and landing it yourself**. Your agent (the
orchestrator) writes a self-contained brief, hands it to an implementer CLI, then reviews the diff and
commits — staying the reviewer the whole way.

Three skills ship today: **`codex-delegate`** drives the OpenAI Codex CLI, **`opencode-delegate`**
drives the OpenCode CLI, and **`agy-delegate`** drives the Google Antigravity CLI. Same loop, different
implementer.

## Install

Browse first:

```bash
npx skills add amElnagdy/delegate-skills --list
```

Install the package, or just one skill:

```bash
npx skills add amElnagdy/delegate-skills
npx skills add amElnagdy/delegate-skills --skill codex-delegate
npx skills add amElnagdy/delegate-skills --skill opencode-delegate
npx skills add amElnagdy/delegate-skills --skill agy-delegate
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
Use $codex-delegate to run this queue of migration tasks through Codex while I review each one.
Use $agy-delegate to have Antigravity implement the UI cleanup, then review and commit it.
```

## How this differs from the OpenAI Codex plugin

The official openai-codex Claude Code plugin is excellent and
**complementary** — this skill builds on the same `codex` CLI, it doesn't replace the plugin. They
point in different directions:

- The plugin's `codex:codex-rescue` agent is a **forwarder**: it hands one task to Codex and returns
  the output. It deliberately does not poll, review, or commit.
- The plugin's review command and stop-review gate run the **inverse** direction: **Codex reviews your work**.
- `codex-delegate` is the **orchestration loop in the other direction**: *you* drive Codex to
  implement across one task or a queue, and *you* review and land each result. That loop — brief →
  dispatch → poll → review → commit, with the orchestrator owning the commit — is what the plugin
  leaves to you, and what this skill encodes.

If you have the plugin installed, its companion CLI is an optional alternative dispatch backend; the
bundled `relay.mjs` is the default because it needs nothing but the `codex` binary.

## The skills

### codex-delegate

Drive the OpenAI Codex CLI as a background implementer: write the brief, dispatch via `relay.mjs`,
review the diff, commit it yourself. Ships four references (writing the brief, dispatch/poll, review/
land, multi-task queues) loaded only when needed, and one small helper script.

**You'll feel it when:** a bounded task — a migration, a mechanical refactor, a removal sweep — gets
handed to Codex, comes back as a clean diff with a structured report, and you commit it after re-running
the gates yourself instead of typing it all by hand.

### opencode-delegate

Drive the OpenCode CLI as a background implementer: write the brief, dispatch via `relay.mjs`, review
the diff, commit it yourself. Same four references and loop as `codex-delegate`. Autonomy is set by the
**agent** rather than a sandbox enum — `build` (write-capable) by default, `plan` (read-only) for
review/diagnosis — and the brief is piped to `opencode run` on stdin so multi-line XML briefs need no
quoting.

**You'll feel it when:** a bounded task gets handed to OpenCode, comes back as a clean diff with a
structured report and the run's cost, and you commit it after re-running the gates yourself.

### agy-delegate

Drive the Google Antigravity CLI (`agy`) as a background implementer: write the brief, dispatch via
`relay.mjs`, review the diff, commit it yourself. Same four references and loop as the other delegate
skills. Fresh runs start a new Antigravity project and explicitly add the target repo as the workspace;
Antigravity's permission bypass is opt-in, not the default.

**You'll feel it when:** a bounded task gets handed to Antigravity, comes back as a clean diff with a
structured report and a conversation id, and you commit it after re-running the gates yourself.

### gemini-delegate

*Planned.* A delegate skill for the Gemini CLI, if and when it gains a comparable non-interactive mode.
Reserved so the umbrella can grow without a rename.

## Requirements

- For `codex-delegate`: the [`codex` CLI](https://github.com/openai/codex) installed and authenticated
  (`codex login`).
- For `opencode-delegate`: the [`opencode` CLI](https://opencode.ai) installed and authenticated
  (`opencode auth login`).
- For `agy-delegate`: the [`agy` CLI](https://antigravity.google/docs/cli/getting-started) installed
  and authenticated through Antigravity's first-launch setup.
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus exactly **one** executable per skill — each a `scripts/relay.mjs`.
- Each `relay.mjs` makes no network calls, reads or writes no credentials, sends no telemetry, and has
  no dependencies (Node built-ins only). It shells out only to its implementer CLI (`codex` /
  `opencode` / `agy`) and `git`. That CLI authenticates exactly as you do at the terminal. Read the
  script before you run it.
- None of the relays ever commit — committing is always the orchestrator's job, after review.

**Verification status:** each relay's mechanics are verified — argument handling, exit codes,
`result.json`, resume, and implementer-specific guards. `opencode-delegate` requires `--model`, since
OpenCode has no safe default. `agy-delegate` is verified end-to-end on macOS against `agy` 1.0.16: a
headless `agy --print` run edits the working tree, the brief is delivered via `--print=` (never split
across argv), the workspace is pinned with an absolute `--add-dir`, and `result.json` carries the
conversation id and touched files; the pre-run brief-size guard and the resume/project
mutual-exclusion guards are exercised. Windows launch is pending a native PowerShell/cmd smoke. The full delegate → review → commit loop is designed
for and run on Claude Code but not yet formally verified end-to-end here. Other orchestrators (Cursor,
…) are designed-for but unproven. This line gets upgraded to "verified end-to-end" with evidence, not
assumption.

## Repository shape

```text
skills/
├── codex-delegate/
│   ├── SKILL.md
│   ├── scripts/relay.mjs
│   └── references/
│       ├── writing-the-brief.md
│       ├── dispatch-and-poll.md
│       ├── review-and-land.md
│       └── multi-task-queues.md
├── opencode-delegate/
│   ├── SKILL.md
│   ├── scripts/relay.mjs
│   └── references/
│       ├── writing-the-brief.md
│       ├── dispatch-and-poll.md
│       ├── review-and-land.md
│       └── multi-task-queues.md
└── agy-delegate/
    ├── SKILL.md
    ├── scripts/relay.mjs
    └── references/
        ├── writing-the-brief.md
        ├── dispatch-and-poll.md
        ├── review-and-land.md
        └── multi-task-queues.md
```

The `SKILL.md` stays small so it loads cheaply; the references load only when the task needs them.

## License

MIT — see [LICENSE](LICENSE).
