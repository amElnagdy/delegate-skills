# Writing the brief

A brief is the entire task as CodeNeter will see it. It runs in a fresh session with **no memory of
your conversation, no access to your prior notes, and no shared context** — only the text you send and
whatever it can read from the working tree. If a constraint isn't in the brief or discoverable in the
repo, it doesn't exist for CodeNeter. The single most common failure is a brief that assumes context it
doesn't have.

## What the session loads by itself

Project rules, skills, and project MCP servers load only in folders the user has trusted in an
interactive CodeNeter session. You cannot tell from outside whether a folder is trusted, so do not rely
on it:

1. Read the project's instruction files yourself (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, the
   `Makefile`, `package.json` scripts).
2. Copy every rule whose violation would invalidate the work into the brief: scope limits, forbidden
   patterns, required commands, generated-file policy, commit policy.
3. Name the real gate commands. "Run the tests" is not one.

## The shape that works

A compact, block-structured prompt with XML tags works better than long prose. State the task, what
"done" looks like, how to behave by default, and the few constraints that actually matter. Add a block
only when the task needs it — don't ship empty ceremony.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics — current state, what to
change, and explicitly what to leave untouched. The "leave untouched" list is what keeps CodeNeter from
wandering into unrelated refactors.
</task>

<verification_loop>
Run these before finishing and fix anything they surface, don't just report it:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
If a command is refused, say so in the report instead of claiming it passed.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do not write outside <the paths in scope>. Do NOT run git add, git commit, or git push —
the orchestrator commits after reviewing. Leave the work uncommitted in the working tree. Do not
delegate to another agent or session.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate outcomes (paste the test/lint counts, or say which commands were refused)
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

That four-block skeleton covers most implementation tasks. Reach for the extra blocks when the task
profile calls for them:

- **Debugging / open-ended fixes** — add `<completeness_contract>` (resolve fully, don't stop at the
  first plausible fix) and `<missing_context_gating>` (don't guess missing repo facts; find them or
  state what's unknown).
- **Diagnosis without edits** — add `<grounding_rules>` (ground every claim in evidence; label
  inferences) and say plainly: "Do not edit, create, or delete any file. Report findings only." That
  is an instruction, not a mode: CodeNeter edits files in every `--mode`, including `plan` and `ask`.
  Check the working tree afterwards, because nothing enforces it.
- **Research / recommendations** — add `<research_mode>` (separate observed facts, inferences, open
  questions).

## Match the gates to the approvals

Without `--auto`, CodeNeter refuses terminal commands, so the `<verification_loop>` cannot run. Two
honest options:

- **Approvals off (default):** keep the block, but expect the report to say the commands were refused
  (`tools.refused` in `result.json` counts them). You run every gate yourself during review.
- **`--auto`:** the implementer can run the gates and fix what they surface. Pass it only when the user
  has accepted unattended commands in that repository — `--auto` also approves file deletions and MCP
  calls, with no sandbox.

## Path discipline is scope guidance

CodeNeter has no filesystem boundary: its file tools accept paths outside `--cd`, and with `--auto` its
commands can reach anywhere the process can. Name the files or directories it may change, say plainly
that everything else is off limits, and keep `<action_safety>` in every brief. That is guidance, not a
sandbox. A worktree isolates the checkout but does not contain the process; use a container or another
OS-enforced boundary when writes outside the target tree are unacceptable. `touchedFiles` is only a
review aid: it cannot show ignored files or writes outside the repository.

## `git commit` is not blocked, only forbidden

With `--auto` nothing stops CodeNeter from running `git commit`, so the brief has to tell it not to.
Record `HEAD` before dispatch and keep the "do NOT run git add or git commit" line. If `HEAD` changed,
inspect status, staged and unstaged diffs, and the intervening log first. Only after confirming the
whole commit range belongs to the run, use `git reset --soft <recorded-baseline>` so you can review that
range as a diff.

## Start with plain text

The CLI replaces a prompt that starts with `/name` with a saved command of that name, so the relay
refuses a brief whose first character is `/`. Open with a sentence, or with a `<task>` block.

## One task per brief

Keep each brief to a single, bounded job. "Review this, fix what you find, update the docs, and suggest
a roadmap" produces a muddled run; split it into separate dispatches. One brief → one run → one commit
keeps review and rollback clean, and lets a later task assume the earlier one landed.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the fact
block before sending — ownership, target branch, constraints, anything a judgment call rests on. If a
premise turns out wrong while the run is live, stop the run and re-dispatch a corrected brief rather
than discounting the output afterward; inspect the working tree and reconcile any partial or
premise-contaminated edits — keep or revert them — before the re-dispatch.

## Delta briefs

Rework continues the same session with `--session <sessionId>`, which keeps the conversation, model,
and mode. Send only what changed: the review findings and the paths they concern. `--auto` is not
remembered, so pass it again if the rework needs commands. See [review-and-land.md](review-and-land.md).

## A worked example

```xml
<task>
In the payments service at services/billing/, the refund path double-charges when a refund is retried
after a network timeout (the idempotency key isn't checked before re-submitting). Make the refund
submission idempotent: check for an existing refund by idempotency key before creating a new one.
Touch only services/billing/refund.py and its tests. Leave the charge path, the API routes, and the
data models untouched, and do not write outside services/billing/.
</task>

<verification_loop>
Run and make green before finishing:
  pytest tests/billing/ -q
  ruff check services/billing/
If either command is refused, say so in the report.
</verification_loop>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add or commit; leave
changes in the working tree for review. Do not delegate to another agent.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and your fix, (2) files touched, (3) pytest + ruff outcomes with counts or
"refused", (4) anything you left open or want decided.
</structured_output_contract>
```

Send this with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
