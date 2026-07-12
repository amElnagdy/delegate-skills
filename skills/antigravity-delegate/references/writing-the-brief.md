# Writing the brief

A brief is the entire task as agy will see it. agy runs in a fresh conversation with **no memory of
your conversation, no access to your prior notes, and no shared context** — only the text you send and
whatever it can read from the working tree. If a constraint isn't in the brief or discoverable in the
repo, it doesn't exist for agy. The single most common failure is a brief that assumes context agy
doesn't have.

## Match the model to the brief

agy has a usable default model, so a bare dispatch runs; naming one anyway is often worth it:

- **The available set is the account's.** `agy models` lists the choices (Gemini tiers plus partner
  models, depending on the account's plan). If the human has stated model preferences for delegated
  work (in the target repo's `AGENTS.md` or their `CLAUDE.md`), honor those; when in doubt about
  cost-sensitive choices, ask rather than guess.
- **Read the task's difficulty off the brief you just wrote.** A mechanical, well-bounded brief — a
  rename sweep, a library migration, a dead-code removal — is safe on a fast model. A brief whose risk
  lives in judgment — a concurrency fix, a money or auth path, an ambiguous spec — wants a strong one,
  because the sweep's failure modes (plausible-but-wrong logic, swallowed errors) are exactly what a
  weaker model produces more of.
- **A resumed run continues its conversation.** With `--resume-last` / `--conversation`, send only the
  delta brief.

## The shape that works

agy responds well to compact, block-structured prompts with XML tags rather than long prose. State the
task, what "done" looks like, how to behave by default, and the few constraints that actually matter.
Add a block only when the task needs it — don't ship empty ceremony.

One agy-specific rule: **name the working root in the brief.** agy's workspace can hold several
directories, and its scratch space is always available — an explicit "work only under /path/to/repo"
line pins the edits where you expect them (the relay adds the directory to the workspace, but the brief
should still say it's the target).

```xml
<task>
One or two sentences: the concrete job and where it lives (the absolute path of the working root).
Then the specifics — current state, what to change, and explicitly what to leave untouched. The
"leave untouched" list is what keeps agy from wandering into unrelated refactors.
</task>

<verification_loop>
Run these before finishing and fix anything they surface, don't just report it:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
Confirm the working tree shows only the intended changes afterward.
</verification_loop>

<action_safety>
Keep changes scoped to the task, inside the working root only. No unrelated refactors, renames, or
cleanup unless required for correctness. Do NOT run git add or git commit — the orchestrator commits
after reviewing. Leave the work uncommitted in the working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate outcomes (paste the test/lint counts)
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

That four-block skeleton covers most implementation tasks. Reach for the extra blocks when the task
profile calls for them:

- **Debugging / open-ended fixes** — add `<completeness_contract>` (resolve fully, don't stop at the
  first plausible fix) and `<missing_context_gating>` (don't guess missing repo facts; find them or
  state what's unknown).
- **Review / diagnosis** — add `<grounding_rules>` (ground every claim in evidence; label inferences)
  and an explicit "do not modify any files" instruction. **Treat that instruction as advisory, not
  enforced** — agy has no read-only mode, so check `touchedFiles` afterward and expect it to be empty.
- **Research / recommendations** — add `<research_mode>` (separate observed facts, inferences, open
  questions).

## Always ask for the report explicitly

agy's `--print` output is the plain text it chooses to print when it stops — there is no structured
event stream to assemble a report from. If the agent finishes a task purely through tool calls and
stops without a closing summary, `finalMessage` comes back thin — not a relay defect, just nothing
said. The `<structured_output_contract>` block is what guarantees a report you can read: it tells agy
to end with a written summary, so the result file carries one.

## Discover the real gates — don't hardcode

`<verification_loop>` is only useful if it names the project's *actual* commands. Read the repo's
`AGENTS.md` / `CLAUDE.md` / `Makefile` / `package.json` first and copy the real ones in (`make test`,
`npm run lint`, `cargo test`, `pytest -q`, whatever it is). A brief that says "run the tests" without
naming them gets you an agy that guesses — or skips.

## Honor the repo's conventions

If the project forbids certain things in code — say, spec/ticket IDs in comments, process language like
"MVP"/"for now"/"phase N", or specific test conventions, whatever the repo's own conventions ban —
restate the load-bearing ones in the brief. agy can read the repo's rules files from the working tree,
but its compliance is only as reliable as what's explicitly in front of it.

## One task per brief

Keep each brief to a single, bounded job. "Review this, fix what you find, update the docs, and suggest
a roadmap" produces a muddled run; split it into separate dispatches. One brief → one agy run → one
commit keeps review and rollback clean, and lets a later task assume the earlier one landed.

## A worked example

```xml
<task>
In the payments service at /home/dev/shop/services/billing/, the refund path double-charges when a
refund is retried after a network timeout (the idempotency key isn't checked before re-submitting).
Make the refund submission idempotent: check for an existing refund by idempotency key before creating
a new one. Touch only services/billing/refund.py and its tests. Leave the charge path, the API routes,
and the data models untouched.
</task>

<verification_loop>
Run and make green before finishing:
  pytest tests/billing/ -q
  ruff check services/billing/
Confirm git status shows only refund.py and its test file changed.
</verification_loop>

<action_safety>
Scope strictly to the refund idempotency fix, inside /home/dev/shop only. No unrelated refactors. Do
NOT git add or commit; leave changes in the working tree for review.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and your fix, (2) files touched, (3) pytest + ruff outcomes with counts,
(4) anything you left open or want decided.
</structured_output_contract>
```

Send this with `relay.mjs` (see [dispatch-and-poll.md](dispatch-and-poll.md)); review the result and
commit it yourself (see [review-and-land.md](review-and-land.md)).
