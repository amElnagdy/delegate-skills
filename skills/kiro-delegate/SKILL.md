---
name: kiro-delegate
description: >-
  Delegate a bounded coding task to the Kiro CLI as a headless implementer, then review its
  working-tree diff and land it yourself. Use when the user explicitly asks to delegate work to
  Kiro, Kiro CLI, or kiro-cli. Do not use for small inline edits, review-only work, or when Kiro
  authentication and the applicable Kiro/AWS terms have not been accepted.
license: MIT
compatibility: Requires Node.js 18+, git, and an authenticated Kiro CLI (`kiro-cli`) whose capabilities pass relay preflight; accepted Kiro/AWS terms are required for headless use.
metadata:
  version: 0.1.0
---

# Kiro CLI Delegate

You are the **orchestrator**. This skill delegates one bounded implementation task to a separate
Kiro CLI process. Kiro edits the working tree; you own the brief, judgment, verification, and Git
commit.

Kiro's public guidance may restrict third-party harness use. Confirm that the intended Kiro/AWS
account terms permit this automated use before dispatching.

## When not to use

- The task is small enough to implement directly or is review-only.
- `kiro-cli` is unavailable, unauthenticated, or needs interactive clarification.
- The task is not bounded enough to review as one diff.

## Prerequisites

1. `--cd` is an existing Git worktree with a verifiable, non-unborn `HEAD`.
2. `kiro-cli --version` and `kiro-cli chat --help` pass relay capability preflight.
3. Headless authentication is configured, preferably with `KIRO_API_KEY`; never put it in a brief,
   command argument, repository file, or result artifact.

The child receives a sanitized environment by default. `--inherit-env` is an explicit unsafe opt-in;
artifact redaction still applies. Redaction covers known environment values, not secrets read from
files, MCP, or external services.

## Workflow

1. Write one complete brief using [writing-the-brief.md](references/writing-the-brief.md).
2. Dispatch with the relay, for example:

   ```powershell
   node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd "C:\path\to\repo" --trust-tools=fs_read,fs_write,execute_bash,grep,glob,code
   ```

3. Read `result.json`, inspect `git status --short`, `git diff`, and `git diff --cached`, then rerun
   the gates yourself. The relay never commits, pushes, or creates a PR.
4. Resume only the same task with `--resume` or `--resume-id <UUID>` and a delta brief.

Use the smallest explicit tool set needed. Do not use `--trust-all-tools` unless the user explicitly
accepts unrestricted Kiro tool approval.

## Result contract

The relay writes `delegate-relay.result.v1` with `status`, `exitCode`, `signal`, Kiro's final report,
`touchedFiles` (`null` when Git cannot report, `[]` when clean), and a session id when exposed. It
also records lane/permission/workspace metadata, preflight results, redaction metadata, and artifact
paths. A changed HEAD or unknown Git state is a failed boundary requiring inspection.

## References

- [writing-the-brief.md](references/writing-the-brief.md)
- [dispatch-and-poll.md](references/dispatch-and-poll.md)
- [review-and-land.md](references/review-and-land.md)
- [multi-task-queues.md](references/multi-task-queues.md)
