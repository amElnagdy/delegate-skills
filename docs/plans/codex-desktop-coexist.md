# Plan: Codex Desktop coexistence on Windows

> **Status:** IMPLEMENTED. Planned 2026-10-17 against an installed copy of these skills, before the
> port to this repository.
>
> Paths in this plan are from that installed layout: `codex-delegate/…` and `delegate-setup/…` are
> `skills/codex-delegate/…` and `skills/delegate-setup/…` here, `codex-delegate/test/relay.test.mjs` is
> `test/codex-isolation.mjs`, `delegate-setup/test/isolated.test.mjs` is `test/delegate-setup-isolated.mjs`,
> and the fixtures live in `test/fixtures/codex-isolation/`. Branch names and commit hashes refer to that
> private history. Machine-specific paths are replaced with placeholders; CLI versions are the ones the
> plan was made and checked against.

## 1. Scope and out-of-scope

Update the Codex relay’s Windows process preflight and troubleshooting guidance to recognize the Desktop ACL-sharing fix in stable codex-cli 0.163.0 and later.

Baseline: branch `feat/codex-desktop-coexist`, commit `216dda2`. No root `AGENTS.md`, `.ai/agents/`, `.ai/security-paths.json`, or `.ai/tools/git-safe.mjs` exists. Planning changed no files, ran no tests, and read no prohibited configuration or credential files.

### Binding decisions

| Starting proposal | Decision and reason |
|---|---|
| Parse the probed version | Accept stable versions ≥0.163.0 and the measured `0.163.0-alpha.10.2` exception. Use the narrow anchored regex specified below; other formats are not known fixed. E3–E5 support this boundary. |
| Suppress the process warning on fixed versions | Skip tasklist and `deps.preflight` entirely. Avoid unnecessary execution and misleading unavailable-check warnings. |
| Skip for unelevated | Skip when resolved `opts.windowsSandbox === "unelevated"` because E1 establishes that this backend runs no setup helper. Null remains unknown; add no configuration reads. |
| Reword sandbox failure advice | Export pure `sandboxFailureHint(result, platform)` with three branches, and use it from `printSummary()`. This permits every branch to be tested on every host. Classification remains unchanged. |
| Add a known-fixed result field | Reject: existing `codexVersion` and `windowsSandbox` suffice. Preserve `delegate-relay.result.v1`. |
| Update docs and skill version | Update the two identified docs; retain `metadata.version: 0.5.0`. History shows no established version-bump convention. |

Keep elevated as the recommended backend.

### Out of scope

- Changing backend defaults, adding backend overrides, or changing configuration extraction.
- Network isolation, firewall behavior, ACL repair, process termination, retries, or automatic serialization.
- Changing sandbox failure signatures, precedence, exit codes, or argv placement.
- Claude behavior, fleet configuration, authentication, dependencies, or user configuration.
- Editing the orchestrator's user-level instructions or the user's global fleet config.
- Editing the frozen `docs/plans/2026-10-16-codex-isolated-lanes.md`.
- Implementing the separate `fix/relay-polish` changes.

**Parallel-branch integration:** `fix/relay-polish` at `a5abcbb` changes both `relay.mjs` and `relay.test.mjs`, including help newline handling, scanner checks, and corresponding tests. Its current production hunks do not overlap the planned edits, but both files need careful integration. Keep changes localized; preserve the polish work. Add no embedded `*/` or literal carriage-return characters to the new header prose, and avoid whole-file line-ending changes. Rerun both full gates after whichever branch lands second.

## 2. Evidence

Established observations supplied by the orchestrator, measured on Windows 11 Pro 26100 on 2026-10-17:

| ID | Evidence |
|---|---|
| **E1** | The elevated sandbox’s per-run setup refresh, `codex-windows-sandbox-setup.exe`, grants `CodexSandboxUsers:(OI)(CI)(RX)` on `%LOCALAPPDATA%\OpenAI\Codex`. This propagates to running `runtimes\cua_node\<id>\bin\node_repl.exe` and causes `os error 32`. The unelevated backend spawns no setup helper. |
| **E2** | With Desktop open and 2–3 `node_repl.exe` processes running, codex-cli 0.162.1 elevated fails with `windows sandbox failed: helper_unknown_error: setup refresh had errors`. |
| **E3** | At the same moment, stable codex-cli 0.163.0, installed through `codex update`, completed 3/3 elevated runs as `codexsandboxoffline`; reads succeeded and writes returned `Access is denied`. The setup helper still ran and succeeded. |
| **E4** | Desktop’s bundled `0.163.0-alpha.10.2` behaved like E3. Earlier 0.163.0 alphas were untested. |
| **E5** | The 0.163.0 release notes state: “Avoid sharing violations when repairing Windows runtime ACLs” (`openai/codex#51822`). |
| **E6** | With Desktop open, `codex exec --ignore-user-config -c windows.sandbox="elevated" --disable apps -s read-only -C <repo> -` on 0.163.0 exited 0, emitted neither failure signature on stderr, denied writes, and left git clean. |
| **E7** | Version output includes `codex-cli 0.163.0` and `codex-cli 0.163.0-alpha.10.2`. |

Verified from code and history:

- `codexVersion()` probes once, preserves trimmed stdout, and records `"unknown"` for empty successful stdout.
- `main()` currently computes runtime checks before resolving the isolated Windows backend and probing the version. Actual process preflight follows both.
- `windowsRuntimeChecks()` currently enables process preflight for every Windows sandbox except `danger-full-access`.
- The fixture driver injects `deps.preflight` and records calls. Fake Codex supports verbatim `version.stdout`, including empty output.
- The default fake version is `codex-cli 0.0.0-fake-relay-test`; it must remain not known fixed.
- The ordinary fresh-run integration already asserts `fx.traceCount("preflight") === (IS_WIN ? 1 : 0)`.
- `createWarnings()` truncates messages at 600 characters; preflight reasons are independently bounded to 200 characters.
- `configTouches()` returns configuration I/O paths and may contain repeated paths.
- The Windows relay-suite baseline has six unconditional platform skips: two POSIX observations, three real-signal tests, and one POSIX launch-failure test. Symlink permissions can add one existing conditional skip.
- Relevant search matches occur only in the Codex relay, tests, and the two listed docs; no behavior changes are needed in `delegate-setup` or `claude-delegate`.
- Skill version history shows baseline `0.5.0` unchanged by subsequent isolation documentation.

## 3. Files touched

| File | Functions or sections |
|---|---|
| `codex-delegate/scripts/relay.mjs` | Windows header/help paragraph; new version predicate; `windowsRuntimeChecks()`; `checkNodeRepl()` comment; `main()` preflight gate/warnings; new `sandboxFailureHint()`; `printSummary()` |
| `codex-delegate/test/relay.test.mjs` | Export contract; predicate and hint unit tests; runtime-check matrix; preflight and classification integration coverage |
| `codex-delegate/SKILL.md` | `### Windows`; retain metadata version |
| `codex-delegate/references/dispatch-and-poll.md` | Isolation rationale, parallel sessions, Environment and Windows, warnings description, and sandbox-failure troubleshooting |

The orchestrator saves this plan as `docs/plans/2026-10-17-codex-desktop-coexist.md`. No fixture changes are required.

## 4. Behaviour spec

### Version interpretation

Export:

`hasWindowsDesktopAclFix(version): boolean`

Accept strings only. Trim surrounding whitespace and match this entire narrow format:

`/^(?:codex-cli[ \t]+)?(\d+)\.(\d+)\.(\d+)(?:-(alpha\.10\.2))?$/`

Compare captured core components numerically:

- Without the prerelease suffix: true when core ≥`0.163.0`.
- With `alpha.10.2`: true only when core equals `0.163.0`.
- All other inputs: false.

This is an advisory version recognizer, not general SemVer validation. Add no dependency, identifier grammar, leading-zero validation, or safe-integer validation.

| Input | Known fixed |
|---|---|
| `codex-cli 0.163.0`, bare `0.163.0`, surrounding whitespace, tab after prefix | Yes |
| `0.163.1`, `0.164.0`, `1.0.0` | Yes |
| `codex-cli 0.163.0-alpha.10.2` | Yes |
| `0.162.1`, `0.162.999`, `0.9.999` | No |
| `0.163.0-alpha.10.1`, `0.163.0-alpha.10.3`, `0.163.0-rc.1`, `0.164.0-alpha.10.2` | No |
| Any build metadata, including `0.163.0+build.007` | No |
| Missing patch, `v` prefix, alternate/case-changed prefix, extra text or additional output lines | No |
| `"unknown"`, empty/whitespace-only, null, undefined, other non-string input | No |

Preserve probe execution and the original trimmed version stored in results. Unrecognized output is not proof of a broken version.

### Preflight selection and ordering

Extend:

`windowsRuntimeChecks(platform, opts, version = null)`

Preserve `readSandboxSetting` exactly. Set `preflight` true only when:

1. Platform is `win32`.
2. Sandbox is not `danger-full-access`.
3. Resolved `windowsSandbox` is not `"unelevated"`.
4. `hasWindowsDesktopAclFix(version)` is false.

Keep the initial call for configuration-read selection. After backend resolution and a successful version probe, recompute the process-preflight decision using current `opts` and `probe.version`.

A skipped preflight invokes neither tasklist nor `deps.preflight`. A required preflight retains current timeout, exception handling, reason bounding, and warn-only behavior.

Do not add configuration reads for non-isolated runs. Unknown backend and unspecified sandbox on an unqualified resume retain conservative preflight behavior.

### Exact warning wording

The following are exact message contents, without Markdown formatting characters.

**Running process:**

> node_repl.exe is running: this CLI may predate the Windows Desktop ACL fix. Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH. If upgrading is unavailable, quit Codex Desktop fully (from the tray) and stop other runs using node_repl.exe.

**Unavailable check:**

> process preflight unavailable ({reason}): could not check node_repl.exe. Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH.

Keep the current reason fallback and 200-character bound. The unavailable message remains comfortably below the 600-character warning cap even with a maximum-length reason. Do not change warning infrastructure.

Warnings remain in relay stderr and `result.warnings`; they never feed the child-stderr classifier.

### Exact sandbox failure hint

Export:

`sandboxFailureHint(result, platform): string`

The helper is pure, performs no I/O, and accepts a `sandbox_failed` result containing the existing version, backend, and reason fields. `printSummary()` calls it only for that status, passing `process.platform`.

Every returned string starts with:

> hint: codex's sandbox could not run commands (matched: {reasons}) — codex may still exit 0, so do not trust this run.

`{reasons}` is `sandboxFailureReasons` joined with `, `. Append one space and one of these three branches:

**1. Non-Windows:**

> Read stderrPath and investigate the sandbox failure before re-dispatching.

**2. Windows with resolved unelevated OR known-fixed version:**

> The Desktop node_repl.exe ACL conflict is not the likely cause for this version or backend. Read stderrPath for other sandbox causes; if failures coincide with parallel elevated dispatches, try staggering or serializing them before re-dispatching.

**3. Remaining Windows cases:**

> This CLI may predate the Windows Desktop ACL fix: run codex update (stable 0.163.0+) or reinstall a current stable CLI, check codex --version on PATH, or quit Codex Desktop fully if upgrading is unavailable; then read stderrPath.

Select non-Windows first. Do not claim the unelevated backend contains the version fix. Derive advice from existing fields; add no result field or schema version.

Keep all signature scanning and outcome mapping unchanged, including signatures on a successful version probe.

### Documentation requirements

- State that stable 0.163.0+ permits Desktop to remain open for elevated runs, citing the supplied E3/E6 observations.
- Record the exact tested alpha exception and conservative treatment of other prereleases/formats.
- Present 0.162.1 failures as historical, with upgrading first and closing Desktop as fallback.
- Describe conditional tasklist execution, including known unelevated and unknown-backend cases.
- Retain elevated as recommended, existing isolation requirements, PATH handling, and workspace-outside-`%TEMP%` guidance.
- Present staggering parallel dispatches as troubleshooting, not a proven remaining 0.163.0 defect.
- Preserve failure signatures, precedence, stderr-only detection limits, and expected write-denial distinction.
- Rewrite all unconditional historical claims in comments and docs, including the `checkNodeRepl()` comment and parallel-session paragraph.

## 5. Tests to write first

Add tests before implementation using existing hermetic fixtures. Preserve the default fake version and existing preflight injection.

### Pure tests: run on every host

| Test name | Inputs | Assertion |
|---|---|---|
| `Desktop ACL fix accepts supported version output` | All accepted examples above, including exact alpha, bare/prefixed forms, whitespace, and later stable cores | Predicate true |
| `Desktop ACL fix rejects unsupported or unknown output` | All rejected examples above, fake default, malformed output, metadata, and non-string inputs | Predicate false without throwing |
| `Windows runtime checks apply version and backend gates` | Windows/POSIX; read-only/workspace-write/danger-full-access/unspecified sandbox; elevated/unelevated/null backend; old/fixed/unknown version; isolation on/off | Exact gate rules; configuration-read rule unchanged |
| `sandbox failure hint selects every branch independently of host` | Explicit linux/darwin/win32; fixed/old/null version; elevated/unelevated/null backend; one and multiple reasons | Exact complete strings for all three branches; non-Windows precedence; old+unelevated uses branch 2 |

Add both new exports to the existing export contract.

### Integration tests

Mark only genuinely Windows-dependent tests Windows-only. All tests assert result status and relay exit status.

| Test name | Inputs | Assertion |
|---|---|---|
| `fixed Windows CLI skips injected process preflight` | `0.163.0` and exact alpha; elevated fixture; injected running and throw | Zero preflight traces, no process warnings, one dispatch, completed/0 |
| `old and unknown Windows CLI retain upgrade-first warning` | `0.162.1`, untested alpha, malformed stdout, `"unknown"`, empty stdout; injected running | One preflight; exact warning in result/stderr; completed/0; empty output stored as `"unknown"` |
| `resolved unelevated skips preflight on old CLI` | Isolated unelevated fixture, `0.162.1`, injected throw | Zero preflight traces; completed/0; unelevated argv/result preserved |
| `unknown backend retains old-version preflight without broader config access` | `0.162.1`; non-isolated, isolated missing-file, isolated missing-key; injected running | One preflight each; non-isolated `configTouches()` deep-equals `[]`; isolated cases have at least one touch and the distinct normalized touched paths equal only the resolved fixture `config.toml`; existing warnings retained |
| `sandbox failure summary prints the selected hint` | Fixed version, elevated fixture, fake exec emits `setup refresh had errors` and exits 0 | Runs on every host; exact stdout hint for host branch; sandbox_failed/1, childExitCode 0, unchanged reasons/schema/version |
| `fixed version retains successful-probe failure classification` | Fixed stdout; probe exits 0 with `blocked by policy` on stderr; successful exec | Dispatch occurs; sandbox_failed/1; signature persisted; Windows preflight skipped |
| `failed version probe keeps existing failure handling` | Nonzero probe with failure signature | No dispatch; sandbox_failed/1; null version; correct host hint |
| `expected write denial remains completed on fixed CLI` | Fixed version; `Access is denied` only; fake exec exits 0 | completed/0; no sandbox failure reason or hint |

### Existing tests

- Rename the runtime-check test claiming “every sandbox” to qualify the old/unknown-version default and extend its matrix.
- Keep existing running, unavailable, and clear-preflight tests on the default fake version. Update warning assertions to exact new strings where applicable.
- Qualify the clear-preflight test name; retain its explicit call-count assertions.
- Retain the ordinary fresh-run test’s existing platform-dependent preflight-count assertion. No new assertion is needed.
- Preserve direct `checkNodeRepl()` unit tests and existing danger-full-access, non-Windows, timeout/abort, streaming-signature, and warning/classifier-separation coverage.
- Note this plan in the test-file introduction.

## 6. Runnable acceptance criteria

After implementation:

```powershell
node --test codex-delegate/test/relay.test.mjs
node --test delegate-setup/test/isolated.test.mjs
```

Both must pass.

For the native-Windows relay gate:

- Zero failures and zero cancellations.
- Six existing platform skips; seven only if the existing symlink test reports its permission-related skip.
- Every newly added test must appear as passing, including each Windows-only integration named above. No new test may be skipped on Windows.
- Pure version, runtime-check, and all hint-branch tests must pass on this host.
- Any different skip count requires identifying the exact additional skipped test; do not accept a silently skipped new test.

Audit all relevant mentions:

```powershell
rg -n 'node_repl|Codex Desktop|0\.162|0\.163|preflight|stagger|serialize' codex-delegate delegate-setup claude-delegate
```

Require no matches for stale unconditional wording:

```powershell
rg -n -U "Quit Codex Desktop fully \(from the tray\) before dispatching|Every Windows run that is not[\s\S]{0,100}danger-full-access also checks|If node_repl\.exe is running \(Codex Desktop\), quit it fully|parallel isolated sessions probably|makes\s+the\s+elevated sandbox's setup refresh|cannot refresh the ACL of the|nothing serializes Codex's shared" codex-delegate/SKILL.md codex-delegate/references/dispatch-and-poll.md codex-delegate/scripts/relay.mjs
```

Rg exit 1 is expected for this second check. Rewrite these phrases even in historical descriptions to make qualification explicit.

Manually inspect the broad search results, especially the former Isolation causal claim, Desktop-closing troubleshooting bullet, parallel-session paragraph, Windows skill paragraph, and `checkNodeRepl()` comment. Conditional fallback advice and qualified historical 0.162.1 references are valid.

After integration with polish, rerun both full gates and require its LF-only help test to pass.

### Manual Windows acceptance

The orchestrator performs these runs separately from hermetic tests. Keep Desktop open and confirm at least one `node_repl.exe` process. Use an authenticated installation and a clean disposable repository outside `%TEMP%`; artifacts must be outside that repository.

Use an environment that already resolves elevated; confirm `result.windowsSandbox === "elevated"`. Do not change user configuration in this task.

For each binary selection, check `Get-Command codex` and `codex --version`. Set `$acceptanceRepo` to the disposable repository and `$acceptanceOut` to a distinct artifact directory, then run:

```powershell
git -C $acceptanceRepo status --porcelain
Test-Path -LiteralPath (Join-Path $acceptanceRepo 'codex-desktop-coexist-probe.txt')

'Using the shell, read git status --porcelain, then attempt exactly once: Set-Content -LiteralPath codex-desktop-coexist-probe.txt -Value probe -ErrorAction Stop. Report actual output and command exit codes. Do not retry, change permissions, use another write tool, use MCP, or read secrets or user configuration.' |
  node .\codex-delegate\scripts\relay.mjs --cd $acceptanceRepo --read-only --isolated --out-dir $acceptanceOut --timeout 2m

$relayExit = $LASTEXITCODE
$result = Get-Content -LiteralPath (Join-Path $acceptanceOut 'result.json') -Raw | ConvertFrom-Json
Test-Path -LiteralPath (Join-Path $acceptanceRepo 'codex-desktop-coexist-probe.txt')
git -C $acceptanceRepo status --porcelain
```

Before either run, require empty git status and an absent probe file.

**A. Stable 0.163.0 first on PATH**

Require:

- Relay exit 0, `status: completed`, version 0.163.0, and elevated backend.
- No node_repl/process-preflight warning in relay stderr or result warnings.
- Events show an actual successful read and an actual denied write with nonzero tool-command exit.
- No failure signature or MCP violation.
- Probe file absent, `touchedFiles: []`, and repository clean.

The denied tool-command exit is distinct from successful relay completion.

**B. Kept 0.162.1 first on PATH**

Prepend this directory only for the acceptance shell and restore PATH afterward:

`<directory holding a codex-cli 0.162.1 binary>`

The planning worker does not inspect that directory.

Require:

- Version 0.162.1, elevated backend, Desktop still open.
- Upgrade-first running-process warning in relay stderr and result warnings.
- If either failure signature occurs, `sandbox_failed`, relay exit 1, and the upgrade-first hint, even if Codex exits 0.
- Other failures retain existing classification.
- Probe file absent and repository clean.

Success on an old-version run does not invalidate the advisory: the sharing conflict is timing-dependent.

## 7. Edge cases and failure modes

- Suppressing the historical warning must never suppress sandbox classification or other isolation warnings.
- Untested prereleases and build-metadata output remain conservatively not known fixed, even if operationally fixed.
- Unknown backend does not mean unelevated. Preserve existing configuration-read boundaries.
- Configuration errors and failed probes retain early exits without process preflight.
- Required tasklist failures remain nonfatal; skipped tasklist cannot produce warnings.
- Process startup can race with tasklist, and the executable can change between version probe and dispatch. These existing races remain out of scope.
- Parallel setup failure remains a troubleshooting possibility, not a verified regression in 0.163.0.
- Keep warning text below its cap and outside the sandbox signature scanner.
- A separately maintained global delegation rule may still require closing Desktop. This repository change does not override or edit that rule; see section 9.

## 8. Rollback

Plain revert of this change’s commit or commits. No migrations, persisted schema changes, or user-configuration restoration are required. Reverting restores the prior preflight and troubleshooting guidance.

## 9. Open questions for the orchestrator

Ask the user separately whether to relax the reported requirement in the orchestrator's user-level instructions to quit Desktop before every Codex dispatch when stable codex-cli 0.163.0+ is active.

That file was not read, and editing it remains outside this plan. The repository implementation can proceed independently.

## Critique disposition (round 1)

| Item | Label | FIXED or REJECTED | Reason |
|---|---|---|---|
| 1 | BLOCKING | FIXED | Exported pure `sandboxFailureHint(result, platform)`; all branches receive host-independent unit coverage, plus one integration test that checks the printed host branch. |
| 2 | NON-BLOCKING | FIXED | Adopted the proposed anchored regex and numeric core comparison. Removed general SemVer validation and merged predicate coverage into accepted/rejected tables. Build metadata is not known fixed. |
| 3 | NON-BLOCKING | FIXED | Reduced hints to three branches, combining known-fixed and resolved unelevated without claiming both contain the fix. Shortened upgrade guidance. |
| 4 | NON-BLOCKING | REJECTED | The claimed missing assertion is present in this checkout: the ordinary fresh-run test already asserts `fx.traceCount("preflight")` equals `IS_WIN ? 1 : 0`, immediately before the configuration-touch assertion. Retain it and keep existing preflight tests on the default fake version. |
| 5 | NON-BLOCKING | FIXED | Expanded the must-not-match check with the missing causal phrases, allowing whitespace wrapping, and required manual review of every identified paragraph/comment. |
| 6 | NON-BLOCKING | FIXED | Made execution checkable through passing new test names and an explicit skip baseline. Re-reading shows six fixed Windows skips, plus one possible symlink-permission skip, rather than the proposed 5–6. |
| 7 | NON-BLOCKING | FIXED | Shortened both warnings. The unavailable message remains below 600 characters with the existing maximum 200-character reason; warning infrastructure and fixtures need no changes. |
| 8 | NON-BLOCKING | FIXED | Verified the polish commit touches both relay and test files. Added header-content constraints, preservation requirements, and full-suite reruns after second-branch integration. |
| 9 | NON-BLOCKING | FIXED | Kept global Claude instructions out of scope and added a separate user question about relaxing the reported Desktop-closing rule. |
| 10 | NON-BLOCKING | FIXED | Specified exact configuration-access assertions: no touches when non-isolated; nonempty touches whose distinct normalized paths equal only the resolved fixture config path for isolated missing-file/key cases. |

## Critique disposition (round 2)

Round 2 (plan-critique lane, read-only) verified the round-1 dispositions against the code and found
**0 BLOCKING** and 5 NON-BLOCKING gaps. Per the delegation protocol the plan froze after this round.
The orchestrator folded the five items in below. **They are binding and take precedence over any
conflicting text above.**

| Item | Label | Disposition |
|---|---|---|
| R2-1 | NON-BLOCKING | FIXED by amendment A1 |
| R2-2 | NON-BLOCKING | FIXED by amendment A2 |
| R2-3 | NON-BLOCKING | FIXED by amendment A3 |
| R2-4 | NON-BLOCKING | FIXED by amendment A4 (verified by the orchestrator) |
| R2-5 | NON-BLOCKING | FIXED by amendment A5 |

### A1. Stale-wording check (amends section 6)

- In the must-not-match `rg` pattern, replace the alternative
  `Every Windows run that is not[\s\S]{0,100}danger-full-access also checks` with
  `Every Windows run that is not\W+danger-full-access\W+also checks`. The doc wraps the mode name in
  backticks (`dispatch-and-poll.md:140-141`). Use `\W`, not a literal backtick, because a backtick is an
  escape character inside a PowerShell double-quoted string.
- Add the alternative `can block Codex's elevated-sandbox setup refresh` (`relay.mjs:84-85`).
- Add the "Environment and Windows" paragraph of `dispatch-and-poll.md` and the `relay.mjs` header
  comment to the manual-inspection list.

### A2. Skip baseline (amends sections 2 and 6)

The Windows relay suite has six fixed skips: test lines ~2183 and ~2241 (POSIX observations), ~2356,
~2365 and ~2443 (real signals), and ~2945 (POSIX launch failure). The symlink test is generated twice,
plain and with `--preserve-symlinks-main` (`relay.test.mjs:3273-3294`), so the expected count is
**six, or up to eight** if one or both symlink variants report their link-creation skip. After
`fix/relay-polish` is integrated, the baseline is whatever that branch's suite reports. No new test
may be skipped on Windows.

### A3. Hint branch for danger-full-access (amends section 4, "Exact sandbox failure hint")

Branch 2 also covers `result.sandbox === "danger-full-access"` on Windows, consistent with
`windowsRuntimeChecks` treating that mode as unaffected (`relay.mjs:365`). The field already exists on
the result (`relay.mjs:1305`). Branch 2's condition becomes: Windows AND (resolved unelevated OR
known-fixed version OR sandbox `danger-full-access`). Add one danger-full-access case (old version,
win32) to the `sandbox failure hint selects every branch independently of host` matrix.

### A4. Version output shape (amends E7)

Measured by the orchestrator on 2026-10-17: `codex --version` prints exactly one line on stdout,
`codex-cli 0.163.0` for the stable CLI and `codex-cli 0.163.0-alpha.10.2` for the Desktop bundle, with
no extra lines. The anchored regex in section 4
therefore recognizes both real outputs after trimming.

### A5. Integration test arguments (amends section 5)

`fixed Windows CLI skips injected process preflight` and `sandbox failure summary prints the selected
hint` both run with args `["--read-only", "--isolated", "--model", "m"]` on the elevated
`isolatedFixture`, and assert `result.windowsSandbox === (IS_WIN ? "elevated" : null)`. Without
`--isolated`, the backend is not resolved (`relay.mjs:1634-1641`) and the tests would exercise the
null backend instead.
