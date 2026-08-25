---
name: hermes-delegate
description: >-
  Delegate a coding task to a separate Hermes Agent CLI (`hermes`) session: write a
  self-contained brief, dispatch it headless with the bundled scripts/relay.mjs, poll
  for the structured result, review the diff, and land the commit yourself. Use when
  the user asks to delegate work to Hermes specifically — not other CLIs (they have
  their own *-delegate skills) and not fleet-lane setup (that is delegate-setup).
license: MIT
compatibility: >-
  Requires the `hermes` CLI (Node-based installer) authenticated — Nous Portal OAuth
  via `hermes portal`, or an API-key credential via `hermes auth`.
metadata:
  version: 0.5.0
---

# Hermes Delegate

You are the orchestrator. Hermes Agent is the implementer: a separate `hermes` process
edits a real working tree from your self-contained brief. The diff is the deliverable;
the relay never commits; you review and land.

## Autonomy in Hermes's own terms

Measured on macOS (the README's Verification status entry pins the exact CLI version).
Hermes has no sandbox and no permission modes — none may be invented. Both headless
channels were probed with an unattended file-write ask:

- `chat -q -Q` (the relay's channel): ran the write unattended, exit 0, no prompt.
  The relay still passes `--yolo` explicitly so the bypass never depends on user
  config; stock-config behavior is re-probed before any verification claim ships.
- `-z/--oneshot`: its own help says approvals are auto-bypassed; the probe confirmed
  it — wrote instantly, exit 0, silent stderr.

Expect provider/billing failures as prose on stdout with exit 1: exit codes alone are
not proof of success — read the report and touchedFiles. Read-only runs restrict
`--toolsets` and skip `--yolo`. That is best-effort, NOT enforcement: there is no
read-only toolset (`file` writes by design), so treat the diff as the guarantee,
never the flag. Never pass `--worktree`: Hermes deletes the isolated tree at session
end, destroying uncommitted edits (measured).

## Prerequisites (check once)

1. `hermes --version` succeeds and prints a version.
2. Hermes is authenticated the way you authenticate it at the terminal (Nous Portal
   OAuth, or your provider's API key). An auth or billing lapse surfaces as a failed
   run, not as a missing binary.
3. You are in (or will point `--cd` at) the target git repository.

## Flow

brief → dispatch (relay) → poll → review (re-run the gates yourself) → land (you commit).

See references/: writing-the-brief.md, dispatch-and-poll.md, review-and-land.md,
multi-task-queues.md.
