---
name: antigravity-delegate
description: >-
  Delegate a coding task to the Antigravity CLI (agy, Google's terminal coding agent) as a background
  implementer, then review its diff and land it yourself. Use this whenever the user wants to hand
  implementation work to Antigravity — phrasings like "have Antigravity do X", "delegate this to agy",
  "run it through Antigravity", or "use agy to implement/fix/refactor" — or wants to run a queue of
  coding tasks through Antigravity while staying the reviewer. Prefer it when the user will review the
  diff and commit it themselves. DO NOT USE for tasks small enough to do inline, for review-only
  dispatches that must be guaranteed read-only (agy has no enforced read-only mode), or when the user
  wants the code written directly without delegating.
license: MIT
compatibility: Requires the `agy` CLI (Antigravity CLI) installed and signed in with a Google account, Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows; Antigravity also ships native Windows installers).
metadata:
  version: 0.1.0
---

# Antigravity Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the Antigravity CLI (`agy`) — then review what it produced and land it yourself. You
write the brief and own the judgment; agy does the typing in its own conversation; you verify and
commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so any agent with those two capabilities — Claude Code, a sibling CLI session,
or a comparable one — can drive it. (It is designed for and run on Claude Code; treat other
orchestrators as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `agy` CLI is not installed or not signed in (first run opens a Google sign-in flow).
- **You need a guaranteed read-only run.** agy has no enforced read-only mode — `--mode plan` was
  verified to still write the working tree — so review/diagnosis dispatches can touch files. Use an
  implementer with an enforced read-only mode for that, or work on a branch/stash and verify the tree
  afterward.
- You want to write the code yourself.

## Prerequisites (check once)

1. `agy --version` succeeds. If not, install it — download the installer and review it before running
   (`curl -fsSL https://antigravity.google/cli/install.sh -o agy-install.sh`, read the script, then
   `bash agy-install.sh`; Antigravity's docs also list native Windows installers) — and sign in on
   first run.
2. **Confirm which `agy` is on PATH.** `command -v agy` shows the active binary and `agy --version` its
   version. The relay records the version it ran into `result.json`, so a stale binary is visible after
   the fact.
3. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model (optional)

agy has a usable default model, so `--model` is optional — but still worth setting deliberately.
`agy models` lists the available models (Gemini tiers plus partner models, depending on the account's
plan). Match the model to the brief: a fast model for a mechanical sweep (rename, migration, removal);
a strong one for a subtle bug or a money/security path. If the human has stated model preferences for
delegated work (in the repo's `AGENTS.md` or their `CLAUDE.md`), honor those.

More depth: [references/writing-the-brief.md](references/writing-the-brief.md).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

agy sees **only** the text you send plus what it can read from the working tree — no chat history, no
shared context. Everything the task needs goes in the brief: the goal, the current state, what to
change, what to leave untouched, the project's **actual** gate commands (discover them from the repo's
AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report contract. Tell agy it will **not** commit
(you will). Keep one task per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to agy with the bundled helper. It wraps `agy --print`, captures the run, and writes a
structured `result.json` — so your only job is "run a command, read a file." (`<skill-dir>` below is
this skill's installed directory — the folder containing this `SKILL.md`. Claude Code prints it as
"Base directory for this skill" when the skill loads; on other orchestrators use that same directory —
if unsure where it landed, run `find ~ -name relay.mjs -path '*antigravity-delegate*'` and substitute
the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pick a model explicitly:                add --model <name>       (default: agy's configured default)
# continue this repo's last conversation: add --resume-last        (delta brief only)
# longer/shorter run budget:              add --timeout <duration> (default 60m; agy's own default is 5m)
# see all options:                        node .../relay.mjs --help
```

The helper always adds the working root to agy's workspace (`--add-dir`) — without that, agy does its
work in its own scratch directory instead of the repo (verified) — and writes its artifacts to a temp
dir, so the repo under review stays clean. It **never commits** — see step 5. Mechanics, flags, and the
`result.json` shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until agy finishes, so back it with whatever your orchestrator offers and resume when
it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job`
  in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a `status`. (A
  pre-run usage error — bad args or an empty brief — instead exits with code 2 and writes no result
  file, so check the exit code too. A missing `agy` binary exits 127 but *does* write a `result.json`
  with status `agy_unavailable`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line.

### 4. Review — do not trust the self-report

agy's `result.json` includes its own final message and any gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did agy do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
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

Every agy dispatch is **write-capable** — plan on it (all verified against agy 1.1.1):

- agy only works on directories in its **workspace**: the relay always passes `--add-dir` for the
  working root. Without it, agy operates in its own scratch directory and the repo never changes.
- **There is no enforced read-only mode.** agy's `--mode plan` still writes the working tree when asked
  to, so the relay refuses a `--read-only` flag rather than offer a false promise. If you need
  isolation, work on a branch or stash first — and treat `touchedFiles` after any "review" dispatch as
  a real diff to inspect.
- Permissions **auto-approve by default**: the relay passes agy's `--dangerously-skip-permissions` so a
  headless run never blocks on a prompt no one can answer. That is the point of unattended delegation —
  the orchestrator's diff review and the implementer sweep (step 4) are the safety net, not a
  per-action prompt. Pass `--no-skip-permissions` to withhold it and rely on agy's own defaults (which
  already allow workspace file edits and safe commands headlessly, but may refuse riskier commands).
- Headless runs are budgeted by agy's `--print-timeout`. agy's own default (5m) is too short for real
  delegated work, so the relay defaults it to 60m; a run that exceeds the budget fails with
  "timeout waiting for response".

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report agy's design decisions, defensible-but-unasked turns, and
non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if correct
completion needs going beyond the brief, ask — don't expand the mandate yourself). The full treatment
is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief agy can
  execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--resume-last`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
