# delegate-skills

[![skills.sh](https://skills.sh/b/amElnagdy/delegate-skills)](https://skills.sh/amElnagdy/delegate-skills)

Skills for **delegating coding work to a separate CLI agent and landing it yourself**. Your agent (the
orchestrator) writes a self-contained brief, hands it to an implementer CLI, then reviews the diff and
commits — staying the reviewer the whole way.

Four skills ship today: **`codex-delegate`** drives the OpenAI Codex CLI, **`opencode-delegate`**
drives the OpenCode CLI, **`cursor-delegate`** drives the Cursor CLI, and **`antigravity-delegate`**
drives Google's Antigravity CLI. Same loop, different implementer.

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
npx skills add amElnagdy/delegate-skills --skill cursor-delegate
npx skills add amElnagdy/delegate-skills --skill antigravity-delegate
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

### cursor-delegate

Drive the Cursor CLI (`cursor-agent`) as a background implementer: write the brief, dispatch via
`relay.mjs`, review the diff, commit it yourself. Same four references and loop as its siblings.
Headless permissions have two switches, and the relay sets both: file edits apply without prompting,
and `--force` (the relay default) lets approval-gated shell commands auto-run so the brief's gate
commands actually execute. `--read-only` maps to cursor-agent's `plan` mode, which is **enforced** —
a plan run cannot write the tree. The brief is piped on stdin, so multi-line XML briefs need no quoting.

**You'll feel it when:** a bounded task gets handed to Cursor, comes back as a clean diff with a
structured report, the session id for rework, and the run's token usage — and you commit it after
re-running the gates yourself.

### antigravity-delegate

Drive Google's Antigravity CLI (`agy`) as a background implementer: write the brief, dispatch via
`relay.mjs`, review the diff, commit it yourself. Same four references and loop as its siblings, with
two verified agy quirks encoded: the relay always adds the working root to agy's workspace
(`--add-dir` — without it agy edits its own scratch directory, not the repo), and it offers **no
`--read-only` flag** because agy has no enforced read-only mode (`--mode plan` can still write the
tree). It also raises agy's 5-minute print timeout to a delegation-sized default.

**You'll feel it when:** a bounded task gets handed to Antigravity, comes back as a clean diff with a
structured report and the conversation id for rework — and you commit it after re-running the gates
yourself.

### gemini-delegate

*Planned.* A delegate skill for the Gemini CLI, if and when it gains a comparable non-interactive mode.
Reserved so the umbrella can grow without a rename.

### What about ZCode?

No skill — for now, deliberately. Z.ai's ZCode is a desktop app with no CLI or headless mode, so there
is nothing for a relay to drive. Its GLM models are still reachable for delegation today through
`opencode-delegate` (pick a GLM model with `--model`). If ZCode ships an official CLI, a
`zcode-delegate` sibling can join without a rename.

## Requirements

- For `codex-delegate`: the [`codex` CLI](https://github.com/openai/codex) installed and authenticated
  (`codex login`).
- For `opencode-delegate`: the [`opencode` CLI](https://opencode.ai) installed and authenticated
  (`opencode auth login`).
- For `cursor-delegate`: the [`cursor-agent` CLI](https://cursor.com/docs/cli) installed and
  authenticated (`cursor-agent login`).
- For `antigravity-delegate`: the [`agy` CLI](https://antigravity.google/docs/cli-install) installed
  and signed in with a Google account (first run opens the sign-in flow).
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus exactly **one** executable per skill — each a `scripts/relay.mjs`.
- Each `relay.mjs` makes no network calls, reads or writes no credentials, sends no telemetry, and has
  no dependencies (Node built-ins only). It shells out only to its implementer CLI (`codex` /
  `opencode` / `cursor-agent` / `agy`) and `git`. (The `antigravity-delegate` relay additionally reads
  one local agy cache file — the per-directory conversation-id map — so `result.json` can carry the id
  for a later resume.) That CLI authenticates exactly as you do at the terminal. Read the script before
  you run it.
- None of them ever commits — committing is always the orchestrator's job, after review.

**Verification status:** each relay's mechanics are verified — argument handling, exit codes,
`result.json`, resume, and (for `opencode-delegate`) the required-model guard, since OpenCode has no safe
default. For `cursor-delegate` and `antigravity-delegate` the dispatch mechanics were verified with live
runs against `cursor-agent` 2026.07.09 and `agy` 1.1.1: headless write runs, resume, result capture,
plan-mode read-only enforcement (Cursor — enforced; Antigravity — **not** enforced, which is why its
relay refuses `--read-only`), and agy's scratch-directory behavior without `--add-dir`. The full
delegate → review → commit loop is designed for and run on Claude Code but not yet formally verified
end-to-end here on a real task. Other orchestrators are designed-for but unproven. This line gets
upgraded to "verified end-to-end" with evidence, not assumption.

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
│   └── references/ (same four)
├── cursor-delegate/
│   ├── SKILL.md
│   ├── scripts/relay.mjs
│   └── references/ (same four)
└── antigravity-delegate/
    ├── SKILL.md
    ├── scripts/relay.mjs
    └── references/ (same four)
```

The `SKILL.md` stays small so it loads cheaply; the references load only when the task needs them.

## License

MIT — see [LICENSE](LICENSE).
