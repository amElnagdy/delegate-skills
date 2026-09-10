# Task 1 report: RED behavioral harness

## Status

Completed the requested RED-only test and registration phase. No
`skills/resilient-delegate` production files were created.

## Files

- Added `test/relay/resilient-delegate.mjs` for the resilient controller's
  observable failover, stopping, aggregate, dirty-tree, and Astra-effort
  contracts.
- Added the `resilient-delegate` smoke runner to `test/relay/index.mjs`.
- Registered the utility carve-out in `test/relay/package-shape.mjs` and
  `skills.sh.json`.
- Included the supplied design and Task 1 plan documents in the commit.

## Commit

`70b51cbcd53aecf04d2759e31df4f40badf73805` — `test: add resilient delegation red coverage`

## Commands and observed result

1. `node test/relay-smoke.mjs --only resilient-delegate`
   - Exited 1 with exactly one failed check:
     `resilient-delegate controller is present for behavioral smoke tests`.
   - This is the expected missing-production failure; the test module parsed and
     ran successfully.
2. `node test/relay-smoke.mjs --only package-shape`
   - This is a separate expected RED invocation. It exited 1 because the
     intentionally registered utility has no production directory or `SKILL.md`
     yet; it is not part of the controller test's one-check failure claim.
3. `git diff --check`
   - Exited 0.

## Concern for Task 2

The behavior table drives deterministic attempt outcomes through candidate
`testResult` and `testTouchedFiles` fixture fields. It requires distinct
`failureClass` values for missing versus unauthenticated implementers and exact
`stopReason` values for every non-failover category. Task 2 should keep those
fields test-only (or replace this narrow fixture seam with an equivalent
controlled relay fixture) so the runtime configuration accepts only real
implementer settings.
