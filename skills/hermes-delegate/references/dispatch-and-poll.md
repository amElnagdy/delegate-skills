# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `hermes chat` in quiet single-query mode
(`chat --query-file <brief> -Q`, headless), passes `--yolo` on write runs, captures everything,
and writes a structured `result.json`. Your job collapses to: run one command, then read one file. Everything
Hermes-specific lives in the helper, which is what keeps the loop portable across orchestrators.

## Before the first run: check the binary

```bash
command -v hermes   # the active binary; a stale install can shadow a current one
hermes --version    # recorded into result.json so a stale binary is visible after the fact
```

Authentication is whatever you use at the terminal — Nous Portal OAuth (`hermes portal`) or an
API-key credential. An auth or billing lapse shows up as a failed run with error prose in the
report (Hermes prints provider failures to stdout and exits 1), not as `hermes_unavailable`.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only-leaning run (review/diagnosis): add --read-only
# continue the previous session:           add --resume-last  (send only the delta brief)
# continue a specific session:             add --resume <id>
# hard time limit (watchdog):              add --timeout 2h  (default: 30m)
# see all options:                         node .../relay.mjs --help
```

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. See
[`SKILL.md`](../SKILL.md) if you need to locate it.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root for the run (default: current directory); passed to Hermes as `--in`. Remember: **briefs must still use absolute paths** — see [writing-the-brief.md](writing-the-brief.md). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Model for this run (`chat -m`), e.g. `anthropic/claude-sonnet-4`. Default: Hermes's own configured model. |
| `--provider <name>` | Inference provider for this run (`--provider`). Default: Hermes's own configured provider. |
| `--max-turns <n>` | Cap on agent turns for this run (`chat --max-turns`). A watchdog of last resort: a cap that trips mid-task produces a partial edit, not a clean failure. |
| `--read-only` | Review/diagnosis intent: restricts toolsets (drops `terminal`, `code_execution`, web/image tools) and omits `--yolo`. **Best-effort, NOT enforcement** — Hermes has no read-only toolset and no sandbox. The relay reports what actually changed. |
| `--resume-last` | Continue the most recent session for this workspace; send only the delta brief (Hermes `--continue`). |
| `--resume <id>` | Continue a specific session id (Hermes `--resume`); mutually exclusive with `--resume-last`. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child's whole process tree is killed and `result.json` gets `status: "timeout"`. Default 30m. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only the implementer's edits and nothing of the helper's own.

## What the helper runs

Under the hood the relay dispatches roughly:

```bash
# fresh write run (default)
hermes chat --query-file <run-dir>/brief.txt -Q --yolo --in <repo> \
  [-m MODEL] [--provider NAME]

# read-only-leaning run
hermes chat --query-file <run-dir>/brief.txt -Q -t <restricted-toolsets> --in <repo>

# resume most recent session / a specific session
hermes chat --query-file <delta.txt> -Q … --continue        # or --resume <id>
```

`-Q/--quiet` suppresses banner, spinner, and tool previews so stdout is only the final response.
`--yolo` is Hermes's own autonomy bypass term; the relay passes it explicitly so unattended writes
never depend on user config. It is never passed on `--read-only` runs.

**Brief delivery:** the brief rides `--query-file`, never argv — so it stays out of the host
process list, isn't bounded by the OS argument-length cap, and a brief that begins with `-` can't
be misread as a flag.

**Never pass `--worktree`.** Measured hazard: Hermes creates `<repo>/.worktrees/hermes-<hex>/`,
does the work inside it correctly — then **deletes the whole tree at session end**
("✓ Worktree cleaned up"), destroying every uncommitted edit. Nothing survives for a dispatched
run: no branch, no reflog. (Hermes 0.21.x spares a worktree holding unpushed *commits* — but this
skill never lets Hermes commit, so dispatched work is always uncommitted and nothing is spared.)
The relay refuses to pass it; don't try to add it back. Work directly in the dispatch
tree instead.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `"hermes"`
- `status` — `completed` | `failed` | `timeout` | `aborted` | `hermes_unavailable`
- `exitCode` — mirrors Hermes's exit code; `128` plus the signal number if the child was killed;
  `127` if `hermes` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the
  child exited `0` after the watchdog's SIGTERM; exit-0 runs whose captured report matches a known
  provider/billing failure line are downgraded to `failed`
- `signal` — the signal that killed the child, otherwise `null`
- `hermesVersion` — the binary that actually ran
- `sessionId` — Hermes's own session id, parsed from the child's stderr (`session_id:` line); when
  stderr carried none, the relay looks it up via the unique `--source` tag it dispatched with; may
  be `null` if both fail. Feed it back through `--resume <id>`
- `finalMessage` — Hermes's final response: exactly the report your `<report_contract>` asked for,
  captured whole from stdout
- `reportCaptured` — `"complete"` | `"empty"`. Hermes has no structured output mode; this says
  whether any report text was captured at all. Treat `"empty"` like a failed run
- `readOnly` — whether the run was dispatched read-only-leaning
- `resumed` — whether the run continued a previous session
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report; `[]` means git ran and the tree is clean
- `briefPath` / `finalPath` / `stderrPath` — the exact brief relay sent, the captured report file,
  and the child's stderr
- `workdir`, `model`, `provider`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present on every run that did not complete
- `error` — present on every non-clean outcome (launch failures, `timeout`, `aborted`, detected
  provider/billing failures); never infer cause from `exitCode` alone

The helper also prints a summary to stdout and exits with Hermes's mapped exit code, so a wrapping
script can branch on success/failure directly.

## Waiting for completion

The helper blocks until Hermes finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on
  completion, then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll —
  `node relay.mjs … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent
  (`Start-Job` in PowerShell, `start /b` in cmd). A run is done when `result.json` exists with a
  `status`. **But** a pre-run usage error (bad args, empty brief) exits with code 2 *before*
  writing any file — so check the exit code too, don't only watch for the file. (A missing `hermes`
  binary exits 127 but *does* write a `result.json` with status `hermes_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: hermes_unavailable` (exit 127):** `hermes` isn't on PATH. Install the Hermes Agent CLI
  and authenticate, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `hermes --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter),
  so Hermes was never dispatched; check the install by running `hermes --version` yourself.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a closed
  terminal) and forwarded the kill to Hermes. The result is written before the relay exits; inspect
  the working tree before re-dispatching.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: failed` with a billing/provider `error`:** Hermes reports provider problems as prose on
  stdout and can still exit 1 with the failure printed; the relay matches known failure lines
  (line-anchored) and carries them in `error`. Fix credentials/billing and re-dispatch.
- **`reportCaptured: "empty"`:** Hermes exited without producing a final response. Treat as a
  failed run; `stderrTail` usually shows where it stopped.

## Recovering lost work

The run directory keeps `brief.txt` (what was sent), `final.txt` (what was captured), and
`stderr.txt` (the child's stderr). If finished work is lost — the run killed late, or the working
tree damaged afterward — read those before re-dispatching: they identify which files the run was
about, which scopes what needs redoing. When the tree still holds the work, preserve the tree
rather than replaying artifacts.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: Hermes edits the
working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
