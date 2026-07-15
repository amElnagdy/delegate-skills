---
name: grok-delegate
description: >-
  Delegate a bounded coding task to the Grok Build CLI as a headless implementer, then independently
  review its diff and land it yourself. Use when the user asks to have Grok Build implement, fix,
  migrate, or refactor code, or to run a queue of implementation tasks through Grok while the
  orchestrator remains reviewer and commit owner. Covers writing a self-contained brief, dispatching
  through the bundled relay.mjs, resuming a session with corrective feedback, reviewing the resulting
  working tree, and committing only after independent verification.
license: MIT
compatibility: Requires the `grok` CLI installed and authenticated, Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.1.0
---

# Grok Delegate

You are the **orchestrator**. Grok Build is a separate **implementer**. You provide a bounded brief,
Grok edits the working tree headlessly, and you inspect the actual diff, rerun the project gates, and
commit only verified work.

## When not to use this

- The task is small enough to complete inline.
- `grok version` fails or Grok is not authenticated (`grok login`).
- The user wants Grok only to review existing work; use `--read-only` with a review brief instead.

## Prerequisites

1. Run `grok version` and confirm the expected binary is on `PATH`.
2. Authenticate with `grok login` (`grok login --device-auth` in a headless environment).
3. Point `--cd` at a git repository and discover its actual test/lint/build commands.

## The loop

### 1. Write a self-contained brief

Grok sees the brief and the working tree, not the orchestrator's conversation. State the goal, scope,
constraints, files or subsystems involved, acceptance criteria, real project gate commands, and a final
report contract. Explicitly tell Grok not to commit or push. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only review:          add --read-only
# resume latest session:    add --resume-last
# resume a known session:   add --session <id>
# inspect every option:     node .../relay.mjs --help
```

The relay launches Grok with headless `streaming-json`, records raw events and the final report, writes
`result.json`, and never commits. By default it auto-approves implementation tool calls so an unattended
run cannot stall on a permission prompt. `--read-only` disables write/edit tools, does not auto-approve,
and fails if the git working-tree status changes. Details:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Treat completion as process state

The relay blocks until Grok exits. A run is complete only when the process has exited and `result.json`
exists. A usage error exits 2 before writing a result. A missing Grok binary exits 127 and writes
`status: grok_unavailable`.

### 4. Review independently

Do not accept Grok's report as evidence. Inspect `git diff`, compare every edit with the brief, rerun the
project's own gates, check for scope creep and dangling references, and use applicable guard skills.
Start with `touchedFiles`, but trust the working tree itself. See
[references/review-and-land.md](references/review-and-land.md).

### 5. Correct or land

When changes are required, send only the review delta back into the same session with `--session <id>`
or `--resume-last`, then repeat the review. When the diff and all gates pass, the orchestrator creates
the commit. One task should produce one reviewed commit.

## Non-negotiables

- The orchestrator reruns gates and owns the commit.
- Grok must never commit or push.
- A self-report is a claim, not evidence.
- Stop rather than silently broaden the task beyond the brief.
- Keep raw `events.jsonl` available when output parsing or a failed run needs diagnosis.

## Trust posture

`scripts/relay.mjs` uses Node built-ins only, makes no network calls itself, reads no credentials, and
shells out only to `grok` and `git`. Authentication remains inside the installed Grok CLI. The helper
stores run artifacts under the system temp directory unless `--out-dir` is supplied.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md)
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md)
- [references/review-and-land.md](references/review-and-land.md)
- [references/multi-task-queues.md](references/multi-task-queues.md)
