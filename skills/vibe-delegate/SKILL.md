---
name: vibe-delegate
description: >-
  Delegate a coding task to the Mistral Vibe CLI (`vibe`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Vibe —
  phrasings like "have Vibe implement X", "delegate this to Vibe", "run it through Mistral Vibe", "use
  vibe to implement/fix/refactor" — or wants to run a queue of coding tasks through Vibe while staying
  the reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants the code written
  directly without delegating.
license: MIT
metadata:
  version: 0.1.0
---

# Vibe Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer** — the Mistral
Vibe CLI (`vibe`) — then review what it produced and land it yourself. You write the brief and own
the judgment; Vibe does the typing in its own session; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `vibe` CLI is not installed or authenticated.
- You need a CLI-enforced read-only implementer. Vibe's `plan` agent is best-effort read-only only.

## Prerequisites (check once)

1. Install Mistral Vibe:
   - **Linux/macOS (recommended):** `curl -LsSf https://mistral.ai/vibe/install.sh | bash`
   - **With uv:** `uv tool install mistral-vibe`
2. Configure your API key with `vibe --setup`, or set `MISTRAL_API_KEY` in the environment.
3. Confirm `vibe --version` succeeds.
4. Work in, or point `--cd` at, the target git repository.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

Vibe sees only the text you send plus what it can inspect in the workspace — no chat history or shared
context. Include the goal, current state, what to change, what to leave untouched, the project's
**actual** gates, and a report contract. Tell Vibe not to commit. Keep one task per brief. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled helper. It wraps Vibe's headless `--prompt` mode, captures the structured event
stream, and writes `result.json`. (`<skill-dir>` is the installed folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# limit turns for cost control:           add --max-turns <n>
# planning/read-only (best-effort):       add --plan-only
# resume the most recent session:         add --resume-last  (delta brief only)
# resume a specific session:              add --session <id> (delta brief only)
# see all options:                        node .../relay.mjs --help
```

The child process's cwd pins the workspace. The relay writes artifacts under the system temp dir by
default and never commits. See [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Vibe finishes. Run it with the orchestrator's background-command facility, or
background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; a missing `vibe` exits 127 and writes `status: "vibe_unavailable"`.

Trust process state and the working tree over a progress display. Completion means the process exited
and `result.json` exists.

### 4. Review — do not trust the self-report

Treat Vibe's final message and gate claims as claims:

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.
- Round-trip migrations and grep for dangling references after removals or renames.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Commit only after the gates pass
and the diff holds. If rework is needed, send a delta brief with `--resume-last` or `--session <id>`,
then review again.

## Autonomy and permissions

In `--prompt` mode the relay always sets the agent profile explicitly:

| Relay flag | What Vibe gets | Use when |
| --- | --- | --- |
| *(default)* | `--agent auto-approve` | Normal implementation — auto-approves all tool executions |
| `--plan-only` | `--agent plan` | Review/diagnosis — **best-effort, not enforced** |

The `plan` agent auto-approves only safe read tools (e.g. `grep`, `read`). Write tools require
approval, which will not happen in headless mode — so the agent should not attempt them. Still,
inspect `touchedFiles` and the diff after every run. The diff, not a flag, is the guarantee.

`--trust` is always passed to prevent interactive trust prompts in headless runs.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits remain: **surface, don't absorb**
(report Vibe's design decisions, defensible-but-unasked turns, and non-blocking nitpicks) and **stop
for scope changes** (if correct completion needs going beyond the brief, ask instead of expanding the
mandate). See [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — structure, report contract,
  real gates, argv delivery, and delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — flags, artifacts,
  `result.json`, polling, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) — review checklist, commit boundary,
  and rework through Vibe sessions.
- [references/multi-task-queues.md](references/multi-task-queues.md) — sequential queues, constraint
  carry-forward, progress tracking, and the final coherence pass.
