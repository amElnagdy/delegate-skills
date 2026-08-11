# Review and land

Gemini's output is proposed work, not an approval. After the relay exits:

1. Read `result.json` and the final report.
2. Check `status`, `exitCode`, `signal`, `stopReason`, `error`, and `readOnlyViolation`.
3. Inspect `git diff`, `git diff --check`, and `touchedFiles`; distinguish pre-existing dirt from
   files changed during this run.
4. Run the project's actual gates yourself. A model saying “tests passed” is not evidence.
5. Review security-sensitive, generated, dependency, and migration changes manually.
6. Commit and push only the reviewed diff. The relay never commits or pushes.

`readOnlyViolation: true` means a Git-visible change was detected during a `--read-only` run;
`false` means the available tripwire saw no change; `null` means Git evidence was incomplete. The
tripwire cannot attribute concurrent changes or ignored files, so treat `null` and concurrent dirt as
unknown rather than safe.

If the run timed out, was aborted, failed preflight, or returned malformed output, preserve the
artifacts for diagnosis and dispatch a fresh bounded brief after fixing the cause. Never treat a
partial diff as a complete implementation.

