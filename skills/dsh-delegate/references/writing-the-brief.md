# Writing the brief

A brief is the entire task as `dsh` will see it. `dsh --profile headless` runs in a **fresh,
persisted Agent with no memory of your conversation, no access to your prior notes, and no shared
context** — only the text you send and whatever it can read from the working tree. If a constraint
isn't in the brief or discoverable in the repo, it doesn't exist for the implementer. The single
most common failure is a brief that assumes context `dsh` doesn't have.

## What `dsh` already reads — don't restate it

`dsh` loads applicable `AGENTS.md` / `CLAUDE.md` from the workspace root (the relay's `--cd`, which
becomes the child's `cwd` and the harness's `workspaceRoot`) with a **65,536-byte render budget**.
House rules there — style, forbidden patterns, commit conventions — already apply and need not be
copied into the brief. Restate only the load-bearing few the task depends on, because compliance is
only as reliable as what's in front of the model; everything else the file already says stays out of
the brief to save the budget for the task.

## How the brief reaches `dsh`

`dsh --profile headless` takes the task **only as a positional argv value** — no stdin, no
`--message-file`, no prompt flag. `dsh --profile headless --help` documents that positional as
`[task...]` — multiple words are joined by spaces — which is a second, independent reason a
multi-line brief cannot ride argv. To avoid that space-joining and argv mangling (especially under
`shell: true` on win32 for the `dsh.cmd` shim), the relay writes your brief verbatim to
`<out-dir>/brief.md` (under the system temp dir, which is a platform temporary root the
`workspace-write` sandbox allows reading and writing — reads are not confined) and passes a short,
single-line, ASCII-only pointer task as the positional, naming the absolute path and instructing
`dsh` to read it and execute it fully. With an empty positional the harness exits 1 with
`error: a task is required, for example: dsh --profile headless "run the tests"`. The brief is
therefore a file `dsh` is told to read, not inline prompt text. Keep it self-contained and explicit;
`dsh` has no other channel to ask for clarification.

## The shape that works

`dsh` responds well to compact, block-structured prompts with XML tags rather than long prose. State
the task, what "done" looks like, how to behave by default, and the few constraints that actually
matter. Add a block only when the task needs it — don't ship empty ceremony.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics — current state, what to
change, and explicitly what to leave untouched. The "leave untouched" list is what keeps the
implementer from wandering into unrelated refactors.
</task>

<verification_loop>
Run these before finishing and fix anything they surface, don't just report it:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
Confirm the working tree shows only the intended changes afterward.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add or git commit — the orchestrator commits after reviewing. Leave the
work uncommitted in the working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate outcomes (paste the test/lint counts)
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

The effective model is not observable from the run: `--model`/`--provider` write a
`agent-default-model` overlay that overrides the composed default, but a stored selection in
`$DSH_HOME/settings.yaml` layers over that entry and wins (`packages/core/agent-default-model/README.md`:
"That composition entry is the base of the `agent-default-model` Settings section; a mounted settings
provider layers the user's choice over it"). The relay records what was requested as `modelOverlay` in
`result.json` and never reads or writes the user's settings, so do not make the brief depend on a
particular model being the one that runs — state model preferences as capacity hints, not as
guarantees.

That four-block skeleton covers most implementation tasks. Reach for the extra blocks when the task
profile calls for them:

- **Debugging / open-ended fixes** — add `<completeness_contract>` (resolve fully, don't stop at the
  first plausible fix) and `<missing_context_gating>` (don't guess missing repo facts; find them or
  state what's unknown).
- **Review / diagnosis (read-only)** — add `<grounding_rules>` (ground every claim in evidence; label
  inferences) and dispatch with `--read-only` so the run is confined to `read-only`.
- **Research / recommendations** — add `<research_mode>` (separate observed facts, inferences, open
  questions).

## Always ask for the report explicitly

The relay assembles `dsh`'s final message from the stdout it prints when it stops. If the agent
finishes a task purely through tool calls and stops without a closing summary, `finalMessage` comes
back empty — not a relay defect, just nothing said. The `<structured_output_contract>` block is what
guarantees a report you can read: it tells `dsh` to end with a written summary, so the result file
carries one.

## Discover the real gates — don't hardcode

`<verification_loop>` is only useful if it names the project's *actual* commands. Read the repo's
`AGENTS.md` / `CLAUDE.md` / `Makefile` / `package.json` first and copy the real ones in (`make test`,
`npm run lint`, `cargo test`, `pytest -q`, whatever it is). A brief that says "run the tests" without
naming them gets you an implementer that guesses — or skips.

## One task per brief

Keep each brief to a single, bounded job. "Review this, fix what you find, update the docs, and suggest
a roadmap" produces a muddled run; split it into separate dispatches. One brief → one `dsh` run →
one commit keeps review and rollback clean, and lets a later task assume the earlier one landed.
Because there is no resume, each brief must be fully self-contained — a fresh Agent is created for
every dispatch.

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
after a network timeout (the idempotency key isn't checked before re-submitting). Make the refund
submission idempotent: check for an existing refund by idempotency key before creating a new one.
Touch only services/billing/refund.py and its tests. Leave the charge path, the API routes, and the
data models untouched.
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
Report: (1) the root cause and your fix, (2) files touched, (3) pytest + ruff outcomes with counts,
(4) anything you left open or want decided.
</structured_output_contract>
```

Send this with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
