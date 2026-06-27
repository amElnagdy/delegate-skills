# Review and land

OpenCode did the typing; you own the judgment. This is where delegation earns its keep or quietly ships
a mistake. The discipline is simple to state and easy to skip under time pressure: **verify against
reality, never against the self-report, then commit it yourself.**

## Re-run the gates yourself

`result.json` carries OpenCode's own claim that the gates passed. Treat that as a claim, not evidence —
re-run the project's actual test/lint/build commands in the working tree and read the output. A run
that "passed" in OpenCode's report but fails when you run it is exactly the failure this step exists to
catch, and it happens often enough to be worth the minute every time.

For changes with their own verification shape, go further:

- **Migrations / schema:** round-trip them (apply, reverse, re-apply on a scratch target) and check for
  drift, rather than trusting that "the migration is reversible."
- **Removals / renames:** grep the codebase for dangling references to whatever was removed.
- **Anything stateful:** exercise the actual behavior, don't just confirm it compiles.

## Read the diff against the brief

Open the diff (`touchedFiles` in the result is your starting list) and hold it against what you asked
for:

- **Scope creep** — did OpenCode change things the brief said to leave untouched? Unasked refactors,
  renames, "while I was here" edits. These are the most common quality problem in delegated work.
- **Scope shortfall** — did it do the whole task, including the edge cases and cleanup, or stop at the
  first plausible version?
- **Quiet judgment calls** — sometimes OpenCode makes a defensible decision the brief didn't anticipate.
  Don't just accept it because it looks reasonable; understand it and decide.

## Compose with guard skills

This skill produces the work; it doesn't judge code quality. If you have the `guard-skills` package
installed, run the relevant guard on OpenCode's diff before you commit — `clean-code-guard` on
production code, `test-guard` on any tests it wrote, `docs-guard` on documentation. They catch the
systematic failure modes of generated code that a quick read misses. The two packages are designed to
pair: delegate-skills delegates and lands; guard-skills reviews.

## The commit boundary

When the gates pass and the diff holds, **you commit** — the orchestrator, never OpenCode. This is the
deliberate boundary: committing should be the act of the party that verified the work. Write a clear
message describing what landed. If your project attributes co-authorship, that's the place for it.

## Reworking: send the delta, not the whole task

If the review turns up problems, don't restate the entire brief. Continue the same OpenCode session with
just the correction:

```bash
echo "The fix is right, but the test mocks the DB session - use the real migrated fixture instead, and
drop the now-unused import." | node "<skill-dir>/scripts/relay.mjs" --resume-last --cd /path/to/repo
```

(`<skill-dir>` is this skill's install directory — see [dispatch-and-poll.md](dispatch-and-poll.md).)

`--resume-last` continues the most recent session, so it keeps OpenCode's context from the first run and
a short delta is enough. (Use `--session <id>` with the `sessionId` from `result.json` if a newer run
has since become "the last one.") Then review again — rework gets the same gate-rerun and diff-read as
the original, no shortcuts. Repeat until it's right, then commit.

## Surface, don't absorb

The human opted into delegation, so committing verified, gate-passing work is the agreed contract.
But keep them in the loop on anything that changes the shape of the work:

- **Report design decisions** OpenCode made, and any defensible-but-unrequested turns it took.
- **Note non-blocking nitpicks** you chose not to block on, so the human can overrule you.
- **Stop and ask** if correct completion requires going beyond the brief — don't expand the mandate on
  your own. A scope change is the human's call, not yours or OpenCode's.

For a multi-task run, capture these in the progress file rather than letting them scroll past — see
[multi-task-queues.md](multi-task-queues.md).
