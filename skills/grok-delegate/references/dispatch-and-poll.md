# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `grok -p` (headless mode), runs the brief under
an explicit autonomy profile, captures everything, and writes a structured `result.json`. Your job
collapses to: run one command, then read one file. Everything Grok-specific lives in the helper, which
is what keeps the loop portable across orchestrators.

## Before the first run: check the binary

Two gotchas, both worth 30 seconds:

```bash
command -v grok      # the active binary; a stale install can shadow a current one
grok version         # recorded into result.json so a stale binary is visible after the fact
grok login           # or: grok login --device-auth / export XAI_API_KEY=...
```

Grok Build is an early beta gated behind an eligible xAI subscription (SuperGrok / X Premium+). An
auth failure or missing beta access shows up as a failed run, not as `grok_unavailable`.

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
| `--cd <dir>` | Working root for Grok (default: current directory); passed as `--cwd`. |
| `--model <name>` | Grok model (default: Grok's own configured default). |
| `--effort <level>` | Reasoning effort for this run (`--effort`). |
| `--read-only` | Review/diagnosis with no edits (`--sandbox read-only --permission-mode plan`). |
| `--full-access` | Unrestricted auto-approve (`--always-approve --sandbox off`); opt-in. |
| `--resume-last` | Continue the most recent Grok session for this cwd; send only the delta brief. |
| `--session <id>` | Continue a specific session id; mutually exclusive with `--resume-last`. |
| `--prompt-stdin` | **Experimental.** Pipe the brief on stdin and pass `-p -` instead of putting the brief in argv. Unverified — use while testing which delivery path Grok accepts. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Default autonomy (neither `--read-only` nor `--full-access`) is **workspace-write**:
`--always-approve --sandbox workspace`. Grok's native default is `ask`, which would hang a headless
pipe; the relay always sets autonomy explicitly.

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Grok's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `tool` — `"grok"`
- `status` — `completed` | `failed` | `grok_unavailable`
- `exitCode` — mirrors Grok's exit code; `127` if `grok` isn't on PATH
- `grokVersion` — the binary that actually ran
- `sessionId` — feed this to a later `--session <id>` (or use `--resume-last`)
- `finalMessage` — Grok's own final report (the `<structured_output_contract>` you asked for)
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw streaming-json event stream, and the final-message file
- `workdir`, `autonomy`, `model`, `effort`, `resumeLast`, `promptStdin`, `startedAt`, `finishedAt`
- `stderrTail` — last ~20 stderr lines; present **only** on a failed run (a non-zero Grok exit), absent on `completed`, `grok_unavailable`, and launch failures
- `error` — present **only** if Grok failed to launch

The helper also prints a summary to stdout and exits with Grok's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until Grok finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief) exits with code 2 *before* writing any file — so check the exit code
  too, don't only watch for the file. (A missing `grok` binary exits 127 but *does* write a
  `result.json` with status `grok_unavailable`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: grok_unavailable` (exit 127):** `grok` isn't on PATH or isn't found. Install
  (`curl -fsSL https://x.ai/cli/install.sh | bash`, or `npm i -g @xai-official/grok`) and
  `grok login`, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail` and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse, missing beta access, an invalid `--model`, or a sandbox that blocked
  something the task needed. Fix the cause and re-dispatch; don't paper over it by doing the work
  yourself unless that's what the user wants.
- **Empty `finalMessage`:** Grok exited before producing a final message, or the streaming-json event
  shape didn't match the extractor. Treat as a failed run; the events log usually shows where it
  stopped — and is the source of truth for tightening the parser.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
# fresh run (default workspace-write autonomy)
grok --no-auto-update --no-alt-screen --output-format streaming-json --cwd <repo> \
  --always-approve --sandbox workspace -p "<brief>"

# resume most recent session for this cwd
grok --no-auto-update --no-alt-screen --output-format streaming-json --cwd <repo> \
  --continue --always-approve --sandbox workspace -p "<delta>"

# resume a specific session
grok --no-auto-update --no-alt-screen --output-format streaming-json --cwd <repo> \
  --resume <id> --always-approve --sandbox workspace -p "<delta>"
```

`--no-auto-update` and `--no-alt-screen` are always set so automated runs don't check for updates or
take over the terminal. Autonomy flags are re-passed on resume because headless permission mode may
not inherit.

**Prompt delivery:** by default the brief is the `-p` argv value. `--prompt-stdin` is an experimental
alternate that pipes the brief on stdin and passes `-p -` — use it while testing which path Grok
accepts for multi-line XML briefs; lock in the winner once verified.

Two alternatives exist if you ever want them, but the helper is the recommended path:

- **Raw `grok -p`** — fine for one-offs; you give up the captured `result.json`, touched-files
  summary, and session-id extraction the helper does for you.
- **`grok agent stdio` (ACP)** — richer IDE/tool integration over JSON-RPC. Out of scope for this
  skill; the headless `-p` path is the one the relay drives.

## The commit boundary

The helper never commits — by design, not omission. The robust contract is: Grok edits the working
tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
