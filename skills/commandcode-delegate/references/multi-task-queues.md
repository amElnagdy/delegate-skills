# Multi-task queues

Run dependent Command Code tasks sequentially. One task gets one brief, one run, one review, and one
commit before the next task starts. This keeps failure recovery and rollback clear.

## Queue contract

For each task:

1. Confirm prerequisites from earlier tasks are present in the working tree or committed history.
2. Write a fresh bounded brief with current repository state and real gates.
3. Dispatch and wait for `result.json`.
4. Review the diff and rerun gates independently.
5. Commit verified work before starting the next task, unless the human explicitly requested one
   atomic final commit and the tasks cannot be reviewed independently.

Stop the queue on failure, scope expansion, ambiguous output, or a gate regression. Do not let a later
task hide or compensate for an earlier failure.

## Continue exact context

The first completed result contains `sessionId`. Prefer exact continuation for dependent work:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief task-1.txt --cd /path/to/repo --out-dir /tmp/task-1

node "<skill-dir>/scripts/relay.mjs" --brief task-2.txt --cd /path/to/repo \
  --session <sessionId-from-task-1> --out-dir /tmp/task-2
```

Use `--resume-last` only when no other headless Command Code run can become "latest" in that working
directory and starting fresh when none exists is acceptable. Exact session ids avoid both fallback
and resuming the wrong queue after concurrent or manual runs.

Send only the delta in resumed briefs. The session already carries prior conversation, but the brief
must still state current goal, scope, gates, no-commit rule, and output contract.

## Carry constraints forward

Later briefs must preserve constraints established earlier:

- Public API and compatibility decisions.
- Files or subsystems left intentionally untouched.
- Migration and generated-code ordering.
- Repository gate commands.
- Human decisions made during review.

Do not rely on model memory for a load-bearing constraint; restate it.

## Model handling

A resumed Command Code session remembers its model. Pass `--model` only when the human names an exact
model or project policy requires one. "Any model" or "model does not matter" means omit the flag. Let
the configured model handle a fresh run and the session retain its model on continuation.

## Independent tasks

Do not share a session merely to save setup when tasks are unrelated. Separate sessions reduce context
contamination. Do not run write-capable tasks concurrently in the same working tree; use isolated git
worktrees when true parallelism is required and the human approved it.

## Final coherence check

After the queue:

- Run aggregate repository gates.
- Search for stale names and dangling references across task boundaries.
- Confirm docs and examples match final behavior.
- Inspect commit order and working-tree status.
- Report any decisions or deviations surfaced during individual reviews.

Queue completion means the combined repository state is coherent, not merely that every relay exited
zero.
