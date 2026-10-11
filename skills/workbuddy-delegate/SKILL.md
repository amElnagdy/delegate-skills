---
name: workbuddy-delegate
description: >-
  Delegate a coding task to the WorkBuddy/CodeBuddy CLI as a background implementer, then review its diff
  and land it yourself. Use this whenever the user wants to hand implementation work to WorkBuddy —
  phrasings like "have WorkBuddy do X", "delegate this to WorkBuddy", "run it through CodeBuddy",
  or "use WorkBuddy to implement/fix/refactor" — or wants to run a queue of coding tasks through
  WorkBuddy while staying the reviewer. Prefer it when the user will review the diff and commit it
  themselves. DO NOT USE for tasks small enough to do inline, or when the user wants the code written
  directly without delegating.
license: MIT
compatibility: Requires the `codebuddy` CLI installed and authenticated, and git. The orchestrating
  agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux,
  or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# WorkBuddy Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the WorkBuddy/CodeBuddy CLI — then review what it produced and land it yourself.
You write the brief and own the judgment; WorkBuddy does the typing in its own session; you verify
and commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so any agent with those two capabilities — Claude Code, OpenCode driving a
sibling session, or a comparable one — can drive it. (It is designed for and run on Claude Code;
treat other orchestrators as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `codebuddy` CLI is not installed or not authenticated (run `codebuddy` and follow the login
  flow, or see the quickstart at https://www.codebuddy.ai/docs/cli/quickstart).
- You want to write the code yourself, or you only need a review (use the plan agent via
  `--read-only` uses CodeBuddy's native `--permission-mode plan`.

## Prerequisites (check once)

1. `codebuddy --version` succeeds. If not, install:
   - macOS/Linux: `curl -fsSL https://copilot.tencent.com/cli/install.sh | bash`
   - Windows: `irm https://copilot.tencent.com/cli/install.ps1 | iex`
   Then run `codebuddy` and complete the authentication flow.
2. **Confirm which `codebuddy` is on PATH.** `command -v codebuddy` shows the active binary and
   `codebuddy --version` its version. The relay records the version it ran into `result.json`, so a
   stale binary is visible after the fact.
3. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model

WorkBuddy uses model identifiers like `gpt-5`, `gpt-4`, etc., configured via `--model` flag or
through its config system. The model is the one decision a single-model backend never had, and it
has two owners:

- **The human owns which models are allowed.** WorkBuddy supports various models (OpenAI, Anthropic,
  local via Ollama, etc.); only the human knows which are their subscriptions or available
  endpoints. So the usable set is theirs — ideally stated once in the repo's `AGENTS.md` or their
  `CLAUDE.md` (e.g. "delegate mechanical work to `gpt-4o-mini`, hard logic to `gpt-5`").
- **You, the orchestrator, pick per task — from that set.** Match the model to the brief: a cheap,
  fast model for a mechanical sweep (rename, migration, removal); a strong one for a subtle bug or
  a money/security path.
- **If no usable set is stated, ask — don't guess.** Guessing risks using a model the user doesn't
  have access to or didn't intend to spend tokens on. Name the constraint to the human and let them
  choose.

More depth: [references/writing-the-brief.md](references/writing-the-brief.md).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

WorkBuddy sees **only** the text you send plus what it can read from the working tree — no chat
history, no shared context. Everything the task needs goes in the brief: the goal, the current
state, what to change, what to leave untouched, the project's **actual** gate commands (discover
them from the repo's AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report contract. Tell
WorkBuddy it will **not** commit (you will). Keep one task per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to WorkBuddy with the bundled helper. It wraps `codebuddy -p`, captures the run,
and writes a structured `result.json` — so your only job is "run a command, read a file."
(`<skill-dir>` below is this skill's installed directory — the folder containing this `SKILL.md`.
Claude Code prints it as "Base directory for this skill" when the skill loads; on other orchestrators
use that same directory — if unsure where it landed, run `find ~ -name relay.mjs -path
'*delegate-workbuddy*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --model <model-name> --cd /path/to/repo
# --model is required on a fresh run
# fleet lane from delegate-setup:           add --lane <name>  (dials apply; flags still win)
# read-only (review/diagnosis, no edits):   add --read-only   (maps to --permission-mode plan)
# reasoning effort:                        add --effort high
# continue the previous WorkBuddy session:  add --resume-last  (delta brief only; keeps the model)
# hard time limit (watchdog):               add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                          node .../relay.mjs --help
```

The helper defaults to a write-capable mode and writes its artifacts to a temp dir, so the repo
under review stays clean. It **never commits** — see step 5. Mechanics, flags, and the `result.json`
shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until WorkBuddy finishes, so back it with whatever your orchestrator offers and
resume when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and
  poll the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent
  (`Start-Job` in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a
  `status`. (A pre-run usage error — bad args or an empty brief — instead exits with code 2 and
  writes no result file, so check the exit code too. A missing `codebuddy` binary exits 127 but
  *does* write a `result.json` with status `codebuddy_unavailable`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line. The implementer's full report is the
`finalMessage` field in `result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

WorkBuddy's `result.json` includes its own final message and any gate claims. **Re-verify, don't
accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did WorkBuddy do what was asked, nothing more (scope creep)
  and nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Committing should be the act
of the party that verified the work. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--resume-last` (don't restate the whole task) and
  review again.

## Autonomy model

WorkBuddy's autonomy is governed by the **mode** and **permissions**:

- **Interactive/Print mode** (the relay default: `codebuddy -p`) — write-capable when given file
  operation permissions; edits files in the working dir headlessly. The equivalent of "let it
  implement."
- **Read-only / review mode** — the relay passes CodeBuddy's `--permission-mode plan`, its native
  plan mode. It also records `readOnlyViolation` from the before/after Git status; inspect that
  field because the orchestrator remains the final safety boundary.

Permissions: WorkBuddy uses a permission system for file operations. The relay passes `-y`
(auto-approve file operations) by default so a headless run never blocks on a prompt no one can
answer. That is the point of unattended delegation — the orchestrator's diff review and the
implementer sweep (step 4) are the safety net, not a per-action prompt. Pass `--no-auto` to honor
the agent's own permission config instead (allow/ask/deny per action); pair it with an agent whose
in-workspace permissions are set to *allow*, or a headless run can hang waiting on an `ask`.
Read-only runs never get `-y` — auto-approving would let edit permissions through and defeat
"read-only," so a review can't be tricked into touching the tree.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report WorkBuddy's design decisions, defensible-but-unasked
turns, and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes**
(if correct completion needs going beyond the brief, ask — don't expand the mandate yourself). The
full treatment is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief
  WorkBuddy can execute blind: structure, XML blocks, the report contract, embedding the real gate
  commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--resume-last`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
