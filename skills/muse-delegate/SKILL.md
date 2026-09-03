---
name: muse-delegate
description: >-
  Delegate a coding task to Muse Code (`muse`) as a background implementer, then review its diff and
  land it yourself. Use this whenever the user wants to hand implementation work to Muse — phrasings
  like "have Muse do X", "delegate this to Muse", "run it through Muse", or "use Muse to
  implement/fix/refactor" — or wants to run a queue of coding tasks through Muse while staying the
  reviewer. Prefer it when the user will review the diff and commit it themselves. DO NOT USE for tasks
  small enough to do inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the `muse` CLI installed and authenticated (`muse login` or `META_API_KEY`), Node 18+, and git. Upstream's launcher targets UNIX (macOS/Linux). The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh.
metadata:
  version: 0.5.0
---

# Muse Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — Muse Code (`muse`) — then review what it produced and land it yourself. You write
the brief and own the judgment; Muse does the typing in its own `exec` run; you verify and commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so any agent with those two capabilities can drive it. (It is designed for
and run on Claude Code; treat other orchestrators as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `muse` CLI is not installed or not authenticated (run `muse login`, or set `META_API_KEY`).
- You want to write the code yourself.
- You are on native Windows and need a supported launcher. Upstream's `muse` launcher is Darwin/Linux
  only; this skill still ships in the Windows contract matrix, but a live Windows dispatch is not a
  supported Muse install.

## Read this before the first dispatch: the autonomy model

Headless Muse is **`muse exec` only**. `muse resume` is the interactive TUI and is never invoked.
`--resume-last` is rejected; continue a run with `--session <id>` (Muse's `--session-id`).

Write runs keep Muse's sandbox **on** and pass `--disable-approval` so a headless run cannot hang on a
tool-approval prompt. They also pass `--trust-workspace` and `--user-input-auto-resolve`. That is not
`--yolo` and not `--full-access` — do not invent either as the default.

`--read-only` adds `--disable-write` (non-shell filesystem writes) **and** `--disable-shell`. Approval
stays disabled so the review cannot block on a prompt either.

`--provider echo|meta` is a **relay-only** flag for tests and explicit probes. It is not a fleet dial.

## Prerequisites (check once)

1. `muse --version` succeeds. If not, install Muse Code and run `muse login` (or export `META_API_KEY`).
2. **Confirm which `muse` is on PATH.** `command -v muse` shows the active launcher. The relay records
   the version it ran into `result.json`.
3. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model

Muse has a configured default model, so a fresh run may omit `--model`. Pass `--model` or a fleet
`--lane` that sets one when you need to pin a catalog id. A resumed `--session` keeps the session's
model. If the human has not named a usable set, ask before guessing a metered id.

More depth: [references/writing-the-brief.md](references/writing-the-brief.md).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

Muse sees **only** the text you send plus what it can read from the working tree — no chat history,
no shared context. Everything the task needs goes in the brief: the goal, the current state, what to
change, what to leave untouched, the project's **actual** gate commands (discover them from the repo's
AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report contract. Tell Muse it will **not**
commit (you will). Keep one task per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to Muse with the bundled helper. It wraps `muse exec --json --prompt-file`, captures
the run, and writes a structured `result.json`. (`<skill-dir>` below is this skill's installed
directory — the folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# optional model:                           add --model <id>
# fleet lane from delegate-setup:           add --lane <name>  (dials apply; flags still win)
# reasoning intensity:                      add --effort none|minimal|low|medium|high|xhigh|ultra
# read-only (no non-shell writes, no shell): add --read-only
# continue a specific Muse session:         add --session <id>  (delta brief only; no --resume-last)
# hard time limit (watchdog):               add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                          node .../relay.mjs --help
```

The helper writes artifacts to a temp dir, so the repo under review stays clean. It **never commits**
— see step 5. Mechanics, flags, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Muse finishes, so back it with whatever your orchestrator offers and resume
when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file. The run is done when `result.json` exists with a `status`. (A pre-run usage error —
  bad args or an empty brief — instead exits with code 2 and writes no result file, so check the exit
  code too. A missing `muse` binary exits 127 but *does* write a `result.json` with status
  `muse_unavailable`. `--resume-last` is a usage error: headless resume is `--session <id>`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Muse can exit 0 without a `run.terminal.completed` event; the relay reports that
as `failed`, not `completed`. The implementer's full report is the `finalMessage` field in
`result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

Muse's `result.json` includes its own final message and any gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did Muse do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Committing should be the act of
the party that verified the work. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--session <id>` (don't restate the whole task) and
  review again. There is no headless `--resume-last`.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report Muse's design decisions, defensible-but-unasked turns,
and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if correct
completion needs going beyond the brief, ask — don't expand the mandate yourself). The full treatment
is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief Muse can
  execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--session`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
