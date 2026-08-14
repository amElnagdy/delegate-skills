# Multi-task queues

Freebuff is interactive, so a queue is sequential and human-supervised.

For each task:

1. Write a fresh self-contained brief.
2. Run `relay.mjs` with `--confirm-human`.
3. Work the task in the Freebuff TUI.
4. Review the resulting diff and re-run the project's gates.
5. Land or reject the diff before moving to the next task.

Do not batch unrelated tasks into one Freebuff conversation. A delta brief is appropriate only when correcting
or completing the same bounded task.
