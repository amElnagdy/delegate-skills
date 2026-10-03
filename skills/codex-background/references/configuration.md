# Configuration and lifecycle

Install codex-background and each selected implementer delegate skill explicitly. This package
does not declare automatic Skills CLI dependencies and does not configure MCP during installation.

```sh
npx skills add amElnagdy/delegate-skills --skill codex-delegate
npx skills add amElnagdy/delegate-skills --skill codex-background
```

The first skill selects a Codex implementer; the second supports a Codex orchestrator using any
registered implementer. A short foreground shell run does not require the support utility.
For background work, missing MCP tools/registry are a setup error, not a reason to start polling.
Locate their installed paths yourself, review the scripts, and create a local registry outside the contribution.
The server uses Node built-ins only and makes no network calls itself. The selected relay
continues to launch its own implementer CLI with its existing authentication and permissions.

## Explicit registry

Set CODEX_BACKGROUND_REGISTRY to an absolute JSON file path in the MCP server environment.
No PATH scans, fleet discovery, executable overrides or automatic registry updates occur.
A key maps to the canonical installed <key>-delegate/scripts/relay.mjs file. Only those registered
scripts can be launched, always with the server's Node executable and no shell.

Example registry (replace every example path with an absolute path appropriate to the host):

```json
{
  "schema": "codex-background.registry.v1",
  "hostToolTimeoutSeconds": 7200,
  "stateDirectory": "/absolute/artifacts/codex-background-state",
  "workspaceRoots": ["/absolute/projects"],
  "artifactRoots": ["/absolute/artifacts"],
  "relays": {
    "agy": "/absolute/skills/agy-delegate/scripts/relay.mjs",
    "codex": "/absolute/skills/codex-delegate/scripts/relay.mjs",
    "zcode": "/absolute/skills/zcode-delegate/scripts/relay.mjs",
    "cline": "/absolute/skills/cline-delegate/scripts/relay.mjs",
    "opencode": "/absolute/skills/opencode-delegate/scripts/relay.mjs"
  }
}
```

Windows registry paths use JSON-escaped backslashes or forward slashes. The state directory must
be within an artifact root. A run's output directory must be fresh, within artifact roots and
outside adapter state. Workspaces and briefs are canonicalized and checked against approved roots.
These admission checks do not sandbox implementer tools; the selected delegate's permission
model and the host's OS containment still apply. Registered scripts/configuration must be trusted.

## Codex host setup

Configure a stdio MCP server with command pointing to the installed Node executable and args
containing only the absolute installed codex-background/scripts/server.mjs path. Set the registry
environment variable. Configure Codex's tool_timeout_sec to match hostToolTimeoutSeconds;
startup_timeout_sec controls startup only and does not extend tool execution.

Portable template (substitute absolute paths; do not commit the user's resolved configuration):

```toml
[mcp_servers.codex_background]
command = "/absolute/path/to/node"
args = ["/absolute/skills/codex-background/scripts/server.mjs"]
tool_timeout_sec = 7200
required = true

[mcp_servers.codex_background.env]
CODEX_BACKGROUND_REGISTRY = "/absolute/config/codex-background-registry.json"
```

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
node --test --test-concurrency=1 skills/codex-background/scripts/server.test.mjs
node --test test/codex-background-relays.mjs
```

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
