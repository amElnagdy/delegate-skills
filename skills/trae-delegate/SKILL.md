---
name: trae-delegate
description: >-
  Delegate a coding task to TRAE CLI 2.0 (`traecli`) as a background implementer, then review its diff
  and land it yourself. Use this whenever the user wants to hand implementation work to TRAE —
  phrasings like "have Trae do X", "delegate this to Trae", "run it through TRAE CLI", or "use
  traecli to implement/fix/refactor" — or to run a queue of coding tasks through TRAE CLI while
  staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants the
  code written directly without delegating.
license: MIT
compatibility: Requires TRAE CLI 2.0 (`traecli`) installed and authenticated (`traecli login`), Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# TRAE CLI Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — TRAE CLI 2.0 (`traecli`) — then review what it produced and land it yourself. You
write the brief and own the judgment; traecli does the typing in its own sandbox; you verify and
commit.

TRAE CLI is a **fork of the OpenAI Codex CLI** and exposes the same `exec` surface, so this skill is
modeled on `codex-delegate`'s loop and adapts it to traecli's verified flags. It has **not** been
verified end-to-end against every traecli build; treat the mechanics below as designed-for the Codex
exec surface that TRAE CLI forks, and re-check the flags you rely on (`traecli exec --help`) if a run
behaves unexpectedly.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so it works the same whether you are Claude Code, OpenCode with a selected
model, or any comparable agent.

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- The `traecli` CLI is not installed or not authenticated (run `traecli login`).
- You want to write the code yourself, or you only need a review (use traecli's own `exec review`).

## Prerequisites (check once)

1. `traecli --version` succeeds. If not, install TRAE CLI 2.0 and authenticate with `traecli login`.
   traecli is a fork of the Codex CLI, so it inherits that CLI's exec surface — but it must be
   **installed and logged in** for a headless run to work.
2. **Confirm which `traecli` is on PATH.** Multiple installs are possible (e.g. a package-manager
   copy and a bundled one). `command -v traecli` shows the active binary and `traecli --version` its
   version — an old binary may predate flags this skill relies on (`traecli exec --json`, `-o`,
   `exec resume`). The relay records the version it ran as `traeVersion` in `result.json`, so a stale
   binary is visible after the fact.
3. **Confirm you are logged in.** `traecli login status` must **not** say `Not logged in`. traecli
   writes that status to **stderr** (stdout stays empty) and exits non-zero when logged out; a benign
   `WARNING: proceeding, even though we could not update PATH` line is always on stderr and is not a
   failure. A headless run against the hosted provider **fails until the account is authenticated** —
   there is no anonymous mode. If you cannot log in (e.g. an offline host), the alternate path is a
   local model: `traecli exec` with `--oss --local-provider <lmstudio|ollama>` reaches a locally
   served model instead of the hosted provider.
4. You are in (or will point `--cd` at) the target git repository.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

traecli sees **only** the text you send — no repo memory, no chat history, no shared context.
Everything the task needs goes in the brief: the goal, the current state, what to change, what to
leave untouched, the project's **actual** gate commands (discover them from the repo's
CLAUDE.md/AGENTS.md/Makefile — do not assume), and a report contract. Tell traecli it will **not**
commit (you will). Keep one task per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to traecli with the bundled helper. It wraps `traecli exec`, captures the run, and
writes a structured `result.json` — so your only job is "run a command, read a file." (`<skill-dir>`
below is this skill's installed directory — the folder containing this `SKILL.md`, i.e. the directory
you loaded the skill from. Claude Code prints it as "Base directory for this skill" when the skill
loads; on other orchestrators use that same directory — if unsure where it landed, run
`find ~ -name relay.mjs -path '*trae-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only (review/diagnosis, no edits):   add --read-only
# isolated review (skip ambient MCP/user config): add --ignore-user-config
# permission preset (default|bypass_permissions|auto): add --permission-mode auto
# no session files left on disk:            add --ephemeral
# structured final message:                 add --output-schema schema.json
# continue the exact traecli session:       add --session <threadId>  (from result.json; send only the delta brief)
# fallback when no thread id is available:  add --resume-last
# hard time limit (watchdog):               add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                          node .../relay.mjs --help
```

The helper defaults to a write-capable (`workspace-write`) sandbox and writes its artifacts to a temp
dir, so the repo under review stays clean. It **never commits** — see step 5. Mechanics, flags, and
the `result.json` shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until traecli finishes, so back it with whatever your orchestrator offers and
resume when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job`
  in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a `status`. (A
  pre-run usage error — bad args or an empty brief — instead exits with code 2 and a stderr message and
  writes no result file, so check the exit code too. A missing `traecli` binary exits 127 but *does*
  write a `result.json` with status `trae_unavailable`.)

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line. The implementer's full report is the
`finalMessage` field in `result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

traecli's `result.json` includes its own summary and gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did traecli do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

Because traecli's sandbox cannot reliably write `.git` (it varies by version, OS, and path), **the
orchestrator commits.** Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--session <threadId>` from the prior `result.json`
  (use `--resume-last` only when no thread id is available), and review again.

## Read-only second opinions

The relay doubles as a clean way to get an adversarial second opinion with no write risk: dispatch
`--read-only` with a brief that lists the agreed points, then each contested point with both
positions, and ask traecli to defend or concede each — deliverable in its final message, touching no
files. `--read-only` is a shortcut for `--sandbox read-only`; confirm the guarantee held by checking
`touchedFiles` came back empty rather than assuming no edits. (traecli's sandbox is a Codex-fork
sandbox; whether it hard-enforces read-only the way Codex does is not separately verified here.)

## Autonomy model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report traecli's design decisions, defensible-but-unasked turns,
and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if
correct completion needs going beyond the brief, ask — don't expand the mandate yourself). The full
treatment is in [references/review-and-land.md](references/review-and-land.md).

## Authorization model

`--sandbox` selects how much traecli may touch (`read-only` | `workspace-write` |
`danger-full-access`), and `--permission-mode` selects its approval preset (`default` |
`bypass_permissions` | `auto`). These are the knobs that decide how far a run can reach, and the
human's opt-in is what authorizes the resulting commits. Keep the principles of the autonomy model:
the orchestrator owns the commit, reports anything that changes the shape of the work, and stops to
ask when correct completion would require going past the brief.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief traecli
  can execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the exact-session rework cycle.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
