# Writing the brief

A brief is the entire task as `dsh` will see it. It runs in a separate session with **no memory of
your conversation, no access to prior notes, and no shared context** — only the text you send and
whatever it can inspect in the workspace. If a constraint is not in the brief or discoverable in the
repo, it does not exist for `dsh`.

One shortcut: `dsh` auto-loads applicable `AGENTS.md` / `CLAUDE.md` context files from the workspace
(measured: a rule stated only in the repo's `AGENTS.md` was followed by a headless run), so
conventions written there reach `dsh` without inlining. Restate the load-bearing rules in the brief
anyway — the brief is the contract.

## How the brief travels

`dsh --profile headless` takes the task **only as a positional argv value** — it reads no stdin
(measured: a piped task with no positional exits 1, "a task is required") — and multiple positional
words are space-joined, so a multi-line brief cannot ride argv. The relay therefore writes your
brief verbatim to `<out-dir>/brief.md` and passes this fixed one-line pointer as the task
(keep it in lockstep with `relay.mjs`):

```
Read the task brief at <out-dir>/brief.md and execute it fully.
```

The `workspace-write` sandbox confines mutations, not reads, and leaves the platform temp roots
writable, so the implementer can read the pointer file. Consequences for you: the brief lands on
disk under the run directory — keep secrets out of it and reference environment variables or
workspace files instead — and there is no argv size cap to worry about.

## Rework is a fresh brief, not a delta

The headless surface has no resume (`--resume` is rejected; measured). Every dispatch starts a
fresh session that remembers nothing. So a rework brief must be **fully self-contained**: fold the
original brief's constraints plus the corrections into one document. Never send only "fix the test
you just wrote" — there is no "you just" for a fresh session.

## The shape that works

Use a compact, block-structured brief. State the task, what done means, the few constraints that
matter, and the report `dsh` must return.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics - current state, what to
change, and explicitly what to leave untouched. The leave-untouched list prevents unrelated refactors.
</task>

<verification_loop>
Run these before finishing and fix anything they surface, do not just report it:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
Confirm the working tree shows only the intended changes afterward.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add or git commit - the orchestrator commits after reviewing. Leave the
work uncommitted in the working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate outcomes (include test/lint counts)
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

Add extra blocks only when the task needs them:

- **Debugging or open-ended fixes** — add `<completeness_contract>` (resolve fully, not just the
  first plausible cause) and `<missing_context_gating>` (find missing repo facts or state what is
  unknown).
- **Research or recommendations** — add `<research_mode>` (separate observed facts, inferences, and
  open questions), and dispatch with `--read-only` so the sandbox refuses writes.

## Always ask for the report explicitly

The relay's `finalMessage` is `dsh`'s final stdout text — the harness prints exactly the final
assistant message. Without a closing summary, the edits may exist but the result is hard to review.
The `<structured_output_contract>` block makes the expected report explicit.

## Discover the real gates

Read the repo's `AGENTS.md`, `CLAUDE.md`, `Makefile`, `package.json`, or equivalent first and copy
the actual commands into `<verification_loop>`. A brief that says only "run the tests" makes the
implementer guess or skip them.

## Size the brief for the model that will serve it

`dsh` deployments often serve a locally hosted model with a context window far smaller than hosted
frontier models — `result.json`'s `actualModel` and `usage` show what served the run and what it
cost. For a small-context deployment: keep briefs lean, point at workspace files instead of inlining
them, keep the leave-untouched list tight, and split wide tasks into more, smaller queue items. The
`usage.inputTokens` trend across a queue is the early warning that briefs are outgrowing the
context.

## One task per brief

Keep each brief bounded. One brief → one `dsh` run → one reviewed commit keeps the diff and rollback
clean. Split mixed implementation, review, documentation, and roadmap requests into separate
dispatches.

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

<verification_loop>
Run and make green before finishing:
  pytest tests/billing/ -q
  ruff check services/billing/
Confirm git status shows only refund.py and its test file changed.
</verification_loop>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add or commit; leave
changes in the working tree for review.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and fix, (2) files touched, (3) pytest and ruff outcomes with counts,
(4) anything left open or needing a decision.
</structured_output_contract>
```

Dispatch with [dispatch-and-poll.md](dispatch-and-poll.md), then review and commit with
[review-and-land.md](review-and-land.md).
