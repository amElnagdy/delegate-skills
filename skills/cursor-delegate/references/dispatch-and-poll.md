# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `cursor-agent --print`, runs the brief, captures
everything, and writes a structured `result.json`. Your job collapses to: run one command, then read one
file. Everything Cursor-specific lives in the helper, which is what keeps the loop portable across
orchestrators.

## Before the first run: check the binary

Three gotchas, all worth 30 seconds:

```bash
command -v cursor-agent    # the active binary on PATH (the installer also links a plain `agent` alias)
cursor-agent --version     # the relay records this in result.json too
cursor-agent status        # must show you logged in
```

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
| `--cd <dir>` | Working root for cursor-agent (default: current directory). |
| `--model <name>` | Cursor model (default: the account's configured model; `cursor-agent models` lists the choices). The result's `resolvedModel` records what actually ran. |
| `--read-only` | Run in cursor-agent's `plan` mode — review/diagnosis with no edits, **enforced by cursor-agent** (verified: a plan run cannot write the tree). |
| `--no-force` | The relay passes cursor-agent's `--force` (auto-run approval-gated shell commands) **by default** so the brief's gate commands actually execute; `--no-force` drops it, and such commands are then refused rather than prompted (a headless run never prompts). Headless **file edits are applied either way** — `--force` only governs commands. A `--read-only` run never gets `--force`. |
| `--resume-last` | Continue the most recent cursor-agent session; send only the delta brief (see review-and-land). |
| `--session <id>` | Continue a specific session id; send only the delta brief. |
| `--timeout <duration>` | Run budget, Go duration format (e.g. `90s`, `45m`, `2h`). Default `60m`. cursor-agent has no timeout flag of its own, so the relay terminates a run that exceeds the budget and reports it `failed`. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Every run also gets cursor-agent's `--trust` — without it, a dispatch into a not-yet-trusted workspace
hangs on a prompt no one can answer in headless mode. Dispatching into the repo is itself the trust
decision.

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only cursor-agent's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `cursor-agent`
- `status` — `completed` | `failed` | `cursor_agent_unavailable`. A run that exits 0 but reports
  `is_error` in its result event is still `failed` — the relay treats either signal as failure
- `exitCode` — mirrors cursor-agent's exit code; `127` if `cursor-agent` isn't on PATH
- `cursorAgentVersion` — the binary that actually ran
- `mode` — `default` (write-capable) or `plan` (read-only)
- `sessionId` — feed this to a later `--session <id>` (or use `--resume-last`)
- `resolvedModel` — the model that actually ran (from the run's init event), useful when `--model` was
  omitted and the account default applied
- `finalMessage` — cursor-agent's own closing report (from the run's `result` event, falling back to
  its assistant messages). Thin if the run ended without a written summary — ask for the report
  explicitly
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git can't report — `git` missing, or a non-repo run; `[]` means git ran and
  the tree is clean
- `usage` — token counts from the run's result event (`null` if none were reported)
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSON event stream, and
  the final-message file
- `workdir`, `model`, `force`, `resumeLast`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present **only** on a failed run
- `error` — present **only** if cursor-agent failed to launch

The helper also prints a summary to stdout and exits non-zero on any failure, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until cursor-agent finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `cursor-agent` binary exits 127 but *does* write a
  `result.json` with status `cursor_agent_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: cursor_agent_unavailable` (exit 127):** `cursor-agent` isn't on PATH or isn't found.
  Install it — download Cursor's installer and review it before running (`curl -fsS
  https://cursor.com/install -o cursor-install.sh`, read it, then `bash cursor-install.sh`) — then
  `cursor-agent login` and re-dispatch.
- **`status: failed` with a "timed out after …" `error`:** the run exceeded the relay's `--timeout`
  budget (default 60m) and was terminated. Re-dispatch with a bigger `--timeout`, or split the brief
  into smaller tasks.
- **`status: failed`:** read `result.json`'s `stderrTail` and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse (`cursor-agent status`), or an unknown `--model` — cursor-agent rejects
  it up front and lists the valid names. Fix the cause and re-dispatch; don't paper over it by doing
  the work yourself unless that's what the user wants.
- **Thin `finalMessage`:** the run ended without a written closing summary (common when it completes
  purely through tool calls). The edits may still be correct — check `touchedFiles` and the diff. To
  get a report next time, add a `<structured_output_contract>` block (see
  [writing-the-brief.md](writing-the-brief.md)).
- **Gate commands didn't run:** if the report says commands were skipped or refused, check whether the
  run was dispatched with `--no-force` — approval-gated commands are refused without `--force` in
  headless mode.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
cursor-agent --print --output-format stream-json --trust --force        < brief.txt   # fresh write run
cursor-agent --print --output-format stream-json --trust --mode plan    < brief.txt   # read-only run
cursor-agent --print --output-format stream-json --trust --force --continue      < delta-brief.txt   # resume most recent
cursor-agent --print --output-format stream-json --trust --force --resume <id>   < delta-brief.txt   # resume a specific session
```

The brief is fed on **stdin**, never as an argument — which is why a multi-line, XML-tagged brief needs
no quoting. The `stream-json` output is newline-delimited JSON events; the relay records them all to
`events.jsonl`, takes `finalMessage` and `usage` from the closing `result` event, `resolvedModel` from
the `init` event, and `session_id` from any event that carries it.

If you ever want it, raw `cursor-agent -p` is fine for one-offs — you just give up the captured
`result.json`, touched-files summary, and session-id extraction the helper does for you.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: cursor-agent edits the
working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
