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
| `--resume-last` | Continue the most recent Codex session; send only the delta brief (see review-and-land). "Most recent" is global, so an unrelated Codex run can steal it — prefer `--session`. The relay warns on every use. |
| `--session <id>` | Continue one specific thread by id (the `threadId` from a prior `result.json`); send only the delta brief. Mutually exclusive with `--resume-last`; an empty id is rejected. |
| `--isolated` | Isolate Codex from ambient user config: `--ignore-user-config` plus `--disable apps`, and on Windows the configured sandbox backend (see [Isolation](#isolation)). Default on for a lane whose resolved sandbox is `read-only`; off otherwise. |
| `--no-isolated` | Opt out of that default. The last of `--isolated` / `--no-isolated` wins. |
| `--ignore-user-config` | Enables the same isolation bundle, even together with `--no-isolated`. Authentication still uses `CODEX_HOME`. |
| `--disable <feature>` | Disable a Codex feature (repeatable; letters, digits, `. _ : / -`, starting with a letter or digit; anything else is rejected before launch). Isolation always disables `apps` too; duplicates are dropped. |
| `--clean-env` | Pass only runtime basics (`PATH`, home, locale, temp, `CODEX_HOME`, and Windows equivalents) to Codex and its version preflight. This changes inherited variables only; it does not protect files or other same-user secrets. |
| `--keep-env <name>` | Keep one additional variable under `--clean-env`; repeat for each required environment-backed auth, custom-provider credential, proxy, certificate, or MCP variable. The name must be set and use portable environment-variable syntax. |
| `--skip-git-repo-check` | Allow running outside a git repo. |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`, `2h`); on expiry the child is killed and `result.json` gets `status: "timeout"`. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh, unique dir under `<temp>/delegate-relay`). An explicit dir is locked for the run (see [Output directories](#output-directories)). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Codex's edits and nothing of the helper's own.

### Isolation

Why it exists, as observed on Windows:

- `--ignore-user-config` alone also drops `[windows] sandbox = "elevated"`, after which every sandboxed
  command reported "blocked by policy". The relay therefore reads that one setting and passes it back. If no backend is
  configured, Codex uses its built-in default; if that fails on this machine, the run shows up as
  `sandbox_failed`.
- Ignoring the config does not remove account connectors (`codex_apps`); they load until `--disable apps`.
- On a CLI without the Windows Desktop ACL fix (`openai/codex#51822`),
  a running `node_repl.exe` (Codex Desktop, or any Codex run that loads the user config) made the
  elevated sandbox's setup refresh fail with `os error 32` / `setup refresh had errors`. Codex can
  still exit `0`. The relay reports such runs as `sandbox_failed`, never `completed`. A CLI with the
  fix is not affected (see [Environment and Windows](#environment-and-windows)).

**Precedence** for effective isolation: an explicit `--ignore-user-config` always enables it; otherwise
the last explicit `--isolated` / `--no-isolated`, then the lane's `isolated` dial, then the default
(on for a lane whose resolved sandbox is `read-only`, even when `--sandbox` overrides it). Standalone
`--read-only` without a lane does not enable isolation; add `--isolated`. `--clean-env` is independent.
An explicit write-capable sandbox with isolation is allowed.

What an isolated run changes:

| Aspect | Behavior |
| --- | --- |
| Flags | `--ignore-user-config`, `--disable apps` (plus any `--disable`), and on Windows `-c windows.sandbox=<elevated\|unelevated>`. macOS/Linux get the first two only, with no config read and no process check. |
| Dropped config | The user config's default model, custom providers, profiles and approval settings. The relay warns when no model is set (`--model` or a lane model); an explicit `--model` does not restore a custom provider. |
| Windows setting | Only `[windows] sandbox` (or top-level `windows.sandbox`) is read, from `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. Nothing else is read, logged or followed. |
| Missing file or key | A warning; the run continues with no backend override. |
| Invalid, duplicate, ambiguous or unreadable setting | Codex is not dispatched: `status: "failed"`, exit `2`, with a `result.json` (an exception to "a usage error writes no result"). For ambiguity or TOML the scan cannot follow, see [When a run misbehaves](#when-a-run-misbehaves). |

**Placement.** A fresh run puts the isolation flags right after `exec`. On resume, `-s <mode>` goes
before `resume <id>` (observed enforced: a resumed write was denied), while the isolation flags and
every `-c` override must follow the target: placed before it, every command was "blocked by policy"
and Codex still exited `0`. The relay does this for you. There is no `-c sandbox_mode` fallback.

**Claude lanes** are unchanged and outside this dial: Claude lanes load no configured MCP servers and
disallow every `mcp__*` tool. `isolated` is a Codex-only lane dial (see `delegate-setup`'s schema).

**Isolation and sandbox are per invocation** and are not inherited from the session you resume. Repeat
the original `--lane <name>` (or `--read-only --isolated`) on every `--session`/`--resume-last` call, or
the resumed turn runs with your user config, apps, and Codex's own sandbox. `mcpViolation` stays false
on such a resume, because the relay then knows of no read-only sandbox.

**Parallel sessions.** Resume with `--session <threadId>`; `--resume-last` is global and warns. Default
run dirs are distinct. If parallel elevated dispatches fail together with `setup refresh had errors`,
try staggering or serializing them (see troubleshooting); this is not a known defect of a fixed CLI.
The `node_repl.exe` check is advisory and cannot prevent such a race.

### Output directories

An explicit `--out-dir` is locked with `<dir>/.relay.lock` (`{pid, startedAt}`) for the whole run;
sequential reuse works, and the next run clears the previous `result.json` and `final.txt`. A second
relay on the same dir exits `2` without touching it. **That invocation has no result:** any `result.json`
there belongs to the lock owner, so a poller must check the exit code, not only the file. If the lock
is incomplete or malformed the dir stays busy and the message says the metadata is unavailable. The
relay never takes a lock over. A relay killed outright (on Windows, an orchestrator timeout or stopped
task) leaves its lock behind. The conflict message prints the owner's pid and start time: check that
pid (`Get-Process -Id <pid>` / `ps -p <pid>`) and confirm it is not a relay started at that time, since
pids are reused. Then delete `.relay.lock`, or use another dir. When reusing an explicit dir
sequentially, a poller that starts before the new relay clears the old files can read the previous
run's `result.json`: check `startedAt` or the exit code before trusting it.

### Environment and Windows

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

Also on Windows: a sandboxed `--cd` under `%TEMP%` can be denied to the sandbox user, so run Codex
from a normal workspace (relay artifacts may still live under temp). A Windows run checks, warn-only,
for a running `node_repl.exe` with `tasklist.exe /FI "IMAGENAME eq node_repl.exe"` (2 s cap; it never
kills anything, and a failed check is itself only a warning), unless the sandbox is
`danger-full-access`, the backend resolved to `unelevated` (which runs no setup helper), or the
probed version is known to carry the Desktop ACL fix. A fixed CLI lets Codex Desktop stay open for
elevated runs (observed on Windows: the elevated runs completed, reads worked and writes were denied
as expected). The relay recognizes the stable releases that carry the fix and the one prerelease
tested with it (Desktop's bundled CLI); other prereleases and unrecognised `codex --version` output
are treated as not known fixed. An unknown backend (no
isolation, or no configured backend) or an unknown or unrecognised version keeps the check, as does
a resume that passes no sandbox mode. If `node_repl.exe` is running, the warning says the CLI may
predate the Desktop ACL fix: upgrade with `codex update` (or reinstall a current stable CLI) and
check `codex --version` on PATH; if upgrading is unavailable, quit Codex Desktop fully and stop
other runs using `node_repl.exe`. A failed check warns only to upgrade and verify the version.

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
- `status` — `completed` | `failed` | `timeout` | `aborted` | `codex_unavailable` | `sandbox_failed`. Precedence: `sandbox_failed` outranks `aborted`, which outranks `timeout`, which outranks `failed`.
- `exitCode` — mirrors Codex's exit code; `128` plus the signal number if the child was killed; `127` if `codex` isn't on PATH; `1` for `sandbox_failed` even when Codex exited `0`; `2` for an invalid Windows isolation setting; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` — the signal that killed the child, otherwise `null`
- `codexVersion` — the binary that actually ran
- `threadId` — feed this to a later `--session <id>` (exact thread; preferred) or `--resume-last` (global "most recent", which another Codex run can steal)
- `finalMessage` — Codex's own final report (the `<structured_output_contract>` you asked for)
- `touchedFiles` — `git status --porcelain` lines in the working root: your review starting point. `null` (not `[]`) when git can't report — `git` missing, or a non-repo run under `--skip-git-repo-check`; `[]` means git ran and the tree is clean
- `briefPath` / `eventsPath` / `finalPath` — the exact brief relay sent, the raw JSONL event stream, and the final-message file
- `stderrPath` — the complete stderr stream in `stderr.txt`, including diagnostics omitted from the summary
- `workdir`, `sandbox`, `model`, `effort`, `webSearch`, `networkAccess`, `resumeLast`, `session`, `cleanEnv`, `keepEnv`, `startedAt`, `finishedAt` — `sandbox` is the applied mode, or a note that Codex used its active config on an unqualified resume; `session` is the explicit session id, or `null` for fresh and `--resume-last` runs; `keepEnv` records names only, never values; `webSearch` is the mode the relay passed, or `null` when Codex used its configured mode (which may still search); `subagentModel` and `subagentEffort` are the values the relay passed, or `null` when subagents used Codex's own defaults
- `stderrTail` — up to 20 nonblank lines from the final 64 KiB of stderr; a partial first line is marked as truncated. Present on every run that did not complete (`failed`, `timeout`, `aborted`, `sandbox_failed`), absent on `completed`, `codex_unavailable`, and the invalid-isolation-setting `failed` (Codex never ran). Read `stderrPath` for the complete diagnostics.
- `error` — present on a launch failure, on `timeout`, `aborted` and `sandbox_failed` runs, on an invalid isolation setting, and when the `codex --version` preflight fails
- `isolated` — effective isolation (see [Isolation](#isolation)); `ignoreUserConfig` — same as `isolated` (kept for compatibility); `disabledFeatures` — the features passed to `--disable`, `apps` included when isolated; `windowsSandbox` — the backend passed on (`elevated` / `unelevated`), `null` unless one was
- `warnings` — relay-generated messages, also printed to stderr apart from Codex's own stderr: missing Windows config file or key, no model on an isolated run, a running or uncheckable `node_repl.exe` (Windows only, under the conditions in [Environment and Windows](#environment-and-windows)), `--resume-last`, MCP events without an id
- `mcpCalls` — `{count, names: [{server, tool}]}`: distinct MCP tool calls (one per item id, started-only and failed ones included) and their distinct server/tool pairs; arguments and results are never copied. `mcpViolation` — `true` when any such call happened in an isolated run or one with a known `read-only` sandbox (an unqualified, non-isolated resume has no known sandbox). It is an audit field, not an exit policy: **callers must reject a read-only or isolated result with `mcpViolation: true`.**
- `sandboxFailureReasons` — the canonical phrases that matched (empty unless `sandbox_failed`)
- `childExitCode` — Codex's own exit code, `null` if it never ran or died on a signal; `watchdogFired` — whether the `--timeout` watchdog fired; `abortSignal` — the signal that killed the relay on an `aborted` run, else `null`. These keep the underlying facts when a higher-priority status wins.

The helper also prints a summary to stdout and exits with Codex's exit code, so a wrapping script can
branch on success/failure directly.

## Waiting for completion

The helper blocks until Codex finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll — `node relay.mjs
  … &` in bash/zsh (including Git Bash/WSL), or your shell's equivalent (`Start-Job` in PowerShell,
  `start /b` in cmd). A run is done when `result.json` exists with a `status`. **But** a pre-run usage
  error (bad args, empty brief, an `--out-dir` another relay holds) exits with code 2 *before* writing
  any file — so check the exit code too, don't only watch for the file; in a busy `--out-dir` an
  existing `result.json` is the other relay's. (A missing `codex` binary exits 127 but *does* write a
  `result.json` with status `codex_unavailable`; an invalid Windows isolation setting exits 2 *with* a
  `result.json` of status `failed`.)

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written — not when a status line says so.

## When a run misbehaves

- **`status: codex_unavailable` (exit 127):** `codex` isn't on PATH or isn't found. Install
  (`npm i -g @openai/codex`) and `codex login`, then re-dispatch.
- **an `error` mentioning `version preflight` (`failed`, or `timeout` at exit 124):** the bounded
  `codex --version` probe failed (non-zero exit, a signal, or no answer within its cap of 10s, or
  `--timeout` when shorter), so codex was never dispatched; only the relay's own artifacts may already
  exist under `--out-dir`. The `error` text states the probe's exit code, signal or timeout. If the
  probe's stderr carries a sandbox signature the status is `sandbox_failed` instead (see below).
  Check the install by running `codex --version` yourself.
- **`status: sandbox_failed` (exit 1):** Codex's stderr (the whole stream, not only the tail) contained
  `setup refresh had errors` or `blocked by policy` (case-insensitive), so its sandbox could not run
  commands even if Codex exited `0`. It outranks `aborted`, `timeout` and `failed`; `childExitCode`,
  `watchdogFired` and `abortSignal` keep the underlying facts, and `sandboxFailureReasons` names the
  match even when its line fell outside `stderrTail`. The `codex --version` probe's stderr goes through
  the same matcher:
  - Probe fails (non-zero exit, signal or timeout): Codex is not dispatched, and the result is
    `sandbox_failed` if that stderr carries a signature, otherwise `failed` / `timeout`.
  - Probe succeeds (exit `0`) but its stderr carries a signature: Codex **is** dispatched and may change
    files; the final status is still `sandbox_failed` (exit `1`).

  Read `stderrPath`. Do not trust anything in the run; on a write lane, inspect the working tree
  (`touchedFiles`, `git status`) before re-dispatching. Then:
  - The summary prints a hint with three branches. Non-Windows: read `stderrPath` and investigate.
    Windows with a resolved `unelevated` backend, a known-fixed version, or `danger-full-access`: the
    Desktop `node_repl.exe` conflict is not the likely cause; read `stderrPath` for other causes, and
    if failures coincide with parallel elevated dispatches, try staggering or serializing them. Other
    Windows cases (including a failed version probe, which records no version): the CLI may predate
    the Desktop ACL fix, so run `codex update` or reinstall a current stable CLI,
    check `codex --version` on PATH, quit Codex Desktop fully only if upgrading is unavailable, then
    read `stderrPath`.
  - On an older CLI without the fix, `os error 32` with `node_repl.exe` running is the historical
    Desktop conflict: upgrade first, otherwise quit Codex Desktop and any other Codex run that loads
    the user config, then re-dispatch.
  - On a known-fixed CLI, or with no `node_repl.exe` running, if failures coincide with parallel
    elevated dispatches, try staggering or serializing them. This is a troubleshooting step, not a
    known defect of a fixed CLI; the preflight cannot prevent it.
  - Limits: `blocked by policy` is a conservative signature, so a false positive is possible, though a
    legitimate read-only write denial was observed reading `Access ... is denied`, which is *not* a
    signature. Only stderr is scanned: a phrase that appears only inside `events.jsonl` is not
    classified.
- **`status: failed`, exit 2, error `invalid isolation configuration`:** the `[windows] sandbox`
  setting in Codex's `config.toml` is invalid, duplicated, ambiguous or unreadable. Codex was never
  dispatched. For an invalid or duplicated setting, fix it to a single `"elevated"` or `"unelevated"`
  value; for an ambiguous one or a file the scan cannot follow, see the next bullets. Or, if you
  accept loading your full user config (MCP servers and apps included), run `--no-isolated` without
  `--ignore-user-config`.
  - Ambiguous: after a line that holds `"""` or `'''` (outside a full-line comment) or that leaves an
    array or inline table open, any later line that mentions `windows` or `sandbox` as a whole word
    (any case, even in a string or comment; `sandbox_mode` and `[sandbox_workspace_write]` do not count)
    is ambiguous, and so is any later line that holds a complete `\xHH`, `\uHHHH` or `\UHHHHHHHH`
    escape (2, 4 or 8 hex digits). A Windows path such as `C:\Users\me\repo` (Codex's own
    `[projects.'C:\Users\...']` keys) does not count. A path still counts when a component is named
    `Windows` or `sandbox` (`C:\Windows\Temp`, a whole-word mention), or when it starts with what reads
    as a complete escape (`C:\tools\x64`, `...\x86\...`): the scan matches the text, so this holds
    even after an escaped `\\`. The error names that line (`(line N)`). To fix it, put a top-level
    `windows.sandbox = "elevated"` line at the very top of the file, above the first multi-line value
    (a `[windows]` header there would capture the keys below it), and keep every later line free of
    those words (a comment such as `# Windows note` counts) and escapes. Or remove the trigger: put an
    array or inline table on one line, and replace a triple-quoted string (even one on a single line,
    `note = """text"""`) with a regular `"..."` or `'...'` string.
  - Cannot follow: the error's reason reads "the scan cannot follow the syntax here and cannot
    classify the lines after it (line N)" (the full message is
    `invalid isolation configuration in <path>: <reason>. ...`). The file holds TOML the scan cannot
    follow: trailing content after a complete value on the same line (`other = [] sandbox = "unelevated"`,
    `a = 1 2`), a carriage return that is not part of a CRLF line ending (anywhere in a line, or a final
    CR with no LF), an unterminated single-line string, a character that cannot start a value where
    one is expected (`a = ,`, `x = [1,,2]`), a missing value at the end of a line (`a =`,
    `a = # note`; inside an open array or inline table a line may still end waiting for a value),
    a key with no `=` after it on its line (`a`, `a # note`, also inside an open inline table), two
    key parts with no `.` between them or a `.` with no part on one side (`a b = 1`, `a..b = 1`,
    `a. = 1`), a bracket, brace or comma right after a key (`x = { a }`, `a[ = 1`), an `=` with no
    key before it (`= 5`, `x = { = 1 }`), a bare key with an ASCII character outside `A-Za-z0-9_-`
    (`a+b = 1`, `a/b = 1`; quote such a key, and non-ASCII bare keys are accepted),
    a stray multiline delimiter, or a closer that does not match an open bracket (`a = [1}`,
    `a = 1]`). The scan does not validate every TOML syntax error, only the ones listed. The line
    named is where the scan stopped (for an unterminated single-line string, the line that holds
    it). Fix it by making the file valid TOML.
  - Other structural reasons: `a line is longer than the 1 MiB limit`,
    `a value nests deeper than 256 levels`,
    `a multiline string is still open at the end of the file` and
    `an array or inline table is still open at the end of the file` (each with `(line N)`) mean the
    scan will not read the file as it is. For the two end-of-file reasons, N is the last line of the
    file, not the line that opened the string or bracket. Shorten that line, flatten the value, or
    close the string or the bracket. When both are open at the end, the multiline string is the one
    reported.
- **An output-directory lock error (exit 2, no result):** see [Output directories](#output-directories).
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
codex exec [isolation] --json -o <final.txt> -s workspace-write [-m model] [-c model_reasoning_effort=<level>] [-c agents.default_subagent_model=<name>] [-c agents.default_subagent_reasoning_effort=<level>] [-c web_search=<mode>] [-c sandbox_workspace_write.network_access=true] - < brief.txt   # fresh run
codex exec [-s mode] resume <threadId>|--last --json -o <final.txt> [-m model] [-c model_reasoning_effort=<level>] [-c agents.default_subagent_model=<name>] [-c agents.default_subagent_reasoning_effort=<level>] [-c web_search=<mode>] [-c sandbox_workspace_write.network_access=true] [isolation] - < delta-brief.txt  # resume
```

where `[isolation]` is any `--disable <feature>` flags (always), plus `--ignore-user-config --disable apps`
on an isolated run, plus `-c windows.sandbox=<value>` on Windows when an isolated run found a backend.

On resume, the helper places an explicit `--sandbox`/`--read-only` or fleet-lane sandbox before the
`resume` subcommand so Codex applies it to the resumed turn. Without one, Codex uses its active config.
The isolation flags and `-c` overrides go after the resume target (see [Isolation](#isolation)).
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
