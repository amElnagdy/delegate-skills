# Writing the brief

A brief is the entire task as Hermes will see it. A dispatched Hermes session runs in a fresh
process with **no memory of your conversation, no access to your prior notes, and no shared
context** — only the text you send and whatever it can read from disk with its own tools
(including any project rules it finds in the repo).
If a constraint isn't in the brief or discoverable in the repo, it doesn't exist for Hermes. The
single most common failure is a brief that assumes context Hermes doesn't have.

## Every file target is an absolute path

Unattended, Hermes resolves **relative paths against its default workspace — the user's home
directory — not against the shell directory you dispatched from**, even inside a git repo and even
though the relay passes `--in <dir>`. There is no flag or environment variable that overrides this;
it is a property of how headless Hermes anchors its tools.

So the brief must spell out every file target as an **absolute path under the dispatch root**:

- ❌ "add `slugify()` to `lib.js`" — risks landing `lib.js` in the home directory
- ✅ "add `slugify()` to `/Users/me/work/myrepo/lib.js`"

The relay re-verifies after the run (`touchedFiles` shows where edits actually landed) and warns
loudly when a run wrote outside the dispatch root — but the warning comes after the mess. Put the
absolute paths in the brief and there is nothing to clean up.

## The shape that works

State the task, what "done" looks like, the constraints that actually matter, and how to report.
Keep it compact; add a section only when the task needs it.

```text
<task>
One or two sentences: the concrete job and where it lives (absolute paths). Then the specifics —
current state, what to change, and explicitly what to leave untouched. The "leave untouched" list
is what keeps Hermes from wandering into unrelated refactors.
</task>

<verification_loop>
Run these before finishing and fix anything they surface, don't just report it:
  <the project's real test command>
  <the project's real lint/format command>
Confirm git status in <dispatch root> shows only the intended changes afterward.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add or git commit — the orchestrator commits after reviewing. Leave
the work uncommitted in the working tree.
</action_safety>

<report_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched (absolute paths)
  3. Gate outcomes (paste the test/lint counts)
  4. Anything you deviated on, left open, or want a decision on
</report_contract>
```

That four-block skeleton covers most implementation tasks. Reach for the extra sections when the
task profile calls for them:

- **Debugging / open-ended fixes** — add a completeness clause (resolve fully, don't stop at the
  first plausible fix) and a missing-context rule (don't guess repo facts; find them or state what
  is unknown).
- **Review / diagnosis (read-only)** — add grounding rules (every claim backed by file evidence;
  inferences labeled), tell Hermes in the brief not to edit anything, and dispatch with
  `--read-only`. Note read-only is best-effort on Hermes, not a hard block — verify `touchedFiles`
  after the run.
- **Research / recommendations** — add a mode clause (separate observed facts, inferences, open
  questions).

## Discover the real gates — don't hardcode

`<verification_loop>` is only useful if it names the project's *actual* commands. Read the repo's
`CLAUDE.md` / `AGENTS.md` / `Makefile` / `package.json` first and copy the real ones in (`make test`,
`npm run lint`, `cargo test`, `pytest -q`, whatever it is). A brief that says "run the tests"
without naming them gets you a Hermes that guesses — or skips.

## Honor the repo's conventions

House rules in the repo (style guides, forbidden patterns, commit conventions) apply only as far as
Hermes finds and follows them. If the project forbids certain things in code — spec IDs in
comments, process language like "MVP"/"for now"/"phase N", specific test conventions — restate the
load-bearing ones in the brief too, because compliance is only as reliable as what's in front of
the implementer.

## One task per brief

Keep each brief to a single, bounded job. "Review this, fix what you find, update the docs, and
suggest a roadmap" produces a muddled run; split it into separate dispatches. One brief → one
dispatch → one commit keeps review and rollback clean, and lets a later task assume the earlier one
landed.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the
fact block before sending — ownership, target branch, constraints, anything a judgment call rests
on. If a premise turns out wrong while the run is live, stop the run and re-dispatch a corrected
brief rather than discounting the output afterward; for a write-capable run, inspect the working
tree and reconcile any partial or premise-contaminated edits — keep or revert them — before the
re-dispatch.

## A worked example

```text
<task>
In the payments service at /Users/me/work/billing/services/refund.py, the refund path double-charges
when a refund is retried after a network timeout (the idempotency key isn't checked before
re-submitting). Make the refund submission idempotent: check for an existing refund by idempotency
key before creating a new one. Touch only /Users/me/work/billing/services/refund.py and its test
file. Leave the charge path, the API routes, and the data models untouched.
</task>

<verification_loop>
Run and make green before finishing:
  pytest tests/billing/ -q
  ruff check services/
Confirm git status in /Users/me/work/billing shows only refund.py and its test changed.
</verification_loop>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add or commit;
leave changes in the working tree for review.
</action_safety>

<report_contract>
Report: (1) the root cause and your fix, (2) files touched (absolute paths), (3) pytest + ruff
outcomes with counts, (4) anything you left open or want decided.
</report_contract>
```

Send this with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
