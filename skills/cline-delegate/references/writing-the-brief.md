# Writing the brief

A brief is the entire task as cline will see it. It runs in a separate process with **no memory of
your conversation and no shared context** - only the text you send and whatever it can inspect in
the workspace. If a constraint is not in the brief or discoverable in the repo, it does not exist
for cline.

Cline does not auto-load `AGENTS.md` or `CLAUDE.md` context files from the workspace; it sees only
the brief plus the files it reads itself. Repo conventions you rely on must be inlined.

## Model choice and resumed sessions

Cline picks a default model when `--model` is omitted, so a fresh dispatch does not require it.
Pass `--model <id>` only when the human asked for a specific model, or `--provider <name>` to
pick a provider. The relay forwards ids and provider names made of letters, digits, `. _ : / -`
only.

When you do pass `--model <id>`, the id must be **vendor-qualified** (`provider/model`, e.g.
`deepseek/deepseek-v4-flash`) — cline 3.0.52+ rejects a bare id like `deepseek-v4-flash` with
"invalid model format, expected modelType/model". The relay validates the shape before dispatch
and fails fast with exit 2 instead of letting the run die after startup.

A resumed run keeps the session context. Send only the delta brief with `--session <id>` (the
relay maps this to cline's `--id` flag). The session id comes from a previous run's
`result.json`.

## The shape that works

Use a compact, block-structured brief. State the task, what done means, the few constraints that
matter, and the report cline must return.

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

- **Debugging or open-ended fixes** - add `<completeness_contract>` (resolve fully, not just the
  first plausible cause) and `<missing_context_gating>` (find missing repo facts or state what is
  unknown).
- **Research or recommendations** - add `<research_mode>` (separate observed facts, inferences,
  and open questions), and dispatch with `--plan` so cline cannot modify the tree.

## Always ask for the report explicitly

The relay builds `finalMessage` from cline's final `run_result` event text. Without a closing
summary, the edits may exist but the result is hard to review. The `<structured_output_contract>`
block makes the expected report explicit.

## Discover the real gates

Read the repo's `AGENTS.md`, `CLAUDE.md`, `Makefile`, `package.json`, or equivalent first and copy
the actual commands into `<verification_loop>`. A brief that says only "run the tests" makes the
implementer guess or skip them.

## Honor repo conventions

Restate the load-bearing house rules in the brief. Cline can inspect the workspace, but the
important constraints should be directly in front of it.

## One task per brief

Keep each brief bounded. One brief -> one cline run -> one reviewed commit keeps the diff and
rollback clean. Split mixed implementation, review, documentation, and roadmap requests into
separate dispatches.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the
fact block before sending - ownership, target branch, constraints, anything a judgment call rests
on. If a premise turns out wrong while the run is live, stop the run and re-dispatch a corrected
brief rather than discounting the output afterward; inspect the working tree and reconcile any
partial or premise-contaminated edits - keep or revert them - before the re-dispatch.

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

## Brief delivery

The relay passes the brief as cline's `[prompt]` argument - the only transport cline's `--json`
output mode accepts (it rejects a pipe-only invocation with "requires a prompt argument or piped
stdin"). Keep the brief focused so it stays well under OS command-line limits; large context
should be pointed at workspace files cline reads itself. Keep secrets out of the brief anyway on
shared machines - reference environment variables or files with tight permissions.

**On Windows the brief must be a single line**, without `%`, `!`, `"`, or newlines: the relay
launches the `cline.cmd` shim through cmd.exe, which re-parses the quoted `[prompt]` token and
cannot carry those characters. The relay rejects a non-portable brief before dispatch (exit 2);
it never mangles it and sends. On Windows, author the brief as a single line - replace the XML
block markers' newlines with ordinary prose or `|`-joined blocks, e.g.
"`<task>fix the refund double-charge in services/billing/refund.py | verification_loop: run pytest tests/billing/ -q | action_safety: no unrelated refactors, do NOT commit | structured_output_contract: report what changed, files touched, gate outcomes`".
The validated sandbox is the same; only the layout shifts.

Dispatch with [dispatch-and-poll.md](dispatch-and-poll.md), then review and commit with
[review-and-land.md](review-and-land.md).