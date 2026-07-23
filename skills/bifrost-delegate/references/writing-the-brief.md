# Writing the Delegation Brief

This is lightweight guidance, not a required template. Adapt it to the task and the project's existing development process.

The delegated model has no repository access. Include enough context for an independent opinion, but avoid unrelated content.

## General guidance

- State the goal and the question clearly.
- Include only relevant architecture, files, code excerpts, or diffs.
- Use exact names and paths when they help avoid ambiguity.
- Separate confirmed facts from assumptions when practical.
- Do not include credentials, tokens, private keys, or unrelated private content.
- Keep the requested output clear and proportionate to the task.

## Plan mode

A useful plan brief may include:

- the goal and current state;
- relevant architecture or affected areas;
- requirements and constraints;
- known decisions or uncertainties;
- expected validation.

Ask for a focused implementation plan rather than a full redesign unless broader analysis is explicitly needed.

## Advise mode

A useful advice brief may include:

- the proposed approach;
- why it is being considered;
- relevant current behavior;
- constraints and alternatives already considered;
- the specific decision or risk to evaluate.

Ask the delegate to focus on correctness, edge cases, trade-offs, or simpler alternatives as relevant.

## Review mode

A useful review brief may include:

- the original requirements;
- a short implementation summary;
- the relevant final diff or changed areas;
- available test or gate results;
- known limitations or intentionally deferred scope.

Ask for blockers, important issues, minor improvements, and a recommendation when that format is useful.

## Before sending

Check that the selected mode fits the question, the necessary context is present, assumptions are visible, and no secrets are included.
