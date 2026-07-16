# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `codex exec`, runs the brief in a sandbox, captures
everything, and writes a structured `result.json`. Your job collapses to: run one command, then read
one file. Everything Codex-specific lives in the helper, which is what keeps the loop portable across
orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v codex      # the active binary; a stale install (e.g. Homebrew) can shadow a current one
codex --version       # an old binary predates `exec --json`, `-o`, and `exec resume`
codex login status    # must be authenticated
```

The Codex CLI moves fast and behavior shifts between versions, so the helper records the version it
actually ran into `result.json` — if something behaves oddly, check which binary answered.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. On Claude
Code it's the printed "Base directory for this skill"; on other orchestrators substitute that install
path. See [`SKILL.md`](../SKILL.md) if you need to locate it.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root for Codex (default: current directory). |
| `--model <name>` | Codex model (default: Codex's own configured default). |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (default: `workspace-write`). |
| `--read-only` | Shortcut for `--sandbox read-only` — review/diagnosis with no edits. |
| `--resume-last` | Continue the most recent Codex session; send only the delta brief (see review-and-land). |
| `--skip-git-repo-check` | Allow running outside a git repo. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Codex's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `codex_unavailable`
- `exitCode` — mirrors Codex's exit code; `128` plus the signal number if the child was killed; `127` if `codex` isn't on PATH
- `signal` — the signal that killed the child, otherwise `null`
- `codexVersion` — the binary that actually ran
- `threadId` — feed this to a later `codex exec resume <id>` (or use `--resume-last`)
- `finalMessage` — Codex's own final report (the `<structured_output_contract>` you asked for)
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report — `git` missing, or a non-repo run under `--skip-git-repo-check`; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSONL event stream, and the final-message file
- `workdir`, `sandbox`, `model`, `resumeLast`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present **only** on a failed run (a non-zero Codex exit), absent on `completed`, `codex_unavailable`, and launch failures
- `error` — present **only** if Codex failed to launch

The helper also prints a summary to stdout and exits with Codex's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until Codex finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `codex` binary exits 127 but *does* write a
  `result.json` with status `codex_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: codex_unavailable` (exit 127):** `codex` isn't on PATH or isn't found. Install
  (`npm i -g @openai/codex`) and `codex login`, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail` and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse, an invalid `--model`, or a sandbox that blocked something the task
  needed. Fix the cause and re-dispatch; don't paper over it by doing the work yourself unless that's
  what the user wants.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **Empty `finalMessage`:** Codex exited before producing a final message. Treat as a failed run;
  the events log usually shows where it stopped.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
codex exec --json -o <final.txt> -s workspace-write [-m model] - < brief.txt   # fresh run
codex exec resume --last --json -o <final.txt> - < delta-brief.txt            # resume (no -s/-C)
```

`resume` deliberately gets no `-s`/`-C` — it inherits the original session's sandbox and working root —
which is why the helper sets the child process's working directory instead.

Two alternatives exist if you ever want them, but the helper is the recommended path:

- **Raw `codex exec`** — fine for one-offs; you give up the captured `result.json`, touched-files
  summary, and thread-id extraction the helper does for you.
- **The openai-codex Claude Code plugin's companion CLI** (`task`/`status`/`result`) — richer job
  tracking if you have that plugin installed. It runs Codex as a background job behind a broker process,
  so you track jobs through `queued`/`running` states; the bundled helper instead spawns `codex`
  in-process and blocks until completion, so the only state to track is whether `result.json` exists —
  which is why it's the default here.

## The commit boundary

The helper never commits — by design, not omission. Whether Codex's sandbox can write `.git` varies by
version, OS, and execution path, so relying on it is a coin flip. The robust contract is: Codex edits
the working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
