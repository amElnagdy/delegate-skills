# Writing the brief

Freebuff is interactive, but the brief still follows the same contract as every other implementer.
A human will paste it into the TUI, so make it easy to copy as one block.

Use this shape:

```text
GOAL
One sentence describing the desired outcome.

CONTEXT
What exists today and why the change is needed.

SCOPE
- Files/components that may change.
- Behaviors that must be preserved.

OUT OF SCOPE
Explicitly name nearby work that must not be touched.

GATES
Use the commands discovered from AGENTS.md/CLAUDE.md/package scripts/Makefile.
Do not invent project commands.

IMPLEMENTATION NOTES
Constraints, compatibility requirements, and edge cases.

REPORT
Before ending the session, summarize:
- what changed;
- files touched;
- gates run and their results;
- known limitations or follow-up work.

COMMIT BOUNDARY
Do not commit. Leave the verified changes in the working tree for the reviewer.
```

Keep one task per brief. A second task should be a new brief or a delta brief for the same conversation.
