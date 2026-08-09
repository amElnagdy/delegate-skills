---
name: cline-delegate
description: >-
  Delegate a coding task to the Cline coding agent CLI (`cline`) as a background implementer, then
  review its diff and land it yourself. Use this whenever the user wants to delegate implementation
  work to Cline - phrasings like "have Cline implement X", "delegate this to cline", "run it through
  Cline", or "use cline to implement/fix/refactor" - or wants to run a queue of coding tasks through
  Cline while staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the user
  wants the code written directly without delegating.
license: MIT
metadata:
  version: 0.4.2
---

# Cline Delegate

You are the **orchestrator**. Delegate a bounded coding task to a separate **implementer** - the Cline
coding agent CLI - then review what it produced and land it yourself. You write the brief and own
the judgment; the implementer makes changes in its own session in a clean working tree; you verify
and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `cline` CLI is not installed or authenticated.
- You need a sandboxed implementer. Cline is a coding agent for dev machines: no sandbox,
  no multi-tenancy, and by default it can run `bash`/`powershell` commands as the current user.

## Prerequisites (check once)

1. Install `cline` (npm or bundled binary; the relay probes `cline --version`).
2. Authenticate: run `cline auth` (interactive sign-in), or configure
   `ANTHROPIC_API_KEY` / an OpenAI-compatible base URL.
3. Confirm `cline --version` succeeds.
4. Work in, or point `--cd` at, the target git repository.

## Choose the model (optional)

Cline picks a default model. To choose another, pass `--model <id>` or `--provider <name>`
(e.g. `anthropic`, `openai-native`, `openrouter`). The relay accepts letters, digits,
and `. _ : / -` only (the value reaches a shell on Windows).

`--model` ids must be **vendor-qualified** (`provider/model`, e.g.
`deepseek/deepseek-v4-flash`): cline rejects a bare id like `deepseek-v4-flash`
with "invalid model format, expected modelType/model", and the relay fails fast on a
bare id instead of dispatching a doomed run.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write a brief

Cline sees only the text you send. It cannot read your conversation: the brief must stand alone
with the goal, current state, what to change, what to leave untouched, the project's **real**
gates, and a report contract. Keep each brief to a single task. Write it to a file and pass it as
the relay's `--brief`. See [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled relay. It runs `cline --json -v` with the brief as cline's `[prompt]` positional argument (the transport this relay uses for cline's prompt; cline also accepts piped stdin, but the relay never uses it), captures the JSON event
stream, and writes `result.json`.

On Windows the brief must be a single line without `%`, `!`, `"`, or newlines, and
`--model` ids must be vendor-qualified (`provider/model`) - the relay rejects violations
before dispatch, not after the run starts. See [references/writing-the-brief.md](references/writing-the-brief.md).

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a model / provider:        add --model <id>  --provider <name>
# read-only planning pass:          add --plan
# resume a specific session:         add --session <id>   (delta brief only)
# hard time limit (watchdog):        add --timeout 2h   (the 30m default suits brief runs; most implementation briefs should be 1-2h)
# see all options:                   node .../relay.mjs --help
```

The child's cwd pins the workspace. The relay writes artifacts under the system temp dir by
default and never commits. See [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The relay blocks until cline finishes. Run it with the orchestrator's background-command
facility, or background it in the shell and poll for `result.json`. A pre-run usage error exits 2
and writes no result; a missing `cline` exits 127 and writes `status: "cline_unavailable"`.

Completion means the process exited and `result.json` exists - trust process state and the
working tree, not the progress display. Cline's final message is the `finalMessage` field of
`result.json`.

### 4. Review - do not trust the self-report

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

If the work is good, commit it. The relay never commits - the diff and `result.json` are the
record; run `git status` and `git diff` first to confirm exactly what changed. If the group has a
PR flow, make the commit and push a branch; let human review happen. If the diff is wrong or
incomplete, send a delta brief to the same session with `--session <id>` and review again.

## Autonomy and permissions

Run as a CLI subprocess with `--json -v`, cline has no UI prompts: it executes tool calls
and shell commands immediately, without confirmation. There is no sandbox and no
permission-mode enforcement in headless runs - cline evaluates each tool call and runs
`bash`/`powershell` as the current user, so malformed or malicious briefs are dangerous.
The headless read-only gate is `--plan`, which restricts cline to plan mode (analysis
only, no edits). Plan-first for anything risky: dispatch the brief with `--plan`, review
the plan output, then re-dispatch to the same session without `--plan` to implement. There
is no second agent.

## Authorization model

Delegation is something the human opts into. Once briefed, cline works as a tool you approved use
of. The boundary is: **do not accept conclusions from the self-report**; verify everything on
disk. For anything touching credentials, production data, or irreversible operations, dispatch to
the human first instead of encoding it in a brief.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, scope, gates,
  brief delivery.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts,
  `result.json`, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - what to verify before calling
  the diff done, at the end of a run.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues,
  constraint carry-forward, progress tracking, and the final coherence pass.