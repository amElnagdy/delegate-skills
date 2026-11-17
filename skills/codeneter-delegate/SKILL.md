---
name: codeneter-delegate
description: >-
  Delegate a coding task to the CodeNeter CLI (`codeneter`) as a background implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  CodeNeter — phrasings like "have CodeNeter implement X", "delegate this to CodeNeter", "run it
  through the codeneter CLI", or "use CodeNeter to implement/fix/refactor" — or to run a queue of
  coding tasks through CodeNeter while staying the reviewer. DO NOT USE for tasks small enough to do
  inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the CodeNeter CLI (`codeneter`, `npm install -g @codeneter/cli`, Node 20.9+) installed and signed in with `codeneter login` (or `CODENETER_AUTH_TOKEN`), and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux).
metadata:
  version: 0.5.0
---

# CodeNeter Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the CodeNeter CLI (`codeneter run`) — then review what it produced and land it
yourself. You write the brief and own the judgment; CodeNeter does the typing in your working tree;
you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- `codeneter` is not installed or not signed in (run `codeneter login`; `codeneter whoami` shows the
  account).
- You need a read-only run. CodeNeter has none: file edits run in every mode. Use a sibling with an
  enforced read-only mode for reviews and second opinions.
- You need writes outside the target tree to be impossible, not just unlikely. CodeNeter has no
  sandbox; use an OS-enforced one such as `codex-delegate`, or run this inside a container.

## Read this before the first dispatch: the autonomy model

`codeneter run` has **no sandbox and no read-only mode**, and its `--mode` (`agent`, `plan`, `ask`)
only guides the agent: file edits run in every mode, and its file tools accept paths outside the
workspace. What it does gate is approvals:

- **Approvals off (the relay's default):** CodeNeter reads and edits files. Terminal commands, file
  deletions, and MCP calls (when the CLI's `approvalPolicy.confirmMcp` is on) need an approval a
  headless run cannot give, so the CLI refuses them and the agent carries on. The implementer
  **cannot run the project's gates** in this posture; `tools.refused` in `result.json` counts what it
  was refused.
- **`--auto`:** approves terminal commands, deletions, and MCP calls for the whole run. Nothing
  sandboxes them. Pass it only when the user has accepted unattended commands in that repository.
- **`autoApprove` in the CLI's config** (`~/.codeneter/config.json`) approves everything with no flag,
  and no flag turns it off for one run. The relay reads that one key and refuses to launch while it is
  on unless you pass `--auto`, so a run you meant to keep approvals-off never silently gets them.

## Prerequisites (check once)

1. `codeneter --version` succeeds and `codeneter whoami` prints your account. If not, install the CLI
   (`npm install -g @codeneter/cli`) and run `codeneter login`.
2. You are in (or will point `--cd` at) the target git repository, and its tree is clean before you
   dispatch — a run with no sandbox is much easier to review against a clean baseline.
3. If you will pin a model, list the exact ids with `codeneter models` (see below).

## Choose the model

Omitting `--model` uses the CLI's configured model, or the saved model when resuming. To pin one, pass
`--model <id>` with a `Model ID` from `codeneter models` — copy it, never infer it from a name. That
list also shows each model's supported effort levels; pass one with `--effort <level>` and the relay
sends `<id>?effort=<level>`. The model that served the run is recorded as `resolvedModel` in
`result.json`.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

CodeNeter sees **only** the text you send plus what it can read in the working tree — no chat history
or shared context. Project rules, skills, and project MCP servers load only in folders the user has
trusted in an interactive CodeNeter session, so copy every load-bearing rule into the brief. Include
the goal, current state, what to change, what to leave untouched, the project's **actual** gates, and
a report contract. Tell it not to commit. Keep one task per brief, and start it with plain text: the
CLI replaces a prompt beginning with `/name` with a saved command, so the relay refuses one. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled helper. It wraps `codeneter run --output-format stream-json`, feeds the brief on stdin,
captures the event stream, and writes `result.json`. (`<skill-dir>` is the installed folder containing
this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# approve commands, deletions, MCP calls:   add --auto  (only with the user's acceptance)
# continue the exact session:               add --session <sessionId>  (from result.json; delta brief only)
# pin a model from `codeneter models`:      add --model <id> [--effort <level>]
# guide the agent (not a restriction):      add --mode plan|ask|agent
# hard time limit (watchdog):               add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                          node .../relay.mjs --help
```

The relay writes artifacts under the system temp dir by default and **never commits**. Mechanics,
flags, and the `result.json` shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until CodeNeter finishes. Run it with the orchestrator's background-command facility,
or background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; a missing `codeneter` exits 127 and writes `status: "codeneter_unavailable"`.

Completion means the process exited and `result.json` exists. CodeNeter's full report is the
`finalMessage` field in `result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

Treat CodeNeter's final message and gate claims as claims:

- **Re-run the project's gates yourself.** Without `--auto` the implementer could not run them at all;
  with `--auto` it only says it did.
- **Read the diff** against the brief, starting with `touchedFiles` — and because there was no
  sandbox, check for edits outside the paths the brief named, not just inside them.
- Run relevant guard skills if installed.
- Round-trip migrations and grep for dangling references after removals or renames.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The relay never commits, but nothing stops CodeNeter from writing `.git` when it may run commands.
The brief forbids implementer commits, and you compare `HEAD` with the pre-dispatch baseline before
landing anything. **The orchestrator commits**, only after the gates pass and the diff holds. If it
needs rework, send a delta brief with `--session <sessionId>`, then review again.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits remain: **surface, don't absorb**
(report CodeNeter's design decisions, defensible-but-unasked turns, and non-blocking nitpicks) and
**stop for scope changes** (if correct completion needs going beyond the brief, ask instead of
expanding the mandate). `--auto` is a separate opt-in: accepting delegation is not accepting
unattended commands. See [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — structure, scope limits the CLI
  will not enforce, real gates, and delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — flags, artifacts,
  `result.json`, polling, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) — review checklist, commit boundary,
  and rework through the same session.
- [references/multi-task-queues.md](references/multi-task-queues.md) — sequential queues, constraint
  carry-forward, progress tracking, and the final coherence pass.
