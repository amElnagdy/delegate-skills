---
name: qoder-delegate
description: >-
  Delegate a coding task to the Qoder CLI (`qodercli`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user asks to have Qoder implement, fix, refactor,
  or run a queue of coding tasks while the orchestrator remains the reviewer. DO NOT USE for tasks
  small enough to do inline, or when the user wants code written directly without delegation.
license: MIT
metadata:
  version: 0.1.0
---

# Qoder Delegate

You are the **orchestrator**. Delegate one bounded coding task to a separate **implementer** - Qoder CLI -
then review what it produced and land it yourself. You write the brief and own the judgment; Qoder
edits the working tree in its session; you verify and commit.

The loop needs only shell and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- `qodercli` is not installed or authenticated.
- You want to write the code yourself or need only an interactive Qoder session.

## Prerequisites (check once)

```bash
command -v qodercli
qodercli --version
qodercli --list-models
```

If the binary is missing, install it using the cURL, Homebrew, or npm method in Qoder's
[official Quick Start](https://docs.qoder.com/en/cli/quick-start). Authenticate with `qodercli login`,
or set `QODER_PERSONAL_ACCESS_TOKEN` for automation. A successful `--list-models` confirms the current
account can return its live model catalog.

## Choose model and context window

Qoder's available models can change. If the human requests a model, use its exact current value from
`qodercli --list-models`; never invent or pin a catalog entry. Otherwise omit `--model` and let Qoder
use its current default.

`--context-window <n>` is optional. Pass a positive integer only when the human requests a size or the
task needs an explicit budget. Qoder applies it only to supported models; surface an unsupported
model/size error instead of silently choosing another value.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

Qoder sees the brief plus what it can inspect in the workspace, not this chat. Include the goal,
current state, what to change, what to leave untouched, the project's **actual** gates, and a closing
report contract. Tell Qoder not to commit. Keep one task per brief. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled relay. It wraps Qoder's non-interactive `stream-json` mode and writes `result.json`.
`<skill-dir>` is the installed folder containing this `SKILL.md`.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a live model:                 add --model "<value from qodercli --list-models>"
# request a supported context window: add --context-window 32768
# resume the latest session:          add --resume-last  # delta brief only
# resume a specific session:          add --session <id> # delta brief only
# see every option:                   node .../relay.mjs --help
```

Implementation runs default to Qoder's `accept_edits` permission mode. The relay never bypasses
permissions unless the caller explicitly passes another mode, and it never commits. See
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The relay blocks until Qoder exits. Run it with the orchestrator's background-command facility, or
background it in the shell and wait for `result.json`. Completion means the process exited and the
file contains a `status`; do not trust a progress display.

A pre-run usage error exits 2 and writes no result. Missing `qodercli` exits 127 and writes
`status: "qoder_unavailable"` with installation guidance.

Native Windows relay launch is not yet verified; do not claim it until a native Windows smoke passes.

### 4. Review - do not trust the self-report

Treat Qoder's final message and gate outcomes as claims:

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Check any `--add-dir` workspaces separately; their changes are not in the primary tree report.
- Run relevant guard skills if installed.
- Round-trip migrations and grep for dangling references after removals or renames.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits; **the orchestrator commits**. Commit only after the gates pass and the diff
holds. If rework is needed, send a delta brief with `--resume-last` or `--session <id>`, then review
again.

## Permission model

Qoder print mode cannot show approval prompts. The relay defaults to `accept_edits`, which permits safe
workspace edits while Qoder continues to deny or classify riskier actions. `default` can deny actions
that would require a prompt; `dont_ask` fails closed; `auto` makes non-interactive allow/deny decisions;
`bypass_permissions` is for explicitly trusted runs only. Qoder safety checks may still deny an action
in broader modes. Review the diff after every run.

## Authorization model

Delegation is something the human opts into. Once they ask for it, landing verified, gate-passing work
is the contract. Two limits remain: **surface, do not absorb** (report Qoder's design decisions and
non-blocking deviations) and **stop for scope changes** (ask before expanding beyond the brief). See
[references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - brief structure, real gates,
  report contract, secrets, and delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, model/context controls,
  artifacts, result fields, sessions, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - independent review, commit boundary,
  and rework.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues, constraint
  carry-forward, progress tracking, and final coherence.
