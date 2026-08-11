# zcode-delegate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an eleventh implementer skill, `zcode-delegate`, letting an orchestrator dispatch a brief to the Z.AI ZCode CLI, then review the diff and land it.

**Architecture:** One `scripts/relay.mjs` modelled on `codex-delegate`'s control flow (preflight → dispatch → watchdog → atomic result write), but with three ZCode-specific departures: the CLI is resolved from PATH *or* the desktop app bundle, the brief is delivered by `--attach` (no stdin exists), and the result is one JSON document parsed tolerantly (no event stream). `delegate-setup` gains a `zcode` registry entry plus a bundle-locating fallback in `discover.mjs`.

**Tech Stack:** Node 18+ built-ins only (`node:child_process`, `node:fs`, `node:path`, `node:os`, `node:string_decoder`). No dependencies, no network of its own, no credentials, no telemetry. `git` for `touchedFiles`.

## Global Constraints

Copied verbatim from `docs/plans/zcode-delegate.md` and the repo's house rules. **Every task inherits these.**

- **The relay never commits.** Committing belongs to the reviewing orchestrator.
- **Node built-ins only.** No dependencies, no network calls of its own, no credentials read or written, no telemetry.
- **Usage errors exit 2 before writing any result file; a missing binary exits 127 *with* one.**
- **Exactly four references** per implementer skill: `writing-the-brief`, `dispatch-and-poll`, `review-and-land`, `multi-task-queues`. Not three, not five.
- **Shared relay helpers are byte-identical by contract.** `MAX_TIMER_MS`, `parseDuration`, `killChild`, `gitTouchedFiles`, `MAX_BUFFERED_CHARS`, and the read-only tripwire family must be copied byte-for-byte from a sibling. `test/relay-parity.mjs` fails on a single differing byte.
- **Do NOT add `makeEventScanner`.** ZCode has no event stream. Precedent: `vibe` carries `MAX_BUFFERED_CHARS` without `makeEventScanner`.
- **`SKILL.md` frontmatter:** `name` must equal the directory; `description` under 1024 characters; also `license`, `compatibility`, `metadata.version`.
- **All skills' `metadata.version` must be in lockstep** — the suite asserts a single distinct value across every skill.
- **Autonomy is stated in the CLI's own terms**, and whatever ZCode cannot enforce is said plainly.
- **Never claim "verified" without a run.** "Contract-tested, live run pending" is the honest alternative.
- **Vocabulary:** use ZCode's own terms verbatim — `mode` (`build`/`edit`/`plan`/`yolo`), `session`, `goal` (`--target`), `app-server`, `plugins`, `skills`. Never coin synonyms.
- **Verified CLI facts** (zcode 0.16.1, do not re-derive): `--allowed-tools`, `--max-turns`, `--settings`, `--permission-mode`, `--allow-main-worktree-yolo` are **rejected** by the binary despite appearing in `--help`. There is **no `--model` flag** and **no stdin brief delivery**.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `skills/zcode-delegate/SKILL.md` | Trigger description, prerequisites, the five-step loop, autonomy caveats |
| `skills/zcode-delegate/scripts/relay.mjs` | The whole dispatch mechanic: resolve → preflight → dispatch → parse → result |
| `skills/zcode-delegate/references/writing-the-brief.md` | Brief structure + report contract |
| `skills/zcode-delegate/references/dispatch-and-poll.md` | Flags, `result.json` shape, backgrounding, recovery |
| `skills/zcode-delegate/references/review-and-land.md` | Review checklist, commit boundary, rework via `--session` |
| `skills/zcode-delegate/references/multi-task-queues.md` | Sequential queues, carrying constraints forward |
| `test/harness/constants.mjs` | Register `zcode` in `SKILLS` + `EXTRA_ARGS` |
| `test/harness/install-shim.mjs` | Add `zcode` to the Windows `.cmd` fake list |
| `test/fixtures/fake-cli.cjs` | New `zcode-success` smoke mode |
| `test/relay/zcode.mjs` | ZCode-specific smoke assertions |
| `test/relay/index.mjs` | Register the new runner |
| `test/relay-parity.mjs`, `test/relay-isolated.mjs` | Add `zcode` to the relay lists |
| `skills/delegate-setup/scripts/implementers.mjs` | `zcode` registry entry + `ZCODE_MODE` |
| `skills/delegate-setup/scripts/discover.mjs` | `locate` fallback when the binary is absent from PATH |
| `skills/delegate-setup/scripts/config.mjs` | Validate `permissionMode` against `ZCODE_MODE` |
| `skills/delegate-setup/references/schema.md` | Dial-table row |
| `skills.sh.json`, `README.md`, `AGENTS.md` | Registration and docs |

---

## Task 1: Register the skill and scaffold its shape

The smoke suite is self-checking: adding `zcode` to `SKILLS` with no directory fails immediately. That failure is our first test.

**Files:**
- Modify: `test/harness/constants.mjs`
- Modify: `test/harness/install-shim.mjs`
- Create: `skills/zcode-delegate/SKILL.md`
- Create: `skills/zcode-delegate/references/{writing-the-brief,dispatch-and-poll,review-and-land,multi-task-queues}.md`
- Create: `skills/zcode-delegate/scripts/relay.mjs` (stub only; Task 2 fills it)
- Modify: `skills.sh.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the directory `skills/zcode-delegate/` with all six markdown files and `scripts/relay.mjs` present on disk. Later tasks assume `h.relayPath("zcode")` resolves.

- [ ] **Step 1: Add zcode to the smoke matrix (this is the failing test)**

In `test/harness/constants.mjs`, add `"zcode"` to the end of `SKILLS` and `zcode: []` to `EXTRA_ARGS`. Leave `binaryName` untouched — its default already returns `zcode`.

```js
export const SKILLS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "zcode"];

export const EXTRA_ARGS = {
  claude: [], codex: [], opencode: ["--model", "fake/model"], agy: [], grok: [],
  kimi: [], qoder: [], vibe: [], cursor: [], pi: [], zcode: [],
};
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `node test/relay-smoke.mjs --only package-shape`
Expected: FAIL — `smoke matrix has no entry without a directory`.

- [ ] **Step 3: Create SKILL.md**

Create `skills/zcode-delegate/SKILL.md`. Keep `description` under 1024 characters. Set `metadata.version` to whatever the other skills currently carry (check `skills/codex-delegate/SKILL.md`; it is `0.4.2` as of writing — Task 8 bumps all of them together).

```markdown
---
name: zcode-delegate
description: >-
  Delegate a coding task to the Z.AI ZCode CLI as a background implementer, then review its diff and
  land it yourself. Use this whenever the user wants to hand implementation work to ZCode — phrasings
  like "have ZCode do X", "delegate this to ZCode", "run it through ZCode", or "use ZCode to
  implement/fix/refactor" — or to run a queue of coding tasks through ZCode while staying the
  reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants the code written
  directly without delegating.
license: MIT
compatibility: Requires the `zcode` CLI (Z.AI ZCode), Node 18+, and git. ZCode ships its CLI inside the desktop app rather than on PATH or npm — see Prerequisites. The orchestrating agent must be able to run shell commands and read files.
metadata:
  version: 0.4.2
---

# ZCode Delegate

You are the **orchestrator**. This skill hands a bounded coding task to a separate **implementer** —
the Z.AI ZCode CLI — then you review what it produced and land it yourself.

## Prerequisites (check once)

1. ZCode is installed. The CLI ships **inside the desktop app**, not on PATH and not on npm.
   The relay finds it automatically on Windows and macOS; you can also point at it explicitly
   with `--zcode-path <file>` or the `ZCODE_CLI` environment variable. On Linux (AppImage) there
   is no fixed install path, so one of those two is required.
2. A model provider is configured. `zcode login` is the intended path, but it fails on 0.16.1 with
   `OAuth response is not valid JSON`. Until that is fixed upstream, supply the key by environment
   instead: `ZCODE_API_KEY`, or `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`.
3. You are in (or will point `--cd` at) the target git repository.

## Autonomy — read this before dispatching

ZCode's own term is **mode**, with four values. Only two are usable headlessly:

| mode | Behaviour |
| --- | --- |
| `yolo` | Writes. ZCode's own default for `--prompt`. This relay's write-capable default. |
| `plan` | Refuses edits. What `--read-only` selects. |
| `build`, `edit` | **Rejected by this relay.** Headless runs have no permission client, so they exit 0 having done nothing. |

ZCode exposes `--disallowed-tools` (a denylist) but **no `--allowed-tools`**, so an explicit
allowlisted tool surface is not possible here. `plan` mode refused edits in testing, but whether
that is tool-enforced or model compliance is unproven — the relay reports a `readOnlyViolation`
tripwire rather than promising a guarantee. Confirm `touchedFiles` came back empty.

## The loop

1. **Write the brief** — ZCode sees only what you send. See [references/writing-the-brief.md](references/writing-the-brief.md).
2. **Dispatch** with the bundled helper:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# read-only (review/diagnosis, no edits):  add --read-only
# continue a specific session:             add --session <sess_...>
# continue the latest session for --cd:    add --resume-last
# hard time limit (watchdog):              add --timeout 2h
```

3. **Wait** — the relay writes `result.json` with a `status`.
4. **Review** — re-run the project's gates yourself; never trust the self-report.
5. **Land it** — *you* commit.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md)
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md)
- [references/review-and-land.md](references/review-and-land.md)
- [references/multi-task-queues.md](references/multi-task-queues.md)
```

- [ ] **Step 4: Create the four references**

Copy each from `skills/codex-delegate/references/` and adapt Codex-specific wording to ZCode's terms. The four files and their required substance:

- `writing-the-brief.md` — brief structure, XML blocks, the report contract, embedding the project's real gate commands. Add: **the brief is delivered as a file via `--attach`**, so it has no length ceiling, and it must tell ZCode it will not commit.
- `dispatch-and-poll.md` — every relay flag, the `result.json` field list from Task 5, backgrounding per orchestrator, and recovery. Add: `zcode_unavailable` and how CLI resolution works.
- `review-and-land.md` — review checklist, the commit boundary, the rework cycle via `--session <sess_...>`. Add the mode table from `SKILL.md`, and note `--attach` + `--session` is untested (Task 7 verifies it).
- `multi-task-queues.md` — sequential queues, carrying constraints forward, the end-of-run coherence check.

- [ ] **Step 5: Create the relay stub**

Create `skills/zcode-delegate/scripts/relay.mjs` so the file exists; Task 2 replaces it wholesale.

```js
#!/usr/bin/env node
// delegate-skills · zcode-delegate · relay.mjs — implemented in Task 2.
process.stderr.write("relay: not implemented\n");
process.exit(2);
```

- [ ] **Step 6: Register in skills.sh.json**

Add `"zcode-delegate"` to the end of the `skills` array in the "Delegate to CLI agents" grouping.

- [ ] **Step 7: Add zcode to the Windows fake-CLI shim list**

In `test/harness/install-shim.mjs`, add `"zcode"` to the win32 `.cmd` list so a fake `zcode` lands on PATH:

```js
for (const skill of ["claude", "codex", "opencode", "grok", "cursor", "pi", "zcode"]) {
```

- [ ] **Step 8: Run the suite to verify package shape passes**

Run: `node test/relay-smoke.mjs --only package-shape`
Expected: PASS, including `zcode: exactly the four references` and `zcode: listed in skills.sh.json`.

- [ ] **Step 9: Commit**

```bash
git add skills/zcode-delegate skills.sh.json test/harness/constants.mjs test/harness/install-shim.mjs
git commit -m "feat(zcode-delegate): scaffold skill shape and register in the smoke matrix"
```

---

## Task 2: Relay argument parsing and usage errors

**Files:**
- Modify: `skills/zcode-delegate/scripts/relay.mjs`
- Test: `test/relay/zcode.mjs` (created here, registered in Task 6)

**Interfaces:**
- Consumes: the scaffold from Task 1.
- Produces: `parseArgs(argv) -> opts`, where `opts` has `{ brief, cd, lane, mode, readOnly, disallowedTools, session, resumeLast, timeout, outDir, zcodePath, skipGitRepoCheck }`. `fail(message, code = 2)` writes `relay: <message>` to stderr and exits.

- [ ] **Step 1: Write the failing test**

Create `test/relay/zcode.mjs`:

```js
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function runZcode(h) {
  const workDir = h.freshRepo("work-zcode");

  for (const [label, extra] of [
    ["build mode is rejected", ["--mode", "build"]],
    ["edit mode is rejected", ["--mode", "edit"]],
    ["bogus mode is rejected", ["--mode", "bogus"]],
  ]) {
    const outDir = join(h.scratch, `out-reject-${label.replace(/\W+/g, "-")}`);
    const run = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, ...extra,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`zcode validation: ${label} before artifacts`,
      run.status === 2 && !existsSync(outDir));
  }
}
```

- [ ] **Step 2: Register the runner temporarily and run it**

Add to `test/relay/index.mjs`: `import { runZcode } from "./zcode.mjs";` and `["zcode", runZcode],` at the end of `runners`.

Run: `node test/relay-smoke.mjs --only zcode`
Expected: FAIL — the stub exits 2 but also for the wrong reason; confirm the checks fail or pass spuriously, then proceed.

- [ ] **Step 3: Implement parseArgs**

Replace `relay.mjs` with the real header + parsing. Start by copying `skills/codex-delegate/scripts/relay.mjs` wholesale — this preserves the byte-identical shared helpers required by parity — then replace the Codex-specific parts. In `parseArgs`, the ZCode option set is:

```js
const ZCODE_MODES = new Set(["plan", "yolo"]);
const ZCODE_REJECTED_MODES = new Set(["build", "edit"]);
const SAFE_SESSION = /^sess_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
```

Mode handling, which is the novel validation:

```js
case "--mode": {
  const value = next("--mode");
  if (ZCODE_REJECTED_MODES.has(value)) {
    fail(`--mode ${value} cannot write in a headless run (ZCode has no permission client there, so the run exits 0 having done nothing). Use --mode yolo to write, or --read-only for plan mode.`);
  }
  if (!ZCODE_MODES.has(value)) {
    fail(`--mode must be one of: ${[...ZCODE_MODES].join(", ")}`);
  }
  opts.mode = value;
  flagged.add("mode");
  break;
}
```

Default `opts.mode = null` and resolve it after lane application: `opts.mode ?? (opts.readOnly ? "plan" : "yolo")`. `--read-only` sets `opts.readOnly = true`. `--session` validates against `SAFE_SESSION` and is mutually exclusive with `--resume-last`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/relay-smoke.mjs --only zcode`
Expected: PASS — all three rejection checks.

- [ ] **Step 5: Commit**

```bash
git add skills/zcode-delegate/scripts/relay.mjs test/relay/zcode.mjs test/relay/index.mjs
git commit -m "feat(zcode-delegate): parse args and reject headless-unusable modes"
```

---

## Task 3: Resolve the ZCode CLI

**Files:**
- Modify: `skills/zcode-delegate/scripts/relay.mjs`
- Modify: `test/relay/zcode.mjs`

**Interfaces:**
- Consumes: `opts.zcodePath` from Task 2.
- Produces: `resolveZcode(opts) -> { command, prefixArgs, source } | null`. `command` is an absolute path or a bare binary name; `prefixArgs` is `[]` for a binary or `[bundlePath]` when `command` is `process.execPath`. `source` is one of `"path"`, `"flag"`, `"env"`, `"bundle"`.

> **Why the unavailable test cannot clear `PATH`.** Every sibling proves "missing binary" by running
> with `PATH: ""`. That is **invalid for zcode**: with `PATH` empty, bundle auto-discovery still finds
> an installed ZCode desktop app, so the run would succeed on any developer machine that has ZCode
> and fail only in CI — the worst kind of flake. Instead, an explicitly-named CLI that does not exist
> resolves to **unavailable** (127 *with* a result file), not a usage error. That is both the honest
> reading ("the CLI you named isn't there" is the same condition as "couldn't find one") and
> deterministic on every machine. Only malformed usage — `--zcode-path` with no value — is exit 2.
>
> For the same reason, **do not** add `zcode` to the hardcoded list in `test/relay/preflight.mjs`:
> that loop's unavailable sub-test is `PATH`-based. zcode carries its own preflight checks in its own
> module, exactly as `qoder` does.

- [ ] **Step 1: Write the failing test**

Append to `test/relay/zcode.mjs`, inside `runZcode`:

```js
  const missingOutDir = join(h.scratch, "out-unavailable-zcode");
  const missing = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", missingOutDir,
  ], {
    // Deterministic on every machine: naming a CLI that does not exist is the
    // unavailable condition. Clearing PATH would not be - bundle discovery
    // would still find an installed ZCode desktop app.
    env: { ...h.baseEnv, ZCODE_CLI: join(h.scratch, "no-such-zcode.cjs") },
    encoding: "utf8",
  });
  h.check("zcode unavailable: an explicitly named missing CLI writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "zcode_unavailable");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/relay-smoke.mjs --only zcode`
Expected: FAIL — no `result.json`, or status is not `zcode_unavailable`.

- [ ] **Step 3: Implement resolveZcode**

```js
const BUNDLE_RELATIVE = ["resources", "glm", "zcode.cjs"];

function bundleCandidates() {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [join(local, "Programs", "ZCode", ...BUNDLE_RELATIVE)];
  }
  if (process.platform === "darwin") {
    return [
      join("/Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
      join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    ];
  }
  // Linux ships an AppImage with no fixed install path: nothing honest to guess.
  return [];
}

function asTarget(file, source) {
  return file.endsWith(".cjs") || file.endsWith(".js")
    ? { command: process.execPath, prefixArgs: [file], source }
    : { command: file, prefixArgs: [], source };
}

/** null means unavailable (127 with a result file), never a usage error. */
function resolveZcode(opts) {
  // An explicitly named CLI wins, and a named-but-missing one is "unavailable" -
  // the same condition as finding none, so it stays a 127 with a result file.
  const named = opts.zcodePath || (process.env.ZCODE_CLI || "").trim();
  if (named) {
    if (!existsSync(named)) return null;
    return asTarget(resolve(named), opts.zcodePath ? "flag" : "env");
  }
  if (onPath("zcode")) return { command: "zcode", prefixArgs: [], source: "path" };
  for (const candidate of bundleCandidates()) {
    if (existsSync(candidate)) return asTarget(candidate, "bundle");
  }
  return null;
}
```

`onPath(binary)` walks `PATH` (honouring `PATHEXT` on win32) and returns the resolved file or `null` — mirror `resolveBinary` in `skills/delegate-setup/scripts/discover.mjs`.

- [ ] **Step 4: Wire the unavailable path**

In `main()`, after `prepareRunDir`, resolve before the version preflight:

```js
const target = resolveZcode(opts);
if (!target) {
  reportUnavailable(writeResult, run.resultPath);
  return;
}
```

`reportUnavailable` writes `status: "zcode_unavailable"`, `exitCode: 127`, and a stderr line naming the three ways to point at the CLI.

- [ ] **Step 5: Run to verify it passes**

Run: `node test/relay-smoke.mjs --only zcode`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/zcode-delegate/scripts/relay.mjs test/relay/zcode.mjs
git commit -m "feat(zcode-delegate): resolve the CLI from PATH, flag, env, or app bundle"
```

---

## Task 4: Dispatch with --attach

**Files:**
- Modify: `skills/zcode-delegate/scripts/relay.mjs`
- Modify: `test/fixtures/fake-cli.cjs`
- Modify: `test/relay/zcode.mjs`

**Interfaces:**
- Consumes: `resolveZcode` (Task 3), `opts` (Task 2).
- Produces: `buildArgv(opts, briefPath) -> string[]` — the args **after** `prefixArgs`.

- [ ] **Step 1: Add the fake CLI mode**

In `test/fixtures/fake-cli.cjs`, after the `qoder-success` block, add:

```js
if (process.env.SMOKE_MODE === "zcode-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  // The bundled AI SDK prints this banner with console.info — i.e. on stdout,
  // ahead of the JSON. The relay must tolerate it.
  console.log("AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.");
  console.log(JSON.stringify({
    sessionId: "sess_smoke-1",
    traceId: "trace-1",
    turnId: "turn_1",
    response: "fake zcode completed",
    usage: { source: "provider", modelRequestCount: 1, inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    eventCount: 12,
    projection: { status: "idle", turnCount: 1, totalTokenCount: 9, contextUsed: 9, contextWindow: 200000 },
  }, null, 2));
  process.exit(0);
}
```

- [ ] **Step 2: Write the failing test**

Append to `runZcode` in `test/relay/zcode.mjs`:

```js
  const outDir = join(h.scratch, "out-success-zcode");
  const argsFile = join(h.scratch, "args-success-zcode");
  const run = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--session", "sess_prior-0",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? (h.WIN ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean) : JSON.parse(readFileSync(argsFile, "utf8")))
    : [];
  h.check("zcode success: relay exits zero", run.status === 0);
  h.check("zcode success: mode is always explicit and never inherits yolo by default",
    args.includes("--mode") && args[args.indexOf("--mode") + 1] === "yolo");
  h.check("zcode success: brief is attached, never passed as prompt text",
    args.includes("--attach") &&
    args[args.indexOf("--attach") + 1].endsWith("brief.md") &&
    args[args.indexOf("--prompt") + 1] === "Follow the attached brief exactly.");
  h.check("zcode success: session resume uses --resume", 
    args.includes("--resume") && args[args.indexOf("--resume") + 1] === "sess_prior-0");
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("zcode success: JSON parsed past the stdout banner",
      value.status === "completed" &&
      value.sessionId === "sess_smoke-1" &&
      value.finalMessage === "fake zcode completed" &&
      value.usage?.totalTokens === 9 &&
      value.contextWindow === 200000);
  }
```

Add `readFileSync` to the imports at the top of the file.

- [ ] **Step 3: Run to verify it fails**

Run: `node test/relay-smoke.mjs --only zcode`
Expected: FAIL — argv assertions fail; no `sessionId` in the result.

- [ ] **Step 4: Implement buildArgv and the brief file**

`prepareRunDir` writes the brief to `brief.md` (not `brief.txt`) and exposes `run.briefPath`.

```js
const ATTACH_PROMPT = "Follow the attached brief exactly.";

function buildArgv(opts, briefPath) {
  const argv = ["--cwd", opts.cd, "--json", "--no-color", "--mode", opts.mode];
  if (opts.disallowedTools) argv.push("--disallowed-tools", opts.disallowedTools);
  if (opts.session) argv.push("--resume", opts.session);
  else if (opts.resumeLast) argv.push("-c");
  argv.push("--attach", briefPath, "--prompt", ATTACH_PROMPT);
  return argv;
}
```

Spawn with `[...target.prefixArgs, ...buildArgv(opts, run.briefPath)]`. Use `shell: true` **only** when `process.platform === "win32"` and `target.command` ends in `.cmd`/`.bat`; a `node <bundle>` launch uses `shell: false`. When shelling, quote spaceable args exactly as codex's relay does.

- [ ] **Step 5: Implement tolerant JSON parsing**

```js
/** stdout may carry an AI SDK console.info banner before the JSON document. */
function parseZcodeOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}
```

On `close`, map `response` → `finalMessage`, `sessionId` → `sessionId`, `usage` → `usage`, `projection.contextWindow` → `contextWindow`. A `null` parse with exit 0 is still `completed`, but `finalMessage` falls back to the trimmed stdout and a `parseWarning` field is set; a `null` parse with a non-zero exit is `failed` with `stderrTail`.

- [ ] **Step 6: Run to verify it passes**

Run: `node test/relay-smoke.mjs --only zcode`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/zcode-delegate/scripts/relay.mjs test/fixtures/fake-cli.cjs test/relay/zcode.mjs
git commit -m "feat(zcode-delegate): dispatch via --attach and parse the JSON document tolerantly"
```

---

## Task 5: Result contract, tripwire, and parity

**Files:**
- Modify: `skills/zcode-delegate/scripts/relay.mjs`
- Modify: `test/relay-parity.mjs`
- Modify: `test/relay-isolated.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `result.json` conforming to `delegate-relay.result.v1`.

- [ ] **Step 1: Add zcode to the parity lists (the failing test)**

In `test/relay-parity.mjs`:

```js
const RELAYS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "zcode"];
const READ_ONLY_TRIPWIRE_RELAYS = ["claude", "grok", "zcode"];
```

and add `"zcode"` to the `MAX_BUFFERED_CHARS` relay list. **Do not** add it to the `makeEventScanner` list.

In `test/relay-isolated.mjs`, add `"zcode"` to `RELAYS`.

- [ ] **Step 2: Run to verify it fails**

Run: `node test/relay-parity.mjs`
Expected: FAIL — the tripwire symbols are missing from the zcode relay.

- [ ] **Step 3: Copy the tripwire family byte-for-byte**

From `skills/claude-delegate/scripts/relay.mjs`, copy these top-level declarations **verbatim, comments included**: `FINGERPRINT_UNREADABLE`, `FINGERPRINT_DIRECTORY`, `gitRepoRoot`, `gitStatusEntries`, `dirtyPaths`, `canonicalFilePath`, `asciiFold`, `gitPathKey`, `gitPathIsExcluded`, `gitTripwireState`, `pathFingerprint`, `gitIndexFingerprints`, `fingerprintPaths`, `fingerprintDirtyPaths`, `changedDirtyPaths`, `readOnlyVerdict`, and `MAX_BUFFERED_CHARS`. Do not reformat or "improve" them — a single differing byte fails parity.

- [ ] **Step 4: Wire the tripwire**

Take `gitTripwireState(opts.cd)` before dispatch when `opts.mode === "plan"`, and call `readOnlyVerdict(...)` at close. Set `readOnlyViolation` on the result (tri-state: `true`, `false`, or `null` when git cannot report). Leave it `null` for `yolo` runs.

- [ ] **Step 5: Finalize the result fields**

`makeResultWriter` emits: `schema: "delegate-relay.result.v1"`, `lane`, `laneSource`, `workdir`, `mode`, `readOnly`, `disallowedTools`, `session`, `resumeLast`, `zcodeVersion`, `zcodeSource` (from `resolveZcode`), `startedAt`, `finishedAt`, `briefPath`, `outputPath`, `finalPath`, plus the per-outcome `status`, `exitCode`, `signal`, `sessionId`, `finalMessage`, `touchedFiles`, `usage`, `contextWindow`, `readOnlyViolation`. Write atomically via temp + rename.

- [ ] **Step 6: Add zcode's own preflight checks**

zcode is deliberately absent from `test/relay/preflight.mjs` (see Task 3), so add the equivalent to
`test/relay/zcode.mjs`, mirroring the `qoder` module:

```js
  for (const [mode, expectedStatus, expectedExit] of [
    ["zcode-version-hang", "timeout", 124],
    ["zcode-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", preflightOutDir, "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(preflightOutDir, "result.json")) ? h.result(preflightOutDir) : {};
    h.check(`zcode preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
```

The shared fake already routes any `*-version-hang` / `*-version-fail` `SMOKE_MODE` by suffix, so no
fixture change is needed. Keep the copied `reportVersionFailure` wording containing both
`version preflight` and `was not dispatched`.

- [ ] **Step 7: Run parity and the full suite**

Run: `node test/relay-parity.mjs && node test/relay-isolated.mjs && node test/relay-smoke.mjs`
Expected: PASS, including the timeout and abort matrices now covering zcode.

- [ ] **Step 8: Commit**

```bash
git add skills/zcode-delegate/scripts/relay.mjs test/relay-parity.mjs test/relay-isolated.mjs
git commit -m "feat(zcode-delegate): result contract, read-only tripwire, and helper parity"
```

---

## Task 6: Fleet integration in delegate-setup

**Files:**
- Modify: `skills/delegate-setup/scripts/implementers.mjs`
- Modify: `skills/delegate-setup/scripts/discover.mjs`
- Modify: `skills/delegate-setup/scripts/config.mjs`
- Modify: `skills/delegate-setup/references/schema.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `IMPLEMENTER_BY_KEY.zcode`, exported `ZCODE_MODE`.

- [ ] **Step 1: Add the registry entry**

Append to `IMPLEMENTERS` in `implementers.mjs`:

```js
{
  key: "zcode",
  skill: "zcode-delegate",
  binary: "zcode",
  versionArgs: ["--version"],
  // ZCode ships its CLI inside the desktop app; consulted only when `binary`
  // is absent from PATH. The bundle is a .cjs, so it runs under node.
  locate: {
    launcher: "node",
    candidates: {
      win32: ["%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs"],
      darwin: [
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        "~/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      ],
      linux: [],  // AppImage has no fixed install path — nothing honest to guess.
    },
  },
  // No auth-status command exists, and `zcode login` is broken on 0.16.1.
  authProbe: null,
  // No --model flag: the model is chosen in the CLI's own config file.
  modelProbe: null,
  usageProbe: null,
  supports: ["permissionMode", "timeout", "readOnly"],
  winShell: false,
},
```

Add the mode constant beside `QODER_PERMISSION`:

```js
/** ZCode's --mode. build/edit are omitted: headless runs have no permission
 *  client, so they exit 0 having done nothing. The relay rejects them too. */
export const ZCODE_MODE = Object.freeze(["plan", "yolo"]);
```

- [ ] **Step 2: Resolve the usage probe honestly**

Check whether a directory under `~/.zcode/cli/` maps 1:1 to sessions:

```bash
ls ~/.zcode/cli/exec | grep -c '^sess_'
ls ~/.zcode/cli/artifacts | grep -c '^sess_'
```

If one is a clean per-session count, replace `usageProbe: null` with `{ homeSubdir: ".zcode/cli", path: ["<that dir>"], entry: "dir", match: /^sess_/ }`. If neither is, **leave it `null`** — precedent: opencode, qoder, vibe. Do not guess.

- [ ] **Step 3: Add the locate fallback in discover.mjs**

Change the resolution used by the probe loop from `resolveBinary(impl.binary)` to a helper that returns `{ command, prefixArgs }`:

```js
function expandCandidate(raw) {
  const home = homedir();
  return raw
    .replace(/^~(?=\/)/, home)
    .replace(/%([A-Z_]+)%/g, (_, name) => process.env[name] || "")
    .split("/").join(sep);
}

/** PATH first (sibling behaviour); then the registry's bundle candidates. */
function resolveImplementer(impl) {
  const onPath = resolveBinary(impl.binary);
  if (onPath) return { path: onPath, command: onPath, prefixArgs: [] };
  const candidates = impl.locate?.candidates?.[process.platform] ?? [];
  for (const raw of candidates) {
    const file = expandCandidate(raw);
    try {
      if (statSync(file).isFile()) {
        return { path: file, command: process.execPath, prefixArgs: [file] };
      }
    } catch { /* keep looking */ }
  }
  return null;
}
```

Thread `prefixArgs` through `runProbe` / `captureProbe` so they call `execFileSync(command, [...prefixArgs, ...args])`. `needsWindowsShell` must consult `resolved.command`, and a `node <bundle>` launch never needs the shell.

- [ ] **Step 4: Validate the dial in config.mjs**

Where `permissionMode` is validated against `QODER_PERMISSION` for qoder, add the zcode branch against `ZCODE_MODE`, so a lane with `permissionMode: "build"` fails validation with the same reasoning the relay uses.

- [ ] **Step 5: Add the schema row**

In `skills/delegate-setup/references/schema.md`, add to the implementer table:

| `zcode` | zcode-delegate | `zcode` | permissionMode, timeout, readOnly |

Below the table, note: ZCode has no `--model` flag, so `model` is not a dial; `permissionMode` accepts only `plan` and `yolo`.

- [ ] **Step 6: Run the setup smoke and a live discover**

Run: `node test/relay-smoke.mjs --only delegate-setup && node skills/delegate-setup/scripts/discover.mjs`
Expected: PASS, and the JSON report lists `zcode` under `discovered` with its version, found via the bundle rather than PATH.

- [ ] **Step 7: Commit**

```bash
git add skills/delegate-setup
git commit -m "feat(delegate-setup): register zcode and locate CLIs shipped inside desktop apps"
```

---

## Task 7: Live verification against the real CLI

No new code. This produces the evidence the README's Verification status is allowed to claim.

**Files:** none modified. Record results in the PR description.

- [ ] **Step 1: Read-only run**

```bash
node skills/zcode-delegate/scripts/relay.mjs --brief /tmp/brief.txt --cd /tmp/throwaway-repo --read-only
```

Expect `status: "completed"`, `touchedFiles: []`, `readOnlyViolation: false`, a `sess_...` in `sessionId`.

- [ ] **Step 2: Write run**

Brief instructing a single file creation. Expect the file to exist, `touchedFiles` to list exactly it, and `mode: "yolo"`.

- [ ] **Step 3: Resume with --attach — the untested combination**

Re-dispatch with `--session <sessionId from step 2>` and a delta brief. Confirm ZCode recalls the earlier turn **and** reads the newly attached brief. If `--attach` and `--resume` conflict, fall back to inlining short delta briefs via `--prompt` and document that in `review-and-land.md`.

- [ ] **Step 4: Unavailable path**

```bash
PATH= ZCODE_CLI= node skills/zcode-delegate/scripts/relay.mjs --brief /tmp/brief.txt --cd /tmp/throwaway-repo
```

Expect exit 127 **with** a `result.json` whose status is `zcode_unavailable`.

- [ ] **Step 5: Record what ran**

Write down platform, CLI version, and exactly which runs happened. Anything not run is not claimed.

---

## Task 8: Documentation and release hygiene

**Files:**
- Modify: `README.md`, `AGENTS.md`, every `skills/*/SKILL.md` (version bump)

- [ ] **Step 1: README table row**

The table is alphabetical by skill name (`agy` → `vibe`), so `zcode-delegate` goes **last, after the
`vibe` row**:

| [`zcode-delegate`](skills/zcode-delegate/SKILL.md) | [Z.AI ZCode](https://zcode.z.ai) (`zcode`) | `--mode yolo` | `--read-only` (`--mode plan`) | `--resume-last`, `--session <id>` |

- [ ] **Step 2: README distribution caveat**

Under the table, add a footnote marker on the ZCode row pointing to: ZCode ships its CLI inside the desktop app — not on PATH, not on npm, and not covered by the public docs, which describe only the GUI. The relay resolves it from PATH, `--zcode-path`/`ZCODE_CLI`, or the installed app bundle. `zcode login` fails on 0.16.1, so the key comes from `ZCODE_API_KEY` / `ANTHROPIC_API_KEY` / `ZAI_API_KEY`.

- [ ] **Step 3: README Verification status line**

Write only what Task 7 actually ran, naming the platform and CLI version. If a step was skipped, say so.

- [ ] **Step 4: AGENTS.md vocabulary row**

Add to the vocabulary table:

| `mode` (`build`/`edit`/`plan`/`yolo`), `session`, `goal` (`--target`), `app-server`, `plugins`, `skills` | ZCode's own terms — use verbatim when discussing `zcode` | don't paraphrase them; `build`/`edit` are not usable headlessly |

Also update `AGENTS.md:5`, which currently reads "Ten implementer skills ship today:" — make it
"Eleven" and add `zcode-delegate` (Z.AI ZCode) to the list that follows. Update the pre-publish
bullet listing which relays need `shell:true` on win32: zcode needs it **only** when resolved to a
`.cmd`/`.bat` shim, never for a `node <bundle>` launch.

- [ ] **Step 5: Version lockstep**

Bump `metadata.version` in **every** `skills/*/SKILL.md` (all twelve) to the next patch — e.g. `0.4.3`.

Run: `node test/relay-smoke.mjs --only package-shape`
Expected: PASS `all skill metadata.version values are present and in lockstep`.

- [ ] **Step 6: Full gate run**

```bash
node test/relay-parity.mjs
node test/relay-isolated.mjs
node test/event-scanner.mjs
node test/relay-smoke.mjs
npx skills add . --list
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md skills
git commit -m "docs(zcode-delegate): README row, vocabulary, and version lockstep"
```

---

## Self-Review

**Spec coverage.** Every section of `docs/plans/zcode-delegate.md` maps to a task: skill shape → 1; locating the CLI → 3; dispatch → 4; result parsing → 4; read-only → 5; result contract → 5; fleet integration → 6; work items → 1–8; verification status → 7–8; open risks → 7 (`--attach` + resume, timeout tree via the matrix in 5, usage probe in 6 step 2).

**Placeholders.** None. The one deliberately conditional step (usage probe, Task 6 step 2) states both branches and its decision rule, and `null` is a valid registry value with three existing precedents.

**Type consistency.** `resolveZcode` returns `{ command, prefixArgs, source }` in Task 3 and is consumed with those names in Tasks 4 and 5. `buildArgv(opts, briefPath)` is defined and called with the same signature. `parseZcodeOutput(stdout)` returns the parsed object or `null`, and both branches are handled. `run.briefPath` points at `brief.md` in Tasks 4 and 5. `ZCODE_MODE` in `implementers.mjs` matches `ZCODE_MODES` in the relay in value (`plan`, `yolo`), though intentionally not in name — one is an exported registry constant, the other a relay-local `Set`.

**Known deviation to flag in review.** `impl.locate` and the `{ command, prefixArgs }` resolution shape are new concepts in `delegate-setup`. No sibling needs them because no sibling ships inside a desktop app. This is the single design deviation the maintainer is most likely to question, and Task 6 keeps it additive: `locate` is consulted only when PATH resolution fails, so every existing implementer's behaviour is unchanged.
