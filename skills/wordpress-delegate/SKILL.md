---
name: wordpress-delegate
description: >-
  Delegate a WordPress coding task to the CLI implementer best suited to it — routing by the kind of
  work, prepending the WordPress engineering standards, then handing off to a sibling delegate — and
  review its diff and land it yourself. Use this whenever the user wants implementation work done on a
  WordPress site, theme, plugin, or block — phrasings like "have an agent build this WooCommerce
  feature", "delegate this Elementor widget", "audit the plugin for nonce and escaping issues", or
  "run this queue of WordPress tasks" — and you want the implementer chosen for you rather than named.
  DO NOT USE when the user names the implementer themselves (use that CLI's own delegate skill), for
  tasks small enough to do inline, or for non-WordPress work.
license: MIT
compatibility: Requires at least one sibling delegate from this package installed beside it (codex-delegate, grok-delegate, kimi-delegate, and opencode-delegate are the shipped routing targets), its implementer CLI installed and authenticated, Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.1.0
---

# WordPress Delegate

You are the **orchestrator**, acting as the WordPress technical lead. This skill lets you hand a
bounded WordPress task to a separate **implementer** — chosen for you by the kind of work, not named
by you — then review what it produced and land it yourself.

It is the one skill in this package that launches no implementer CLI of its own. It does three things
and then gets out of the way:

1. **Classifies the brief** — what kind of work it is (the *lane*) and what it is about (the
   *domains*).
2. **Prepends the WordPress engineering standards** — security, platform APIs, coding standards,
   backward compatibility, performance — so the same bar applies whichever implementer runs.
3. **Dispatches through that implementer's own sibling delegate**, whose `relay.mjs` owns every
   CLI-specific mechanic and writes the result contract.

The loop is otherwise identical to every sibling: brief → dispatch → poll → review → **you commit**.

## When NOT to use this

- The user named the implementer ("have Codex do this") — use that CLI's own delegate skill directly.
- The task is small enough to just do inline.
- The work is not WordPress. The preamble and the domain notes would be noise at best.
- No sibling delegate is installed beside this one. This skill dispatches through them; it cannot run
  alone. `node "<skill-dir>/scripts/relay.mjs" --list-routes` names its targets.

## Prerequisites (check once)

1. At least the routed sibling is installed — the four shipped routing targets are
   `codex-delegate`, `grok-delegate`, `kimi-delegate`, and `opencode-delegate`. Install the whole
   package (`npx skills add amElnagdy/delegate-skills`) and all ten are there.
2. That sibling's implementer CLI is installed and authenticated. Each sibling's own `SKILL.md`
   carries its install and login commands; this skill does not restate them.
3. You are in (or will point `--cd` at) the target git repository — the WordPress install, the theme,
   or the plugin, whichever is the repo.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

The implementer sees **only** the text sent — no repo memory, no chat history. Everything the task
needs goes in the brief: the goal, the current state, what to change, what to leave untouched, the
project's **actual** gate commands, and a report contract.

You do **not** need to restate the WordPress standards. The relay prepends them, plus notes for the
domains it detects (WooCommerce, Elementor, ACF, WPForms, database, security, integrations, hosting,
deployment). Read the exact text with `--print-preamble`. What you must supply is the part no
preamble can know: **which** site, **which** plugin versions, **which** gates, and what is out of
scope. Full guidance and a WordPress template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/wp-content/plugins/acme
# see where it would route, without dispatching:  add --dry-run
# make the router refuse when it is unsure:       add --strict-routing
# override the router:                            add --implementer codex   (or --lane performance)
# read-only (audit/diagnosis, no edits):          add --read-only
# hard time limit (watchdog):                     add --timeout 2h  (default: off)
# see all options and the lane table:             node .../relay.mjs --help   ·   --list-routes
```

(`<skill-dir>` is this skill's installed directory — the folder containing this `SKILL.md`. Claude
Code prints it as "Base directory for this skill" when the skill loads; on other orchestrators use
that same directory. If unsure where it landed, run
`find ~ -name relay.mjs -path '*wordpress-delegate*'` and substitute the directory above it.)

Artifacts go to a temp dir so the repo under review stays clean; the sibling's own artifacts land in
`<out-dir>/implementer/`. It **never commits** — see step 5. Mechanics, flags, the routing table, and
the `result.json` shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The relay blocks until the sibling finishes, which is until the implementer finishes. Back it with
whatever your orchestrator offers:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** foreground for short tasks, or background it and poll the result
  file. The run is done when `result.json` exists with a `status`. A pre-run usage error exits 2 (and
  a refusal under `--strict-routing` exits 3) **before** writing any result file, so check the exit
  code too. A missing sibling relay exits 127 but *does* write a `result.json` with status
  `implementer_unavailable`.

Do not trust progress trackers over reality. Read the working tree, not a status line.

### 4. Review — do not trust the self-report

Everything in the sibling's review discipline applies unchanged, and WordPress adds its own failure
modes that a green test suite cannot see: a missing nonce, an unescaped echo, `$wpdb` interpolation,
an `update_option` that autoloads a megabyte, a direct write to a Woo order's post meta under HPOS.

**Start with the routing decision.** `result.json` records the lane, the confidence, and the signals
that matched. A `low`, `none`, or `contested` confidence means the router guessed — read the diff
against what the user actually asked for, not against what the lane assumed.

Then: re-run the project's gates yourself, read the diff against the brief, and run the WordPress
sweep. Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

No relay in this package commits. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--session <id>` from `implementerSession` in the
  prior `result.json`, and review again. The relay translates that into the chosen CLI's own resume
  flag and skips the preamble, which the session already carries.

## Routing

The relay picks the implementer from the brief. Lanes are scored by keyword signals; the
highest-scoring lane wins, and lane order breaks ties, so a brief that trips both security and
performance is routed as security.

| Lane | Implementer | Why |
| --- | --- | --- |
| `security-audit` | `grok` (read-only) | Adversarial reading, not editing; the deliverable is findings. |
| `research` | `grok` (read-only) | Breadth and a defended recommendation, not a diff. |
| `documentation` | `kimi` | High-volume, low-branching prose work. |
| `refactor-sweep` | `opencode` | Sustained context across many files beats depth on any one. |
| `plugin-architecture` | `codex` | Structural decisions compound. |
| `elementor-widget` | `codex` | The control/render/editor contract fails silently when wrong. |
| `performance` | `codex` | Measurement-driven and easy to get plausibly wrong. |
| `implementation` (fallback) | `codex` | No lane signal dominated. |

**Domains are not lanes.** WooCommerce, ACF, WPForms, database, integrations, hosting, and deployment
work is *understood* — detected, recorded, and given its own preamble notes — but it does not pick the
implementer. A WooCommerce checkout bug is implementation work; a WooCommerce security review is a
security audit. The kind of work routes; the subject informs.

**When the router is unsure, ask.** Confidence is `high` (two or more signals), `low` (one),
`contested` (a tie), or `none`. On anything below `high`, put the question to the user rather than
letting the fallback decide — or pass `--strict-routing` and let the relay refuse, which prints the
exact question to ask.

One rule overrides the score: **a read-only lane needs two signals to win.** "Fix the cart hook, it's
missing a nonce check" is a bugfix that says "nonce", not an audit request — it demotes to
`implementation` and keeps its writes, with `security-audit` recorded in `alternates`. A lane that
withholds writes on one keyword returns an empty diff to someone who asked for a fix.

Adding a lane is one row in the table at the top of `scripts/relay.mjs`; see
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

## Read-only audits

The `security-audit` and `research` lanes run read-only by default, which makes this the clean way to
get a WordPress security review with no write risk: dispatch the audit brief, get findings in the
final report, touch no files. Verify `touchedFiles` came back empty rather than assuming it — Grok's
read-only is best-effort and flagged after the fact (`readOnlyViolation`), not enforced. Route to
`codex` with `--implementer codex --read-only` when you want the guarantee enforced by a sandbox.

## Authorization model

Delegation is something the human opts into. Once they have, committing verified, gate-passing work
is the agreed contract. Two limits: **surface, don't absorb** (report the implementer's design
decisions and defensible-but-unasked turns, and report a low-confidence routing decision as one of
them) and **stop for scope changes** (if correct completion needs going beyond the brief, ask). Full
treatment in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — what the preamble covers so you
  don't restate it, what only you can supply, and a WordPress brief template.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the routing
  table and how to extend it, the `result.json` contract, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the WordPress review sweep, the
  routing-confidence check, the commit boundary, and the rework cycle.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a WordPress queue:
  per-task routing, carrying constraints forward, and the end-of-run coherence check.
