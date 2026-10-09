# Review and land

The implementer made the changes; you own the judgment. Verify against reality, never the
self-report, and read the diff as generated code because a green gate cannot catch every failure
mode.

## Check tests before trusting gates

If the diff touches existing tests, review those edits first:

- Treat unbriefed test edits as a contract change, not part of the fix.
- Treat newly skipped, disabled, or commented-out tests as failing until proven otherwise.
- Treat loosened assertions the same way: contains/truthy replacing exact matches, broadened error
  types, and widened tolerances all weaken the gate.

## Re-run the gates yourself

`result.json` carries `dsh`'s claims, not evidence. Re-run the project's actual test, lint, and
build commands in the working tree and read their output. Passing is necessary, not sufficient.

For changes with a specialized verification shape:

- **Migrations or schema:** round-trip them and check for drift.
- **Removals or renames:** grep for dangling references.
- **Stateful behavior:** exercise the behavior, not just compilation.

## Read the diff against the brief

Start with `touchedFiles`, open the diff, and compare it to the brief:

- **Scope creep** — changes the brief excluded.
- **Scope shortfall** — missed behavior, edges, or cleanup.
- **Quiet judgment calls** — defensible but unasked decisions that need review.

Cross-check the run's metadata while you are here: `actualModel` confirms which model actually
served the run (a `--model` request may have been outranked by a stored settings selection), and
on a `--read-only` run, `readOnlyViolation` plus `recordedPermissionMode` confirm the posture the
harness recorded — `false` is a measured verdict, `null` means coverage was incomplete and the
tree deserves a direct look.

## The implementer sweep

Check every diff for patterns gates often miss:

- Hardcoded success or fixture data on a real-work path.
- Catch-all error handling that returns a default instead of propagating or recovering.
- Imports, dependencies, methods, and signatures not present in the installed version.
- Unused imports, uncalled helpers, unreachable branches, and scaffolding comments.
- A second client, error idiom, or logging style beside the repo's existing one.
- Tests that assert internals instead of behavior, or near-duplicate test bodies.
- Optional parameters, config flags, and abstractions with no caller.
- Guards for impossible cases that hide trust-boundary validation.

Send anything blocking back as a fresh rework brief, or fix it in the tree, and report either
choice to the human. Run relevant guard skills if installed.

## The commit boundary

When the gates pass and the diff holds, **the orchestrator commits**, never the implementer.
Write a clear message describing what landed.

From dispatch until that commit, the uncommitted working tree is the authoritative copy of the
implementer's work — the only one you can commit from, and often the only copy at all. Never run
`git checkout`, `reset`, `clean`, or a branch switch in the workspace between those two points —
however messy an interrupted run looks, inspect it first: `git status`, `git diff`,
`git diff --cached` for anything the implementer staged (plain `git diff` is blind to the index),
and open any untracked files (`??` in `git status`) directly — they are the implementer's new
files, and no diff shows their contents. The tree is evidence, not clutter. After that inspection
the verdict can legitimately be to discard — work built on a premise you have since corrected,
for example — and then `git checkout`/`clean` is the right tool. The ban is on reflexive cleanup
before anyone has looked.

## Rework: a fresh, self-contained brief

There is no headless resume — `--resume` is rejected by the app, and the `sessionId` in
`result.json` is an audit handle for the on-disk record, not something a new run can continue. So
rework is a **new brief that stands alone**: fold the original brief's constraints, the state the
first run left behind, and the corrections into one document.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief rework-01.txt --cd /path/to/repo
```

State in the rework brief what the tree already contains ("refund.py now checks the idempotency
key; keep that") so the fresh session extends the work instead of redoing or reverting it. Rework
gets the same gate rerun, test review, diff review, and implementer sweep.

Keep rework briefs as narrow as the original, and keep the default `workspace-write` posture in
mind: mutations are confined to the workspace and temp roots, reads are not, and the approval seam
fails closed headlessly. Use `--read-only` for diagnosis-only follow-ups.

## Surface, do not absorb

The human opted into delegation, so committing verified, gate-passing work is the contract. Keep
them in the loop when the work changes shape:

- Report design decisions and defensible-but-unrequested turns.
- Note non-blocking nitpicks you did not block on.
- Stop and ask if correct completion requires going beyond the brief.

For a queue, keep these notes in the progress file described in
[multi-task-queues.md](multi-task-queues.md).
