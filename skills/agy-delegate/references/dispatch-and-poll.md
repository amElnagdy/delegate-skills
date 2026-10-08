# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `agy --print`, runs the brief in Antigravity,
captures the final response, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file.

## Before the first run: check the binary

```bash
command -v agy
agy help
agy models
```

`agy models` proves the CLI can authenticate and list available model labels. The relay records the
version it can infer from `agy changelog` into `result.json`. Neither command proves that a headless
write will be approved.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed - the folder containing its `SKILL.md`.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin before passing it to `agy --print`. |
| `--cd <dir>` | Working root for Antigravity (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Antigravity model label. Optional; a fresh run can use Antigravity's configured default. |
| `--effort <level>` | Reasoning effort: `low`, `medium`, or `high` (passed as agy's own `--effort`). |
| `--project <id>` | Use an existing Antigravity project. |
| `--new-project` | Force a fresh project; with auto-grant, replace the workspace registration. |
| `--auto-grant` | Opt into managed project write and command approvals. Off by default. |
| `--no-auto-grant` | Override fleet opt-in and skip preparing approvals; existing grants are not revoked. |
| `--allow-command <name>` | Add a bare executable/cmdlet name to project approvals; repeatable. Requires auto-grant. |
| `--auto-grant-dry-run` | Print proposed approvals without launching AGY or writing files; no brief required. |
| `--resume-last` | Continue the most recent Antigravity conversation; send only the delta brief. |
| `--conversation <id>` | Continue a specific Antigravity conversation; send only the delta brief. |
| `--sandbox` | Enable Antigravity's terminal sandbox for the run. |
| `--read-only` | Windows: fresh plan mode without bypass; rejects existing projects/resumes. Other platforms: existing sandbox plus internal tool approval. See read-only behavior below. |
| `--dangerously-skip-permissions` | Pass Antigravity's permission-bypass flag; mutually exclusive with `--read-only`. Never use this unless the human explicitly accepts it. |
| `--print-timeout <duration>` | Timeout agy itself applies to print mode (default: `30m`). |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`); overrides the default of `--print-timeout` plus a 60s grace. On expiry the agy process tree is killed and `result.json` gets `status: "timeout"`. Set it explicitly when agy may hang past its own print timeout. Malformed, zero, and out-of-range durations are rejected; the maximum is `596h31m23s`. |
| `--add-dir <dir>` | Add an extra workspace directory. Repeatable; relative paths resolve against `--cd`. Fresh runs always add the `--cd` repo (absolute path) as a workspace dir. Edits inside extra workspaces are not reported in `touchedFiles`. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Antigravity's edits and nothing of the helper's own.

## Managed project permissions

Headless `agy --print` cannot answer tool permission prompts. A working directory or an
`--add-dir` workspace does not itself approve writes or commands. The relay detects the CLI's
auto-denial rather than reporting a successful no-op.

For trusted implementation work, opt into project approvals:

```bash
node "<skill-dir>/scripts/relay.mjs" --cd /path/to/repo --auto-grant-dry-run
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo --auto-grant
```

The dry-run prints the proposed rules, UUID and paths without launching AGY or creating files.
Normal dispatch remains unchanged unless `--auto-grant` or an AGY fleet lane's `autoGrant: true`
is selected. Explicit flags override fleet dials. `--allow-command <name>` adds a bare executable
or cmdlet name; it requires opt-in. Repeated explicit command flags replace lane `allowCommands`
extras. Names containing shell syntax are rejected.

The relay creates or reuses a project keyed by the canonical absolute `--cd` directory
(case-insensitive on Windows). `--new-project` replaces that registration with a new UUID.
An explicit `--project` must be an existing UUID for auto-grant; with auto-grant off, AGY project
names are also accepted. Read-only, permission-bypass and resume runs prepare no new approvals.
Resume retains the conversation's existing permission state.

Project JSON is written to `~/.gemini/config/projects/<uuid>.json` with nested
`permissionGrants.permissionGrants.allow` / `deny` arrays and escaped file URLs in
`projectResources.resources`. The schema is inferred from AGY rather than a documented stable
API; see the README's verification status for the tested CLI and platform. Files use UTF-8
without BOM: an incompatible or BOM-prefixed file can make AGY fall back to its default project.
The relay fails if the log reports a different project than the managed UUID. Missing log IDs
remain `null` and do not prove which project was selected.

The registry lives at `$XDG_CONFIG_HOME/delegate-skills/agy-projects.json` or
`~/.config/delegate-skills/agy-projects.json`; `DELEGATE_CONFIG_DIR` overrides its directory.
`AGY_CONFIG_DIR` overrides only the relay's project-file location. It does **not** relocate
AGY's configuration: use it for offline tests or an AGY installation already reading that location.
Existing user fields, grants and resources are preserved. Only recorded relay-owned entries
are replaced, so removed extra directories and command extras lose the relay's approvals.
Untracked pre-existing grants remain the user's responsibility.

Relay writers lock registry updates. Each file is replaced atomically, and a pending transaction
records permission ownership before the project write. A later normal dispatch recovers an
interrupted update; dry-run reports that recovery is needed without writing. Malformed state or
an external edit during an interrupted transaction fails with an actionable path, preserving the
files for inspection. This is process-interruption recovery, not a power-loss durability guarantee.
Avoid editing project JSON concurrently with dispatch.

Write grants cover `--cd` and explicit `--add-dir` directories, without glob patterns.
Default command approvals cover node/npm/npx/pnpm/yarn, python/py/pip, git, pwsh/powershell,
common PowerShell file cmdlets, echo/dir/type/cd. Each gets anchored regex rules for a bare invocation
and arguments. Inspect the exact list with dry-run before choosing this policy.

**Command approvals are not filesystem confinement.** Shells, interpreters, package tools and
file commands can modify paths outside the workspace. Denies for ordinary `git push`,
`git reset --hard`, `git clean` and `rm -rf` spellings are best-effort guards;
shell chaining and alternative spellings can evade them. Auto-grant is an approval convenience
for a trusted implementer, not an OS sandbox. Grants persist in the project after dispatch;
opting out skips updates rather than revoking existing approvals. Remove the managed project
and its registry entry when that project is no longer needed.

## Read-only behavior

On Windows, `--read-only` launches a fresh project with `--mode plan` and no permission
bypass. Explicit projects and resume flags are rejected before launch because inherited write
grants can permit writes even in plan mode. A direct file-read review can complete; a tool that
needs an unapproved permission is denied and the relay reports failure. Global permissions can
still affect a fresh project, so plan mode is not OS-enforced read-only access.

Other platforms retain the existing `--sandbox --dangerously-skip-permissions` launch.
The Windows tests do not establish that behavior on other platforms. On all platforms the relay
fingerprints the working tree; a proven change forces failure. A `null` verdict means incomplete
coverage, not proof of no changes. Ignored files, reverted edits and paths outside the working
root are outside that evidence. Use an OS-enforced boundary when those writes must be prevented.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` - the result-format version (currently `delegate-relay.result.v1`)
- `tool` - `agy`
- `status` - `completed` | `failed` | `timeout` | `aborted` | `agy_unavailable`
- `exitCode` - mirrors Antigravity's exit code; `128` plus the signal number if the child was killed; `127` if `agy` is not on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` - the signal that killed the child, otherwise `null`
- `agyVersion` - inferred from `agy changelog` when available
- `projectId` / `conversationId` - parsed from the Antigravity log when present
- `finalMessage` - Antigravity's stdout response
- `touchedFiles` - `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git cannot report; `[]` means git ran and the tree is clean
- `readOnlyViolation` - `true` when fingerprints prove a working-tree change, `false` when coverage is complete and proves none, and `null` when fingerprinting was incomplete or the run was not `--read-only`
- `briefPath` / `finalPath` / `logPath` / `stderrPath` - the exact brief, final message, Antigravity
  log, and stderr capture
- `workdir`, `model`, `effort`, `project` (the `--project` you passed, vs `projectId` parsed from the log),
  `sandbox`, `readOnly`, `dangerouslySkipPermissions`, `resumed` (true for a `--resume-last` or `--conversation`
  run), `startedAt`, `finishedAt`
- `stderrTail` - last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), except a launch failure, which reports `failed` with no `stderrTail`; also present when `finalMessage` is empty so diagnostics are not discarded
- `autoGrant` - approval metadata: `enabled`, skip `reason`, or the managed `projectId`, `projectPath`, `registryPath`, `reused`, `allow`, `deny`, and `commandPermissionsAreNotSandboxed`
- `error` - present on a launch failure, `timeout`, `aborted`, headless permission denial, or silent no-op

The helper also prints a summary to stdout and normally exits with Antigravity's exit code. It forces
exit 1 when Antigravity exits 0 after a detected headless permission denial or with neither a final
message nor observable working-tree changes. A proven read-only violation or logged managed-project mismatch also forces failure. A wrapping script can branch on success/failure directly.

## Waiting for completion

The helper blocks until Antigravity finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the Bash call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll. A run is done
  when `result.json` exists with a `status`. A pre-run usage error exits with code 2 before writing any
  file, so check the exit code too. A missing `agy` binary exits 127 and writes `result.json` with
  `status: agy_unavailable`.

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written.

## When a run misbehaves

- **`status: agy_unavailable` (exit 127):** `agy` is not on PATH. Install the Antigravity CLI and run
  its first-launch setup, then re-dispatch.
- **`status: timeout`:** the relay watchdog killed the run. Inspect `error` to see whether the selected
  limit was explicit `--timeout` or the derived `--print-timeout` plus 60s grace. The working tree may
  hold a half-applied change — inspect it before changing that limit, reducing the brief, or resuming.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to agy. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and `events.jsonl` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child - commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail`, `stderrPath`, and `logPath` for the cause.
  Common causes: auth lapse, an unknown model label, timeout, or a permission the run needed.
- **Headless write permission denied:** the relay detects Antigravity's `no output produced ...
  auto-denied` stderr sentinel, reports `status: failed`, preserves `stderrTail`, and exits 1.
  For an approved write task, inspect `--auto-grant-dry-run` and opt in with `--auto-grant`.
  See managed project permissions above before choosing command approvals.
- **Empty `finalMessage`:** a run with edits may still be correct - check `touchedFiles`, the diff, and
  the preserved `stderrTail`. With no observable edits, the relay reports `status: failed` rather than
  claiming completion. To get a report next time, add a `<structured_output_contract>` block (see
  [writing-the-brief.md](writing-the-brief.md)).

## What the helper is doing

Under the hood the helper runs roughly:

```bash
agy --new-project --add-dir <repo> --print-timeout 30m --print=<brief>
agy --continue --print-timeout 30m --print=<delta brief>
agy --conversation <id> --print-timeout 30m --print=<delta brief>
```

`agy --print` requires the prompt as a flag argument, so keep briefs focused. The relay still accepts
stdin or `--brief <file>` for your convenience; it reads the text first, then passes it to `agy` as
`--print=<brief>` (the `=` form so a brief that begins with a bare flag like `--help` still runs).
Two consequences of the brief riding the command line: it is visible in the host process list (`ps`),
so on a shared machine keep secrets out of it; and a brief over ~120 KB is rejected up front (the OS
caps a single argument), so have `agy` read large context from the workspace instead of inlining it.

## The commit boundary

The helper never commits - by design, not omission. The robust contract is: Antigravity edits the
working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).

## Permission engine traps

Permission matching varies by AGY version and platform. Historical upstream reports describe
bare-command matching, executable paths containing spaces, differing settings files and unsupported
write globs ([issue #614](https://github.com/google-antigravity/antigravity-cli/issues/614)).
Do not assume the settings path in a denial message is the effective one on your installation.
The managed project mechanism avoids global settings changes and uses explicit directory rules
plus command regexes. If a targeted approval still fails, inspect the log and reproduce it with
a small brief; do not silently switch to permission bypass.
