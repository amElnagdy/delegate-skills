# delegate-skills

[![relay smoke](https://img.shields.io/github/actions/workflow/status/amElnagdy/delegate-skills/relays.yml?branch=master&label=relay%20smoke)](https://github.com/amElnagdy/delegate-skills/actions/workflows/relays.yml)
[![skills.sh](https://www.skills.sh/b/amElnagdy/delegate-skills)](https://www.skills.sh/amElnagdy/delegate-skills)
[![License](https://img.shields.io/github/license/amElnagdy/delegate-skills)](LICENSE)

**Create your fleet of lanes. One orchestrator, the right implementer for every job.**

Discover the implementer CLIs already installed on your machine, organize them into lanes like
`feature`, `tests`, and `ui`, then delegate by lane — or choose one implementer directly. Either way,
you keep the review and the commit.

```bash
npx skills add amElnagdy/delegate-skills
```

Then ask your orchestrating agent to create the fleet:

```text
Use $delegate-setup to discover my installed implementer CLIs and create a fleet for feature, tests, and UI work.
```

Or delegate directly:

```text
Use $codex-delegate to have Codex implement the refactor in services/billing/, then review and commit it.
```

```mermaid
flowchart LR
  S["$delegate-setup<br/>discover → propose → approve"] --> F["Example fleet"]
  O["Your orchestrator"] --> F
  F -->|"feature"| A["OpenCode"]
  F -->|"tests"| B["Codex"]
  F -->|"ui"| C["Cursor"]
  A --> R["Review the diff<br/>Run the gates"]
  B --> R
  C --> R
  R --> L["You land the commit"]
```

## Choose how you delegate

### Create a fleet

| Skill | Job |
| --- | --- |
| [`delegate-setup`](skills/delegate-setup/SKILL.md) | Discover installed CLIs, propose **fleet lanes**, and write global or project config after you approve. Never dispatches work. |

A **fleet** is your set of named lanes. Each **lane** binds a kind of work to one implementer and
optional dials such as model, effort, or variant. Setup discovers what is available, proposes a compact
fleet, shows you the complete configuration, and writes only after explicit approval.

Configuration can apply globally or to one repository. Once it is ready, dispatch with the matching
`*-delegate` skill and `--lane <name>`. Explicit flags override lane dials, and the wrong implementer
skill for a lane fails loud. Project config is content-bound to explicit setup approval, so cloned or
edited project lanes fail closed until re-approved. See the
[`delegate-fleet.v1` schema](skills/delegate-setup/references/schema.md) for paths, supported dials,
and overlay behavior.

### Delegate directly

Skip setup when you want one implementer or one-off dials. Pick the skill for a CLI you have:

| Skill | Implementer CLI | Write access (default) | Read-only run | Resume |
| --- | --- | --- | --- | --- |
| [`agy-delegate`](skills/agy-delegate/SKILL.md) | Google Antigravity (`agy`) | Antigravity's own `permissions`; bypass opt-in | — [^none] | `--resume-last`, `--conversation <id>` |
| [`claude-delegate`](skills/claude-delegate/SKILL.md) | [Claude Code](https://code.claude.com/docs/en/overview) (`claude`) | `acceptEdits` + explicit tool surface | `--read-only` (`plan` mode) | `--resume-last`, `--session <id>` |
| [`codex-delegate`](skills/codex-delegate/SKILL.md) | [OpenAI Codex](https://github.com/openai/codex) (`codex`) | `--sandbox workspace-write` | `--read-only` | `--resume-last`, `--session <id>` |
| [`cursor-delegate`](skills/cursor-delegate/SKILL.md) | [Cursor Agent](https://cursor.com/cli) (`cursor-agent`) | `--force`; `--no-force` withholds command approval | `--read-only` (plan mode) | `--resume-last`, `--session <id>` |
| [`grok-delegate`](skills/grok-delegate/SKILL.md) | Grok Build (`grok`) | workspace-scoped; `--full-access` opt-in | `--read-only` — best-effort [^grok] | `--resume-last`, `--session <id>` |
| [`kimi-delegate`](skills/kimi-delegate/SKILL.md) | [Kimi Code](https://moonshotai.github.io/kimi-code/en/) (`kimi`) | `auto permission mode`, always | — [^none] | `--resume-last`, `--session <id>` |
| [`opencode-delegate`](skills/opencode-delegate/SKILL.md) | [OpenCode](https://opencode.ai) (`opencode`) | agent `build` (`--model` required) | `--read-only` (agent `plan`) | `--resume-last`, `--session <id>` |
| [`pi-delegate`](skills/pi-delegate/SKILL.md) | [Pi](https://github.com/earendil-works/pi-mono) (`pi`) | full local tools — no sandbox, no permission modes [^none]; project trust opt-in | `--read-only` (`read,grep,find,ls`) | `--resume-last`, `--session <id>` |
| [`qoder-delegate`](skills/qoder-delegate/SKILL.md) | [Qoder](https://docs.qoder.com/en/cli/quick-start) (`qodercli`) | `auto` permission mode; bypass opt-in | `--permission-mode plan` | `--resume-last`, `--resume <id>` |
| [`vibe-delegate`](skills/vibe-delegate/SKILL.md) | [Mistral Vibe](https://github.com/mistralai/mistral-vibe) (`vibe`) | `accept-edits`; `--full-access` opt-in | `--plan-only` (`plan` agent) | `--resume-last`, `--session <id>` |

[^none]: No CLI-enforced read-only mode. `touchedFiles` and the diff, not a flag, are the guarantee.

[^grok]: `grok` cannot be prevented from writing headlessly, so the relay snapshots the tree and sets
`readOnlyViolation: true` when a read-only run wrote anyway.

Each skill name links to its `SKILL.md`, which owns that implementer's prerequisites, flags, and
caveats. Building one for another CLI? [Claim it first](../../issues?q=is%3Aissue+label%3Aimplementer),
then see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install

Browse first:

```bash
npx skills add amElnagdy/delegate-skills --list
```

Install the package, the setup skill, or one implementer skill:

```bash
npx skills add amElnagdy/delegate-skills
npx skills add amElnagdy/delegate-skills --skill delegate-setup
npx skills add amElnagdy/delegate-skills --skill codex-delegate
```

To pin an installation, append an existing release tag as `@vMAJOR.MINOR.PATCH`. The Skills CLI
installs by git ref, not by `metadata.version` in `SKILL.md`.

Install for a specific agent, or globally:

```bash
npx skills add amElnagdy/delegate-skills --skill codex-delegate --agent claude-code
npx skills add amElnagdy/delegate-skills --global
```

Works with any orchestrating agent the [Skills CLI](https://github.com/vercel-labs/skills) supports.

## How delegation works

Whether you choose the implementer directly or through a fleet lane, every dispatch follows the same
review-first loop:

1. **Write a brief** — self-contained task context; the implementer has no orchestrator chat history.
2. **Dispatch** it with the bundled `relay.mjs`.
3. **Wait** for completion — the relay writes a structured `result.json`.
4. **Review** the diff — re-run the project's gates yourself; pair with [guard skills](https://github.com/amElnagdy/guard-skills).
5. **Land** it — *you* commit, because committing belongs to the reviewer.

```text
Use $claude-delegate to have a separate Claude Code session implement the parser fix, then review and commit it.
Use $opencode-delegate with --lane feature to implement the billing workflow, then review and commit it.
Use $codex-delegate to run this queue of migration tasks through Codex while I review each one.
```

Every relay speaks the same `delegate-relay.result.v1` contract: `status`, `exitCode`, `signal`
(with a host-killed hint when the OOM killer ends a run), the implementer's own final report,
`touchedFiles`, and a session id where the CLI exposes one. Learn the loop once, swap the implementer
freely.

You feel it when a bounded task — a migration, a mechanical refactor, a removal sweep — comes back as
a clean diff with a structured report, and you land it after re-running the gates yourself instead of
typing it all by hand.

## What counts as an implementer skill

Four invariants hold for every `*-delegate` skill. They are also the bar for a new implementer:

- **A separate CLI edits a real working tree, and the diff is the deliverable.** Not an API wrapper,
  not a gateway — an implementer whose work you can read with `git diff`.
- **The relay never commits.** Committing belongs to the reviewer, always.
- **Node built-ins only.** No dependencies, no network calls of its own, no credentials, no telemetry.
  The relay launches its implementer CLI and `git`, plus the platform process launcher where a Windows
  shim or a process-tree kill needs one.
- **Autonomy is stated in the CLI's own terms**, and whatever it cannot enforce is said plainly — see
  the two footnotes above.

This is a loop, not a forwarder: a forwarder hands over one task and returns the output. Here you
dispatch, poll, review, and land, across one task or a queue. It stays complementary to a vendor's own
plugin or subagents — those coordinate inside one agent; this keeps the contract portable across
orchestrators, with the commit on the reviewer.

`delegate-setup` is the setup-skill exception: it discovers CLIs and writes an approved fleet map, but
never dispatches coding work.

Full checklist: [CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- For a `*-delegate` skill, its implementer CLI authenticated as you would at the terminal. Each
  implementer skill's `SKILL.md` carries its own install and login commands.
- `delegate-setup` requires no implementer CLI; it discovers whichever ones are available.
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus small Node scripts. Each `*-delegate` skill has exactly one
  `scripts/relay.mjs`. The `delegate-setup` utility ships `discover.mjs` / `config.mjs` / `lane.mjs`
  (and a shared implementer table) instead of a relay — it never dispatches coding work.
- Those scripts make no network calls of their own, read or write no credentials, send no telemetry, and
  have no dependencies (Node built-ins only). Relays launch an implementer CLI and `git`, plus the
  platform process launcher/termination utility where a Windows shim or process-tree kill requires one.
  Discover may invoke installed CLIs for `--version` / model list probes (those CLIs may contact their
  own services). Read the script before you run it.
- None of the relays ever commit — committing is always the orchestrator's job, after review.

**Verification status** — claims here are backed by runs, not assumptions.

True of every relay: argument handling, exit codes, `result.json` shape, resume, and signal reporting
are verified, along with each implementer-specific guard.

Per skill — platform, CLI version, and what the run exercised:

- `agy-delegate` — macOS, `agy` 1.0.16: headless edit run, `--print=` delivery, absolute `--add-dir`
  workspace pin.
- `claude-delegate` — macOS, `claude` 2.1.220: write run under `acceptEdits`; plan mode refusing an
  edit, with the porcelain tripwire true on a violation and false on a clean run;
  `--session`/`--resume-last` resume; `claude_unavailable`/127 and usage errors exiting 2 without a
  result file; deny rules and the shell sandbox blocking `git commit`, `git push`, `git -C <dir> push`,
  a nested `claude`, and a `$HOME` write.
- `cursor-delegate` — Windows, `cursor-agent` 2026.07.23-e383d2b: write run under `--force`; plan-mode
  `--read-only` touching nothing; `--session <id>` resume applying a delta brief; usage errors exiting
  2. A maintainer-run native macOS plan-mode smoke against the same version captured model, session,
  and usage with no touched files.
- `grok-delegate` — macOS, `grok` 0.2.101: streaming-json report capture, file-based brief delivery,
  resume; read-only is best-effort by measurement, hence the violation flag.
- `kimi-delegate` — macOS, `kimi` 0.24.0: headless `-p` edit run, stream-json parsing, and both
  resume paths — the relay's `--session`/`--resume-last`, which drive Kimi's own `--session` and
  `--continue`.
- `pi-delegate` — macOS: stdin brief delivery, explicit provider and model selection, JSON
  session/provider/model/usage capture, and a `--read-only` run leaving a clean tree. Write,
  `--session`, and `--resume-last` runs are contributor-reported.
- `qoder-delegate` — macOS, `qodercli` 1.0.47, by the contributor: Lite edit run, `accept_edits`,
  explicit model and 32768-token context window, no commit.
- `codex-delegate`, `opencode-delegate`, `vibe-delegate` — contract-tested only: argument validation,
  bounded version preflight, missing binary, result parsing, and whole-process-tree timeout/abort
  cleanup. No end-to-end run is recorded here.
- `delegate-setup` — contract-tested: discover JSON shape, config validate/write/load, whole-lane
  project overlay, global write without creating `.delegate/`, and `--lane` resolve / wrong-skill /
  flag-override against relays. The smoke suite runs live discovery against installed CLIs
  (versions vary by machine). Native Windows discover smoke not yet claimed.

Not yet verified: native Windows launches for `agy`, `claude`, `grok`, `kimi`, `pi`, `qoder`, and
`vibe` (the `codex`/`opencode`/`grok` `.cmd` shim handling is in place and quoted; Cursor serializes a
pre-joined, quoted command; Qoder and Vibe target their documented native executables). Claude's own
shell sandbox is unsupported on native Windows regardless of launch mechanics, and upstream Vibe
officially targets UNIX. A native Linux `cursor-agent` run is unverified. The full delegate → review →
commit loop is designed for and run on Claude Code; other orchestrators (Cursor, …) are designed-for
but unproven.

## Repository shape

Implementer skills share one shape; the setup utility has a different one:

```text
skills/
├── <name>-delegate/
│   ├── SKILL.md
│   ├── scripts/relay.mjs
│   └── references/
│       ├── writing-the-brief.md
│       ├── dispatch-and-poll.md
│       ├── review-and-land.md
│       └── multi-task-queues.md
└── delegate-setup/
    ├── SKILL.md
    ├── scripts/
    │   ├── discover.mjs
    │   ├── config.mjs
    │   ├── lane.mjs
    │   └── implementers.mjs
    └── references/
        ├── schema.md
        └── setup-dialogue.md
```

Adding an implementer is a new directory plus two lines here: a table row, and a verification line once
a run backs it.

Contributing? House rules, the controlled vocabulary, and the pre-publish checklist live in
[AGENTS.md](AGENTS.md) — read it before opening a pull request, and point your agent at it too.

## License

MIT — see [LICENSE](LICENSE).
