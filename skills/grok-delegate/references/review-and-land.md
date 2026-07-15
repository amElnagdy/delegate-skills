# Review and land

The implementer's report is not evidence. The orchestrator owns verification.

1. Read `result.json`, `stderr.txt`, and the raw events when the run was incomplete or ambiguous.
2. Inspect `git status`, `git diff --stat`, and the full diff.
3. Compare every changed file against the brief and explicit exclusions.
4. Re-run the repository's real test, lint, typecheck, build, migration, or generation gates.
5. Check architecture boundaries, migrations and reversibility, generated-file drift, and dangling references.
6. Confirm Grok did not create commits or push branches.

Reject the result when it is incomplete, broadens scope, relies on unverified assumptions, changes
unrelated files, weakens tests, or reports gates that the orchestrator cannot reproduce.

For corrections, write a small delta brief with concrete findings and resume the same session:

```bash
node relay.mjs --brief corrections.txt --cd /path/to/repo --session <session-id>
```

Review the entire accumulated diff again, not only the latest edits. Commit only after the diff and all
required gates pass. The orchestrator authors the commit message and owns the landing decision.
