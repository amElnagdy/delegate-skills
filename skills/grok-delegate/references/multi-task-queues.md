# Multi-task queues

Run queues sequentially unless tasks are genuinely independent and isolated in separate worktrees.

For each item:

1. Confirm the previous item is reviewed, gate-passing, and committed.
2. Write a fresh self-contained brief with one outcome and one commit boundary.
3. Dispatch Grok and record the resulting session id and artifact directory.
4. Review the actual diff and rerun the relevant project gates.
5. Resume the same session for corrections, or commit the verified result and move on.

Carry forward only verified repository state and explicit constraints. Do not let a previous Grok session
become hidden shared context for a different task. At the end of the queue, run broader integration gates
and inspect the commit series for duplicated abstractions, inconsistent naming, migration ordering, and
cross-task regressions.
