# Review and land

Command Code did the typing; the orchestrator owns correctness. Treat `finalMessage` as a claim and
the working tree as evidence.

## Inspect test changes first

Before trusting any green result, inspect edits to existing tests:

- New skips, disabled cases, or commented assertions make the gate weaker.
- Relaxed exact assertions, broader exception checks, and wider tolerances change the contract.
- Deleted tests or fixtures can hide a regression.
- Unbriefed test rewrites are scope changes, not implementation details.

If the yardstick changed without approval, stop and resolve that before interpreting gate results.

## Re-run gates yourself

Run the exact test, lint, format-check, build, and typecheck commands named in the brief. Do not copy
the implementer's claim into your final response. Read your own command output and exit codes.

Use stronger checks where the change demands them:

- Migrations: apply, reverse, and reapply on a disposable target.
- Removals or renames: search for dangling references and stale docs.
- Generated files: regenerate from source and confirm a clean second run.
- Stateful behavior: exercise the actual state transition or failure path.
- Security and money paths: inspect validation, authorization, amounts, rounding, and error handling.

## Read the diff against the brief

Start with `touchedFiles`, then inspect the complete diff:

```bash
git status --short
git diff --check
git diff
git diff --cached --check
git diff --cached
```

Inspect every untracked path listed by status. Compare `gitHeadBefore` with `gitHeadAfter`, require
`gitHeadChanged: false`, `gitIndexChanged: false`, and `gitMutationViolation: false`. These are
final-state tripwires: stage-then-unstage, commit-then-reset, side refs, pushes, and other transient git
operations require permission deny rules and independent review. A clean final porcelain status alone
does not prove their absence.

Check:

- Scope creep: unrelated cleanup, refactors, renames, dependencies, or formatting.
- Scope shortfall: missing callers, error paths, docs, tests, or cleanup required by the task.
- Quiet decisions: defaults or behavior choices the brief did not authorize.
- Git mutations: new commits, branches, staged files, or history changes the implementer was told not
  to make.

Do not revert unrelated pre-existing work. Separate the implementer's edits from dirt that existed
before dispatch.

## Generated-code sweep

Green tests can miss systematic generated-code failures. Check every changed path for:

- Hardcoded success values or fixture data on production paths.
- Catch-all error handling that hides failure behind a default result.
- Plausible but nonexistent imports, methods, flags, or config keys.
- New dependencies that duplicate standard library or installed functionality.
- Placeholder branches, TODO implementations, dead feature flags, or speculative abstractions.
- Secrets, credentials, local absolute paths, machine-specific state, or generated artifacts that do
  not belong in source control.
- Comments and docs that describe intended behavior instead of actual behavior.

Run applicable clean-code, test, docs, security, or domain guard skills after this manual sweep.

## Read-only runs

For `--read-only`, require all four:

1. Relay `autonomy` is `read-only`.
2. Relay `status` is `completed` and `readOnlyViolation` is `false`.
3. `gitMutationViolation` is `false`.
4. Independent repository inspection shows no new changes attributable to the run.

For read-only runs, the relay hashes raw tracked files and nonignored untracked content, including
assume-unchanged and skip-worktree paths. Ignored files and transient changes remain outside that
proof. Preserve independent snapshots when forensic assurance matters. Never reset or clean to make
comparison easier.

## Rework

If the result is close but wrong, write a delta brief containing only:

- What failed review, with file and line evidence.
- Required correction.
- Gates to rerun.
- Scope that must remain unchanged.

Resume the exact `sessionId`:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief correction.txt --cd /path/to/repo --session <id>
```

Then repeat the full review. Do not accept "fixed" without new evidence.

## Land

After diff review and independent gates pass:

1. Confirm the index has no unrelated staged changes. If it does, use an isolated worktree or stop and
   ask; plain `git commit` would include them.
2. Stage intended files only: `git add -- <paths>`.
3. Inspect `git diff --cached --check` and `git diff --cached`.
4. Commit with a message matching repository convention.
5. Confirm final status and report any unrelated pre-existing changes separately.

Do not commit if tests fail, scope is unresolved, output is partial, or Command Code made an unapproved
decision. Never ask Command Code to make the commit; verification and commit stay with the same party.

## Authorization limits

Human approval to delegate covers the brief and verified landing, not silent scope expansion. Surface
defensible but unasked choices. Stop and ask when correct completion requires a new subsystem,
dependency, public API change, destructive operation, or other material expansion.
