# Review and land

CodeNeter did the typing; you own the judgment. This is where delegation earns its keep or quietly ships
a mistake. The discipline is simple to state and easy to skip under time pressure: **verify against
reality, never against the self-report — and read the diff as generated code, which fails in ways a
green gate can't see.**

Two things to add to the usual routine here. The run had no sandbox and no read-only mode, so "did it
stay inside the brief's paths?" is a question you answer from `touchedFiles`, not one the tooling
answered for you. And a run without `--auto` could not run the gates at all — `tools.refused` says how
many of its attempts were turned down.

## Check the tests before trusting the gates

If the diff touches existing tests, review those edits *first* — before the gate re-run means anything.
A weakened assertion, an added skip, or a deleted test makes the gate measure less than it did before
the run; green is only meaningful if the yardstick wasn't shortened.

- **Unbriefed edits to existing tests are a contract change, not part of the fix.** Flag them, don't
  absorb them.
- **Skipped, disabled, or commented-out tests added in this diff:** treat the underlying test as failing
  until proven otherwise, whatever the annotation's comment claims.
- **Loosened assertions** (exact match relaxed to contains/truthy, error-type checks broadened, tolerance
  widened): same treatment.

## Re-run the gates yourself

A run without `--auto` could not run them. A run with `--auto` only claims it did. Re-run the project's
actual test/lint/build commands in the working tree and read the output, and keep the result in
proportion: **passing is necessary, not sufficient.** An implementer can *game* a gate, not just
misreport it — that is what the test check above and the sweep below exist to catch.

For changes with their own verification shape, go further:

- **Migrations / schema:** round-trip them (apply, reverse, re-apply on a scratch target) and check for
  drift, rather than trusting that "the migration is reversible."
- **Removals / renames:** grep the codebase for dangling references to whatever was removed.
- **Anything stateful:** exercise the actual behavior, don't just confirm it compiles.

## Read the diff against the brief

Open the diff (`touchedFiles` in the result is your starting list) and hold it against what you asked
for:

- **Out-of-scope writes and deletions** — the first check here, not an afterthought. CodeNeter's file
  tools accept paths outside `--cd`, and with `--auto` its commands and deletions ran unattended. Look
  for ` D` lines in `touchedFiles` as hard as for ` M`. `touchedFiles` is a `git status` review aid,
  not containment proof: it misses ignored files and anything outside the repository.
- **Edits on a run told not to edit** — a diagnosis brief that said "report findings only" is still a
  write-capable run, whatever `--mode` it used. An empty `touchedFiles` is the only confirmation.
- **Scope creep** — did it change things the brief said to leave untouched? Unasked refactors, renames,
  "while I was here" edits. These are the most common quality problem in delegated work.
- **Scope shortfall** — did it do the whole task, including the edge cases and cleanup, or stop at the
  first plausible version? A `limit` in `result.json` is a strong hint of a run that stopped mid-task.
- **Quiet judgment calls** — sometimes CodeNeter makes a defensible decision the brief didn't
  anticipate. Don't just accept it because it looks reasonable; understand it and decide.
- **A commit it made itself** — the brief forbids it, but with `--auto` nothing enforced that. Compare
  `HEAD` with the pre-dispatch baseline, then inspect status, staged and unstaged diffs, and the
  intervening log. If the whole range belongs to the run, `git reset --soft <recorded-baseline>` and
  review it as a diff.

## The implementer sweep

Generated code fails in systematic ways that gates are structurally blind to — each of these can sit in
a diff whose tests are all green. Walk them against every diff before you commit:

- **Hardcoded success or fixture data** on a path the brief says does real work — a canned
  `{status: "ok"}` or default return passes tests *by design*.
- **Catch-all error handling that returns a default** instead of propagating — the suppressed failure is
  exactly what the gate would have caught.
- **Unverified imports and API calls** — confirm every new dependency, method, and signature exists in
  the *installed* version (read the lockfile or the package, don't trust plausibility).
- **Dead weight** — unused imports, helpers nothing calls, unreachable branches, "Step 1/Step 2"
  comment scaffolding, comments that restate the line below them.
- **A second way to do what the file already does** — a new HTTP client, error idiom, or logging style
  introduced beside the existing one instead of reusing it.
- **New tests that assert internals** — asserting that an internal helper was called, or mocking the
  project's own functions to isolate a "unit." Green, brittle, and worthless as regression cover.
- **Speculative surface** — optional parameters, config flags, or abstractions with no caller in this
  diff or the repo.
- **Guards for impossible cases** — null/type checks for values the code's own contract already
  excludes.

Anything the sweep catches goes back to CodeNeter as a delta brief (below) or gets fixed in the tree
before commit — and either way is reported to the user (see "Surface, don't absorb").

If the `guard-skills` package is installed, run the relevant guard on the diff for the full treatment —
`clean-code-guard` on production code, `test-guard` on tests, `docs-guard` on documentation.

## The commit boundary

When the gates pass and the diff holds, **you commit** — the orchestrator, never CodeNeter. Committing
should be the act of the party that verified the work, and a self-committed run has to be unpicked
before it can be reviewed. Write a clear message describing what landed.

From dispatch until that commit, the uncommitted working tree is the authoritative copy of the
implementer's work — often the only copy at all. Never run `git checkout`, `reset`, `clean`, or a branch
switch in the workspace between those two points — however messy an interrupted run looks, inspect it
first: `git status`, `git diff`, `git diff --cached`, and open any untracked files (`??` in
`git status`) directly. After that inspection the verdict can legitimately be to discard — work built on
a premise you have since corrected, for example. The ban is on reflexive cleanup before anyone has
looked.

## Reworking: send the delta, not the whole task

If the review turns up problems, don't restate the entire brief. Continue the same CodeNeter session
with just the correction:

```bash
echo "The fix is right, but the test mocks the DB session - use the real migrated fixture instead, and
drop the now-unused import." | node "<skill-dir>/scripts/relay.mjs" --session <sessionId> --cd /path/to/repo
```

`<sessionId>` is the field of that name from the prior `result.json`, and `--cd` must be the folder the
session was saved under. The session keeps its conversation, model, and mode; `--model` and `--mode`
override them. `--auto` is not remembered: pass it again if the rework needs commands. Run one brief at
a time on a session. Then review again — rework gets the same gate re-run, test check, diff read, and
sweep as the original.

## Surface, don't absorb

The human opted into delegation, so committing verified, gate-passing work is the agreed contract.
But keep them in the loop on anything that changes the shape of the work:

- **Report design decisions** CodeNeter made, and any defensible-but-unrequested turns it took.
- **Note non-blocking nitpicks** you chose not to block on, so the human can overrule you.
- **Report any write outside the brief's paths**, and any edit on a run told not to edit, even when the
  change itself looks harmless.
- **Say when the implementer could not verify its own work** because approvals were off, so nobody
  reads its report as a gate result.
- **Stop and ask** if correct completion requires going beyond the brief — don't expand the mandate on
  your own.

For a multi-task run, capture these in the progress file rather than letting them scroll past — see
[multi-task-queues.md](multi-task-queues.md).
