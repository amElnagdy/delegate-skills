---
name: hermes-delegate
description: >-
  Delegate a coding task to the Hermes Agent CLI (`hermes`) as a background implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  Hermes - phrasings like "have Hermes do X", "delegate this to Hermes", "run it through hermes",
  "let the hermes CLI implement/fix/refactor this" - or wants to run a queue of coding tasks through
  Hermes while staying the reviewer. DO NOT USE for tasks small enough to do inline, when the user
  wants the code written directly without delegating, for other CLIs (they have their own *-delegate
  skills), or for fleet-lane setup (that is delegate-setup).
license: MIT
compatibility: >-
  Requires the `hermes` CLI installed and authenticated (Nous Portal OAuth via `hermes portal`, or an
  API-key credential via `hermes auth`), Node 18+, and git. The orchestrating agent must be able to
  run shell commands and read files.
metadata:
  version: 0.5.0
---

# Hermes Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer** - a headless
`hermes` session - then review what it produced and land it yourself. You write the brief and own the
judgment; Hermes does the typing in its own session; you verify and commit.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `hermes` CLI is not installed or not authenticated.
- You need a CLI-enforced read-only guarantee. Hermes has no sandbox and no permission modes;
  its read-only mode is best-effort (see below), so the diff - not a flag - is the guarantee.

## Prerequisites (check once)

1. `hermes --version` succeeds and prints a version.
2. Hermes is authenticated the way you would authenticate it at the terminal (Nous Portal OAuth, or
   your provider's API key). An auth or billing lapse surfaces as a failed run, not as a missing binary.
3. You are in (or will point `--cd` at) the target git repository.

## Autonomy in Hermes's own terms (measured)

- No sandbox, no permission modes - none may be invented.
- Write runs: the relay passes `--yolo` explicitly so unattended writes never depend on user config.
- Read-only runs: restricted `--toolsets` and no `--yolo`. On hermes 0.20.x and 0.21.2 this leaves
  the session with zero file tools (measured: an ordered write was refused for lack of any file
  tool). This is still best-effort, NOT enforcement - treat `touchedFiles` and the diff as the
  guarantee, never the flag.
- Provider/billing failures can arrive as prose on stdout with exit 1: exit codes alone are not proof
  of success - read the report and `touchedFiles`.
- Never pass `--worktree`: Hermes deletes the isolated tree at session end, destroying uncommitted
  edits (measured). Work lands in the dispatch tree, where the diff is reviewable.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

Hermes sees only the text you send plus what it can inspect in the workspace - no chat history or
shared context. Include the goal, current state, what to change, what to leave untouched, the
project's **actual** gates, and a report contract. Tell Hermes not to commit. Keep one task per brief.

**Use absolute paths for every file the brief names.** Unattended Hermes resolves relative paths
against its home workspace, not `--cd`; a relative-path brief can land edits in the wrong tree. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled helper. It wraps `hermes chat --query-file ... -Q`, captures the session, and writes
`result.json`. (`<skill-dir>` is the installed folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# resume the most recent session:        add --resume-last  (delta brief only)
# resume a specific session:             add --resume <id>  (delta brief only)
# review/diagnosis intent:               add --read-only  (best-effort - see Autonomy above)
# hard time limit (watchdog):            add --timeout 2h  (the default suits short runs; implementation briefs routinely need 1-2h)
# see all options:                       node .../relay.mjs --help
```

The relay pins the workspace with `--in <dir>`, writes artifacts under the system temp dir by default,
and never commits. See [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Hermes finishes. Run it with the orchestrator's background-command facility,
or background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; a missing `hermes` exits 127 and writes `status: "hermes_unavailable"`.

Completion means the process exited and `result.json` exists. Hermes's full report is the
`finalMessage` field (also printed in full on stdout between the report markers).

### 4. Review - do not trust the self-report

Treat Hermes's final message and gate claims as claims:

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Round-trip migrations and grep for dangling references after removals or renames.
- Drift guard: a clean working tree combined with a report naming absolute paths under `$HOME`
  outside the dispatch root means the run landed in the wrong tree - do not commit; re-dispatch
  with an all-absolute brief.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Commit only after the gates
pass and the diff holds. If rework is needed, send a delta brief with `--resume-last` or
`--resume <id>`, then review again.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits remain: **surface, don't absorb**
(report Hermes's design decisions, defensible-but-unasked turns, and non-blocking nitpicks) and
**stop for scope changes** (if correct completion needs going beyond the brief, ask instead of
expanding the mandate). See [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, report contract,
  real gates, and the absolute-path rule.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts,
  `result.json`, polling, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - review checklist, commit boundary,
  and rework through Hermes sessions.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues, constraint
  carry-forward, progress tracking, and the final coherence pass.
