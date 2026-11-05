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
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Codex model (default: Codex's own configured default). |
| `--effort <level>` | Reasoning effort, passed to Codex as `-c model_reasoning_effort=<level>` (default: Codex's own configured default). The relay accepts a bare token; Codex and the model own the supported levels. Applies to fresh and resumed runs. |
| `--subagent-model <name>` | Default model for subagents Codex spawns during the run, passed as `-c agents.default_subagent_model=<name>`. Same character rules as `--model`. See [Subagents](#subagents). |
| `--subagent-effort <level>` | Default reasoning effort for those subagents, passed as `-c agents.default_subagent_reasoning_effort=<level>`. The relay accepts a bare token, as for `--effort`. See [Subagents](#subagents). |
| `--web-search <mode>` | Codex's web search mode, passed as `-c web_search=<mode>`: `disabled`, `cached`, `indexed` or `live` (default: Codex's own configured default). Works under every sandbox. Pass it again on every resume: Codex does not carry it into a resumed turn. See [Web search](#web-search). |
| `--network-access` | Allow network access inside the `workspace-write` sandbox, passed to Codex as `-c sandbox_workspace_write.network_access=true`. Rejected with a read-only sandbox. Pass it again on every resume, with the sandbox named by `--sandbox` or a fleet lane: Codex does not carry it into a resumed turn. See [Network access](#network-access). |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (default: `workspace-write`). |
| `--read-only` | Shortcut for `--sandbox read-only` — review/diagnosis with no edits. |
| `--resume-last` | Continue the most recent Codex session; send only the delta brief (see review-and-land). "Most recent" is global, so an unrelated Codex run can steal it — prefer `--session`. |
| `--session <id>` | Continue one specific thread by id (the `threadId` from a prior `result.json`); send only the delta brief. Mutually exclusive with `--resume-last`; an empty id is rejected. |
| `--clean-env` | Pass only runtime basics (`PATH`, home, locale, temp, `CODEX_HOME`, and Windows equivalents) to Codex and its version preflight. This changes inherited variables only; it does not protect files or other same-user secrets. |
| `--keep-env <name>` | Keep one additional variable under `--clean-env`; repeat for each required environment-backed auth, custom-provider credential, proxy, certificate, or MCP variable. The name must be set and use portable environment-variable syntax. |
| `--no-project-doc` | Do not load project `AGENTS.md` docs (including `AGENTS.override.md` and fallback filenames), passed as `-c project_doc_max_bytes=0`. Codex's user-level instructions in `CODEX_HOME` still load. Use it to review an untrusted checkout whose own `AGENTS.md` could steer the reviewer. Pass it again on every resume: Codex does not carry it into a resumed turn. |
| `--skip-git-repo-check` | Allow running outside a git repo. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Codex's edits and nothing of the helper's own.

`--clean-env` is not a broader security boundary: Codex can still access files and other same-user
secrets available through `HOME`, `CODEX_HOME`, OS facilities, and the selected sandbox. File- or
OS-backed auth and normal configuration still load, but direct environment-backed auth
(`CODEX_API_KEY` or `CODEX_ACCESS_TOKEN`) needs that variable named with `--keep-env`.
`OPENAI_API_KEY` can still matter as a custom-provider credential; provider, proxy, certificate, or
MCP settings that reference any stripped variable likewise need it named with `--keep-env`. The same
filtered environment is used for preflight and dispatch.

On Windows, a sandboxed run (`read-only` or `workspace-write`) receives a `PATH` with every
`WindowsApps` entry removed, again for both preflight and dispatch. The Microsoft Store installs
apps — PowerShell 7 included — under a folder whose ACLs deny execution to the restricted token
Codex's sandbox runs commands with. Codex prefers a `pwsh` found on `PATH`, so a Store-installed
`pwsh` makes every sandboxed command fail with `0xC0070005` while the model keeps working blind:
it cannot run a single gate and either gives up or reports work it never verified. Without those
entries Codex falls back to System32 `powershell.exe`, which the sandbox can launch.
`--sandbox danger-full-access` runs without the restricted token and gets `PATH` unchanged. To
see whether a machine is affected: `(Get-Command pwsh -All).Source` — any result under a
`WindowsApps` folder would hit this.

### Subagents

Codex can spawn its own subagents during a run. `--subagent-model` and `--subagent-effort` set the
model and reasoning effort they start with. Without them, subagents follow Codex's own config, and
with nothing set there they start on the run's own model and effort. Codex's config reference
notes that a model the run names when it spawns a subagent still takes precedence. Subagents run
inside the run's sandbox.

- **Every resume needs them again.** Codex does not carry them over: a resumed turn without the
  flags spawns subagents on Codex's own defaults.
- **A bad value can fail at startup or only at spawn.** An unknown model or an effort the
  model does not support is caught only when Codex spawns a subagent: the run can still end
  `completed` with exit `0`, and the error appears in `stderrPath` or Codex's final report. When the
  subagents' work matters, read both. A model name TOML reads as a number, such as `5.5`, fails
  earlier: Codex stops at startup with `invalid type … expected a string`.
- **Give a run that spawns subagents a `--timeout`.** A failed spawn can leave Codex waiting on no
  subagent at all: in one resumed run, Codex reused an earlier turn's subagent name, the spawn was
  refused, and the run stayed idle for 50 minutes until the relay was terminated.

### Web search

`--web-search <mode>` sets Codex's own web search tool for the run: `disabled` removes it, and
`live` searches the live web. Codex's config reference describes `cached`, its default, as an
OpenAI-maintained index without external web access. The relay checks only that the mode is a bare
token; Codex owns the list and rejects an unknown mode at startup (see
[When a run misbehaves](#when-a-run-misbehaves)).

- **It works under every sandbox.** Search is a hosted tool, separate from the sandbox's network,
  so a `--read-only` review can search the web.
- **Every resume needs it again.** Codex does not carry the mode over: a resumed turn without
  `--web-search` falls back to Codex's configured mode.
- **`disabled` covers only this tool.** Other tools Codex has loaded, such as ChatGPT app
  connectors or MCP servers, can still reach the web.
- **Treat results as untrusted.** A fetched page can carry prompt injection.

### Network access

`workspace-write` runs with no network: `gh`, `curl`, package installs and anything else that
reaches a host fail inside the sandbox. `--network-access` turns network on while keeping the
sandbox's write limits, so reach for it before `--sandbox danger-full-access`, which lifts both.

- **Every resume needs it again.** Codex rebuilds each turn's sandbox from that invocation's config
  and flags, so a resumed `workspace-write` turn without `--network-access` runs offline. A resumed
  run also needs the sandbox named, by `--sandbox workspace-write` or a fleet lane: without one,
  Codex resumes under its configured sandbox, which may be read-only and offline.
- **Read-only stays offline.** Codex ignores the network setting under `read-only`, so the relay
  refuses the pair. For a review that needs the network, dispatch under `workspace-write` with
  `--network-access` and a brief that forbids edits, then confirm `touchedFiles` came back empty.
- **Egress is unfiltered.** Codex's docs warn that network access exposes the run to prompt
  injection from fetched content and to exfiltration of code or secrets. Turn it on for tasks that
  need it, and treat what Codex fetched as untrusted when you review.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` — the result-format version (currently `delegate-relay.result.v1`)
- `status` — `completed` | `failed` | `timeout` | `aborted` | `codex_unavailable`
- `exitCode` — mirrors Codex's exit code; `128` plus the signal number if the child was killed; `127` if `codex` isn't on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `codexVersion` — the binary that actually ran
- `threadId` — feed this to a later `--session <id>` (exact thread; preferred) or `--resume-last` (global "most recent", which another Codex run can steal)
- `finalMessage` — Codex's own final report (the `<structured_output_contract>` you asked for)
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report — `git` missing, or a non-repo run under `--skip-git-repo-check`; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSONL event stream, and the final-message file
- `stderrPath` — the complete stderr stream in `stderr.txt`, including diagnostics omitted from the summary
- `workdir`, `sandbox`, `model`, `effort`, `webSearch`, `networkAccess`, `resumeLast`, `session`, `cleanEnv`, `keepEnv`, `noProjectDoc`, `startedAt`, `finishedAt` — `sandbox` is the applied mode, or a note that Codex used its active config on an unqualified resume; `session` is the explicit session id, or `null` for fresh and `--resume-last` runs; `keepEnv` records names only, never values; `noProjectDoc` is `true` when the relay passed `-c project_doc_max_bytes=0`; `webSearch` is the mode the relay passed, or `null` when Codex used its configured mode (which may still search); `subagentModel` and `subagentEffort` are the values the relay passed, or `null` when subagents used Codex's own defaults
- `stderrTail` — up to 20 nonblank lines from the final 64 KiB of stderr; a partial first line is marked as truncated. Present on every run that did not complete (`failed`, `timeout`, `aborted`), absent on `completed`, `codex_unavailable`, and launch failures. Read `stderrPath` for the complete diagnostics.
- `error` — present on a launch failure, and on `timeout` and `aborted` runs

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
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `codex --version` probe exited non-zero or hung past its cap (10s, or `--timeout` when shorter), so
  codex was never dispatched; only the relay's own artifacts may already exist under `--out-dir`.
  Check the install by running `codex --version` yourself.
- **`status: failed`:** read `result.json`'s `stderrTail`, the full `stderrPath` log, and the tail of `eventsPath` for the cause.
  Common causes: an auth lapse, an invalid `--model`, an unsupported `--effort` or `--web-search`
  mode (Codex fails at startup and names the modes it accepts), or a sandbox that
  blocked something the task needed (a network call needs `--network-access`). Fix the cause and re-dispatch; don't paper over it by doing the
  work yourself unless that's what the user wants.
- **`status: timeout`:** the `--timeout` watchdog killed the run. The working tree may hold a
  half-applied change — inspect it before deciding between a longer `--timeout`, a smaller brief,
  or a resume.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to codex. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child — commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: completed`, but a subagent never ran:** Codex checks that a `--subagent-model` exists
  and supports the `--subagent-effort` only when it spawns a subagent, so a bad value fails the
  spawn and the run carries on. Look for the spawn error in `stderrPath` or the final report, fix the
  value, and resume.
- **Empty `finalMessage`:** Codex exited before producing a final message. Treat as a failed run;
  the events log usually shows where it stopped.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. It cannot rebuild the changes themselves — Codex's JSON stream currently
reports a file change as its path and kind only, without the diff contents — so when the tree
still holds the work, preserve the tree, and otherwise re-dispatch with the log as the map of
what was lost.

## What the helper is doing (and the alternatives)

Under the hood the helper runs roughly:

```bash
codex exec --json -o <final.txt> -s workspace-write [-m model] [-c model_reasoning_effort=<level>] [-c agents.default_subagent_model=<name>] [-c agents.default_subagent_reasoning_effort=<level>] [-c web_search=<mode>] [-c sandbox_workspace_write.network_access=true] [-c project_doc_max_bytes=0] - < brief.txt   # fresh run
codex exec [-s mode] resume --last --json -o <final.txt> [-m model] [-c model_reasoning_effort=<level>] [-c agents.default_subagent_model=<name>] [-c agents.default_subagent_reasoning_effort=<level>] [-c web_search=<mode>] [-c sandbox_workspace_write.network_access=true] [-c project_doc_max_bytes=0] - < delta-brief.txt  # resume
```

On resume, the helper places an explicit `--sandbox`/`--read-only` or fleet-lane sandbox before the
`resume` subcommand so Codex applies it to the resumed turn. Without one, Codex uses its active config.
The helper sets the child process's working directory instead of forwarding `-C`.

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
