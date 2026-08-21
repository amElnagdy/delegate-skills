---
name: dsh-delegate
description: >-
  Delegate a coding task to the DeepSeek Harness CLI (`dsh`) as a background implementer, then review its diff and land it yourself. Use this whenever the user wants to hand implementation work to DeepSeek Harness — phrasings like "have DeepSeek do X", "delegate this to dsh", "run it through DeepSeek Harness", or "use dsh to implement/fix/refactor" — or wants to run a queue of coding tasks through dsh while staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the `dsh` CLI installed (`npm i -g @deepseek-ai/dsh` or `npx @deepseek-ai/dsh`), a provider credential such as `DEEPSEEK_API_KEY` (no `dsh auth` command — credentials resolve from the inherited environment, `$DSH_HOME/.credentials.yaml`, then `.env` files), Node 18+, and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# DeepSeek Harness Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the DeepSeek Harness CLI (`dsh --profile headless`) — then review what it produced
and land it yourself. You write the brief and own the judgment; DeepSeek Harness does the typing in its own
fresh Agent; you verify and commit.

> DeepSeek Harness is in **developer preview** and its README states there will be
> compatibility-breaking changes. Treat any dsh behavior as provisional.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so any agent with those two capabilities — Claude Code, OpenCode driving a
sibling session, or a comparable one — can drive it. (It is designed for and run on Claude Code; treat
other orchestrators as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- `dsh` is not installed or no provider credential is available (`DEEPSEEK_API_KEY` or equivalent).
- You want to write the code yourself, or you only need a review (use `--read-only`).

## Prerequisites (check once)

1. `dsh --version` succeeds. If not, install (`npm i -g @deepseek-ai/dsh`) and set a provider
   credential (`DEEPSEEK_API_KEY`); there is no `dsh auth` command.
2. **Confirm which `dsh` is on PATH.** `command -v dsh` shows the active binary and
   `dsh --version` its version. The relay records the version it ran into `result.json`, so a stale
   binary is visible after the fact.
3. A provider credential is available — `DEEPSEEK_API_KEY` in the environment or the Harness
   credential files.
4. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model

`dsh` has a composed deployment default in the `agent-default-model` row. A per-run override is a
generated `--patch` overlay, not a CLI flag — and the effective model is not observable from the run:

- **No `--model` flag on this surface.** Pass `--model <name>` (and optionally `--provider <name>`,
  defaulting to the harness's own default provider id) to the relay and it writes a patch file:

  ```yaml
  - id: agent-default-model
    config:
      provider: <provider>
      model: <model>
  ```

  and passes it as `dsh --profile headless --patch <file> "<pointer task>"`. A `--patch` overlay
  replaces the targeted row's complete `config` rather than deep-merging keys. That composition entry
  is the base of the `agent-default-model` Settings section; a stored selection in
  `$DSH_HOME/settings.yaml` layers over it and wins, so `--model`/`--provider` are a request, not a
  guarantee. The relay records what was requested as `modelOverlay` in `result.json` and never reads
  or writes the user's settings.

- The usable set of models is the human's to state — ideally once in the repo's `AGENTS.md` or
  `CLAUDE.md`. If none is stated, ask before dispatching rather than guessing. Do not make the brief
  depend on a particular model being the one that runs.

More depth: [references/writing-the-brief.md](references/writing-the-brief.md).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

`dsh` sees **only** the text you send plus what it can read from the working tree — no chat history,
no shared context. Everything the task needs goes in the brief: the goal, the current state, what to
change, what to leave untouched, the project's **actual** gate commands (discover them from the repo's
AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report contract. Tell `dsh` it will **not**
commit (you will). Keep one task per brief. `dsh` also loads applicable `AGENTS.md` / `CLAUDE.md`
from the workspace with a 65,536-byte render budget, so don't restate what those already say. Full
guidance and a template: [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to `dsh` with the bundled helper. It writes the brief to `<out-dir>/brief.md`,
passes a short pointer task as the positional (`dsh --profile headless` takes the task only as
a positional argv value — the file is readable because the `workspace-write` sandbox leaves reads
and the system temp roots unrestricted), captures the run, and writes a structured `result.json` —
so your only job is "run a command, read a file." (`<skill-dir>` below is this skill's installed
directory — the folder containing this `SKILL.md`. Claude Code prints it as "Base directory for
this skill" when the skill loads; on other orchestrators use that same directory — if unsure
where it landed, run `find ~ -name relay.mjs -path '*dsh-delegate*'` and substitute the directory
above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a non-default model:        add --model <name> [--provider <name>]
# fleet lane from delegate-setup:    add --lane <name>  (dials apply; flags still win)
# read-only (review/diagnosis):      add --read-only     (DSH_PERMISSION_MODE=read-only)
# extra composition patch:            add --patch ./overlay.yml  (repeatable)
# hard time limit (watchdog):        add --timeout 2h  (default: off)
# see all options:                   node .../relay.mjs --help
```

The helper writes its artifacts to a temp dir by default, so the repo under review stays clean. It
**never commits** — see step 5. Mechanics, flags, pointer-file delivery, and the `result.json` shape:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until `dsh` finishes, so back it with whatever your orchestrator offers and resume
when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job`
  in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a `status`. (A
  pre-run usage error — bad args or an empty brief — instead exits with code 2 and writes no result
  file, so check the exit code too. A missing `dsh` binary exits 127 but *does* write a
  `result.json` with status `dsh_unavailable`.)
- **There is no resume.** The headless surface exposes no session id; `result.json` reports
  `sessionId: null`. Rework is a fresh, self-contained brief — see step 5.

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line. The implementer's full report is
the `finalMessage` field in `result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

`dsh`'s `result.json` includes its own final message and any gate claims. **Re-verify, don't accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did `dsh` do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Committing should be the act of
the party that verified the work. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a fresh, fully self-contained brief (there is no `--resume-last`;
  `dsh` starts from a clean session each time and remembers nothing from the previous run) and review
  again.

## Autonomy model

`dsh`'s autonomy is the **`DSH_PERMISSION_MODE`** posture in the child's environment, mapped to the
`sandbox-policy` row's `mode` with `workspaceRoot` bound to `process.cwd()`:

| `DSH_PERMISSION_MODE` | sandbox `mode` | `approval` `policy` | Confinement |
| --- | --- | --- | --- |
| unset (default) | `workspace-write` | `ask` | Bash and filesystem **mutations** are confined to the session workspace and the platform temporary roots. Reads, network access, and process visibility are **not** confined. |
| `read-only` | `read-only` | `ask` | Enforced by the sandbox, not by prompt wording. |
| `danger-full-access` | `danger-full-access` | `never` | Removes the workspace boundary **and** sets approval to `never`. Present it as what it is; do not present it as the ordinary posture. |

The **approval seam fails closed** when no answerer is composed — the headless case — so an
escalation beyond the sandbox is rejected, not left hanging on a prompt nobody can answer. This is
why a headless `dsh` run does not need an auto-approve flag and cannot hang on a permission prompt.

The relay exposes this as `--permission-mode <mode>` (the exact `DSH_PERMISSION_MODE` names above)
and `--read-only` as sugar for `read-only` (which also arms the Git tripwire). Leaving the flag off
leaves the variable unset so the harness's own composed default applies.

The **invoking directory is the workspace root.** There is no workspace flag — the relay sets the
child process `cwd` from `--cd` and that becomes the sandbox's `workspaceRoot`. Reads are not
confined and the system temp roots are writable, so the pointer-file brief under that temp root is
readable despite the mutation boundary.

Session telemetry stays local by default and is opt-in through `DSH_TELEMETRY_MODE`. The relay does
not set, change, or defeat any telemetry variable.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract — that is the whole point. Two limits on that
mandate: **surface, don't absorb** (report `dsh`'s design decisions, defensible-but-unasked turns,
and non-blocking nitpicks rather than silently keeping them) and **stop for scope changes** (if correct
completion needs going beyond the brief, ask — don't expand the mandate yourself). The full treatment
is in [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief `dsh` can
  execute blind: structure, XML blocks, the report contract, embedding the real gate commands, and
  why the brief reaches `dsh` as a file it is told to read.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract, backgrounding per orchestrator, the pointer-file mechanic and why, the
  SIGTERM-exits-0 trap, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle as a fresh self-contained brief.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward, progress tracking, and the end-of-run coherence check under no-resume.
