# Review and land

Treat Freebuff's work exactly like any other untrusted implementation diff.

## Review order

1. Read `result.json` and note the relay status.
2. Run `git status --short` and inspect the full diff.
3. Compare every touched file to the brief.
4. Re-run the project's actual gates yourself.
5. Check for unrelated edits, generated files, credential material, and accidental commits.
6. If the task is incomplete, prepare a delta brief and resume the same Freebuff conversation when you know
   its conversation id.

## Commit boundary

Freebuff is told not to commit, but the relay does not enforce that policy by parsing Freebuff's chat.
Before landing, verify:

```bash
git status --short
git diff --stat
git log -1 --oneline
```

Then commit the verified diff yourself.
