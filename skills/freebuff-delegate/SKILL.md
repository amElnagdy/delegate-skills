---
name: freebuff-delegate
description: >-
  Delegate a coding task to the Freebuff CLI as an interactive implementer, then review its Git diff and
  land it yourself. Use this when the user explicitly wants Freebuff to implement a bounded coding task,
  continue a Freebuff conversation, or run a queue where each task is reviewed before commit. Freebuff is
  an interactive TUI: this skill never injects prompts, simulates keystrokes, or claims headless execution.
license: MIT
compatibility: Requires the `freebuff` CLI installed and authenticated, Node 18+, git, and a real interactive terminal. Freebuff's own CLI currently exposes `--continue` and `--cwd`; it does not expose a documented headless prompt or read-only flag.
metadata:
  version: 0.1.0
---

# Freebuff Delegate

You are the **orchestrator**. This skill lets you prepare a bounded coding task for the **Freebuff** CLI,
open Freebuff in the target repository, and then review the resulting working-tree diff yourself.

Freebuff is intentionally treated as an **interactive TUI implementer**. The relay does not type into the
TUI, paste the brief on the user's behalf, scrape conversation content, or call Freebuff's backend directly.
The human must remain present and start/drive the Freebuff session through the normal CLI.

## When to use this

Use this skill when the user explicitly asks for Freebuff to implement or continue a coding task and the
result will be reviewed from the Git working tree.

Do not use it for:

- headless/CI execution: Freebuff does not expose a documented non-interactive prompt interface;
- read-only review: Freebuff does not expose a documented read-only mode;
- API/server automation: the relay has no network client and must not bypass the official CLI;
- tasks small enough that delegation overhead is not worthwhile.

## Prerequisites

1. `freebuff --version` succeeds.
2. Freebuff is authenticated through its normal login flow.
3. The target directory is a Git working tree.
4. The orchestrator is running in a terminal with stdin/stdout attached to a TTY.

## The loop

### 1. Write the brief

The brief must be self-contained. Include the goal, current state, exact scope, what must remain untouched,
project gates, and the report you want Freebuff to give the human at the end of the session.

The relay writes the brief to `handoff.md`. It does **not** paste or type it into Freebuff.

### 2. Dispatch — human-driven

Run:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo --confirm-human
```

The relay will:

- validate the brief and repository;
- write a durable handoff copy into its output directory;
- print the exact handoff instructions;
- launch `freebuff --cwd <repo>` with inherited terminal I/O;
- optionally add `--continue` or `--continue <conversation-id>` when requested;
- never inject the brief into the TUI.

Resume the latest conversation:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief delta.txt --cd /path/to/repo --resume-last --confirm-human
```

Resume a known conversation id:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief delta.txt --cd /path/to/repo --session <id> --confirm-human
```

The relay requires `--confirm-human` so an orchestrator cannot silently turn an interactive product into an
unattended automation path.

### 3. Review

When Freebuff exits, the relay records `touchedFiles` from Git and writes `result.json`. Do not trust a
human summary as proof of correctness. Re-run the project's actual gates yourself and inspect the diff.

Freebuff has no relay-enforced read-only mode, so every implementation run should be treated as write-capable.

### 4. Land

Only after the gates pass and the diff matches the brief, commit the verified changes yourself.
The relay never commits.

## Result contract

The relay writes `delegate-relay.result.v1` with:

- `status` — `completed`, `failed`, `timeout`, `aborted`, `freebuff_unavailable`, or `handoff_error`;
- `exitCode` and `signal`;
- `freebuffVersion` when the version probe succeeds;
- `finalMessage` — a factual relay-generated completion note. Freebuff does not expose a machine-readable
  final report through the documented CLI surface, so the relay never fabricates one;
- `touchedFiles` — Git porcelain paths, `[]` when clean, or `null` if Git cannot report them;
- `sessionId` when the user supplied a known conversation id. The relay does not read Freebuff's private
  conversation store to discover ids.

## Trust boundary

`relay.mjs` uses Node built-ins only. It makes no network calls, reads or writes no credentials, sends no
telemetry, and only launches `freebuff` and `git` plus the platform process launcher required for Windows
process-tree termination. Freebuff itself performs its normal authentication and service communication.
