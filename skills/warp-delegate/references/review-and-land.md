# Review and land

Warp edits the working tree. **You commit.** That boundary is the point of the skill: the
implementer produces a diff, and a reviewer who did not write it decides whether it ships.

## Why the review is not optional here

Every delegate skill asks you to verify the implementer's claims. Warp raises the stakes: `oz agent
run` has no sandbox, no permission mode, and no read-only run, so nothing constrained what the run
could touch while it worked. The diff is not a courtesy record — it is the only record.

## The checklist

Work through these in order. Stop at the first one that fails and decide whether to rework or
discard.

1. **Read `result.json` first.** Check `status` and `exitCode` before anything else. A `timeout` or
   `aborted` status means the tree may be mid-edit and incoherent.
2. **Start from `touchedFiles`.** It is the porcelain list of what moved. `null` means git could not
   report — inspect the tree by hand. `[]` on a run that claimed edits is a contradiction worth
   chasing.
3. **Re-run the gates yourself.** Do not accept "tests pass" from `finalMessage`. Run the project's
   actual lint, typecheck, build, and test commands and read the output.
4. **Read the whole diff against the brief.** `git diff` and `git diff --staged`. Ask of each hunk:
   did the brief ask for this? Changes outside the brief's stated scope are the thing to catch.
5. **Check what should NOT have changed.** Lockfiles, CI config, formatter config, unrelated
   modules, and anything the brief listed under "leave untouched".
6. **Grep for dangling references** after any removal or rename — imports, string keys, docs.
7. **Round-trip migrations.** Apply and roll back before trusting a schema change.
8. **Run guard skills** if the repository has them installed.
9. **Confirm nothing was committed.** `git log -1` should still be your last commit. The relay never
   commits; if a commit exists, the agent made it despite the brief — treat that as a finding.

## Reading `finalMessage` correctly

`finalMessage` is Warp's self-report: a claim, not evidence. Read it for two things only —

- **Decisions it made that the brief did not specify.** These are the parts you most need to surface
  to the user.
- **What it says it could not do.** Usually accurate, and it tells you where to look first.

Everything else in it — "all tests pass", "no other files changed" — is a hypothesis your gates and
your diff read either confirm or refute. If `finalMessage` is empty on a run that exited 0, read
`events.jsonl` rather than assuming the run did nothing.

## Rework through a conversation

When the diff is close but wrong, continue the same conversation rather than starting cold:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief delta-brief.txt --cd /path/to/repo \
  --conversation "$(jq -r .conversationId /tmp/warp-run-1/result.json)"
```

Warp still holds the earlier exchange, so send only the delta — what was wrong, what to change, what
to leave alone. See [writing-the-brief.md](writing-the-brief.md#delta-briefs).

If `conversationId` is `null`, the stream did not carry one; dispatch a fresh run with a brief that
restates the corrected requirements.

Discard rather than rework when the diff misunderstood the goal, wanders far outside the brief, or
would take longer to correct than to redo. `git checkout -- .` and rewrite the brief.

## Landing

Commit once the gates pass and the diff holds. Write the commit message yourself: it should describe
the change, not the delegation. Do not credit the tool in the message unless the project's own
convention asks for it.

## Surface, don't absorb

Delegation is something the human opted into, and committing verified, gate-passing work is the
agreed contract. Two limits stay with you:

- **Surface, don't absorb.** Report Warp's design decisions, its defensible-but-unasked turns, and
  the non-blocking nitpicks you chose not to fix. Silently smoothing them over hides the
  implementer's judgment from the person who owns the code.
- **Stop for scope changes.** If finishing correctly requires going beyond the brief — a dependency
  bump, a schema change, an interface the brief did not mention — ask rather than expanding the
  mandate yourself.

Also surface the things unique to this implementer: whether the run uploaded a workspace snapshot
(`snapshotDisabled: false`) if the repository is sensitive, and the `runUrl` when someone will want
to inspect the run in Warp.
