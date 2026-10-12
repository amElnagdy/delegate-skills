---
name: omniroute-delegate
description: >-
  Delegate a bounded coding task through OmniRoute Launch to a separate Claude Code session,
  then review the result and land it yourself. Use when the user explicitly asks to route delegated
  implementation through OmniRoute or OmniRoute Launch instead of invoking Claude directly.
license: MIT
metadata:
  version: 0.5.0
---

# OmniRoute Delegate

You are the orchestrator. Delegate one bounded implementation task to a separate Claude Code
session launched through OmniRoute, then review its work and land it yourself. The implementer
must never commit; the orchestrator owns verification and commit decisions.

Use this skill only when the human explicitly requests OmniRoute-routed delegation. It is a general
workflow skill and is independent of any particular repository or application.

## Prerequisites

1. Confirm the tools are available:

   ```text
   omniroute --version
   claude --version
   node --version
   git --version
   ```

2. Confirm OmniRoute is serving locally or identify the remote endpoint. The default local endpoint
   is `http://localhost:20128`. OmniRoute can use an active context created with `omniroute connect`.
3. Ensure an OmniRoute API key/token is available through the active context, `OMNIROUTE_API_KEY`,
   `--api-key`, or `--token`. Never place a live key in a brief, repository file, or command log.
4. Confirm the target repository and inspect its applicable agent instructions before writing the
   brief. Copy only the load-bearing constraints and real validation commands into the brief.

If a prerequisite fails, stop and report the exact missing prerequisite. Do not silently invoke the
ordinary `claude` command as a fallback: that would bypass the requested routing boundary.

## The delegation loop

### 1. Write a self-contained brief

The Claude session has no orchestrator conversation history. The brief must include:

- the single bounded task and acceptance criteria;
- the repository path and relevant constraints;
- files or directories it may and may not change;
- the actual test/lint/build gates;
- an explicit instruction not to commit, push, or delegate further; and
- the final report contract: summary, touched paths, commands run, gate results, blockers, and
  unresolved assumptions.

Do not include credentials. Keep one task per brief.

### 2. Dispatch through OmniRoute

The stable entrypoint for this skill is its bundled relay, which emits the shared
`delegate-relay.result.v1` artifact contract:

```text
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

It supports `--lane`, `--remote`, `--api-key`, `--token`, `--port`, `--profile`, `--model`, `--timeout`,
`--resume-last`, `--session`, `--read-only`, and `--dangerously-skip-permissions`. It writes
`brief.txt`, `events.jsonl`, `final.txt`, `stderr.txt`, and `result.json` under a temporary artifact
directory (or `--out-dir`). The relay uses Node built-ins only, never commits, and makes no network
calls of its own.

For direct inspection or troubleshooting, the underlying documented launcher is:

```text
omniroute launch [--remote <url>] [--api-key <key>] [--token <token>] [--profile <profile>] [--port <port>] [Claude arguments...]
```

The launcher injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, health-checks the gateway,
and starts `claude`. It does not write Claude configuration. If a specific model is required, use
an OmniRoute-generated Claude profile:

```text
omniroute setup-claude
omniroute launch --profile <profile-name>
```

For a generic, current OmniRoute launcher, use the documented form when appropriate:

```text
omniroute run claude --model <provider/model> -- [Claude arguments...]
```

Prefer `launch --profile` when the user already uses profiles; prefer `run claude --model` when a
model ID must be selected directly. Do not invent profile names or model IDs: obtain them from the
user, `setup-claude`, or the live OmniRoute catalog.

On Windows, verify how Claude was installed. OmniRoute releases have had `.cmd` versus `.exe`
resolution issues, especially with native Claude installers. If `omniroute launch` cannot resolve
Claude, report the exact error and use the documented generic launcher or a user-approved explicit
Claude executable path only if the installed OmniRoute version supports it. Never bypass OmniRoute
by calling `claude` directly.

When the workflow needs machine-readable completion artifacts, wrap the launch process with the
host's background/process facility and record its exit code, stdout/stderr paths, and process ID.
The OmniRoute launcher itself is a foreground process unless the caller backgrounds it. Do not
claim completion until the child Claude process exits and the recorded artifacts are available.

### 3. Wait and collect results

Wait for the launched Claude process to exit. Record:

- exit code and termination reason;
- OmniRoute/Claude version information when relevant;
- stdout/stderr or relay artifact locations;
- the implementer's final report; and
- the repository state after the run.

Timeouts and crashes are failures, not successful delegation. Preserve the artifacts for diagnosis
and do not automatically retry a task that may have partially modified the worktree.

### 4. Review independently

Treat the implementer's report as a claim. Re-run the repository's actual gates yourself, inspect
complete tracked and untracked changes, and compare every change with the brief. Check especially
that credentials, generated config, unrelated files, and commits were not introduced.

If changes are needed, send a narrow delta brief through the same OmniRoute launch path and review
the resumed result again. Keep the routing boundary unchanged.

### 5. Land

Only after the diff and gates pass may the orchestrator commit, if the human's instructions and the
repository policy permit committing. Otherwise leave the verified changes uncommitted and report the
exact state.

## Remote and model-routing notes

- `--remote <url>` overrides the local port and active context.
- `--api-key <key>` supplies the remote credential; prefer an environment variable or active context
  to avoid exposing secrets.
- `--profile <profile>` selects a Claude profile generated by `omniroute setup-claude`.
- OmniRoute's `auto`, `auto/coding`, `auto/fast`, and provider/model IDs are routing choices, not
  guarantees of a particular upstream model; report the requested route and let OmniRoute determine
  the live eligible target.
- The gateway root URL must not receive an extra `/v1` suffix for Claude Code's Anthropic endpoint.

## References

For the task branch you are executing, read the relevant local reference before dispatch or review:

- [writing-the-brief.md](references/writing-the-brief.md) — self-contained briefs, constraints, gates, and resume deltas.
- [dispatch-and-poll.md](references/dispatch-and-poll.md) — OmniRoute command construction, flags, artifacts, result contract, and failure recovery.
- [review-and-land.md](references/review-and-land.md) — independent gate reruns, diff review, and commit boundary.
- [multi-task-queues.md](references/multi-task-queues.md) — sequential queues, progress tracking, and coherence checks.

The implementation details below are based on OmniRoute's official repository documentation:

The implementation details above are based on OmniRoute's official repository documentation:

- CLI integrations: https://github.com/diegosouzapw/OmniRoute/wiki/CLI-Integrations
- Claude Code configuration: https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/guides/CLAUDE-CODE-CONFIGURATION.md
- Generic CLI launcher: https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/reference/CLI-TOOLS.md

These commands and Windows caveats are version-sensitive. Re-check the official documentation when
OmniRoute or Claude Code is upgraded.
