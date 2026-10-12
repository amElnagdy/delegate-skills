# Multi-task queues

Sometimes you want to run a sequence of tasks through CodeBuddy without babysitting each one. This
reference describes a lightweight queue discipline that keeps the orchestrator in control without
turning into a framework.

## When to queue

- A refactor that naturally splits into 3–10 bounded steps (e.g., "rename X everywhere", "migrate Y
  to Z", "remove dead code in A/B/C").
- A test-hardening pass: "make each failing test green, one at a time."
- A feature that decomposes cleanly: "implement endpoint A", "implement endpoint B", "wire them
  together."

Don't queue open-ended research, ambiguous bugs, or anything where step N depends on human judgment
about step N-1's output. Those need a human in the loop.

## The queue file

A simple JSONL file, one task per line, appended as you go:

```jsonl
{"id": "task-1", "brief": "brief-1.txt", "model": "gpt-4o-mini", "lane": "fast", "status": "pending"}
{"id": "task-2", "brief": "brief-2.txt", "model": "gpt-5", "lane": "complex", "status": "pending"}
```

Fields:
- `id` — your tracker; also used as the progress file key.
- `brief` — path to the brief file for this task.
- `model` — model for this task (or omit to use lane default).
- `lane` — optional fleet lane name from `delegate-setup`.
- `status` — `pending` | `running` | `completed` | `failed` | `timeout` | `needs_review` | `rework` | `done`.
- `resultDir` — filled in after dispatch; the relay's `--out-dir` for this task.
- `notes` — free-form; capture review findings, scope changes, rework reasons.

Keep this file in the repo root (or a `.codebuddy-queue/` subdir) so it survives across sessions.

## The progress file

A separate JSON file tracking aggregate state:

```json
{
  "queueFile": "queue.jsonl",
  "startedAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-01-15T10:45:00Z",
  "totals": { "pending": 2, "running": 0, "completed": 3, "failed": 0, "needs_review": 1 },
  "constraints": {
    "maxConcurrent": 1,
    "defaultModel": "gpt-4o-mini",
    "defaultLane": "feature",
    "globalNoAuto": false
  },
  "findings": [
    { "taskId": "task-1", "type": "scope_creep", "detail": "CodeBuddy refactored unrelated util file" },
    { "taskId": "task-3", "type": "design_decision", "detail": "Chose strategy pattern over visitor; defensible but unasked" }
  ]
}
```

## The loop

```bash
# 1. Pick next pending task (respecting maxConcurrent)
# 2. Update its status to "running"
# 3. Dispatch with relay.mjs (backgrounded if your orchestrator supports it)
# 4. On completion:
#    - Read result.json
#    - If status !== "completed": mark task failed/timeout, log, continue
#    - If status === "completed":
#        * Run the review checklist (review-and-land.md)
#        * If clean: commit, mark task "done"
#        * If issues: mark task "needs_review" or "rework", append to findings
# 5. Update progress file
# 6. Repeat until queue drained or human intervenes
```

Carry constraints forward: if task 3's brief says "follow the same error handling pattern as task 1",
attach task 1's diff or a summary to task 3's brief. The progress file's `findings` array is the
canonical place for "this pattern was established in task X" so later tasks don't reinvent it.

## End-of-run coherence check

When the queue drains, don't just ship. Do one pass over the *entire* accumulated diff:

- `git diff HEAD~${total_commits}..HEAD` (or `git diff` if uncommitted)
- Run the full test suite once
- Scan for: duplicate patterns, conflicting conventions, speculative surface that accumulated across
  tasks, and whether the overall architecture still makes sense.

If the coherence check fails, open a rework task for the offending area rather than silently fixing
it yourself — the human should know the queue produced something that needed correction.

## Background vs foreground

- **Claude Code:** dispatch each task with `run_in_background: true`; the notification returns the
  `result.json` path. You can have 2–3 in flight if `maxConcurrent > 1`, but 1 is safer for review
  quality.
- **Plain shell:** foreground each task (simpler, no polling). If you background, poll `result.json`
  with a short sleep loop.

## Human intervention points

The queue pauses and notifies the human when:
- A task hits `failed`, `timeout`, or `aborted`.
- Review finds `needs_review` issues the orchestrator isn't authorized to resolve (scope changes,
  design decisions, security/auth paths).
- The coherence check fails.
- `maxConcurrent` tasks are running and the orchestrator doesn't support backgrounding.

The human can then: approve a rework delta, adjust the brief, skip a task, reorder the queue, or
stop the queue entirely. The progress file is the handoff surface — it tells them exactly where
things stand.