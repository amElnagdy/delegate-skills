---
name: commandcode-delegate
description: Use when the user wants to hand implementation, a fix, refactor, review, or a sequential coding queue to Command Code, Command Code CLI, `command-code`, or `cmdc`, including phrases such as "have Command Code do X", "delegate this to Command Code", or "run it through Command Code". Do not use for direct inline coding unless delegation was requested.
license: MIT
compatibility: Requires the npm `command-code` CLI with headless JSON support, Node 22+, and git. The CLI must be installed and authenticated. The orchestrating agent must be able to run shell commands and read files. Command Code supports macOS, Linux, WSL, and native Windows.
metadata:
  version: 0.4.2
---

# Command Code Delegate

You are the **orchestrator**. Hand one bounded coding task to Command Code, then review its working-tree
changes and land them yourself. You write the brief and own every judgment; Command Code does the
typing in a separate headless session. The relay never commits.

## When NOT to use this

- The task is faster and safer to do inline.
- `command-code` is unavailable or unauthenticated.
- The user wants direct implementation and did not request Command Code.
- A review is requested, but not specifically a review by Command Code.

## Prerequisites

1. `command-code --no-auto-update --version` and `command-code --help` succeed; help must list `-p`
   plus `--output-format json`. Install with `npm i -g command-code` if needed.
2. `command-code status --json` reports `"authenticated": true`; otherwise run `command-code login`.
3. You are in, or will pass `--cd` for, the target git repository.
4. Confirm candidates with `where.exe command-code` on native Windows or `command -v command-code` on
   POSIX. The relay considers absolute PATH entries only, resolves the npm package entrypoint before
   entering the repository, and runs it with the current Node executable. It records the shim,
   entrypoint, Node, and git paths in `result.json`.
5. Treat the repository as trusted even for read-only runs. Command Code loads project context, and
   write-mode review metadata uses git status. Use an external OS/container sandbox for hostile repos.

On native Windows, never substitute bare `cmd`; that launches `cmd.exe`. Command Code's short Windows
alias is `cmdc`, while full `command-code` works everywhere and is what the relay uses.

## Choose the model

For fresh runs, the relay uses Command Code's configured model. Resumed sessions restore their stored
model. Add `--model <id>` only when the human names that exact model or project policy names one. "Any
model", "default", "model does not matter", or no preference means omit `--model`. The configured or
resumed model is the selection. `command-code --list-models` prints valid ids. Do not guess a different
model: model choice can change cost, limits, and behavior.

## Quick reference

| Intent | Relay option | Command Code mode |
| --- | --- | --- |
| Implement, edit, and test | default | `--yolo` bypass |
| Review or diagnose without repo edits | `--read-only` | enforced `--plan` |
| Continue latest headless session, or start fresh if none exists | `--resume-last` | `--continue` |
| Continue exact session | `--session <id>` | `--resume <id>` |
| Select model | `--model <id>` | `--model <id>` |
| Use an approved fleet lane | `--lane <name>` | Lane dials; explicit flags win |
| Bound dispatch time | `--timeout <dur>` | Relay watchdog; default `30m` |

## The loop

Run five steps for each task. Briefing, review, and landing remain orchestrator decisions.

### 1. Write the brief

The Command Code process does not receive orchestrator chat history. It receives the brief, normal
Command Code taste/memory/config context, target workspace, and prior transcript when resumed. Include
the goal, current state, exact scope, what must remain untouched, the repository's real gate commands,
and a final report contract. Tell it not to stage, commit, or push. Keep one bounded task per brief.

Use [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# use a fleet lane:                  add --lane <name>
# choose a model:                   add --model <id>
# read-only review or diagnosis:    add --read-only
# continue latest headless session: add --resume-last
# continue an exact session:        add --session <id>
# change the 30m watchdog:          add --timeout <dur>
# see every relay option:           node .../relay.mjs --help
```

The helper wraps `command-code -p`, sends the brief on stdin, requests NDJSON with
`--output-format json`, and writes `result.json`, `events.jsonl`, `stderr.log`, and `final.txt` under a
private temporary directory by default. An explicit `--out-dir` must also be outside the target
workspace. Brief text never appears in the process argument list.

Normal implementation runs use `--yolo`. This is Command Code bypass mode, not a workspace sandbox:
ordinary edit, shell, and external-directory prompts are auto-approved. Explicit deny/ask rules and
Command Code's root/home delete circuit breaker still apply. Use this only for trusted repositories
after the human has opted into delegation. A user or managed `permissions.disableBypass` setting can
neutralize `--yolo`; then mutating calls fail or require policy changes rather than silently gaining
access. Read-only runs use `--plan` and never add `--yolo`; the relay rejects repositories containing
submodules because its raw snapshot does not recurse into nested worktrees.

General delegation approval covers ordinary scoped edits inside the target workspace. Before a brief
authorizes destructive operations or any path outside that workspace, get separate explicit human
approval and name that scope in the brief. The relay cannot enforce a workspace sandbox for `--yolo`.

Detailed mechanics: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The relay blocks until Command Code exits. Run it in the background only through the orchestrator's
normal background facility. Completion requires both process exit and a written `result.json`; a
progress line is not completion.

Read `status`, `exitCode`, `finalMessage`, `sessionId`, and `touchedFiles`. A pre-run usage error exits
2 and writes no result. Missing CLI exits 127 with `status: commandcode_unavailable`; watchdog expiry
writes `status: timeout` and exits nonzero.

### 4. Review, never trust the self-report

- Inspect edits to existing tests before treating a green gate as evidence.
- Re-run the repository's actual test, lint, build, and typecheck commands yourself.
- Read the full diff against the brief for scope creep and scope shortfall.
- Verify every new dependency, API, migration, removal, and generated artifact.
- Run relevant guard skills for changed production code, tests, or docs.
- Require `gitMutationViolation: false`; the final-state tripwire fails when HEAD or staged index
  differs after the run. Permission deny rules remain necessary to block transient mutations or push.
- For `--read-only`, require `readOnlyViolation: false`, then still inspect the tree if it was dirty.

Use [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The orchestrator commits only reviewed, gate-passing files. Stage intended paths, inspect the staged
diff, and commit. If corrections are needed, send a delta brief with `--session <id>` and repeat review.
Never ask Command Code to commit for you.

## Authorization model

Delegation is human opt-in. After the human says to proceed, verified work may be committed as part of
that mandate. Two limits remain:

- **Surface, do not absorb:** report unasked design decisions and non-blocking deviations.
- **Stop for scope changes:** ask before expanding beyond the approved brief.

## Red flags

| Wrong turn | Correct action |
| --- | --- |
| Treating Command Code as Claude Code | Use `command-code`; never substitute `claude`. |
| Inventing `run`, `exec`, `--sandbox`, or `--prompt-file` | Use the bundled relay; Command Code headless mode is `-p`. |
| Using bare `cmd` on native Windows | Use `command-code` or `cmdc`. |
| Passing a long brief as an argument | Let the relay send it on stdin. |
| Combining read-only intent with `--yolo` | Use relay `--read-only`, which maps to `--plan`. |
| Choosing a model after "any model" | Omit `--model`; use fresh-run config or resumed-session model. |
| Trusting reported tests or letting the implementer commit | Re-run gates, review diff, then commit as orchestrator. |

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - brief structure, constraints,
  gate commands, and report contract.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - relay flags, artifacts,
  `result.json`, waiting, and failures.
- [references/review-and-land.md](references/review-and-land.md) - review checklist and commit boundary.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues and exact-session
  continuation.
