# Dispatch and poll

`scripts/relay.mjs` is the Command Code-specific transport. It validates options, sends the brief on
stdin to `command-code -p`, captures NDJSON, and writes a stable result contract for the orchestrator.

## Check installation and authentication

```bash
command-code --no-auto-update --version
command-code status --json
command-code --list-models
```

`status --json` must report `"authenticated": true`. On native Windows, use full `command-code` or
the `cmdc` alias; bare `cmd` is Windows Command Prompt. The relay resolves an absolute
`command-code` npm shim from absolute PATH entries before changing working directory, resolves its
package entrypoint, then runs that entrypoint with the current Node executable for both version probe
and dispatch. This prevents repository-local `command-code` or `node` shims from taking over.

## Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing `SKILL.md`. The skill loader normally prints its base
directory when loading the skill.

| Relay flag | Effect |
| --- | --- |
| `--brief <file>` | Read brief from file. Omit to read stdin. |
| `--cd <dir>` | Target working directory; defaults to current directory. |
| `--lane <name>` | Resolve model, effort, timeout, and read-only dials from `delegate-setup`; explicit flags win. |
| `--model <id>` | Requested model override; otherwise use fresh-run config or resumed-session model. |
| `--effort <level>` | Optional reasoning effort. |
| `--max-turns <n>` | Positive maximum agent-turn count. |
| `--read-only` | Use enforced Command Code plan mode; never add bypass. |
| `--resume-last` | Use `--continue`; Command Code starts fresh if no headless session exists. |
| `--session <id>` | Resume exact session id; mutually exclusive with `--resume-last`. |
| `--timeout <dur>` | Relay watchdog; defaults to `30m`, using positive `h`/`m`/`s` strings. |
| `--out-dir <dir>` | Artifact directory; must be outside target workspace. |
| `-h`, `--help` | Print relay help. |

Dynamic model, effort, and session values are restricted to token-shaped selectors. The relay locates
the npm shim but executes the package entrypoint with the current Node executable, without a shell.
Brief content is never a command-line value.

## Permission behavior

Default write dispatch adds `--yolo`. Command Code headless mode otherwise denies edits and arbitrary
shell commands, so it could not implement and run project gates unattended. `--yolo` is bypass mode,
not workspace sandboxing: use it only in trusted repositories. Explicit `deny` and `ask` rules plus
the root/home delete circuit breaker still outrank bypass.

If `permissions.disableBypass` is enabled in managed or user settings, Command Code neutralizes
`--yolo` to default mode. A headless write run can then fail on permissions. Do not remove policy
blindly; inspect the rule and ask the human before changing it.

The relay detects staging and local HEAD changes, but cannot prove that no remote push occurred. For a
hard guard, keep user or project deny rules such as `Shell(git commit:*)`, `Shell(git push:*)`,
`Shell(git reset:*)`, and `Shell(git clean:*)`. Explicit deny rules still apply under bypass. The relay
does not rewrite Command Code permission policy.

`--read-only` adds `--plan` instead. Plan mode blocks repository edits and mutating shell commands.
The relay compares raw tracked files and nonignored untracked files before and after, including file
type and mode, and records `readOnlyViolation`. Ignored files and transient changes remain outside this
final-state proof. Repositories containing submodules are rejected rather than falsely treating gitlink
directories as fully hashed nested worktrees.

## Artifacts

Artifacts are required outside the repository so they do not pollute `touchedFiles`. Default runs use
a private randomly named directory directly under canonical system temp. Explicit `--out-dir` is
canonicalized before creation, and any path resolving inside the target workspace is rejected:

- `brief.txt`: exact brief sent on stdin.
- `events.jsonl`: raw Command Code NDJSON stdout.
- `stderr.log`: complete raw stderr from the Command Code child.
- `final.txt`: final assistant text when a result frame exists.
- `result.json`: normalized relay result.

## `result.json`

Important fields:

- `schema`: `delegate-relay.result.v1`.
- `tool`: `commandcode`.
- `status`: `completed`, `failed`, `timeout`, `aborted`, or `commandcode_unavailable`.
- `exitCode`: Command Code exit code; 127 when unavailable; 124 for a preflight timeout; 128 plus the
  signal number when aborted; or synthetic 1 when output is incomplete.
- `signal`: terminating signal, otherwise `null`.
- `resultSubtype`: Command Code final subtype such as `success`, `error`, or `max_turns`.
- `commandCodeShimPath`: absolute npm shim found through PATH/PATHEXT.
- `commandCodePath`: canonical npm package entrypoint executed through `process.execPath`.
- `nodePath`: Node executable used for the package entrypoint.
- `gitPath`: canonical git executable used for HEAD, index, and raw worktree probes. Final
  `touchedFiles` follows the shared relay helper's PATH lookup.
- `commandCodeVersion`: executable version used.
- `sessionId`: id returned by Command Code for exact continuation.
- `requestedSessionId`: id supplied through relay `--session`, if any.
- `stopReason`: final model stop reason when supplied.
- `finalMessage`: Command Code's final report from `finalText`.
- `usage`: token usage object from Command Code.
- `durationMs`: Command Code-reported duration.
- `lane`, `laneSource`: selected fleet lane and config scope, or `null` without `--lane`.
- `timeout`: selected relay watchdog duration.
- `initialTouchedFiles`: pre-dispatch porcelain lines for write runs; `null` for read-only raw snapshots.
- `touchedFiles`: final porcelain lines for write runs; for read-only runs, raw file changes during the
  run. `null` when state cannot be established.
- `gitHeadBefore`, `gitHeadAfter`, `gitHeadChanged`: final commit-history tripwire.
- `gitIndexChanged`: final staged-index tripwire.
- `gitMutationViolation`: final-state HEAD/index comparison; `true` fails the run, `null` means unknown
  and also fails completion.
- `gitWorktreeHashBefore`, `gitWorktreeHashAfter`: read-only hashes of raw tracked files and
  nonignored untracked content, including assume-unchanged and skip-worktree paths.
- `readOnlyViolation`: present for read-only runs; `true` or `false` when git can compare raw worktree
  state, otherwise `null`.
- `stderrTail`: last stderr lines on failed runs when stderr is nonempty.
- `error`: launch, result, or missing-result error on failed runs.
- `briefPath`, `eventsPath`, `stderrPath`, `finalPath`: artifact paths.
- `workdir`, `autonomy`, `model`, `effort`, `maxTurns`, `resumeLast`, timestamps: requested run
  metadata. Null model/effort/max-turn values mean no relay override, not that the CLI used none.

A successful process is not enough. Relay status becomes `completed` only when Command Code exits 0,
emits a valid final NDJSON success result, has explicit `gitMutationViolation: false`, and, for
read-only runs, has explicit `readOnlyViolation: false`.

Git and read-only fields are complete on dispatched runs. `commandcode_unavailable` and early
preflight failures can omit those fields because no Command Code run occurred.

## Waiting

The relay blocks. In an orchestrator with background jobs, start the relay as a background command and
wait for process completion. Else run it in the foreground. A run is complete only when the process
has exited and `result.json` exists.

Catchable POSIX signals and console interrupts produce `status: aborted` and terminate the child
process group. Windows force-termination APIs cannot be intercepted; when canceling there, terminate
the relay process tree through the orchestrator's job facility. Killing only the relay process can
leave a CLI descendant running.

A validation error such as unknown options, empty brief, or conflicting resume flags exits 2 before
creating artifacts. Missing CLI writes `result.json` with `commandcode_unavailable` and exits 127.

## Failure handling

- `commandcode_unavailable`: no supported npm `command-code` entrypoint was resolved from absolute PATH
  entries. Install with `npm i -g command-code`, or fix PATH/install layout.
- Version preflight failure: status is `failed`, not unavailable; a hung probe is `timeout`. Inspect
  the reported path, Node version, stderr, and installation.
- Exit 3: authentication failed; log in again.
- Exit 4: permission denied; inspect project rules rather than blindly removing them.
- Exit 5: rate limit; wait or choose a human-approved alternative.
- Exit 6 or 7: network or service failure; retry only after identifying the cause.
- Exit 8 or `max_turns`: split the task or raise `--max-turns` deliberately.
- Exit 10: insufficient credits; stop and ask the human.
- Empty or missing final result: inspect `events.jsonl` and `stderr.log`; do not treat partial edits as
  complete.

Relay-generated exit 1 also covers invalid success frames, unknown/failing git tripwires, read-only
violations, and version preflight failure; it is not always a Command Code exit code.

## Underlying commands

The relay executes these shapes and sends the brief on stdin:

```bash
# write-capable run
command-code -p --output-format json --skip-onboarding --no-auto-update --trust --yolo

# read-only run
command-code -p --output-format json --skip-onboarding --no-auto-update --trust --plan

# exact continuation adds
--resume <session-id>

# latest continuation adds
--continue
```

Do not replace these with invented `run`, `exec`, `--sandbox`, or `--prompt-file` forms.

## Commit boundary

The relay does not stage, commit, push, reset, or clean. Review and landing remain orchestrator work.
