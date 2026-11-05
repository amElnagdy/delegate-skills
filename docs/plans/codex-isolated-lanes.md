# Plan: Codex isolated read-only lanes (codex-delegate + delegate-setup)

> **Status:** IMPLEMENTED. Planned 2026-10-16 against an installed copy of these skills, before the
> port to this repository.
>
> Paths in this plan are from that installed layout: `codex-delegate/…` and `delegate-setup/…` are
> `skills/codex-delegate/…` and `skills/delegate-setup/…` here, `codex-delegate/test/relay.test.mjs` is
> `test/codex-isolation.mjs`, `delegate-setup/test/isolated.test.mjs` is `test/delegate-setup-isolated.mjs`,
> and the fixtures live in `test/fixtures/codex-isolation/`. Branch names and commit hashes refer to that
> private history. Machine-specific paths are replaced with placeholders; CLI versions are the ones the
> plan was made and checked against.

## 1. Scope and binding decisions

Implement runtime isolation defaults for Codex read-only lanes, preserve an explicitly configured Windows sandbox backend, and prevent sandbox execution failures from being reported as successful runs.

This repository has no root `AGENTS.md`, `.ai/agents/`, or `.ai/security-paths.json`. The supplied instructions govern this plan. All 774 lines of the Codex relay were inspected during planning; argument construction, lane resolution, configuration validation, artifact handling, abort handling, and the Claude MCP flags were re-read for this revision. No files were changed and no prohibited configuration or credential files were read.

**Binding user decision:** `isolated` is a **Codex-only** dial. Configuration validation rejects it on non-Codex implementers. The Claude-bound `plan-critique` lane is outside this change’s isolation scope.

Document Claude’s existing behavior precisely:

> Claude lanes load no configured MCP servers and disallow every `mcp__*` tool.

The unconditional flags at `claude-delegate/scripts/relay.mjs:589–590` support this wording. Do not claim that claude.ai connector loading itself is disabled.

### In scope

- Codex relay isolation flags, defaults, and feature-disable passthrough.
- Narrow extraction of the Windows sandbox setting.
- Correct fresh/resume argument placement.
- Sandbox failure classification and MCP-call accounting.
- Windows process preflight and resume warnings.
- Unique default artifact directories and protection against concurrent explicit-directory reuse.
- Fleet dial validation and normalization.
- Documentation and Node built-in tests.

### Out of scope

- Writing user/global/project lane configuration or `~/.codex/config.toml`.
- Rebinding `plan-critique` or modifying other implementer relays.
- Selecting or migrating to the unelevated sandbox.
- Modifying ACLs, repairing Codex internals, stopping Desktop, or killing unrelated processes.
- Automatic retry, global sandbox locks, or automatic serialization of Codex sessions.
- Network, authentication, or MCP behavior changes beyond the expressly requested `--disable apps`.
- Dependencies, a package manifest, or a general TOML parser.
- Adding a `-c sandbox_mode` fallback: E4 verifies the existing `-s` placement.

### Residual risks

- `blocked by policy` remains a conservative failure signature. E4 lowers the observed false-positive concern: a legitimate read-only write denial reported `Access ... is denied`, rather than `blocked by policy`. This does not prove every legitimate denial uses different wording.
- Two isolated sessions may still collide during Codex’s shared elevated-sandbox setup refresh, even without a running `node_repl.exe`. Artifact isolation does not serialize that refresh.
- Ignoring user configuration drops configured model defaults, providers, profiles, and approval settings.
- Windows termination of a relay can leave its explicit-output-directory lock behind. This includes ordinary orchestrator timeouts and stopped tasks, not only rare crashes.
- MCP auditing depends on the assumed exec JSONL envelope below. Synthetic fixtures pin the parser contract; they do not independently verify every 0.162.1 installation.

## 2. Evidence

These are local observations supplied by the orchestrator for Windows and codex-cli 0.162.1:

| Evidence | Observed fact |
|---|---|
| **E1** | Fresh `codex exec --ignore-user-config -c windows.sandbox=elevated --disable apps -s read-only ... -` successfully ran a shell command. The bare backend token works. |
| **E2** | On resume, placing the isolation flags before `resume <id>` caused every command to report `blocked by policy` in stderr, while Codex exited zero. |
| **E3** | On resume, placing `-s read-only` before `resume <id>` and the isolation flags after the target successfully ran a command. |
| **E4** | Using E3’s placement, a resumed repository write was denied with `Set-Content : Access to the path ... is denied`, command `exit_code: 1`; no file was created and git status stayed clean. |
| **E5** | The Claude relay unconditionally passes `--strict-mcp-config` and `--disallowedTools mcp__*` at lines 589–590, including for resumes. No separate connector-loading switch exists in that file. |

E5’s unconditional flags were also directly re-read during this revision.

Local `codex exec --help` and `codex exec resume --help` were re-run. Both list `--ignore-user-config`, repeatable `--disable`, and `-c`; only the former lists `-s`. Help establishes accepted flags, while **E1–E4 establish their effective placement**. No external sources are used.

The proposed explanation that a pre-resume override is lost is not treated as a verified internal cause. The observed placement difference is sufficient to determine the implementation.

## 3. Files and component boundaries

| Component | Files touched | Existing anchors |
|---|---|---|
| A: relay | `codex-delegate/scripts/relay.mjs` | Header/help: 2–85; `applyFleetLane`: 106; `parseArgs`: 148; `buildArgv`: 391; events: 427; run directory: 439; result writer: 459; tail: 505; dispatch: 565; main: 718; unconditional invocation: 774 |
| A: tests | New `codex-delegate/test/relay.test.mjs` | Node built-in test runner |
| A: fixtures | New `codex-delegate/test/fixtures/fake-codex.mjs`, `codex.cmd`, `codex`, `relay-driver.mjs` | Synthetic child, Windows/POSIX launch shims, injected test driver |
| B: fleet dial | `delegate-setup/scripts/implementers.mjs` | Dial typedef: 15; Codex supports: 109; `ALL_DIALS`: 434 |
| B: validation | `delegate-setup/scripts/config.mjs` | `validateLane`: 132; implementer allowlist: 148; Boolean validation: 151 |
| B: normalization | `delegate-setup/scripts/lane.mjs` | `normalizeDials`: 78; Codex mapping: 96; realpath main guard: 194 |
| B: tests | New `delegate-setup/test/isolated.test.mjs` | Synthetic configuration and normalization tests |
| C: documentation | `delegate-setup/references/schema.md` | Dial table: 45; Boolean rules: 79 |
| C: documentation | `codex-delegate/SKILL.md` | Prerequisites: 34; dispatch examples: 64 |
| C: documentation | `codex-delegate/references/dispatch-and-poll.md` | Flags: 31; Windows: 61; status list: 77; tail contract: 87; troubleshooting: 109 |
| C: documentation | `codex-delegate/references/review-and-land.md` | Replace the `--resume-last` example at line 106 |

Line numbers refer to the inspected baseline. The Claude relay is evidence only and will not be modified.

## 4. Component A: relay behavior

### 4.1 Isolation resolution and precedence

Add:

- `--isolated`
- `--no-isolated`
- Repeatable `--disable <feature>`

Initialize isolation as unspecified, rather than defaulting it to false before lane resolution.

In `applyFleetLane`, capture whether the **resolved lane** has `sandbox === "read-only"` before applying explicit-flag precedence. `normalizeDials` already maps `readOnly: true` to that sandbox at `lane.mjs:96–99`; no additional `readOnly` metadata is needed.

Determine isolation in this order:

1. Explicit `--isolated` or `--no-isolated`.
2. Explicit lane `isolated: true|false`.
3. Default true for a resolved Codex lane with `sandbox: "read-only"`.
4. Otherwise false.

Both isolation switches add `"isolated"` to `flagged`; the last explicitly supplied switch wins.

An explicit `--ignore-user-config` independently enables the same effective bundle. Consequently, `--no-isolated --ignore-user-config` still ignores configuration, disables apps, and attempts Windows backend preservation. Record effective isolation as true.

The bundle consists of:

- `--ignore-user-config`
- `--disable apps`
- On Windows only, preservation of a valid configured sandbox backend when present

| Interaction | Behavior |
|---|---|
| Standalone `--read-only`, without a lane | Does not implicitly enable isolation; callers can add `--isolated` |
| Explicit `--sandbox` | Overrides the lane sandbox without implicitly opting out of isolation |
| Write-capable sandbox plus isolation | Allowed; configuration isolation and filesystem permissions are separate |
| `--clean-env` | Independent; isolation does not imply it |
| `--keep-env` | Existing validation remains |
| Repeated feature disables | Deduplicate in stable order |
| Default apps disable plus other disables | Union; specifying another feature does not remove `apps` |
| `--session` and `--resume-last` together | Existing usage error |
| Resume without a configured sandbox | Preserve existing behavior; do not impose the relay’s default `workspace-write` |

On macOS/Linux, isolation applies the first two bundle items only. Do not inspect Windows configuration or run the Windows process preflight.

### 4.2 Windows sandbox setting extraction

Run the reader only when `platform === "win32"` and effective `ignoreUserConfig` is true.

Resolve:

- `$CODEX_HOME/config.toml` when `CODEX_HOME` is set.
- Otherwise `homedir()/.codex/config.toml`.

Use the same home/environment interpretation as the child. Do not inspect profile files, project configuration, MCP sections, or referenced paths.

Locating a key in plain TOML necessarily scans surrounding bytes. “Read only this key” means extracting only this scalar, never constructing a configuration object, interpreting other values, logging source contents, or following configuration references.

Use a conservative, bounded **line scanner**:

- Accept an initial UTF-8 BOM, LF, and CRLF.
- Ignore blank lines and full-line comments.
- Recognize `[windows]` and simple, unescaped quoted equivalents.
- Recognize `sandbox = "elevated"` or its single-quoted equivalent inside that exact table.
- Recognize top-level `windows.sandbox = "elevated"`, allowing whitespace around the dot and simple quoted key components.
- Distinguish `"windows.sandbox"` as one literal key from the dotted key.
- Allow trailing comments after a valid target scalar.
- Track section boundaries; do not match nested/profile tables or array-of-table entries.
- Accept only literal `elevated` or `unelevated`; do not decode escaped or multiline target values.
- Detect target-looking assignments that do not match the supported grammar and reject them.
- Reject duplicate target definitions.
- Reject an inline-table definition of the target as unsupported/ambiguous.
- Flag multiline delimiters encountered outside full-line comments. A target-looking definition after such a delimiter is ambiguous and must not be accepted. This deliberately rejects some valid but unsupported layouts instead of implementing multiline TOML parsing.
- Scan through EOF to catch later duplicate or ambiguous target definitions.

If there is no target definition or target-looking ambiguous candidate, return “missing key,” including when unrelated unsupported syntax exists. Unsupported unrelated content must not become general configuration validation.

Use fixed-size reads and bounded line storage. Discard an overlong line only when safely identified as unrelated; otherwise return an ambiguity error. Never echo rejected values or configuration lines.

| Reader outcome | Action |
|---|---|
| File does not exist | No backend override; add warning; proceed |
| Key absent | No backend override; add warning; proceed |
| Valid `elevated` or `unelevated` | Emit the corresponding override |
| Present invalid/duplicate/ambiguous target | Stop before Codex dispatch |
| Existing file unreadable, including an I/O race after opening | Stop before Codex dispatch |

For hard failures, write `status: "failed"`, `exitCode: 2`, `childExitCode: null`, and an error identifying invalid isolation configuration. This is a pre-dispatch configuration error, not evidence that a sandbox ran and failed.

Because the brief and artifact directory have already validated, publish `result.json`. Document this exception to the existing “usage error means no result” guidance.

Missing settings do not select a backend implicitly. Preserving an existing `unelevated` value is supported; migrating users to that backend is not.

### 4.3 Argument construction and placement

Export pure `buildArgv(opts, finalPath, platform = process.platform)`.

The local help establishes the accepted surfaces:

| Flag | `exec` | `exec resume` |
|---|---|---|
| `--ignore-user-config` | Listed | Listed |
| `--disable` | Listed, repeatable | Listed, repeatable |
| `-c` | Listed | Listed |
| `-s` / `--sandbox` | Listed | Not listed |
| `--json`, `-o`, `-m`, `--skip-git-repo-check` | Listed | Listed |

**Fresh runs:** retain the exec-level isolation placement. Emit the isolation group after `exec`, with the existing fresh-run options following it.

**Resumed runs:** emit any configured `-s <mode>` before `resume`, then `resume <id>` or `resume --last`. Emit the entire isolation group **after the resume target**, in the option block containing the effort override, and before the final stdin marker.

Illustrative shapes:

```text
codex exec --ignore-user-config --disable apps -c windows.sandbox=elevated --json -o <final> -s read-only -

codex exec -s read-only resume <id> --json -o <final> --ignore-user-config --disable apps -c windows.sandbox=elevated -

codex exec -s read-only resume --last --json -o <final> --ignore-user-config --disable apps -c windows.sandbox=elevated -
```

Move the unconditional pre-resume emission at `relay.mjs:393` into the appropriate fresh/resume option block. Correct the comment at lines 395–396 to distinguish:

- Sandbox selection before `resume`, verified enforced by E4.
- Isolation and configuration overrides after the resume target, required by E2–E3.

Do not retain the claim that shared options generally take effect before the subcommand.

Keep the effort override after the target on resumes, as it is at line 412. Keep the brief on stdin. Add no `-c sandbox_mode` fallback.

Emit the Windows backend as two tokens:

```text
-c windows.sandbox=elevated
```

E1 verifies that the bare token works. Local `-c` help also states that an unparseable TOML value is used as a literal string. This justifies using the allowlisted bare token instead of the request’s illustrative quoted form.

Only emit the backend override on Windows. There is no POSIX quoting branch for it.

Validate each feature name using the model rule:

```text
^[A-Za-z0-9][A-Za-z0-9._:/-]*$
```

Reject missing, empty, whitespace-containing, flag-shaped, or shell-metacharacter-containing values. Deduplicate in stable order.

Preserve existing output-path quoting. Do not introduce new path rejection rules for `%`, `!`, or quotes. The existing Windows `%` expansion hazard remains a separate follow-up; the new backend and feature tokens must not enlarge that surface.

### 4.4 Warnings

Maintain a bounded `warnings[]` array of relay-generated messages. Emit each warning to **stderr**, separately from captured child stderr, and include it in every published result.

Warnings include:

- Missing Windows configuration file.
- Missing Windows sandbox key.
- Isolated run without an explicit CLI/lane model.
- Running `node_repl.exe`.
- Unavailable process preflight.
- `--resume-last`.
- Malformed MCP items that prevent reliable deduplication.

The resume warning must say:

> “last” is global across parallel sessions; prefer --session \<threadId\>.

Explain that “global” means it is not owned by this relay invocation; cwd filtering does not make it safe when parallel runs share a workspace.

An explicit model suppresses the no-model warning. It does not restore custom-provider configuration.

### 4.5 Sandbox failure classification

Export a pure outcome mapper and use it in normal close, launch-error, version-probe failure, and abort result handling.

Scan **the entire child stderr stream** while persisting it to `stderr.txt`. Retain only enough overlap to match signatures across chunk boundaries. Do not search only the tail or read the complete file into memory.

Match case-insensitively:

- `setup refresh had errors`
- `blocked by policy`

Store the exact canonical matched phrases in `sandboxFailureReasons`.

Do not scan events.jsonl for these text phrases. Requirement 4 specifies stderr; expanding classification to event contents would introduce another behavior change. Event-only rejection remains a documented detection limitation.

Do not classify `Access ... is denied` as a sandbox setup failure. E4 demonstrates that this can be correct read-only enforcement.

| Priority | Condition | Status / exit |
|---:|---|---|
| 1 | Child stderr contains a sandbox signature | `sandbox_failed` / `1` |
| 2 | Relay abort signal received | `aborted` / existing signal-derived code |
| 3 | Watchdog fired | `timeout` / existing non-zero mapping |
| 4 | Child launch error, signal, or non-zero exit | `failed` / existing mapping |
| 5 | Child exited zero | `completed` / `0` |

Missing executable remains `codex_unavailable`, exit 127. Ordinary argument errors remain exit 2 before artifact preparation. Invalid Windows isolation configuration is the separate pre-dispatch `failed`, exit 2 outcome described above.

Preserve underlying facts in `childExitCode`, `signal`, `watchdogFired`, and `abortSignal`.

Every `sandbox_failed` result includes:

- `stderrTail`, using the existing final-64-KiB/20-nonblank-line helper at line 505.
- `sandboxFailureReasons`.
- An error identifying the match even when its original line has fallen outside the tail.

Feed version-probe stderr through the same matcher. Relay warnings must not feed it.

Retain abort cleanup and result refresh, updating diagnostics and MCP accounting in the final snapshot. Do not automatically retry or kill a run solely because a signature was observed.

### 4.6 MCP-call accounting

The assumed exec JSONL projection is:

```json
{"type":"item.started","item":{"id":"item_7","type":"mcp_tool_call","server":"codex_apps","tool":"search","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_7","type":"mcp_tool_call","server":"codex_apps","tool":"search","status":"completed"}}
```

This is a parser contract pinned by synthetic fixtures, not a claim that a live MCP trace was inspected. Additional item fields may exist.

Process `item.started`, `item.updated`, and `item.completed` when `item.type === "mcp_tool_call"`:

- Count distinct `item.id` values.
- Deduplicate lifecycle events for the same invocation.
- Count started-only and failed invocations.
- Count distinct IDs separately even when they invoke the same tool.
- Store distinct `{server, tool}` name pairs, sorted deterministically.
- Do not copy arguments, results, or tool errors into the summary.

Result shape:

```json
{
  "mcpCalls": {
    "count": 2,
    "names": [{"server":"codex_apps","tool":"search"}]
  },
  "mcpViolation": true
}
```

Feed the collector from the same lines persisted by `recordEventLine` at line 427. Preserve thread-ID extraction. Flush the decoder and final newline-less event before terminal result publication.

Recognizable MCP items without IDs are counted conservatively per record and generate a warning. Non-JSON progress lines remain preserved and must not break subsequent parsing.

Set `mcpViolation` when any invocation occurs during:

- An effectively isolated run; or
- A run with an explicitly known effective read-only sandbox.

Do not assume the sandbox of an unqualified, non-isolated resume.

Report violations prominently in the summary and result. This is an audit field, not a new automatic termination or exit-status policy. Callers must reject a read-only/isolation result with `mcpViolation: true`.

Pre-dispatch failures and unavailable binaries receive zero MCP calls.

### 4.7 Windows process preflight

For **every Windows run whose selected sandbox is not `danger-full-access`**, perform the warn-only check, regardless of isolation or whether the backend is known.

Use:

```text
tasklist.exe /FI "IMAGENAME eq node_repl.exe" /FO CSV /NH
```

Requirements:

- `shell:false`, `windowsHide:true`.
- Two-second maximum timeout.
- Bounded output buffer.
- Exact, case-insensitive CSV image-name matching.
- A match warns that an elevated sandbox refresh may be blocked.
- Missing executable, timeout, access denial, or malformed output generates a nonfatal “preflight unavailable” warning.
- Never kill a process or treat absence as proof of safety.

The check is advisory and races with process startup.

### 4.8 Parallel artifacts, locks, and sequential reuse

Replace the timestamp-only default directory at `relay.mjs:443` with `mkdtempSync` beneath the existing temp parent. Use a fixed prefix rather than embedding the repository basename.

For explicit `--out-dir`, acquire a **run-scoped exclusive lock**:

1. Validate arguments and brief.
2. Create the output directory if necessary.
3. Acquire `.relay.lock` using exclusive creation.
4. Write `{pid, startedAt}` through the acquired descriptor.
5. Only after acquisition and metadata initialization, overwrite this run’s existing artifacts.
6. Hold the lock until final result publication and relay exit.

This prevents concurrent overwrite while preserving sequential reuse.

A concurrent claimant exits 2 without modifying artifacts or the active result. Its stderr diagnostic must include:

- Lock path.
- Owner PID and start time, when readable.
- A statement that **this invocation has no result**, even if `result.json` exists in the directory.
- Recovery guidance: wait for the owner, use another output directory, or remove a stale lock only after confirming the prior relay is gone.

Read lock metadata with a small bound and validate the two fields before displaying them. A partially written, malformed, or unreadable lock remains occupied; report unavailable metadata rather than guessing or exposing raw contents.

After acquisition:

- Clear stale `result.json` and `final.txt`.
- Overwrite the brief and reset events/stderr.
- Preserve atomic result publication at lines 489–491.

Register synchronous cleanup immediately after acquiring ownership, before metadata initialization. Release the owned lock on every controllable exit path: preparation error, configuration error, version failure, unavailable executable, spawn failure, completion, timeout, and handled abort. Cleanup must be idempotent.

On Windows, an orchestrator timeout or stopped task can terminate the relay without executing cleanup; the existing warning at `relay.mjs:624` identifies the signal limitation. A stale lock is therefore an expected recovery case for killed Windows relays.

Do not automatically delete or steal a lock based on PID inspection. PID reuse and races make that unsafe. Require confirmation that the previous relay has ended before manual removal, or use another directory.

A caller that loses the lock must ignore the directory’s existing `result.json`; it belongs to another invocation. Document that polling for file existence without checking the invocation’s exit outcome is insufficient.

### 4.9 Result contract and importability

Keep `delegate-relay.result.v1`; add:

- `isolated`
- `disabledFeatures`
- `windowsSandbox`, nullable
- `warnings`
- `mcpCalls`
- `mcpViolation`
- `sandboxFailureReasons`
- `childExitCode`
- `watchdogFired`
- `abortSignal`

Preserve existing fields and atomic publication.

Replace unconditional `main()` at line 774 with the two-sided realpath guard from `lane.mjs:194–205`. Importing the relay must not read stdin, read configuration, resolve lanes, spawn processes, or create artifacts.

Export the pure argument builder, isolation resolver, sandbox scanner, outcome mapper, and diagnostic/event helpers. Provide a narrow dependency-injection boundary for process preflight and fixture-driven execution. Do not add production environment-variable switches that bypass isolation.

## 5. Component B: fleet dial

In `implementers.mjs`:

- Add `isolated` to the Dial typedef and `ALL_DIALS`.
- Add it only to Codex’s `supports` array.

In `config.mjs`:

- Require a Boolean value.
- Preserve rejection of unsupported implementer dials.
- Reject `isolated` on Claude and other implementers, even when false.
- Leave autonomy-consistency validation unchanged.

In `lane.mjs`:

- Pass explicit `isolated` through unchanged.
- Keep the current `readOnly: true` → `sandbox: "read-only"` mapping and deletion of `readOnly`.
- Export `normalizeDials` for pure tests.
- Do not manufacture default isolation here; the relay owns runtime defaults.

**Do not write defaults into user configuration.** Existing Codex read-only lanes gain isolation at dispatch without altering stored documents or project approval hashes.

| Supplied lane | Result |
|---|---|
| `plan`, `review`, `review-sensitive` | Codex read-only defaults apply |
| `plan-critique` | Claude; outside this change’s isolation scope by user decision |
| Claude `pr-draft`, `docs-review` | Unchanged |

Document that adding `isolated` to a non-Codex lane causes whole-document validation to fail. Do not publish examples that add it indiscriminately to every read-only lane.

Existing explicit approval requirements for future configuration writes remain intact.

## 6. Component C: documentation

Update all listed targets and the relay header, which supplies `--help` through `headerComment()` at line 278.

Required coverage:

- New flags, precedence, runtime defaults, and opt-out.
- Codex-only dial decision and unchanged Claude lanes.
- Exact Claude wording: “Claude lanes load no configured MCP servers and disallow every `mcp__*` tool.”
- Fresh versus resume argument placement, citing the local E1–E4 observations.
- Sandbox before `resume`; isolation flags and configuration overrides after the resume target.
- No `sandbox_mode` fallback.
- Missing Windows file/key: warning and continuation.
- Invalid/unreadable setting: pre-dispatch `failed`, exit 2, with a result artifact.
- Apps require separate disabling because ignoring configuration alone does not remove account connectors.
- Elevated-sandbox ACL refresh, `os error 32`, and Codex’s possible zero exit despite unusable commands.
- `sandbox_failed`, phrase triggers, precedence, and exit code.
- E4’s distinction between expected `Access ... is denied` and observed setup-related `blocked by policy`; retain the narrower residual false-positive caveat.
- Stderr-only detection; event-only rejections are not classified by this matcher.
- New result fields, MCP violations, and `stderrTail` presence on `sandbox_failed`.
- Loss of model defaults, custom providers, profiles, and approval settings; an explicit model does not restore provider configuration.
- A sandboxed cwd under `%TEMP%` can be denied to the sandbox user in the reported environment. Use an accessible workspace. Host-written relay artifacts under temp are separate.
- Existing WindowsApps PATH workaround.
- Exact-session examples; replace `review-and-land.md:106` with `--session <threadId>`.
- Resume warnings go to stderr and `warnings[]`.
- Unique default directories, explicit-directory locks, sequential overwrite behavior, and lock metadata.
- Killed Windows relays may leave stale locks.
- A lock-losing invocation has no result of its own; any existing result belongs to the lock owner.
- `sandbox_failed` plus `os error 32` without a running `node_repl.exe`: stagger or serialize dispatches.
- No guarantee that the preflight prevents shared-runtime refresh races.

Keep possible narrowing of `blocked by policy` and the existing Windows `%` path-expansion hazard as follow-up considerations, not implementation work.

## 7. Tests and runnable acceptance criteria

Use Node built-ins only. Run tests by **explicit filename** rather than relying on directory discovery.

### 7.1 Test isolation

Integration tests must:

- Create private temporary `bin` and fixture-home directories.
- Copy the Windows shim as **`codex.cmd`**, or the POSIX shim as executable **`codex`**.
- Put that bin directory first on PATH, followed only by the actual Node executable’s directory.
- Always set `CODEX_HOME` to a fixture directory.
- Set `HOME`/`USERPROFILE` and `XDG_CONFIG_HOME` to fixture locations where relevant.
- Construct an allowlisted child environment without real authentication variables.
- Assert that configuration reading targeted the fixture path.
- Give the fake executable a recognizable version/output marker and assert it was used.
- Stub process preflight through the fixture driver.
- Never invoke real Codex, live MCP, or user configuration.

The fake child supports version probes, controlled stderr/events, exit codes, and waiting for lifecycle tests. Cleanup must terminate fixture children and remove only verified test-owned directories.

### 7.2 Coverage matrix

| Case | Required verification |
|---|---|
| Ordinary fresh execution | Existing argv behavior remains |
| Isolated fresh execution | Isolation group is at exec level; valid bare backend token |
| Resume by ID and `--last` | Exact argv equality: every isolation flag and its value follows the target and precedes final `-` |
| Resume configuration overrides | Backend and effort `-c` arguments are after the target; none leak into the pre-resume block |
| Explicit/lane sandbox on resume | `-s` and its value precede `resume`; absent on unqualified resume |
| Sandbox fallback | No emitted `-c sandbox_mode` |
| Isolation defaults and opt-out | CLI → lane → resolved sandbox precedence |
| Explicit write sandbox on read-only lane | Does not hide the captured isolation default |
| Explicit ignore-config plus opt-out | Bundle remains enabled |
| Repeated disables and default apps | Stable union and deduplication |
| Invalid feature tokens | Rejected before launch |
| Windows backend argument | Bare enum survives the `.cmd` path exactly |
| Non-Windows isolation | No Windows reader or tasklist invocation |
| BOM, CRLF, comments, quoted/dotted target | Correct narrow extraction |
| Nested tables and literal dotted key | Do not match incorrectly |
| Multiline ambiguity, invalid/duplicate target | Pre-dispatch `failed`, exit 2 |
| Missing file/key | Warning, no override, dispatch proceeds |
| Unreadable existing file | Pre-dispatch `failed`, exit 2; inject I/O failure |
| Isolated run without model | Warning; explicit CLI/lane model suppresses it |
| Early signature outside final tail | Still `sandbox_failed` |
| Signature across chunks | Match at every split point |
| Signature plus exit zero | Both result and relay process exit fail |
| Signature plus timeout/abort | Defined precedence; underlying facts retained |
| Ordinary failures/signals/unavailable | Existing mappings preserved |
| Phrase only inside an event | Does not trigger stderr classification |
| Expected `Access ... is denied` | Does not become `sandbox_failed` solely from this phrase |
| MCP lifecycle duplication | One invocation per ID |
| Same tool, different IDs | Multiple calls, one name pair |
| Failed/unfinished MCP item | Counted and violation reported |
| Missing MCP ID | Conservative count plus warning |
| Split UTF-8/final line without newline | Correct accounting and thread ID |
| Preflight match/error/timeout | Warn-only across sandboxed Windows profiles |
| Parallel default directories | Distinct paths despite identical timestamps |
| Sequential explicit-directory reuse | Succeeds; stale final/result cannot leak |
| Concurrent explicit-directory reuse | One owner; loser exits 2 without overwriting |
| Lock metadata | Correct PID/start time persisted and included in conflict diagnostics |
| Incomplete/malformed lock metadata | Lock remains occupied; safe unavailable-metadata diagnostic |
| Losing invocation with existing result | Diagnostic explicitly says it has no result; owner’s result is unchanged |
| Lock cleanup | Every controllable terminal path releases ownership |
| Stale lock after forced termination | Fails clearly; no automatic takeover |
| Import and symlinked entrypoint | No import side effects; direct `--help` works |
| Non-Codex isolation dial | Rejected; unchanged valid Claude documents accepted |
| Fleet normalization | No extra `readOnly` metadata; explicit isolation preserved |
| Config overlays/trust | Stored content and trust behavior remain unchanged |

Integration tests must assert **both `result.json` and relay process exit status**.

### 7.3 Component A gates

```powershell
node --check codex-delegate/scripts/relay.mjs
node --check codex-delegate/test/fixtures/fake-codex.mjs
node --check codex-delegate/test/fixtures/relay-driver.mjs
node --test codex-delegate/test/relay.test.mjs
node codex-delegate/scripts/relay.mjs --help
```

Platform-independent tests assert win32 argv behavior everywhere. Actual `.cmd` integration runs on Windows; executable-shim integration runs on POSIX.

### 7.4 Component B gates

```powershell
node --check delegate-setup/scripts/implementers.mjs
node --check delegate-setup/scripts/config.mjs
node --check delegate-setup/scripts/lane.mjs
node --test delegate-setup/test/isolated.test.mjs
```

### 7.5 Documentation and local CLI checks

```powershell
rg -n 'isolated|disable|sandbox_failed|mcpCalls|mcpViolation|TEMP|node_repl|resume-last|warnings|lock' codex-delegate/SKILL.md codex-delegate/references/dispatch-and-poll.md codex-delegate/references/review-and-land.md delegate-setup/references/schema.md
```

```powershell
$codexExe = '<path to a codex-cli 0.162.1 codex.exe>'
& $codexExe --version
& $codexExe exec --help
& $codexExe exec resume --help
```

Manually compare documentation with implemented flags, argument placement, result fields, failure rules, and passing tests. Keyword matches are not sufficient acceptance.

### 7.6 Required manual Windows acceptance

Run after implementation, using codex-cli 0.162.1, an authenticated installation, and an existing **clean disposable git repository outside `%TEMP%`**. This acceptance test is separate from the hermetic automated suite.

The planning worker does not execute these runs.

Set the repository path to the disposable test repository:

```powershell
$relayScript = (Resolve-Path .\codex-delegate\scripts\relay.mjs).Path
$acceptanceRepo = '<clean disposable git repository outside %TEMP%>'
$acceptanceRoot = Join-Path $env:TEMP ('codex-isolation-' + [guid]::NewGuid().ToString('N'))
$freshOut = Join-Path $acceptanceRoot 'fresh'
$resumeOut = Join-Path $acceptanceRoot 'resume'
$writeOut = Join-Path $acceptanceRoot 'write-denial'
```

Confirm the repository is clean and the probe filename does not already exist:

```powershell
git -C $acceptanceRepo status --porcelain
Test-Path -LiteralPath (Join-Path $acceptanceRepo 'codex-isolation-probe.txt')
```

Proceed only with empty git status and `False` for the probe path.

**Fresh isolated command:**

```powershell
'Run git status --porcelain in the working repository using the shell. Do not edit files, use MCP, or read secrets or user configuration. Report the command exit code.' |
  node $relayScript --cd $acceptanceRepo --read-only --isolated --out-dir $freshOut --timeout 2m

$freshExit = $LASTEXITCODE
$freshResult = Get-Content -LiteralPath (Join-Path $freshOut 'result.json') -Raw | ConvertFrom-Json
```

Pass requires relay exit 0, `status: "completed"`, a nonempty `threadId`, an actually executed successful `git status`, no MCP violation, and no `blocked by policy` in `stderr.txt`.

**Explicit-session resume:**

```powershell
'Run git status --porcelain again using the shell. Do not edit files, use MCP, or read secrets or user configuration. Report the command exit code.' |
  node $relayScript --cd $acceptanceRepo --read-only --isolated --session $freshResult.threadId --out-dir $resumeOut --timeout 2m

$resumeExit = $LASTEXITCODE
$resumeResult = Get-Content -LiteralPath (Join-Path $resumeOut 'result.json') -Raw | ConvertFrom-Json
```

Apply the same success criteria. Inspect events to confirm the command ran; a final-message claim alone is insufficient.

**Resumed read-only write enforcement:**

```powershell
'Using the shell, attempt exactly once: Set-Content -LiteralPath codex-isolation-probe.txt -Value isolation-probe -ErrorAction Stop. This is a read-only enforcement test. Do not retry, change permissions, use another write tool, use MCP, or read secrets or user configuration. Report the actual denial and command exit code.' |
  node $relayScript --cd $acceptanceRepo --read-only --isolated --session $freshResult.threadId --out-dir $writeOut --timeout 2m

$writeExit = $LASTEXITCODE
$writeResult = Get-Content -LiteralPath (Join-Path $writeOut 'result.json') -Raw | ConvertFrom-Json

Test-Path -LiteralPath (Join-Path $acceptanceRepo 'codex-isolation-probe.txt')
git -C $acceptanceRepo status --porcelain
```

Pass requires:

- The event trace shows an actual attempted command and access denial with non-zero command exit.
- The probe file does not exist.
- Git status remains empty.
- `touchedFiles` is an empty array, not null.
- No MCP violation occurred.
- No setup-failure signature occurred.

The expected denied tool command does not itself require a non-zero relay exit: Codex may successfully report the denial. Do not confuse command exit status with relay exit status.

If the write succeeds, acceptance fails. Do not add an automatic `sandbox_mode` fallback; investigate the regression against E4.

## 8. Rollback

This is not a data migration. Implement on `feat/codex-isolated-lanes` in identifiable commits. Revert those commits with `git revert <commit>`, in reverse order if split.

No user configuration restoration is needed because none is written. Existing result artifacts remain historical records. A lock left by a killed relay requires the documented stale-lock check before manual removal.

## Critique disposition (round 1)

| Gap | Severity | Disposition | Reason |
|---:|---|---|---|
| 1 | BLOCKING | FIXED | Recorded the binding Codex-only decision, Claude exclusion, existing connector behavior, and whole-document validation consequence. |
| 2 | BLOCKING | FIXED | Missing file/key warns and proceeds; invalid, ambiguous, duplicate, or unreadable configuration fails before dispatch with `failed`, exit 2. |
| 3 | BLOCKING | FIXED | A run-scoped exclusive lock protects concurrent explicit-directory use while preserving sequential reuse. |
| 4 | NON-BLOCKING | FIXED | Exact matching phrases are recorded; false-positive risk is documented; classification scans stderr only. |
| 5 | NON-BLOCKING | FIXED | Preflight covers every sandboxed Windows run regardless of isolation or known backend. |
| 6 | NON-BLOCKING | FIXED | Shared setup-refresh collision remains an explicit risk; troubleshooting recommends staggering or serializing dispatches. |
| 7 | NON-BLOCKING | FIXED | Documented dropped configuration settings and added a warning for isolated runs without an explicit model. |
| 8 | NON-BLOCKING | FIXED | Use the bare allowlisted backend token, justified by local 0.162.1 `-c` help and checked through a `.cmd` fixture. |
| 9 | NON-BLOCKING | FIXED | Removed new output-path restrictions; the existing percent-expansion hazard is a separate follow-up. |
| 10 | NON-BLOCKING | FIXED | Capture normalized lane sandbox before precedence filtering; retain existing deletion of `readOnly`. |
| 11 | NON-BLOCKING | FIXED | Fixture binaries use the actual `codex` names, isolated PATH/home/config, injected preflight, and explicit test filenames. |
| 12 | NON-BLOCKING | FIXED | Added header/help and review-and-land changes, updated status/tail contracts, and specified warning destinations. |
| 13 | NON-BLOCKING | FIXED | Replaced general lexical parsing with a conservative bounded line scanner and explicit ambiguity handling. |
| 14 | NON-BLOCKING | FIXED | Removed external evidence; local help supports flags, while the MCP envelope is explicitly assumed and pinned by synthetic fixtures. |

## Critique disposition (round 2)

| Gap | Severity | Disposition | Reason |
|---:|---|---|---|
| 1 | BLOCKING | FIXED | Resume isolation flags and backend overrides follow the target; fresh placement remains unchanged; E1–E3 support exact argv tests and manual command acceptance. |
| 2 | NON-BLOCKING | FIXED | E4 verifies pre-resume `-s` enforcement; retain it without a fallback and require a resumed write-denial acceptance test. |
| 3 | NON-BLOCKING | FIXED | Locks contain PID/start time; conflicts print recovery guidance and state that the losing invocation has no result; Windows termination behavior is documented. |
| 4 | NON-BLOCKING | FIXED | Claude wording now matches E5 exactly: no configured MCP servers and all `mcp__*` tools disallowed; no claim about connector loading. |