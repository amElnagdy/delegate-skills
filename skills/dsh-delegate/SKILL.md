---
name: dsh-delegate
description: >-
  Delegate a coding task to the DeepSeek Harness CLI (`dsh`) as a background implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  DeepSeek Harness — phrasings like "have DeepSeek Harness do X", "delegate this to dsh", "run it
  through the harness", or "use dsh to implement/fix/refactor" — including when dsh is configured to
  serve a locally hosted model behind an OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, …), or
  to run a queue of coding tasks through dsh while staying the reviewer. DO NOT USE for tasks small
  enough to do inline, or when the user wants the code written directly without delegating.
license: MIT
compatibility: Requires the `dsh` CLI installed (`npm i -g @deepseek-ai/dsh` or `npx @deepseek-ai/dsh`) with a provider credential — `DEEPSEEK_API_KEY`, or any provider configured in `$DSH_HOME/settings.yaml`, including a local OpenAI-compatible endpoint — plus Node 18+ (22.15+ for the session-record harvest) and git. The orchestrating agent must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# DeepSeek Harness Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** — the DeepSeek Harness CLI (`dsh --profile headless`) — then review what it produced
and land it yourself. You write the brief and own the judgment; the harness does the typing inside
its own sandbox posture; you verify and commit.

> DeepSeek Harness is in **developer preview** and its README promises compatibility-breaking
> changes. Treat any dsh behavior as provisional; the relay records the `dsh` version it ran.

Nothing here is specific to one orchestrating agent. The loop needs only the ability to run a shell
command and read a file, so it works the same whether you are Claude Code, OpenCode with a selected
model, or any comparable agent. (It is designed for and run on Claude Code; treat other orchestrators
as designed-for, not yet proven.)

## When NOT to use this

- The task is small enough to just do inline — delegation overhead is not worth it.
- `dsh` is not installed, or no provider is usable (no `DEEPSEEK_API_KEY` and no configured provider).
- You want to write the code yourself, or you only need a diagnosis (then dispatch `--read-only`).

## Prerequisites (check once)

1. `dsh --version` succeeds. If not, install with `npm i -g @deepseek-ai/dsh`. There is no
   `dsh auth` command: credentials resolve from the environment (`DEEPSEEK_API_KEY`, or the
   `apiKeyEnv` a provider names in `$DSH_HOME/settings.yaml`) and the harness credential files.
2. **Confirm which `dsh` is on PATH.** `command -v dsh` shows the active binary and `dsh --version`
   its version; the relay records the version it ran into `result.json`, so a stale binary is
   visible after the fact.
3. You are in (or will point `--cd` at) the target git repository.

## Choose the implementer model

The headless surface has **no model flag**. The deployment default lives in the composed
`agent-default-model` row (provider + model), which `$DSH_HOME/settings.yaml` can override. The
relay's `--model <name>` (with optional `--provider <name>`) generates a `--patch` overlay that
replaces that row's config — but a stored `settings.yaml` selection **outranks the overlay**
(measured), so the flags are a request, not a guarantee. What makes this workable in practice:
`result.json` reports both — `modelOverlay` is what was requested, and `actualModel` /
`actualProvider` / `reasoningEffort` are what actually served the run, harvested from the session
record dsh writes. Compare them instead of assuming.

For a locally hosted model — or any OpenAI-compatible endpoint — see the local-model section of
[references/dispatch-and-poll.md](references/dispatch-and-poll.md): a persistent selection belongs in
`$DSH_HOME/settings.yaml`, and a fully self-contained per-run wiring can ride a single `--patch`
overlay (measured end-to-end against a local vLLM server).

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

`dsh` sees **only** the text you send plus what it can read from the working tree — no chat history,
no shared context. Everything the task needs goes in the brief: the goal, the current state, what to
change, what to leave untouched, the project's **actual** gate commands (discover them from the
repo's AGENTS.md/CLAUDE.md/Makefile — do not assume), and a report contract. Tell `dsh` it will
**not** commit (you will). Keep one task per brief. `dsh` auto-loads applicable `AGENTS.md` /
`CLAUDE.md` context files from the workspace (measured), so don't restate what those already say —
but keep the load-bearing constraints in the brief anyway. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief to `dsh` with the bundled helper. `dsh --profile headless` takes the task **only** as
a positional argv value — no stdin (measured) — so the relay writes the brief to
`<out-dir>/brief.md` and passes a one-line pointer naming that absolute path; the sandbox confines
mutations, not reads, so the implementer can read it. The relay captures the run and writes a
structured `result.json` — your only job is "run a command, read a file." (`<skill-dir>` below is
this skill's installed directory — the folder containing this `SKILL.md`. Claude Code prints it as
"Base directory for this skill" when the skill loads; if unsure where it landed, run
`find ~ -name relay.mjs -path '*dsh-delegate*'` and substitute the directory above it.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# request a model:                   add --model <name> [--provider <name>]  (a request — check actualModel)
# fleet lane from delegate-setup:    add --lane <name>   (dials apply; explicit flags win)
# read-only (review/diagnosis):      add --read-only     (DSH_PERMISSION_MODE=read-only + tripwire)
# extra composition overlay:         add --patch ./overlay.yml   (repeatable; can wire a local endpoint)
# hard time limit (watchdog):        add --timeout 2h    (default: off)
# see all options:                   node .../relay.mjs --help
```

The helper writes its artifacts to a temp dir by default, so the repo under review stays clean. It
**never commits** — see step 5. Mechanics, flags, the local-endpoint overlay, and the `result.json`
shape: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until `dsh` finishes, so back it with whatever your orchestrator offers and resume
when it returns:

- **Claude Code:** run the Bash call with `run_in_background: true`; you are notified on completion.
- **Plain shell / other agents:** run it in the foreground for short tasks, or background it and poll
  the result file — `… &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent
  (`Start-Job` in PowerShell, `start /b` in cmd). The run is done when `result.json` exists with a
  `status`. (A pre-run usage error — bad args or an empty brief — instead exits with code 2 and
  writes no result file, so check the exit code too. A missing `dsh` binary exits 127 but *does*
  write a `result.json` with status `dsh_unavailable`.)
- **There is no headless resume.** `--resume` is rejected by the app (measured). `result.json`
  reports the run's `sessionId` harvested from the on-disk session record — an audit handle, not a
  resume handle. Rework is a fresh, self-contained brief — see step 5.

Do not trust progress trackers over reality: a run is finished when `result.json` is written and the
process has exited. Read the working tree, not a status line. The implementer's full report is the
`finalMessage` field in `result.json` (also printed in full on stdout between the report markers).

### 4. Review — do not trust the self-report

`dsh`'s `result.json` includes its own final message and any gate claims. **Re-verify, don't
accept:**

- **Re-run the project's gates yourself** (the test/lint/build commands from step 1). Never take
  "gates passed" on faith.
- **Read the diff** against the brief: did `dsh` do what was asked, nothing more (scope creep) and
  nothing less? `touchedFiles` in the result is your starting point.
- **Run the relevant guard skills** on the diff if you have them installed (clean-code-guard,
  test-guard, etc. from `guard-skills`) — this skill produces the work; those skills judge it.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Committing should be the act
of the party that verified the work. Only after the gates pass and the diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a fresh, fully self-contained brief — the headless surface has no resume,
  and `dsh` remembers nothing from the previous run. Fold the previous brief's constraints plus the
  new corrections into one document, and review again.

## Autonomy model

`dsh`'s autonomy is the **`DSH_PERMISSION_MODE`** posture in the child's environment, mapped to the
`sandbox-policy` row's `mode` with `workspaceRoot` bound to `process.cwd()`:

| `DSH_PERMISSION_MODE` | sandbox `mode` | `approval` `policy` | Confinement |
| --- | --- | --- | --- |
| unset (default) | `workspace-write` | `ask` | Filesystem and shell **mutations** are confined to the workspace and the platform temp roots. Reads and network access are **not** confined. |
| `read-only` | `read-only` | `ask` | Enforced by the sandbox: a briefed write is refused by the harness itself (measured), and the relay's tripwire measures the tree besides. |
| `danger-full-access` | `danger-full-access` | `never` | Removes the workspace boundary **and** silences approval. Present it as what it is; never as the ordinary posture. |

The **approval seam fails closed** in a headless run — no answerer is composed, so an escalation
beyond the sandbox is rejected rather than left hanging on a prompt nobody can answer. This is why a
headless `dsh` run needs no auto-approve flag and cannot hang on a permission prompt.

Two relay-specific points, both measured:

- **A refused write still exits 0.** A `read-only` run whose brief ordered a write completes with
  the refusal in the final message and a clean tree — the exit code does not carry it. Read
  `readOnlyViolation` and the final message, not just `status`.
- **An already-exported `DSH_PERMISSION_MODE` is honored and reported** (`permissionModeSource:
  "environment"`), never silently stripped — stripping it would loosen a user's standing read-only
  posture. `--permission-mode` and lane dials override it; `--read-only` is sugar for
  `--permission-mode read-only` and also arms the Git tripwire.

The **invoking directory is the workspace root** — there is no workspace flag; the relay sets the
child's cwd from `--cd` and that becomes the sandbox's `workspaceRoot`.

Session telemetry stays local by default (`DSH_TELEMETRY_MODE` defaults to disabled). The relay does
not set, change, or defeat any telemetry variable. After the run it reads the session record `dsh`
itself wrote under `$DSH_HOME/sessions` — locally, reporting into `result.json` only — to recover
the session id, the served model, token usage, and the recorded permission preset.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"),
committing verified, gate-passing work is the agreed contract — that is the whole point. Two limits
on that mandate: **surface, don't absorb** (report `dsh`'s design decisions,
defensible-but-unasked turns, and non-blocking nitpicks rather than silently keeping them) and
**stop for scope changes** (if correct completion needs going beyond the brief, ask — don't expand
the mandate yourself). The full treatment is in
[references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — how to write a brief `dsh`
  can execute blind: structure, XML blocks, the report contract, the real gates, pointer-file
  delivery, and sizing briefs for small-context local models.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — `relay.mjs` flags, the
  `result.json` contract including the session-record harvest, wiring a local OpenAI-compatible
  endpoint, the SIGTERM-exits-0 trap, and recovery when a run misbehaves.
- [references/review-and-land.md](references/review-and-land.md) — the review checklist, the commit
  boundary, and the rework cycle as a fresh self-contained brief.
- [references/multi-task-queues.md](references/multi-task-queues.md) — running a sequential queue:
  carrying constraints forward without resume, progress tracking, and the end-of-run coherence check.
