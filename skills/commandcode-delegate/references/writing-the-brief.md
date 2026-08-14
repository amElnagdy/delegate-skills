# Writing the brief

The brief carries the task from the orchestrator into Command Code. Command Code has no orchestrator
chat history, but it does retain its normal taste, memory, configuration, workspace context, and a
prior Command Code transcript when resumed. Any constraint that exists only in orchestrator chat must
be repeated in the brief. Missing context produces guesses, scope creep, or an incomplete result.

## Recommended shape

Use compact XML blocks. Add only blocks the task needs.

```xml
<task>
State the concrete goal and location. Describe current behavior, required behavior, and exact scope.
Name files or subsystems that must remain untouched when that boundary matters.
</task>

<verification_loop>
Run these commands before finishing and fix failures rather than only reporting them:
  <the repository's real focused test command>
  <the repository's real lint or format check>
  <the repository's real build or typecheck command>
Confirm the working tree contains only intended changes.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated cleanup, renames, dependency updates, or refactors.
Do not run git add, git commit, or git push. Leave changes uncommitted for orchestrator review.
</action_safety>

<structured_output_contract>
End with:
1. What changed and why
2. Files touched
3. Gate outcomes with useful counts
4. Deviations, open risks, or decisions needed
</structured_output_contract>
```

## Conditional blocks

- Debugging: add `<completeness_contract>` requiring root-cause tracing and a regression check.
- Missing repository facts: add `<missing_context_gating>` requiring inspection instead of guessing.
- Read-only review: add `<grounding_rules>` requiring file and line evidence, state "do not edit", and
  dispatch with relay `--read-only`.
- Research: add `<research_mode>` separating observed facts, inferences, and open questions.

## Use real gates

Read repository instructions and build metadata before drafting. Copy exact commands from files such as
`AGENTS.md`, `CLAUDE.md`, `Makefile`, `package.json`, or language-specific project configuration. Do not
write "run tests" and leave Command Code to guess. If no gate exists, say so explicitly.

## Preserve repository conventions

Restate load-bearing constraints even when they also live in the repo: forbidden files, test style,
generated-code rules, compatibility targets, and the no-commit boundary. Do not paste general style
guides into every brief.

## One task per brief

One brief should produce one reviewable change. Split "fix, refactor, update docs, and propose a
roadmap" into dependent runs. This keeps the diff, failure recovery, and commit boundary clear.

## Example

```xml
<task>
In services/billing/refund.py, retrying a refund after a network timeout can submit the same refund
twice because the idempotency key is not checked before submission. Make refund submission idempotent
and add one focused regression test. Touch only refund handling and its tests. Leave charge creation,
API routes, and data models unchanged.
</task>

<verification_loop>
Run and make green:
  pytest tests/billing/test_refund.py -q
  ruff check services/billing/refund.py tests/billing/test_refund.py
Confirm git status shows only the intended implementation and test files.
</verification_loop>

<action_safety>
No unrelated cleanup or dependency changes. Do not stage, commit, or push.
</action_safety>

<structured_output_contract>
Report the root cause, fix, files touched, exact pytest and ruff outcomes, and anything left open.
</structured_output_contract>
```

Send the brief through `scripts/relay.mjs`; do not place it directly on the command line.
