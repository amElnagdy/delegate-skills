# Configuration and lifecycle

Install codex-background and each selected implementer delegate skill explicitly. This package
does not declare automatic Skills CLI dependencies, and installation itself does not touch Codex
configuration; the bootstrap script does, when you (or Codex) run it.

```sh
npx skills add amElnagdy/delegate-skills --skill codex-delegate
npx skills add amElnagdy/delegate-skills --skill codex-background
```

The first skill selects a Codex implementer; the second supports a Codex orchestrator using any
registered implementer. A short foreground shell run does not require the support utility.
For background work, missing MCP tools are a setup step, not a reason to start polling.
The scripts use Node built-ins only and make no network calls themselves. The selected relay
continues to launch its own implementer CLI with its existing authentication and permissions.

## Setup: install, bootstrap, restart, use

1. Install the delegate skills you want and codex-background (above).
2. Bootstrap. Codex runs this itself when the MCP tools are missing (the SKILL.md tells it to);
   you can also run it by hand from the installed skill directory:

   ```sh
   node "<skill-dir>/scripts/bootstrap.mjs"
   ```

3. Restart Codex (or reload MCP servers) if bootstrap says config or registry changed.
4. Delegate. Codex writes each brief to `<codex-home>/codex-background/briefs/<runId>.txt` and uses
   `<codex-home>/codex-background/runs/<runId>` as outputDirectory; the server's initialize
   instructions and tool descriptions state these exact paths, so no brief needs to be moved by hand.

`<codex-home>` is `--codex-home`, else `$CODEX_HOME`, else `~/.codex`. Bootstrap is idempotent:
a second run with nothing to change writes nothing, creates no backup and reports "Already configured."

| Flag | Meaning |
| --- | --- |
| `--codex-home <dir>` | Codex home to configure |
| `--skills-dir <dir>` | installed skills directory to scan (default: the parent of this skill's directory) |
| `--workspace-root <dir>` | approved workspace root; repeatable. Default: the home directory plus `<codex-home>/worktrees` when it exists. Roots nested inside another are dropped |
| `--host-timeout <s>` | host tool timeout in seconds, 31 or more (default 7200). Also written to `tool_timeout_sec` |
| `--dry-run` | print the planned changes, write nothing |
| `--check` | validate only, write nothing (see below) |
| `--json` | machine-readable summary instead of text |
| `--help` | usage |

An unknown flag or a missing value is a usage error (exit 2). Other failures exit 1.

### What bootstrap writes

- `<codex-home>/codex-background/registry.json` (schema `codex-background.registry.v1`, mode 0600,
  written atomically): `hostToolTimeoutSeconds`, `stateDirectory` (`.../codex-background/state`),
  `workspaceRoots`, `artifactRoots` (`[<codex-home>/codex-background]`) and `relays`. `relays` comes from
  a scan of the skills directory only: every sibling `<key>-delegate` directory whose `scripts/relay.mjs`
  exists, with the same key rules the server enforces. No PATH scan or executable discovery happens.
  Re-running refreshes `relays` and keeps a previously written `workspaceRoots` and host timeout unless the
  matching flag is passed. A registry that is not valid JSON, has another schema, or uses other state/artifact
  roots is copied to `registry.json.bak-<timestamp>` before it is replaced.
- `<codex-home>/codex-background/{state,briefs,runs}` directories.
- `<codex-home>/config.toml`, created when missing. Bootstrap owns only the tables
  `[mcp_servers.codex_background]` (`command` = the running Node executable, `args` = this skill's
  `scripts/server.mjs`, `tool_timeout_sec`, `required = true`) and `[mcp_servers.codex_background.env]`
  (`CODEX_BACKGROUND_REGISTRY`), written inside a marked block (`# BEGIN codex-background ...` to
  `# END codex-background`). Re-running replaces only that block. A hand-written copy of those two
  tables outside the block (the old manual setup) is removed and replaced by the block; any other key you
  had inside them is dropped, reported, and kept in the backup.
- `direct_only_tool_namespaces` under `[features.code_mode]` gains `"mcp__codex_background"`, which makes
  Codex expose the tools as direct native calls instead of through the code-mode exec wrapper that yields
  early and re-polls. Existing entries and order are kept (single-line and multi-line arrays); when the key
  is missing it is inserted under the existing table; when there is no `[features.code_mode]` table, it is
  added inside the managed block.
- Everything else in `config.toml` is preserved byte for byte, including comments and the file's CRLF or LF
  line endings. Before any change to an existing file, a copy is written next to it as
  `config.toml.bak-<timestamp>`. Nothing is written, and no backup made, when the content would not change.

### Conflicts and refusals

Bootstrap does no TOML rewriting beyond the above. If `code_mode` is defined another way
(`code_mode = true` or an inline table under `[features]`, a dotted `features.code_mode...` key, or
`[[features.code_mode]]`), the namespace entry holds anything but single-line strings, the file has duplicate
managed tables, unbalanced markers, or text it cannot parse (for example an unterminated array or string),
bootstrap leaves `config.toml` untouched, prints the exact manual step, and exits 1. The registry may still
have been written. Fix the file by hand and re-run.

### Restart

The server reads the registry at startup. If `config.toml` changed, restart Codex (or reload MCP servers).
If only the registry changed (for example after installing another delegate skill), restart or reload the
codex-background MCP server too. Re-run bootstrap after installing more delegate skills so they are registered.

### Validation (`--check`, and automatic after a write)

Reports pass/fail per item and exits non-zero on any failure: the managed config values and the namespace
entry, the registry parse, each registered relay path, then it starts `server.mjs` with the configured
command, args and `CODEX_BACKGROUND_REGISTRY`, performs an MCP `initialize` plus `tools/list` over stdio, and
requires `delegate_run`, `delegate_wait` and `delegate_abort` with an implementer enum equal to the registered
keys. It closes stdin to stop the server. `--check` expects the same Node executable and skill that bootstrap
would write; after moving or reinstalling either, re-run bootstrap.

## Registry

The server reads the file named by CODEX_BACKGROUND_REGISTRY in its MCP server environment. The
server never updates the registry; bootstrap does, only when run. No PATH scans, fleet discovery or
executable overrides occur. A key maps to the canonical installed <key>-delegate/scripts/relay.mjs
file. Only those registered scripts can be launched, always with the server's Node executable and no shell.
If the registry is missing or invalid the server exits at startup and its error names the bootstrap command.

Windows registry paths use JSON-escaped backslashes or forward slashes (bootstrap writes forward slashes).
The state directory must be within an artifact root. A run's output directory must be fresh, within
artifact roots and outside adapter state. Workspaces and briefs are canonicalized and checked against
approved roots. These admission checks do not sandbox implementer tools; the selected delegate's
permission model and the host's OS containment still apply. Registered scripts/configuration must be trusted.
The default workspace root is your whole home directory; narrow it with `--workspace-root`.

## Manual configuration (advanced)

Bootstrap is the supported path. To configure by hand instead, create the registry (replace every example
path with an absolute path appropriate to the host):

```json
{
  "schema": "codex-background.registry.v1",
  "hostToolTimeoutSeconds": 7200,
  "stateDirectory": "/absolute/artifacts/codex-background-state",
  "workspaceRoots": ["/absolute/projects"],
  "artifactRoots": ["/absolute/artifacts"],
  "relays": {
    "agy": "/absolute/skills/agy-delegate/scripts/relay.mjs",
    "codex": "/absolute/skills/codex-delegate/scripts/relay.mjs"
  }
}
```

then add a stdio MCP server whose command is the installed Node executable and whose args contain only the
absolute `codex-background/scripts/server.mjs` path, with `tool_timeout_sec` matching hostToolTimeoutSeconds
(`startup_timeout_sec` controls startup only and does not extend tool execution). Substitute absolute paths;
do not commit the user's resolved configuration:

```toml
[mcp_servers.codex_background]
command = "/absolute/path/to/node"
args = ["/absolute/skills/codex-background/scripts/server.mjs"]
tool_timeout_sec = 7200
required = true

[mcp_servers.codex_background.env]
CODEX_BACKGROUND_REGISTRY = "/absolute/config/codex-background-registry.json"

[features.code_mode]
direct_only_tool_namespaces = ["mcp__codex_background"]
```

Without the last table Codex routes the tools through its code-mode exec wrapper, which yields early and
re-polls. Running bootstrap later migrates a manual setup into the managed block.

## Codex host behavior

Restart/reload the MCP connection after changing the registry. Invoke the exposed MCP tool directly,
or through a host execution primitive that keeps the outer request pending for its full budget.
An outer execution wrapper with a short yield timeout can resume model inference independently of
this server. Do not drive functions.exec/wait, sleep or status loops to wait for delegation.
The adapter cannot override Desktop/App Server's host timeout or scheduling policy. Validate the
actual host configuration before a real delegation; protocol fixtures alone do not prove zero
reasoning tokens in Desktop.

## Tools and arguments

- delegate_run requires runId (1–80 letters/digits/underscore/hyphen), implementer, brief, workspace,
  outputDirectory and positive integer relayTimeoutSeconds. Optional relayArgs is a string array.
  No executable/relay paths or other fields are accepted. Common --brief, --cd, --out-dir and
  --timeout flags, including equals syntax, cannot occur in relayArgs.
- delegate_wait requires only runId. It waits on the original owned job or returns its persisted
  terminal outcome. Use it for reattachment after interruption, never as periodic status polling.
- delegate_abort requires only runId. It stops a currently owned job and waits for closure.
  It cannot abort unresolved jobs from another server instance or a prior crashed server.

Inside the ownership supervisor, the relay invocation is Node + registered relay + relayArgs followed by --brief, --cd, --out-dir and
--timeout derived from the structured fields. Provider flags, argument ordering within relayArgs,
models, variants and resume IDs are neither translated nor interpreted. Existing relays validate
unsupported flags as before. An additional --add-dir is checked against approved workspace roots
without rewriting the value. Other provider paths and permissions retain their native semantics.

Host timeout must be strictly greater than relayTimeoutSeconds + 30. The relay's own watchdog is
primary. An adapter guard terminates a stuck owned tree after relayTimeoutSeconds + 15 seconds,
leaving delivery margin before the declared host budget. An ownership supervisor stays alive beyond relay-parent exit until all owned descendants exit.
On Windows, an inbox PowerShell/C# helper creates the relay suspended, assigns a kernel job
with KILL_ON_JOB_CLOSE and no breakaway, and resumes it only after assignment. taskkill /T
terminates the live supervisor; closing the job owner kills descendants even if their relay
parent has already exited. No global execution-policy setting is changed. Add-Type/kernel-job
restrictions fail the run clearly rather than fall back to an unsafe parent-PID snapshot.
On Linux, a live session/group leader reserves the process-group identity. A small bundled
C helper is compiled with the fixed system compiler /usr/bin/cc into the run state directory.
It uses PR_SET_CHILD_SUBREAPER to adopt descendants after parent exit, including implementers
that the existing relays deliberately launch in separate sessions. It signals only its own
unreaped children and waits until there are none; adopted IDs cannot be reused while unreaped.
Abort/timeout/shutdown signal the reserved group and give the subreaper time to reap detached
descendants before a final group sweep. This needs Linux procfs and a local C compiler; no
package is downloaded or installed. Other POSIX hosts fail startup explicitly until an equivalent
safe ownership primitive is implemented. A process group alone is insufficient for these relays.
Relay completion and ownership closure are distinct; result.json can appear before either.
Both timers run in the server process,
without notifications or model inference. Explicit abort and graceful shutdown terminate the owned
process tree (taskkill on Windows; owned Linux process group/subreaper TERM then KILL).

## Results, cancellation and recovery

Each run has an exclusive durable state directory, run.json, stdout.log, stderr.log and outcome.json.
A second exclusive claim prevents another run/server from using the same canonical output path.
Used IDs/output paths are not automatically reusable, even after a failure. Keep state on a local
filesystem that supports exclusive creation and atomic rename, with access restricted to the user.
Do not remove state while runs are active; archive it only after reviewing completed work.

Relay stdout/stderr go to local files; no progress/log MCP notifications are emitted. The one
completion response contains adapterStatus, exitCode/signal, artifact/log paths and resultText with
resultEncoding. result.json is never parsed, repaired or overwritten. Its whitespace, finalMessage,
threadId, provider resume fields and custom artifacts survive unchanged. Binary content is returned
as base64. Missing results and nonzero exits are adapter failures; a forced kill never fabricates a
provider result. Review relay status separately even when adapterStatus is completed.

Cancelling the MCP request suppresses its response but does not terminate the job. Reattach with
runId. Graceful connection/server shutdown aborts owned jobs and persists terminal outcomes.
A later server can return terminal outcomes without launching a relay. After an abrupt crash,
a run without a terminal outcome is recovery_required: its original process may still exist.
No stale PID is adopted, probed or killed. Inspect the preserved artifacts and resolve the run
manually through the provider's existing workflow before starting a new explicitly authorized run.

## Local validation

```sh
node --check skills/codex-background/scripts/bootstrap.mjs
node --test --test-concurrency=1 skills/codex-background/scripts/bootstrap.test.mjs
node --test --test-concurrency=1 skills/codex-background/scripts/server.test.mjs
node --test test/codex-background-relays.mjs
node --test test/codex-background-bootstrap-e2e.mjs
```

The bootstrap tests use temporary Codex homes and fake skills directories only; they never read or write the
real `~/.codex` or `~/.agents`. They cover fresh install, CRLF and unrelated-content preservation, migration
of the manual setup, `code_mode` array edits, idempotency, `--dry-run`/`--check`, conflict refusal, an
unsupported host, zero relays and registry re-runs. The end-to-end test installs copies of codex-background,
agy-delegate and codex-delegate into a temporary skills directory, runs bootstrap, launches the server from
the generated config and completes one `delegate_run` against a fake implementer.

The lifecycle fixture runs for 65 seconds and emits noisy stdout/stderr, while asserting one
MCP tool invocation, zero intermediate notifications and one completion response. Lifecycle tests
cover opaque bytes, failure, watchdogs, abort/tree cleanup, cancelled waits, restart recovery,
configured admission and duplicate claims. Integration fixtures exercise common arguments, native resume/add-dir handling and watchdogs
for all 17 unchanged relays. AGY, Codex, ZCode, Cline and OpenCode additionally have successful
completion fixtures. Results remain opaque to the adapter; malformed JSON with exit zero is
returned unchanged, while a missing result file fails. These tests use fake CLIs; no account login or real delegation is performed.

## Native host verification boundary

The installed App Server exposes mcpServer/tool/call with threadId, server, tool and arguments.
That RPC calls the configured MCP server directly. An optional local fixture measures a single
pending native App Server request for more than 65 seconds without starting a model turn:

```sh
# Set CODEX_BACKGROUND_APP_SERVER to the absolute reviewed installed Codex binary.
node test/codex-background-app-server.mjs
```

This isolates CODEX_HOME in a temporary fixture, uses no account credentials and performs no
real delegation or inference. It demonstrates the native RPC wait, not an active model turn's
reasoning usage or Desktop's orchestration policy. To verify a real host turn, record one
mcpToolCall item from item/started through item/completed, check the absence of additional
reasoning/tool calls while it is pending, and correlate thread/tokenUsage/updated with completion.
Account-wide quota percentages alone cannot attribute tokens to that waiting interval.

Invoke the exposed MCP tool directly from Codex. Do not ask the model to call the App Server
RPC through an early-yielding exec wrapper: that recreates the polling boundary. The host
requires tool_timeout_sec above the declared relay budget; required=true makes MCP initialization
failure explicit. Current documentation: [App Server](https://developers.openai.com/codex/app-server)
and [configuration reference](https://developers.openai.com/codex/config-reference).

## Relay compatibility

Every existing relay accepts the appended --brief, --cd, --out-dir and --timeout inputs. Native
relayArgs go first, unchanged. Relays own flag validation, native resume mapping, and watchdog
behavior. The adapter adds only configured-root admission checks for --add-dir; providers that
do not support that flag still reject it themselves. No provider translation belongs in this utility.

| Implementer | Native resume flags | Native --add-dir | Fixture coverage |
| --- | --- | --- | --- |
| agy | --conversation, --resume-last | yes | success + timeout |
| aider | --resume-last (chat history) | no | timeout |
| claude | --session, --resume-last | no | timeout |
| cline | unsupported | no | success + timeout |
| codex | --session, --resume-last | no | success + timeout |
| commandcode | --session, --continue-last | no | timeout |
| copilot | --session, --resume-last | no | timeout |
| cursor | --session, --resume-last | yes | timeout |
| grok | --session, --resume-last | no | timeout |
| kimi | --session, --resume-last | yes | timeout |
| omp | --session, --resume-last | no | timeout |
| opencode | --session, --resume-last | no | success + timeout |
| pi | --session, --resume-last | no | timeout |
| qoder | --resume, --resume-last | yes | timeout |
| vibe | --session, --resume-last | no | timeout |
| warp | --conversation | no | timeout |
| zcode | --session, --resume-last | no | success + timeout |

No invocation incompatibility was identified for the common argument contract on supported
Windows/Linux ownership hosts. macOS and other POSIX hosts are explicitly unsupported by this
utility; their delegate relays retain the existing direct/Claude workflows. Linux runtime prerequisites
are checked before dispatch; both host paths are registered in CI. Windows fixtures have been run locally; Linux runtime validation still requires a host with Node and /usr/bin/cc. No weaker group-only fallback is used. Resume identifiers
can be provider IDs, file paths or history selection; no generic parsing or normalization is applied.
All figures above concern local fixtures, not authenticated live implementer or Desktop runs.
