---
name: devin-delegate
description: >-
  Delegate a coding task to the local Devin CLI (`devin`, Cognition's terminal agent) as a
  background implementer, then review its diff and land it yourself. Use this whenever the user
  wants to hand implementation work to the local Devin CLI — phrasings like "delegate to Devin",
  "have Devin do X", "run it through Devin", "use the Devin CLI to implement/fix/refactor", or "have
  devin CLI do this" — or to run a queue of coding tasks through Devin while staying the reviewer.
  Prefer it when the user will review the diff and commit it themselves. This skill drives the
  local `devin` binary, not Devin Cloud. DO NOT USE for Devin Cloud, for tasks small enough to do
  inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the `devin` CLI (Cognition's local terminal agent) installed and authenticated (`devin auth login`, or `devin setup`), Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows). Native Windows is unverified (docs route Windows through WSL).
metadata:
  version: 0.5.0
---

# Devin Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the local Devin CLI (`devin`) — then review what it produced and land it yourself.
You write the brief and own the judgment; Devin does the typing under an explicit permission mode;
you verify and commit.

This is the **local** `devin` binary, not Devin Cloud. Nothing here is specific to one orchestrating
agent. The loop needs only the ability to run a shell command and read a file, so it works the same
whether you are Claude Code, Cursor, OpenCode with a selected model, or any comparable agent.

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `devin` CLI is not installed or not authenticated (`devin auth status` should print
  `Logged in (via Devin).`).
- The user asked for Devin Cloud, not the local terminal agent.
- You want to write the code yourself, or you only need a review without an implementer run.

## Prerequisites (check once)

1. `devin version` (or `devin --version`) succeeds. If not, install via the Devin CLI installer
   ([devin.ai/docs](https://devin.ai/docs)), then authenticate with `devin auth login` (or
   `devin setup`). `devin update` exists for later upgrades. There is no npm package to install.
2. **Confirm which `devin` is on PATH.** `command -v devin` shows the active binary and `devin version`
   its version — the relay records the version it ran into `result.json`, so a stale binary is
   visible after the fact.
3. You are in (or will point `--cd` at) the target git repository.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

Devin sees **only** the text you send — no orchestrator chat history, no shared context. Everything
the task needs goes in the brief: the goal, the current state, what to change, what to leave
untouched, the project's **actual** gate commands (discover them from the repo's CLAUDE.md/AGENTS.md/
Makefile — do not assume), and a report contract. Tell Devin it will **not** commit (you will). Keep
one task per brief. Full guidance and a template: [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to Devin with the bundled helper. It wraps `devin --print`, captures the run, and
writes a structured `result.json` — so your only job is "run a command, read a file." (`<skill-dir>`
below is this skill's installed directory — the folder containing this `SKILL.md`, i.e. the
directory you loaded the skill from. Claude Code prints it as "Base directory for this skill" when
the skill loads; on other orchestrators use that same directory — if unsure where it landed, run
`find ~ -name relay.mjs -path '*devin-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only (writes and exec rejected headlessly): add --read-only
# continue the previous Devin session:         add --resume-last  (send only the delta brief)
# hard time limit (watchdog):                   add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                              node .../relay.mjs --help
```

The helper defaults to `--permission-mode smart` (the write-capable default that can actually finish
an implementation under `--print`) and writes its artifacts to a temp dir, so the repo under review
stays clean. It **never commits** — see step 5. Mechanics, flags, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Devin finishes, so back it with whatever your orchestrator offers and resume
when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job`
  in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a `status`. (A
  pre-run usage error — bad args or an empty brief — instead exits with code 2 and a stderr message and
  writes no result file, so check the exit code too. A missing `devin` binary exits 127 but *does*
  write a `result.json` with status `devin_unavailable`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and
the process has exited. Read the working tree, not a status line. The implementer's full report is
the `finalMessage` field in `result.json` (also printed in full on stdout between the report markers).
`--print` prints only that final assistant response as plain text; there is no event stream.

### 4. Review — do not trust the self-report

Devin's `result.json` includes its own summary and gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did Devin do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

**The orchestrator commits.** Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--resume-last` (don't restate the whole task) and
  review again.

## Autonomy model

Devin's default permission mode is `normal` (alias `auto`): read-only tools auto-run, everything else
prompts. Under `--print`, a tool call that needs approval is **rejected**, not hung — stderr gets
`warning: rejected a tool call that requires confirmation. Running in non-interactive mode.` and the
run continues, exiting 0. So `accept-edits` alone cannot run an implementation (its first gate command
is rejected). The relay therefore always sets `--permission-mode` explicitly, and the write default
is `smart`:

| Relay flag | What Devin gets | Use when |
| --- | --- | --- |
| *(default)* | `--permission-mode smart` | Normal implementation — workspace file edits auto; a fast model auto-runs clearly-safe shell commands and fetches; package installs, mutating git, `rm`/`sudo`/destructive commands still prompt (and under `--print` a prompt is a rejection) |
| `--read-only` | `--permission-mode normal` | Review / diagnosis — headless `normal` rejects writes **and** exec at the tool boundary. The git tripwire still runs. |
| `--full-access` | `--permission-mode dangerous` | Unrestricted auto-approve; opt-in. Aliases `yolo`/`bypass` exist on the CLI; this relay accepts only the canonical name. |

`--permission-mode <mode>` is also a direct passthrough (and a fleet-lane dial) for the canonical
values `normal`, `accept-edits`, `smart`, and `dangerous`. `accept-edits` auto-runs workspace file
edits and still prompts for shell/fetch — under `--print` those prompts are rejections, so it cannot
finish a typical implementation. `autonomous` is rejected: it needs `--sandbox`, and in sandbox
sessions the `edit`/`write` tools still prompt, which a headless run cannot answer.

**This relay never passes `--sandbox`.** `--sandbox` forces `autonomous` mode, and that combination is
broken headlessly (edit/write still prompt; `--print` rejects them). Do not add it.

`--print` also refuses to start in an untrusted workspace. The relay always passes
`--respect-workspace-trust false` so a dispatch against a throwaway or newly cloned repo is not
blocked by that gate.

The child environment removes only inherited `WINDSURF_API_KEY`. Windsurf terminals inject that
variable; Devin's ACP agent prefers it over the stored `devin auth` login and then fails with
`failed to start ACP agent session`. Every other entry is preserved, and version preflight uses
the same environment. A user who deliberately sets `WINDSURF_API_KEY` for Devin has it ignored by
the relay and should use `devin auth login` instead.

**`--read-only` is enforced at Devin's tool boundary**, unlike grok's advisory plan mode: headless
`normal` rejects writes and exec. The relay still reports `readOnlyViolation` from git porcelain plus
fingerprints of already-dirty Git-visible paths — `true` when either signal proves a change, `false`
when coverage is complete and detects none, and `null` when coverage is incomplete. Ignored paths,
submodule internals, perfect restores, and attribution of concurrent changes remain outside it, so
the diff review stays the guarantee.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report Devin's design decisions, defensible-but-unasked turns, and
non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if correct
completion needs going beyond the brief, ask — don't expand the mandate yourself). The full treatment
is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief Devin can
  execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle via `--resume-last`.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
