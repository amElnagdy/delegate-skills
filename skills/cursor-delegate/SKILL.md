---
name: cursor-delegate
description: >-
  Delegate a coding task to the Cursor CLI (cursor-agent) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Cursor —
  phrasings like "have Cursor do X", "delegate this to Cursor", "run it through cursor-agent", or "use
  Cursor to implement/fix/refactor" — or wants to run a queue of coding tasks through Cursor while
  staying the reviewer. Prefer it when the user will review the diff and commit it themselves. DO NOT
  USE for tasks small enough to do inline, or when the user wants the code written directly without
  delegating.
license: MIT
compatibility: Requires the `cursor-agent` CLI (Cursor CLI) installed and authenticated, Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows; Cursor also ships a native Windows installer).
metadata:
  version: 0.1.0
---

# Cursor Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the Cursor CLI (`cursor-agent`) — then review what it produced and land it yourself.
You write the brief and own the judgment; cursor-agent does the typing in its own session; you verify
and commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so any agent with those two capabilities — Claude Code, a sibling CLI session,
or a comparable one — can drive it. (It is designed for and run on Claude Code; treat other
orchestrators as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `cursor-agent` CLI is not installed or not authenticated (run `cursor-agent login`).
- You want to write the code yourself, or you only need a review (use `--read-only`, which runs
  cursor-agent in its enforced read-only `plan` mode).

## Prerequisites (check once)

1. `cursor-agent --version` succeeds. If not, install (`curl https://cursor.com/install -fsS | bash`;
   Cursor's docs also list a native Windows PowerShell installer) and `cursor-agent login`.
2. **Confirm which `cursor-agent` is on PATH.** The installer also links a plain `agent` alias — the
   relay invokes `cursor-agent`, so that name must resolve. `command -v cursor-agent` shows the active
   binary and `cursor-agent --version` its version. The relay records the version it ran into
   `result.json`, so a stale binary is visible after the fact.
3. `cursor-agent status` shows you are logged in.
4. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model (optional)

Unlike OpenCode, cursor-agent has a **usable default**: a bare run uses the Cursor account's configured
model, and the relay records which model actually ran (`resolvedModel` in `result.json`). So `--model`
is optional — but still worth setting deliberately:

- `cursor-agent models` lists what the account can use. Availability and metering depend on the human's
  Cursor plan, so if they've stated model preferences for delegation (in the repo's `AGENTS.md` or their
  `CLAUDE.md`), honor those.
- Match the model to the brief: a fast model for a mechanical sweep (rename, migration, removal); a
  strong one for a subtle bug or a money/security path.

More depth: [references/writing-the-brief.md](references/writing-the-brief.md).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

cursor-agent sees **only** the text you send plus what it can read from the working tree (including the
repo's own rules files, which it picks up automatically). No chat history, no shared context. Everything
the task needs goes in the brief: the goal, the current state, what to change, what to leave untouched,
the project's **actual** gate commands (discover them from the repo's AGENTS.md/CLAUDE.md/Makefile — do
not assume), and a report contract. Tell cursor-agent it will **not** commit (you will). Keep one task
per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to cursor-agent with the bundled helper. It wraps `cursor-agent --print`, captures the
run, and writes a structured `result.json` — so your only job is "run a command, read a file."
(`<skill-dir>` below is this skill's installed directory — the folder containing this `SKILL.md`.
Claude Code prints it as "Base directory for this skill" when the skill loads; on other orchestrators
use that same directory — if unsure where it landed, run
`find ~ -name relay.mjs -path '*cursor-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pick a model explicitly:                 add --model <name>   (default: the account's configured model)
# read-only (review/diagnosis, no edits):  add --read-only      (cursor-agent's enforced plan mode)
# continue the previous session:           add --resume-last    (delta brief only)
# see all options:                         node .../relay.mjs --help
```

The helper defaults to a write-capable run and writes its artifacts to a temp dir, so the repo under
review stays clean. It **never commits** — see step 5. Mechanics, flags, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until cursor-agent finishes, so back it with whatever your orchestrator offers and
resume when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job`
  in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a `status`. (A
  pre-run usage error — bad args or an empty brief — instead exits with code 2 and writes no result
  file, so check the exit code too. A missing `cursor-agent` binary exits 127 but *does* write a
  `result.json` with status `cursor_agent_unavailable`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line.

### 4. Review — do not trust the self-report

cursor-agent's `result.json` includes its own final message and any gate claims. **Re-verify, don't
accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did cursor-agent do what was asked, nothing more (scope creep)
  and nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Committing should be the act of
the party that verified the work. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--resume-last` (don't restate the whole task) and
  review again.

## Autonomy model

cursor-agent's autonomy in headless (`--print`) mode has two independent switches, and the relay sets
both (verified against cursor-agent 2026.07.09):

- **File edits** are applied without prompting in a headless run — with or without `--force`. There is
  no per-edit approval to lean on; the orchestrator's diff review (step 4) is the safety net.
- **Shell commands** only auto-run under `--force`. The relay passes it by default so the brief's gate
  commands (tests, lint) actually execute instead of being refused; pass `--no-force` to withhold it —
  approval-gated commands are then refused rather than prompted (a headless run never prompts).
- **`--read-only`** runs cursor-agent in its `plan` mode, which **is enforced**: a plan run cannot
  write the working tree (verified — a write instruction in plan mode produced a plan, not a file). It
  never gets `--force`.
- Every run gets `--trust`: without it, dispatching into a not-yet-trusted workspace hangs on a prompt
  no one can answer. Choosing to dispatch into a repo is itself the trust decision, made by the human
  who opted into delegation.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report cursor-agent's design decisions, defensible-but-unasked
turns, and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if
correct completion needs going beyond the brief, ask — don't expand the mandate yourself). The full
treatment is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief
  cursor-agent can execute blind: structure, XML blocks, the report contract, embedding the real gate
  commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--resume-last`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
