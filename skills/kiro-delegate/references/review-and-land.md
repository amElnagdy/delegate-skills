# Review and land

The orchestrator owns judgment. Treat Kiro's `finalMessage` as a report, not proof.

1. Read `result.json`, `git status --short`, `git diff`, and `git diff --cached`.
2. Open every untracked file and inspect changed tests before trusting a green gate.
3. Reject scope creep, weakened assertions, commits, changed `HEAD`, unknown Git state, leaked
   secrets, and unrequested file edits.
4. Rerun the project's actual tests, lint, type, build, and specialized gates yourself.
5. Commit only after the diff and gates satisfy the brief. Kiro and the relay never commit.

For rework, use the same workspace and `--resume-id <UUID>` with a delta brief. Review the complete
tree again; resuming is not a verification shortcut. Preserve interrupted work until it has been
reviewed rather than resetting or cleaning it.
