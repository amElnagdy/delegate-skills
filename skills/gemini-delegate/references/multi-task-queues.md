# Multi-task queues

Queues are an orchestrator concern. Give Gemini one self-contained brief at a time so each result
has a clear diff and gate set. A queue item should name:

- an identifier and exact scope;
- dependencies and the expected base state;
- acceptance tests and the integration target;
- the files or resources it must not touch.

Run the next item only after reviewing the previous result and restoring a clean, known baseline.
Do not resume a session with a different task: use `--resume` only for a short delta brief that
corrects or completes the same work. If the result is ambiguous, stop that item and re-dispatch with
a fresh session rather than layering unrelated prompts.

