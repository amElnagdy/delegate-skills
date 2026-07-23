# Reviewing the Delegated Result

This is lightweight guidance, not a mandatory review process. Use it only where it helps the current task and project workflow.

Treat delegated output as an independent engineering opinion. The orchestrator remains responsible for repository inspection, edits, tests, and the final decision.

## General guidance

- Confirm that the response addresses the supplied brief.
- Verify material claims against the repository or requirements when practical.
- Separate correctness concerns from preferences or speculative redesign.
- Respect the task scope and the project's existing conventions.
- Do not claim that the delegated model inspected files, executed commands, or ran tests.

## Plan results

Consider whether the plan matches the actual architecture, covers the important requirements, stays reasonably scoped, and suggests useful validation.

The plan may be accepted, simplified, combined with the current approach, or rejected.

## Advice results

Consider whether the advice identifies real risks, relevant edge cases, meaningful trade-offs, or a simpler alternative.

Use the advice to support the decision rather than replace engineering judgment.

## Review results

Evaluate findings independently. A finding may be treated as:

- `Blocker` — a confirmed issue that prevents safe approval.
- `Important` — a confirmed issue that would normally be addressed before landing.
- `Minor` — a low-risk quality, clarity, maintainability, or test improvement.
- `Rejected` — unsupported, incorrect, preference-only, intentionally deferred, or outside the task scope.

For accepted findings, apply an appropriate change and rerun affected gates when the project workflow calls for it.

Avoid repeated delegation for minor stylistic suggestions or changes that do not materially affect the implementation.

## Final decision

The orchestrator may approve, approve with follow-up, request changes, or reject the delegated result as unreliable. The final decision always remains with the orchestrator.
