---
name: mcode-delegate
description: >-
  Delegate a coding task to the MiniMax Code CLI (`mcode`) as a background implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  MiniMax Code or a MiniMax model — phrasings like "have MiniMax do X", "delegate this to mcode", "run
  it through MiniMax Code", or "use MiniMax to implement/fix/refactor" — or to run a queue of coding
  tasks through MiniMax Code while staying the reviewer. DO NOT USE for tasks small enough to do
  inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the MiniMax Code CLI (`mcode`, from agent.minimax.io) installed and signed in with `mcode login`, Node 22+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux).
metadata:
  version: 0.5.0
---

# MiniMax Code Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the MiniMax Code CLI (`mcode`) — then review what it produced and land it yourself.
You write the brief and own the judgment; MiniMax Code does the typing in your working tree; you
verify and commit.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so it works the same whether you are Claude Code, OpenCode with a selected
model, or any comparable agent. (It is designed for and run on Claude Code; treat other orchestrators
as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- `mcode` is not installed or not signed in (run `mcode login`, or `mcode login --region global`).
- You want to write the code yourself, or you only need a review of local changes (`mcode exec review`
  does that directly).
- You need writes outside the target tree to be impossible, not just unlikely. MiniMax Code has no
  sandbox; use an OS-enforced one such as `codex-delegate`, or run this inside a container.

## Read this before the first dispatch: the autonomy model

`mcode exec` takes a permission policy — `smart`, `full`, or `off` — and has **no sandbox and no
read-only or plan setting** for a headless run (`ask` needs the TUI or ACP).

- **`smart` (the relay's default; TUI Auto):** already approves file writes and deletions headlessly.
  A live probe asked for an `rm` and got it with no prompt.
  So `smart` is not a guardrail: the brief and a clean working tree are the real scope.
- **`full` (TUI Full access):** skips normal confirmation entirely. The relay passes it only on an
  explicit `--permission full`.
- **`off`:** refused by the relay; MiniMax Code does not document what it disables.

`--read-only` is **advisory**: the relay appends a system prompt forbidding edits, keeps `smart`, and
then runs a Git-visible change tripwire (`readOnlyViolation`). A change is *detected after the fact,
not prevented*, and ignored or outside-repository paths are not covered.

## Prerequisites (check once)

1. `mcode --version` succeeds and you are signed in (`mcode` → `/status` in the TUI). If not, install
   MiniMax Code and run `mcode login`.
2. **Confirm `mcode` is on PATH in the shell the relay runs from.** The official installer puts it in
   `~/.minimax-code/bin`, which only your shell profile adds to PATH; an orchestrator's non-login shell
   may not see it. Pass `--mcode-path <file>` or set `MCODE_CLI` when `command -v mcode` comes back
   empty. The relay records the version it ran in `result.json`.
3. You are in (or will point `--cd` at) the target git repository, and its tree is clean before you
   dispatch — a run with no sandbox is much easier to review against a clean baseline.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

MiniMax Code sees **only** the text you send — no repo memory, no chat history, no shared context
(beyond the repo's own `AGENTS.md`, which it reads). Everything the task needs goes in the brief: the
goal, the current state, what to change, what to leave untouched, the project's **actual** gate
commands (discover them from the repo's AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report
contract. Tell it that it will **not** commit (you will). Keep one task per brief. Full guidance and a
template: [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to MiniMax Code with the bundled helper. It wraps `mcode exec`, captures the run, and
writes a structured `result.json` — so your only job is "run a command, read a file." (`<skill-dir>`
below is this skill's installed directory — the folder containing this `SKILL.md`, i.e. the directory
you loaded the skill from. Claude Code prints it as "Base directory for this skill" when the skill
loads; on other orchestrators use that same directory — if unsure where it landed, run
`find ~ -name relay.mjs -path '*mcode-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only (review/diagnosis; advisory):   add --read-only
# continue the exact session:               add --session <sessionId>  (from result.json; send only the delta brief)
# model / effort for this run:              add --model minimax/<model> --effort high
# hard time limit (watchdog):               add --timeout 2h  (default: off; implementation runs routinely need 1-2h)
# see all options:                          node .../relay.mjs --help
```

The helper defaults to a write-capable (`--permission smart`) run, which intentionally edits the target
repository. Its temp directory keeps only relay artifacts out of that repository. The relay **never
commits** — see step 5. Mechanics, flags, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until MiniMax Code finishes, so back it with whatever your orchestrator offers and
resume when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh, or your shell's equivalent. The run is done when `result.json`
  exists with a `status`. (A pre-run usage error — bad args or an empty brief — instead exits with code
  2 and a stderr message and writes no result file, so check the exit code too. A missing `mcode`
  binary exits 127 but *does* write a `result.json` with status `mcode_unavailable`.)

A run is finished when `result.json` is written and the process has exited — read the working tree,
not a status line. The implementer's full report is the `finalMessage` field in `result.json` (also
printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

`result.json` includes MiniMax Code's own summary and gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did it do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point — and because there was no
  sandbox, check for edits and **deletions** *outside* the paths the brief named, not just inside them.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The relay never commits, but nothing stops MiniMax Code from writing `.git`. The brief forbids
implementer commits, and the reviewer compares `HEAD` with the recorded pre-dispatch baseline before
landing anything. **The orchestrator commits.** Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta brief with `--session <sessionId>` from the prior `result.json`,
  and review again.

## Read-only second opinions

The relay doubles as a way to get an adversarial second opinion: dispatch `--read-only` with a brief
that lists the agreed points, then each contested point with both positions, and ask MiniMax Code to
defend or concede each — deliverable in its final message, touching no files. Because that read-only
state is only a prompt, read the verdict every time: `readOnlyViolation: false` means the Git-visible
detector saw no change (ignored or outside-repository paths are not covered); `true` means it saw
one; `null` means git could not tell. Dispatch second opinions on a clean tree you can afford to
restore.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report MiniMax Code's design decisions, defensible-but-unasked
turns, and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if
correct completion needs going beyond the brief, ask — don't expand the mandate yourself). The full
treatment is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief MiniMax
  Code can execute blind: structure, XML blocks, the report contract, embedding the real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the exact-session rework cycle.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check.
