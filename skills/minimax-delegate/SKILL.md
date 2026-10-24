---
name: minimax-delegate
description: >-
  Delegate a coding task to the MiniMax Code CLI (`mcode`) as a background implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  MiniMax - phrasings like "have MiniMax do X", "delegate this to MiniMax", "run it through mcode", or
  "use MiniMax to implement/fix/refactor" - or wants to run a queue of coding tasks through MiniMax
  while staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants
  the code written directly without delegating.
license: MIT
compatibility: Requires the `mcode` CLI (MiniMax Code), signed in with `mcode login` or a configured MiniMax API key, Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# MiniMax Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer**, the MiniMax
Code CLI, then review what it produced and land it yourself. You write the brief and own the
judgment; MiniMax does the typing in its own session; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline.
- `mcode` is not installed or signed in.
- You need a CLI-enforced read-only implementer. Every `mcode exec` permission policy can write.

## Prerequisites (check once)

1. Install with `npm install -g @minimax-ai/code`, or the official installer from the
   [MiniMax Code CLI docs](https://agent.minimax.io/docs/cli/quick-start).
2. Sign in with `mcode login --region global` (or `mcode login` for a mainland China account). The
   MiniMax desktop app's sign-in may already cover it.
3. Confirm `mcode --version` succeeds.
4. Work in, or point `--cd` at, the target git repository.

## Choose the model

Omit `--model` to use mcode's configured model (MiniMax-M3.1-Flash out of the box). Pass
`--model minimax/MiniMax-M3` or another `provider/model` id only when the human asks for it.
`--effort` works only on models with effort levels: MiniMax-M3.1-Flash takes `low` through `max`,
MiniMax-M3 takes none.

## The loop

Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

MiniMax sees only the brief and the workspace. Include the goal, current state, what to change, what
to leave untouched, the project's **actual** gates, and a report contract. Tell it not to commit. One
task per brief. See [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

For **Codex orchestration of background work**, install and configure the separate
**codex-background** support utility first. If its MCP tools or registry are missing, stop and report
the setup requirement; do not fall back to model-driven polling. Then invoke its registered
`delegate_run` MCP tool once in place of the shell example below. Other orchestrators use the shell.

(`<skill-dir>` is the installed folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# fleet lane from delegate-setup:  add --lane <name>
# pick a model:                    add --model minimax/MiniMax-M3
# reasoning effort:                add --effort high   (models that support it)
# permission policy:               add --permission full   (smart is mcode's default)
# rework in the same session:      add --session <id from result.json>  (delta brief only)
# hard time limit (watchdog):      add --timeout 2h   (default 30m)
```

The brief goes to mcode on stdin, never argv. The relay writes artifacts under the system temp dir and
never commits. See [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until mcode finishes. Run it with the orchestrator's background-command facility.
Completion means the process exited and `result.json` exists. The report is `finalMessage` in
`result.json`, also printed on stdout between the report markers. A usage error exits 2 with no
result; a missing `mcode` exits 127 with `status: "mcode_unavailable"`.

### 4. Review: do not trust the self-report

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits**, only after the gates pass and
the diff holds. For rework, send a delta brief with `--session <id>` and review again.

## Autonomy and permissions

`--permission` maps to `mcode exec --permission`: `smart` (default) lets mcode judge risky actions,
`full` and `off` skip checks. None is read-only, so `touchedFiles` and the diff are the guarantee of
what changed.

## Authorization model

Once the human opts into delegation, committing verified, gate-passing work is the agreed contract.
**Surface, don't absorb:** report MiniMax's design decisions and unasked turns. **Stop for scope
changes:** if correct completion needs work beyond the brief, ask.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, report contract, real gates, delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts, `result.json`, failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - review checklist, commit boundary, rework.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues and progress tracking.
