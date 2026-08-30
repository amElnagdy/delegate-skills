# Dispatch and poll

`scripts/relay.mjs` wraps Cursor's headless print mode (`cursor-agent -p`), captures its structured
stream, and writes a `result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v cursor-agent
cursor-agent --version
cursor-agent status
```

Follow the installer for your platform at [cursor.com/cli](https://cursor.com/cli), inspect what it
will run, then authenticate with `cursor-agent login`. On Windows the CLI installs as a `.cmd` shim;
the relay handles that launch itself, no setup needed.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Cursor model for this run (default: your Cursor default, usually `auto`). Names come from `cursor-agent models`. |
| `--read-only` | Run in Cursor's plan mode: read-only analysis, no edits, no `--force`. |
| `--sandbox <mode>` | Override Cursor's sandbox for this dispatch: `enabled` or `disabled`. |
| `--no-force` | Keep the run write-capable but withhold `--force`; commands requiring approval are refused. |
| `--clarifications` | Recognize the generic clarification envelope and publish `needs_input`; inert unless explicitly enabled. |
| `--session <id>` | Resume a specific Cursor chat (`--resume <id>`); send only the delta brief. |
| `--resume-last` | Resume the most recent Cursor chat (`--continue`); send only the delta brief. |
| `--add-dir <dir>` | Add an extra workspace root on Cursor `2026.07.23` or newer. Repeatable. Edits there are not reported in `touchedFiles`. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). cursor-agent has no timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--session` and `--resume-last` are mutually exclusive. `--session` must be 1–256 characters
(letters, digits, `.`, `_`, `:`, `-`). The child cwd pins the primary workspace; `--add-dir` adds
extra workspace roots only.

## Session identity

The relay captures `sessionId` only from trusted Cursor `system/init` and `result` events, and only
when the value matches the same 1–256 character rule as `--session`. Assistant output, tool events,
and fields inside a clarification envelope are untrusted and cannot select a resume target on any
run. When both init and result report a session id, they must agree before a clarification can
become `needs_input`; a mismatch is a protocol failure.

This rule applies to **every** cursor-delegate run, not only `--clarifications`. A second, weaker
capture path for ordinary completions would let assistant-forged ids become the resume target. One
trust rule keeps `--session` and published `sessionId` on the same boundary.

## Clarification protocol

Clarification is an escape hatch for unresolved judgment, not a replacement for a good brief. Enable
it with `--clarifications` and include the policy from [writing-the-brief.md](writing-the-brief.md).
The implementer must first use the brief, repository, documentation, architecture decisions, and
conventions. It asks only for an ambiguous business rule, conflicting or changed architecture,
unauthorized destructive migration, unclear authorization/security behavior, material scope
expansion, or significant architectural precedent. It asks one blocking question per run.

The entire final report must be one line in this shape:

```text
DELEGATE_CLARIFICATION: {"schema":"delegate-clarification.request.v1","id":"q-001","category":"architecture","question":"Preserve the current relationship or migrate it?","context":{"files":["prisma/schema.prisma"]},"options":[{"id":"A","label":"Preserve it"},{"id":"B","label":"Migrate it"}],"recommended":"B","reason":"The requirement permits multiple relationships.","impact":"Requires a schema migration."}
```

`category` is `business_rule`, `architecture`, `migration`, `security`, `scope`, or `other`.
`context`, `options`, `recommended`, `reason`, and `impact` are optional; `recommended` must identify
a supplied option. IDs, strings, option count, and repository-relative context paths are bounded.
Unknown fields are discarded. A malformed, prose-wrapped, or repeated envelope fails safely instead
of reporting completion. A valid request requires one safe session id from Cursor's init or result
events, and all such trusted events must agree. A session-like value inside assistant output or the
envelope is never a resume target.

Cursor may aggregate earlier progress text into its closing result field. In that runtime shape, the
relay accepts a request only when the final assistant event is itself the exact envelope, the
aggregate ends with that event, and the whole aggregate contains exactly one clarification marker.
Earlier or trailing prose inside the final assistant event remains invalid.

After deciding or obtaining a human decision, preserve the tree and use a separate output directory.
Resume the exact session with a delta brief beginning:

```text
DELEGATE_CLARIFICATION_ANSWER: {"schema":"delegate-clarification.answer.v1","questionId":"q-001","decision":"B","reason":"Approved after architecture review."}
```

Follow that line with any constraints introduced by the decision. A resumed run may complete or ask
the next blocking question. Timeout and cancellation retain their existing statuses and take
precedence over partial assistant text.

The answer envelope is brief content, not a relay control message, so this version deliberately does
not parse it. Session selection remains a separate, validated `--session <id>` argument. This keeps
free-form decisions away from process arguments while Cursor checks the answer against its existing
conversation. If a future relay accepts an answer as a dedicated option or reads prior artifacts
automatically, request/answer matching belongs at that new relay boundary.

A fresh run defaults to write-capable with `--force` (commands run without approval unless your
Cursor config denies them). `--no-force` withholds automatic command approval while retaining file
edits; `--read-only` switches to plan mode instead. The relay always passes `--trust` so a headless
run never stalls on the workspace-trust prompt — point `--cd` only at repositories you trust.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an `--out-dir`
inside the worktree can make the artifacts appear there:

- `brief.txt` — the exact brief.
- `events.jsonl` — raw cursor-agent stdout events.
- `final.txt` — the final report; absent if none was emitted.
- `stderr.txt` — complete stderr.
- `result.json` — the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"cursor-agent"`), `status` (`completed` | `needs_input` | `failed` | `timeout` | `aborted` |
  `cursor_agent_unavailable`), `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `model` (the requested name or `null`), `resolvedModel` (the model Cursor actually
  served, from its init event), `permissionMode` (the mode Cursor reported applying), `readOnly`,
  `force`, `sandbox` (the requested value or `null`, not a claim about what Cursor applied),
  `resumed`, `cursorAgentVersion`, `sessionId`, `startedAt`, and `finishedAt`. `clarifications: true`
  is added only when the opt-in flag is present.
- `clarification` — present only for `needs_input`; the validated
  `delegate-clarification.request.v1` object from Cursor's final report.
- `briefPath`, `finalPath`, `eventsPath`, and `stderrPath`.
- `finalMessage` — the `result` field of Cursor's closing event; when the run died before emitting
  one, the assistant text chunks joined with `"\n\n"` instead. Tool calls and tool results are
  excluded.
- `touchedFiles` — `git status --porcelain` lines for the **final working tree under `--cd` only**,
  not an attribution of Cursor's edits: anything already dirty before dispatch shows up too, and
  edits Cursor makes inside `--add-dir` roots do not show up at all — inspect those trees yourself.
  Dispatch from a clean tree when you want the list to read as "what Cursor changed". `null` means
  git could not report; `[]` means git ran and the tree is clean.
- `usage` — Cursor's token-usage object from the closing result event, or `null` if no result event
  supplied one.
- `stderrTail` — the last 20 non-empty stderr lines on any run that did not complete (`failed`,
  `timeout`, `aborted`), except a launch failure, which reports `failed` with no `stderrTail`.
  `needs_input` is a successful pause and omits `stderrTail`.
- `error` — present for launch failures, when the relay watchdog fires (`timeout`), on an `aborted`
  run, when Cursor's own result event carries `is_error: true`, and when a recognized clarification
  request fails validation (`invalid clarification protocol: …`).

## Waiting for the run, then inspecting status

The helper blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status`. Then branch on that field — do not treat relay exit 0 or the file's existence as
completion:

- **`completed`** — independent gates, diff review, then land or rework.
- **`needs_input`** — do not review as completed and do not land. Obtain a decision, then resume the
  exact `sessionId` with the structured answer and delta described in
  [the clarification protocol](#clarification-protocol).
- **`failed` / `timeout` / `aborted` / `cursor_agent_unavailable`** — handle the failure; do not land.

A pre-run usage error exits 2 and writes no result. A missing `cursor-agent` exits 127 and writes
`status: "cursor_agent_unavailable"`.

Exit 0 means the relay produced a valid successful outcome: `completed` or `needs_input`.
Orchestrators must inspect `result.status`. `needs_input` is exit 0 because Cursor stopped
successfully and the question is actionable; it is not completion.

The relay exit code does not always mirror cursor-agent. A recognized but malformed clarification
request is a protocol failure: `status: "failed"`, `error` beginning `invalid clarification
protocol:`, and a non-zero relay exit even when Cursor itself exited 0. Other child failures keep a
non-zero exit (or 128 plus the signal number when the child dies on a signal).

## When a run misbehaves

- **`status: "cursor_agent_unavailable"` (exit 127):** install the Cursor CLI, authenticate with
  `cursor-agent login`, and re-dispatch.
- **`status: "failed"`:** read `stderrTail`, `stderrPath`, and the tail of `events.jsonl`. If the
  result event carried `is_error: true` the relay reports `failed` even on a zero exit; Cursor's own
  message is in `finalMessage`. An unknown `--model` name fails fast — re-check against
  `cursor-agent models`.
- **`status: "failed"` with `invalid clarification protocol`:** Cursor attempted a clarification but
  did not emit the exact one-line envelope. Preserve the session and partial tree; resume with a
  delta asking it to re-emit a valid request, or make the decision only if the available evidence is
  sufficient.
- **A version-preflight failure:** the relay writes `failed` with the probe's exit code, or `timeout`
  with exit 124 when the probe exceeds the smaller of the run watchdog and 10 seconds. Cursor is not
  dispatched.
- **`status: "aborted"`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to cursor-agent. The result is written before the relay
  exits; inspect the working tree before re-dispatching. On native Windows a hard kill of the relay
  is uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written —
  a relay process that is gone without a `result.json` is an aborted run; inspect the working tree
  and `events.jsonl` directly.
- **`status: "failed"` with `signal: "SIGKILL"`:** the host killed the process, commonly through the
  OOM killer or a supervisor timeout. This is not a Cursor error; check host memory and re-dispatch,
  or split the task into smaller briefs.
- **`status: "timeout"`:** the `--timeout` watchdog killed the run; `error` reads
  `cursor-agent did not finish within --timeout <dur>; killed by the relay watchdog`. Increase
  `--timeout` or split the task. The relay sends SIGTERM, waits 10 seconds, then sends SIGKILL if
  needed (on Windows a single process-tree kill).
- **Empty `finalMessage`:** inspect `touchedFiles` and the diff. Add a
  `<structured_output_contract>` to the next brief to require a closing report.
- **Every command Cursor runs is rejected with "Hook blocked with message: … eval: … syntax error
  near unexpected token `&`" (or Cursor reports "the terminal hook failed"):** a cursor-agent bug,
  not a hook bug. When cursor-agent is launched from a Git Bash (MSYS) console on Windows — which
  is what an orchestrator's bash tool uses — it selects `bash.exe` as its persistent shell while
  still generating its hook wrappers in PowerShell syntax, so every configured hook (its own
  `~/.cursor/hooks.json` and any imported Claude Code `PreToolUse` hooks) errors and Cursor blocks
  the command, fail-closed. File edits still work; command execution does not — which also means
  Cursor cannot run the gates, only claim it could not. Workaround: dispatch the relay from a
  PowerShell or cmd console instead (observed fixed there); or temporarily remove the hook entries
  for the run. Verified on cursor-agent 2026.07.23.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. Whether it also carries the edit contents depends on what the CLI streams,
so treat any reconstruction as unverified until it matches a working-tree diff — when the tree
still holds the work, preserve the tree rather than replaying the log.

## What the relay runs

The argv is equivalent to:

```bash
cursor-agent --print --output-format stream-json --trust \
  [--force | --mode plan] [--sandbox enabled|disabled] [--model <name>] \
  [--resume <id> | --continue] \
  [--add-dir <dir> ...]   # brief on stdin
```

`--no-force` omits both `--force` and `--mode plan`; the run can edit files, but approval-gated
commands are refused.

The brief rides stdin, so it is not visible in the host process list and has no OS argument-size
cap. On Windows the launch goes through the shell so the `cursor-agent.cmd` shim resolves; the brief
still travels on stdin, sandbox, model, session, and directory values are validated, and spaceable
values are quoted.

## The commit boundary

The relay never commits. After a `completed` run, the orchestrator reviews, re-runs the gates, and
commits. A `needs_input` tree is evidence to preserve, not a land candidate. See
[review-and-land.md](review-and-land.md).
