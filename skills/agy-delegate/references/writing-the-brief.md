# Writing the brief

A brief is the entire task as Antigravity will see it. It runs in a separate conversation with **no
memory of your conversation, no access to your prior notes, and no shared context** - only the text you
send and whatever it can inspect in the workspace. If a constraint is not in the brief or discoverable
in the repo, it does not exist for Antigravity.

## Model choice

`agy` has a configured default model, so a fresh dispatch does not require `--model`. Pass `--model`
only when the human has named a preferred Antigravity model label for this task. `agy models` shows the
available labels.

A resumed run keeps the conversation context. Send only the delta brief.

## The shape that works

Antigravity responds well to compact, block-structured prompts with XML tags rather than long prose.
State the task, what "done" looks like, how to behave by default, and the few constraints that actually
matter. Add a block only when the task needs it.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics - current state, what to
change, and explicitly what to leave untouched. The "leave untouched" list is what keeps Antigravity
from wandering into unrelated refactors.
</task>

<edit_only>
Edit files only. Do not run shell commands, tests, lint, formatters, typecheck, builds, package managers,
Git commands, or other executables. The orchestrator owns all validation after the edit returns.
</edit_only>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add or git commit - the orchestrator commits after reviewing. Leave the
work uncommitted in the working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Validation not run by design (the orchestrator owns it)
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

That four-block skeleton covers most implementation tasks. Reach for extra blocks when the task profile
calls for them:

- **Debugging / open-ended fixes** - add `<completeness_contract>` (resolve fully, don't stop at the
  first plausible fix) and `<missing_context_gating>` (don't guess missing repo facts; find them or
  state what's unknown).
- **Research / recommendations** - add `<research_mode>` (separate observed facts, inferences, open
  questions).

## Always ask for the report explicitly

The relay captures `agy --print` stdout as `finalMessage`. If Antigravity finishes without a closing
summary, the result is not useful to review. The `<structured_output_contract>` block is what guarantees
a report you can read.

## Keep validation with the orchestrator

Do not copy test, lint, typecheck, build, package-manager, or other shell commands into an edit-only
brief. Discover the project's real gates yourself, run them after Antigravity returns, and repair
confirmed in-scope findings by resuming the same conversation with another edit-only delta brief.
This keeps the edit-only implementer focused on file edits and makes validation evidence the orchestrator's own.

## Honor the repo's conventions

If the project has house rules in `AGENTS.md`, `CLAUDE.md`, or a similar file, restate the load-bearing
ones in the brief. Antigravity can inspect the workspace, but compliance is more reliable when the
important rules are directly in front of it.

## One task per brief

Keep each brief to a single, bounded job. "Review this, fix what you find, update the docs, and suggest
a roadmap" produces a muddled run; split it into separate dispatches. One brief -> one Antigravity run
-> one commit keeps review and rollback clean.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the
fact block before sending — ownership, target branch, constraints, anything a judgment call rests
on. If a premise turns out wrong while the run is live, stop the run and re-dispatch a corrected
brief rather than discounting the output afterward; for a write-capable run, inspect the working
tree and reconcile any partial or premise-contaminated edits — keep or revert them — before the
re-dispatch.

## A worked example

```xml
<task>
In the payments service at services/billing/, the refund path double-charges when a refund is retried
after a network timeout. Make refund submission idempotent: check for an existing refund by idempotency
key before creating a new one. Touch only services/billing/refund.py and its tests. Leave the charge
path, API routes, and data models untouched.
</task>

<edit_only>
Edit files only. Do not run shell commands, tests, lint, formatters, typecheck, builds, package managers,
Git commands, or other executables. The orchestrator will inspect the diff and run the real project
gates after you return.
</edit_only>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add or commit; leave
changes in the working tree for review.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and your fix, (2) files touched, (3) validation not run by design,
(4) anything you left open or want decided.
</structured_output_contract>
```

Send this with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
