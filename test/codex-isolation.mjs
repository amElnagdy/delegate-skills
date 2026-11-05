/**
 * Tests for skills/codex-delegate/scripts/relay.mjs, written from the frozen plan
 * docs/plans/codex-isolated-lanes.md (sections 4, 7.1, 7.2).
 * The Windows Desktop coexistence tests (version-aware process preflight, sandbox failure hint) are
 * written from the frozen plan docs/plans/codex-desktop-coexist.md (sections 4 and 5, and
 * the round-2 amendments A2, A3 and A5).
 *
 * Run by explicit filename:  node --test test/codex-isolation.mjs
 *
 * Hermetic by construction (plan 7.1): integration tests launch the relay through
 * fixtures/codex-isolation/relay-driver.mjs with a private bin directory holding a synthetic `codex`
 * (fixtures/codex-isolation/fake-codex.mjs behind codex.cmd / codex), a fixture CODEX_HOME / HOME /
 * XDG_CONFIG_HOME, an allowlisted environment, and a stubbed process preflight. Nothing here
 * invokes real Codex, real user configuration, the network, or MCP.
 *
 * Contract the tests pin (names the plan left open; see the report that accompanies this file):
 *   relay.mjs exports  main(argv, deps) buildArgv resolveIsolation windowsRuntimeChecks
 *     isValidFeatureName scanWindowsSandbox readWindowsSandboxSetting resolveCodexConfigPath
 *     mapOutcome createSandboxSignatureScanner createEventAccumulator checkNodeRepl
 *     hasWindowsDesktopAclFix sandboxFailureHint MAX_CONFIG_LINE_BYTES CONFIG_READ_CHUNK_BYTES
 *     MAX_CONFIG_NESTING_DEPTH
 *   windowsRuntimeChecks(platform, opts, version = null) also takes the probed Codex version.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const RELAY = join(REPO, "skills", "codex-delegate", "scripts", "relay.mjs");
const RELAY_URL = pathToFileURL(RELAY).href;
const FIXTURES = join(HERE, "fixtures", "codex-isolation");
const DRIVER = join(FIXTURES, "relay-driver.mjs");
const IS_WIN = process.platform === "win32";
const WIN_ONLY = IS_WIN ? false : "Windows-only behaviour";
const POSIX_ONLY = IS_WIN ? "POSIX-only behaviour (real signals / launch errors)" : false;
const FAKE_VERSION = "codex-cli 0.0.0-fake-relay-test";
const OWNED_MARKER = ".relay-test-owned";
const NODE_DIR = dirname(process.execPath);
const SYSTEM32 = IS_WIN ? join(process.env.SystemRoot || "C:\\Windows", "System32") : null;

// ---------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(check, { timeoutMs = 20_000, intervalMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function samePath(a, b) {
  const norm = (p) => {
    let real;
    try { real = realpathSync.native(p); } catch { real = resolve(p); }
    return IS_WIN ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/** Remove a directory only if this test run created it (marker file + temp parent + prefix). */
function removeOwned(root, token) {
  try {
    const marker = join(root, OWNED_MARKER);
    if (!basename(root).startsWith("relay-test-")) return;
    if (!resolve(root).startsWith(resolve(tmpdir()))) return;
    if (readFileSync(marker, "utf8") !== token) return;
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Leaving a temp directory behind is better than deleting something not verified as ours.
  }
}

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** name -> sha256 for every regular file directly inside dir. */
function snapshotDir(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isFile()) out[name] = sha(readFileSync(path));
  }
  return out;
}

const lines = (...parts) => parts.join("\n");

// ---------------------------------------------------------------------------------------------
// Synthetic Codex JSONL events and fake-codex scenario ops
// ---------------------------------------------------------------------------------------------

const ev = {
  thread: (id) => JSON.stringify({ type: "thread.started", thread_id: id }),
  mcp: (type, id, server, tool, status, extra = {}) =>
    JSON.stringify({ type, item: { ...(id === undefined ? {} : { id }), type: "mcp_tool_call", server, tool, status, ...extra } }),
  command: (id, command, output) =>
    JSON.stringify({ type: "item.completed", item: { id, type: "command_execution", command, aggregated_output: output, exit_code: 1, status: "failed" } }),
  message: (id, text) => JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } }),
};
const op = {
  out: (text) => ({ op: "stdout", text }),
  outLines: (...jsonLines) => ({ op: "stdout", text: `${jsonLines.join("\n")}\n` }),
  outBytes: (buffer) => ({ op: "stdout", base64: buffer.toString("base64") }),
  err: (text) => ({ op: "stderr", text }),
  errBytes: (buffer) => ({ op: "stderr", base64: buffer.toString("base64") }),
  filler: (text, repeat) => ({ op: "stderr", text, repeat }),
  sleep: (ms) => ({ op: "sleep", ms }),
  final: (text) => ({ op: "final", text }),
  marker: (name) => ({ op: "marker", name }),
  wait: (name, maxMs) => ({ op: "wait", name, maxMs }),
  hang: () => ({ op: "hang" }),
};

// ---------------------------------------------------------------------------------------------
// Fixture: private bin / home / config / work / output directories + the relay launcher
// ---------------------------------------------------------------------------------------------

class Fixture {
  constructor({ shim = true } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "relay-test-"));
    this.token = randomBytes(12).toString("hex");
    writeFileSync(join(this.root, OWNED_MARKER), this.token);
    const sub = (name) => {
      const dir = join(this.root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    this.bin = sub("bin");
    this.emptyBin = sub("empty-bin");
    this.codexHome = sub("codex-home");
    this.home = sub("home");
    this.xdg = sub("xdg");
    this.tmp = sub("tmp");
    this.out = sub("out");
    // A distinctive basename: the old default run directory embedded it.
    this.work = sub(`repo-${randomBytes(4).toString("hex")}`);
    this.traceFile = join(this.root, "trace.jsonl");
    this.handles = [];
    this.seq = 0;
    if (shim) this.installShim();
    this.scenario({});
  }

  installShim() {
    copyFileSync(join(FIXTURES, "fake-codex.mjs"), join(this.bin, "fake-codex.mjs"));
    if (IS_WIN) {
      copyFileSync(join(FIXTURES, "codex.cmd"), join(this.bin, "codex.cmd"));
    } else {
      copyFileSync(join(FIXTURES, "codex"), join(this.bin, "codex"));
      chmodSync(join(this.bin, "codex"), 0o755);
    }
  }

  /** scenario({ steps, exitCode, version }) — steps/exitCode describe the `exec` invocation. */
  scenario({ steps = [], exitCode = 0, version = {} } = {}) {
    writeFileSync(join(this.bin, "scenario.json"), JSON.stringify({ version, exec: { steps, exitCode } }));
  }

  config(text, { underHome = false } = {}) {
    const dir = underHome ? join(this.home, ".codex") : this.codexHome;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    writeFileSync(path, text);
    return path;
  }

  get configPath() { return join(this.codexHome, "config.toml"); }

  lanes(lanes) {
    const dir = join(this.xdg, "delegate-skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: "delegate-fleet.v1", lanes }));
  }

  brief(text = "TEST-BRIEF") {
    this.seq += 1;
    const path = join(this.root, `brief-${this.seq}.md`);
    writeFileSync(path, text);
    return path;
  }

  outDir(name) { return join(this.out, name); }
  markerPath(name) { return join(this.bin, name); }
  release() { writeFileSync(this.markerPath("release"), "1"); }

  readJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  invocations() { return this.readJsonl(join(this.bin, "invocations.jsonl")); }
  execInvocations() { return this.invocations().filter((entry) => entry.kind === "exec"); }
  trace() { return this.readJsonl(this.traceFile); }
  traceCount(event) { return this.trace().filter((entry) => entry.event === event).length; }
  configTouches() {
    return this.trace().filter((entry) => typeof entry.event === "string" && entry.event.startsWith("config-")).map((entry) => entry.path);
  }

  /** Allowlisted child environment: no inherited secrets, fixture homes only (plan 7.1). */
  env(extra = {}, { path } = {}) {
    const searchPath = path ?? [this.bin, NODE_DIR, ...(IS_WIN ? [SYSTEM32] : [])];
    const env = {
      PATH: searchPath.join(delimiter),
      CODEX_HOME: this.codexHome,
      HOME: this.home,
      USERPROFILE: this.home,
      APPDATA: join(this.home, "AppData", "Roaming"),
      LOCALAPPDATA: join(this.home, "AppData", "Local"),
      XDG_CONFIG_HOME: this.xdg,
      TMPDIR: this.tmp,
      TEMP: this.tmp,
      TMP: this.tmp,
      RELAY_TEST_TRACE: this.traceFile,
    };
    if (IS_WIN) {
      for (const key of ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  /** Launch the relay driver. Resolves (via .done) with a RunResult; never leaves it unbounded. */
  start(extraArgs = [], opts = {}) {
    const explicitOut = extraArgs.includes("--out-dir");
    const outDir = opts.noOutDir || explicitOut ? null : (opts.outDir ?? this.outDir(`run-${++this.seq}`));
    const args = [DRIVER];
    if (!opts.noBrief) args.push("--brief", opts.briefPath ?? this.brief(opts.brief ?? "TEST-BRIEF"));
    if (!opts.noCd) args.push("--cd", opts.cd ?? this.work);
    if (outDir) args.push("--out-dir", outDir);
    args.push(...extraArgs);
    const child = spawn(process.execPath, args, {
      cwd: this.work,
      env: this.env(opts.env, { path: opts.path }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const started = Date.now();
    const limit = opts.timeoutMs ?? 60_000;
    const handle = { child, pid: child.pid, outDir, exited: false, final: null, kill: (signal = "SIGKILL") => child.kill(signal) };
    handle.done = new Promise((resolveRun, rejectRun) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectRun(new Error(`relay did not exit within ${limit}ms\nargs: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, limit);
      child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        let dir = outDir;
        if (!dir) {
          const match = /^result: (.+)$/m.exec(stdout);
          if (match) dir = dirname(match[1].trim());
        }
        const resultPath = dir ? join(dir, "result.json") : null;
        let result = null;
        if (resultPath && existsSync(resultPath)) {
          try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch { result = null; }
        }
        handle.final = { code, signal, stdout, stderr, outDir: dir, resultPath, result, pid: child.pid, elapsedMs: Date.now() - started };
        handle.exited = true;
        resolveRun(handle.final);
      });
    });
    this.handles.push(handle);
    return handle;
  }

  /** Wait until the fake Codex has created `name`; fail at once, with the relay's output, if the relay exits first. */
  async waitForMarker(handle, name, what) {
    await waitFor(() => existsSync(this.markerPath(name)) || handle.exited, { what });
    if (!existsSync(this.markerPath(name))) {
      const { code, signal, stdout, stderr } = handle.final;
      assert.fail(`the relay exited (code ${code}, signal ${signal}) before ${what}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
  }

  run(extraArgs = [], opts = {}) { return this.start(extraArgs, opts).done; }

  async dispose() {
    for (const handle of this.handles) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
    }
    try { this.release(); } catch { /* directory may already be gone */ }
    // A fake codex that outlived its relay (forced termination) polls for `release`, then exits;
    // wait for it so Windows can delete its working directory. No pid is ever killed here.
    const pids = [...new Set(this.invocations().map((entry) => entry.pid))];
    const deadline = Date.now() + 5000;
    while (pids.some((pid) => isAlive(pid)) && Date.now() < deadline) await sleep(50);
    removeOwned(this.root, this.token);
  }
}

function makeFixture(t, options) {
  const fx = new Fixture(options);
  t.after(() => fx.dispose());
  return fx;
}

// ---------------------------------------------------------------------------------------------
// Assertions shared by the integration tests
// ---------------------------------------------------------------------------------------------

function expectOutcome(run, status, exitCode) {
  assert.ok(run.result, `result.json missing (relay exit ${run.code}, signal ${run.signal})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.result.status, status, `status; stderr:\n${run.stderr}`);
  assert.equal(run.result.exitCode, exitCode, "result.exitCode");
  assert.equal(run.code, exitCode, "relay process exit code must equal result.exitCode");
}

function onlyExec(fx) {
  const execs = fx.execInvocations();
  assert.equal(execs.length, 1, `expected exactly one exec invocation, saw ${execs.length}`);
  return execs[0];
}

function hasSequence(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
}

function warningMatches(result, regex) {
  return result.warnings.filter((warning) => regex.test(warning));
}

/** Every warning must be matched by a distinct expectation, and vice versa (order-free). */
function expectWarnings(result, regexes) {
  assert.ok(Array.isArray(result.warnings), "result.warnings must be an array");
  assert.equal(result.warnings.length, regexes.length, `warnings: ${JSON.stringify(result.warnings)}`);
  const remaining = [...result.warnings];
  for (const regex of regexes) {
    const index = remaining.findIndex((warning) => regex.test(warning));
    assert.notEqual(index, -1, `no warning matching ${regex}: ${JSON.stringify(result.warnings)}`);
    remaining.splice(index, 1);
  }
}

// "must start with a letter or digit" (also accepts begin/begins and an optional article).
const START_WITH_ALNUM = /(?:start|begin)s?\s+with\s+(?:a\s+)?letter\s+or\s+(?:a\s+)?digit/i;

const RE = {
  noModel: /model/i,
  resumeLast: /is global across parallel sessions; prefer --session <threadId>/,
  nodeRepl: /node_repl\.exe/i,
  preflightUnavailable: /preflight unavailable/i,
  configFileMissing: /config/i,
  keyMissing: /sandbox/i,
  mcp: /mcp/i,
};

const NEW_RESULT_FIELDS = [
  "isolated", "disabledFeatures", "windowsSandbox", "warnings", "mcpCalls", "mcpViolation",
  "sandboxFailureReasons", "childExitCode", "watchdogFired", "abortSignal",
];
const LEGACY_RESULT_FIELDS = [
  "schema", "lane", "laneSource", "workdir", "sandbox", "model", "effort", "resumeLast", "session",
  "cleanEnv", "ignoreUserConfig", "keepEnv", "codexVersion", "startedAt", "finishedAt", "briefPath",
  "eventsPath", "finalPath", "stderrPath", "status", "exitCode", "signal", "threadId", "finalMessage",
  "touchedFiles",
];

const WIN_ELEVATED = lines("[windows]", 'sandbox = "elevated"', "");
const BACKEND = IS_WIN ? ["-c", "windows.sandbox=elevated"] : [];
const ISOLATION_GROUP = ["--ignore-user-config", "--disable", "apps", ...BACKEND];

/** Fixture whose Windows config carries the elevated backend (a no-op requirement on POSIX). */
function isolatedFixture(t) {
  const fx = makeFixture(t);
  if (IS_WIN) fx.config(WIN_ELEVATED);
  return fx;
}

// Windows Desktop coexistence (plan 2026-10-17-codex-desktop-coexist.md, section 4 and A5).
// Versions are the one-line `codex --version` outputs; the stable and alpha ones are the measured
// real outputs (A4), the others are the neighbours the plan says must stay "not known fixed".
const VERSION_FIXED = "codex-cli 0.163.0";
const VERSION_FIXED_ALPHA = "codex-cli 0.163.0-alpha.10.2";
const VERSION_OLD = "codex-cli 0.162.1";
const VERSION_UNTESTED_ALPHA = "codex-cli 0.163.0-alpha.10.1";
// A5: without --isolated the Windows backend is not resolved and the null backend would be tested.
const ISOLATED_ARGS = ["--read-only", "--isolated", "--model", "m"];

// Exact warning texts (the Markdown quote marker and formatting are not part of the strings).
const RUNNING_WARNING =
  "node_repl.exe is running: this CLI may predate the Windows Desktop ACL fix. " +
  "Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH. " +
  "If upgrading is unavailable, quit Codex Desktop fully (from the tray) and stop other runs using node_repl.exe.";
const unavailableWarning = (reason) =>
  `process preflight unavailable (${reason}): could not check node_repl.exe. ` +
  "Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH.";

// Exact sandbox failure hint: the shared head, one space, then one of three branches.
const hintHead = (reasons) =>
  `hint: codex's sandbox could not run commands (matched: ${reasons.join(", ")}) — codex may still exit 0, so do not trust this run.`;
const HINT_BRANCH = {
  nonWindows: "Read stderrPath and investigate the sandbox failure before re-dispatching.",
  notAclCause: "The Desktop node_repl.exe ACL conflict is not the likely cause for this version or backend. " +
    "Read stderrPath for other sandbox causes; if failures coincide with parallel elevated dispatches, " +
    "try staggering or serializing them before re-dispatching.",
  mayPredateFix: "This CLI may predate the Windows Desktop ACL fix: run codex update (stable 0.163.0+) or reinstall " +
    "a current stable CLI, check codex --version on PATH, or quit Codex Desktop fully if upgrading is unavailable; " +
    "then read stderrPath.",
};
const expectedHint = (reasons, branch) => `${hintHead(reasons)} ${HINT_BRANCH[branch]}`;
const hintLines = (stdout) => stdout.split(/\r?\n/).filter((line) => line.startsWith("hint:"));

// ---------------------------------------------------------------------------------------------
// Loading relay.mjs for unit tests
//
// The pre-change relay calls main() at import time, which would read stdin and process.exit()
// inside this test process. So the module is imported in-process only after a child process has
// shown the import is side-effect free; otherwise every unit test fails with that reason.
// ---------------------------------------------------------------------------------------------

function probeImport() {
  const root = mkdtempSync(join(tmpdir(), "relay-test-"));
  const token = randomBytes(8).toString("hex");
  writeFileSync(join(root, OWNED_MARKER), token);
  try {
    const sandbox = (name) => { const dir = join(root, name); mkdirSync(dir); return dir; };
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      'import(process.argv[1]).then((m) => console.log("IMPORT_OK " + JSON.stringify(Object.keys(m).sort())), (e) => { console.error(String((e && e.stack) || e)); process.exit(1); });',
      RELAY_URL,
    ], {
      cwd: sandbox("cwd"),
      env: { PATH: NODE_DIR, ...(IS_WIN ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}), TEMP: sandbox("tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"), CODEX_HOME: sandbox("codex-home"), HOME: sandbox("home"), USERPROFILE: join(root, "home") },
      encoding: "utf8",
      timeout: 15_000,
      input: "",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.error?.code === "ETIMEDOUT" };
  } finally {
    removeOwned(root, token);
  }
}

let relay = null;
let relayLoadProblem = null;
{
  const probe = probeImport();
  if (probe.status === 0 && probe.stdout.includes("IMPORT_OK")) {
    relay = await import(RELAY_URL);
  } else {
    relayLoadProblem = `relay.mjs cannot be imported without side effects (plan 4.9): ` +
      `${probe.timedOut ? "import hung" : `exit ${probe.status}`}\n${probe.stderr.trim().split("\n").slice(-3).join("\n")}`;
  }
}

function R() {
  if (relayLoadProblem) assert.fail(relayLoadProblem);
  return relay;
}
function fn(name) {
  const value = R()[name];
  assert.equal(typeof value, "function", `relay.mjs must export function ${name}`);
  return value;
}

// =============================================================================================
// UNIT: exported contract
// =============================================================================================

describe("relay exports (contract)", () => {
  it("exports every function and constant the plan's pure surface needs", () => {
    const mod = R();
    const functions = [
      "main", "buildArgv", "resolveIsolation", "windowsRuntimeChecks", "isValidFeatureName",
      "scanWindowsSandbox", "readWindowsSandboxSetting", "resolveCodexConfigPath", "mapOutcome",
      "createSandboxSignatureScanner", "createEventAccumulator", "checkNodeRepl", "helpTextFrom",
      "hasWindowsDesktopAclFix", "sandboxFailureHint",
    ];
    const missing = functions.filter((name) => typeof mod[name] !== "function");
    for (const name of ["MAX_CONFIG_LINE_BYTES", "CONFIG_READ_CHUNK_BYTES", "MAX_CONFIG_NESTING_DEPTH"]) {
      if (!Number.isSafeInteger(mod[name]) || mod[name] <= 0) missing.push(`${name} (positive integer)`);
    }
    assert.deepEqual(missing, [], "missing or mistyped relay.mjs exports");
  });

  // Review loop 4: the config scanner's value-context tracker is bounded.
  it("exports MAX_CONFIG_NESTING_DEPTH = 256", () => {
    assert.equal(R().MAX_CONFIG_NESTING_DEPTH, 256);
  });
});

// =============================================================================================
// UNIT: buildArgv (plan 4.3)
// =============================================================================================

describe("buildArgv", () => {
  const FINAL = "/o/final.txt";
  const plain = (extra = {}) => ({
    sandbox: "workspace-write", sandboxConfigured: false, session: null, resumeLast: false,
    model: null, effort: null, skipGitRepoCheck: false,
    isolated: false, ignoreUserConfig: false, disabledFeatures: [], windowsSandbox: null, ...extra,
  });
  const iso = (extra = {}) => plain({ isolated: true, ignoreUserConfig: true, disabledFeatures: ["apps"], ...extra });
  const build = (opts, platform = "linux", finalPath = FINAL) => fn("buildArgv")(opts, finalPath, platform);

  it("ordinary fresh execution keeps the legacy argv", () => {
    assert.deepEqual(build(plain()), ["exec", "--json", "-o", FINAL, "-s", "workspace-write", "-"]);
  });

  it("ordinary fresh execution keeps the legacy option order with model, effort and git-check skip", () => {
    const opts = plain({ sandbox: "read-only", sandboxConfigured: true, model: "model-a", effort: "high", skipGitRepoCheck: true });
    assert.deepEqual(build(opts), [
      "exec", "--json", "-o", FINAL, "-s", "read-only", "-m", "model-a",
      "-c", "model_reasoning_effort=high", "--skip-git-repo-check", "-",
    ]);
  });

  it("quotes only the output path, and only on win32; the platform parameter defaults to process.platform", () => {
    assert.deepEqual(build(plain(), "win32", "C:\\a b\\final.txt").slice(0, 4), ["exec", "--json", "-o", '"C:\\a b\\final.txt"']);
    assert.equal(build(plain(), "linux", "/a b/final.txt")[3], "/a b/final.txt");
    assert.equal(build(plain(), "darwin", "/a b/final.txt")[3], "/a b/final.txt");
    assert.deepEqual(fn("buildArgv")(plain(), FINAL), fn("buildArgv")(plain(), FINAL, process.platform));
  });

  it("isolated fresh execution: isolation group directly after exec, then the legacy options", () => {
    assert.deepEqual(build(iso({ sandbox: "read-only", sandboxConfigured: true })), [
      "exec", "--ignore-user-config", "--disable", "apps", "--json", "-o", FINAL, "-s", "read-only", "-",
    ]);
  });

  it("isolated fresh execution on win32 emits the bare backend token as two arguments", () => {
    const opts = iso({ sandbox: "read-only", sandboxConfigured: true, windowsSandbox: "elevated" });
    assert.deepEqual(build(opts, "win32", "C:\\o\\final.txt"), [
      "exec", "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated",
      "--json", "-o", '"C:\\o\\final.txt"', "-s", "read-only", "-",
    ]);
    const unelevated = build(iso({ windowsSandbox: "unelevated" }), "win32");
    assert.ok(hasSequence(unelevated, ["-c", "windows.sandbox=unelevated"]), "an existing unelevated value is preserved");
    assert.ok(!build(iso({ windowsSandbox: null }), "win32").some((token) => token.startsWith("windows.")), "no backend without a configured value");
  });

  it("never emits the Windows backend off win32, even when one was recorded", () => {
    for (const platform of ["linux", "darwin"]) {
      const argv = build(iso({ windowsSandbox: "elevated" }), platform);
      assert.ok(!argv.some((token) => token.startsWith("windows.")), `${platform}: ${argv.join(" ")}`);
      assert.deepEqual(argv.slice(0, 4), ["exec", "--ignore-user-config", "--disable", "apps"]);
    }
  });

  it("isolated fresh execution keeps the group first and the model/effort/skip options after it", () => {
    const opts = iso({ sandbox: "read-only", sandboxConfigured: true, windowsSandbox: "elevated", model: "model-a", effort: "high", skipGitRepoCheck: true });
    assert.deepEqual(build(opts, "win32", "C:\\o\\f.txt"), [
      "exec", "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated",
      "--json", "-o", '"C:\\o\\f.txt"', "-s", "read-only", "-m", "model-a",
      "-c", "model_reasoning_effort=high", "--skip-git-repo-check", "-",
    ]);
  });

  it("emits each feature disable as its own repeatable --disable pair, in the given order", () => {
    const argv = build(iso({ disabledFeatures: ["apps", "web_search", "foo"] }));
    assert.deepEqual(argv, [
      "exec", "--ignore-user-config", "--disable", "apps", "--disable", "web_search", "--disable", "foo",
      "--json", "-o", FINAL, "-s", "workspace-write", "-",
    ]);
  });

  it("passes a feature disable through without isolation, without adding --ignore-user-config or apps", () => {
    assert.deepEqual(build(plain({ disabledFeatures: ["foo"] })), [
      "exec", "--disable", "foo", "--json", "-o", FINAL, "-s", "workspace-write", "-",
    ]);
  });

  it("resume by id: sandbox before resume, whole isolation group after the target, before the final -", () => {
    const opts = iso({ sandbox: "read-only", sandboxConfigured: true, session: "thread-1", windowsSandbox: "elevated" });
    assert.deepEqual(build(opts, "win32", "C:\\o\\final.txt"), [
      "exec", "-s", "read-only", "resume", "thread-1", "--json", "-o", '"C:\\o\\final.txt"',
      "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated", "-",
    ]);
    assert.deepEqual(build(iso({ sandbox: "read-only", sandboxConfigured: true, session: "thread-1" })), [
      "exec", "-s", "read-only", "resume", "thread-1", "--json", "-o", FINAL,
      "--ignore-user-config", "--disable", "apps", "-",
    ]);
  });

  it("resume --last: same placement as resume by id", () => {
    assert.deepEqual(build(iso({ sandbox: "read-only", sandboxConfigured: true, resumeLast: true, windowsSandbox: "elevated" }), "win32", "C:\\o\\final.txt"), [
      "exec", "-s", "read-only", "resume", "--last", "--json", "-o", '"C:\\o\\final.txt"',
      "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated", "-",
    ]);
    assert.deepEqual(build(iso({ sandbox: "read-only", sandboxConfigured: true, resumeLast: true })), [
      "exec", "-s", "read-only", "resume", "--last", "--json", "-o", FINAL,
      "--ignore-user-config", "--disable", "apps", "-",
    ]);
  });

  it("unqualified resume carries no -s; non-isolated resume keeps its legacy argv", () => {
    assert.deepEqual(build(iso({ session: "thread-1" })), [
      "exec", "resume", "thread-1", "--json", "-o", FINAL, "--ignore-user-config", "--disable", "apps", "-",
    ]);
    assert.deepEqual(build(plain({ session: "thread-1" })), ["exec", "resume", "thread-1", "--json", "-o", FINAL, "-"]);
    assert.deepEqual(build(plain({ session: "thread-1", sandboxConfigured: true, sandbox: "read-only" })), [
      "exec", "-s", "read-only", "resume", "thread-1", "--json", "-o", FINAL, "-",
    ]);
  });

  it("resume: backend and effort -c arguments follow the target; nothing leaks into the pre-resume block", () => {
    const opts = iso({
      sandbox: "read-only", sandboxConfigured: true, session: "thread-1", windowsSandbox: "elevated",
      model: "model-a", effort: "high", skipGitRepoCheck: true, disabledFeatures: ["apps", "foo"],
    });
    const argv = build(opts, "win32", "C:\\o\\final.txt");
    const at = argv.indexOf("resume");
    assert.deepEqual(argv.slice(0, at), ["exec", "-s", "read-only"], "pre-resume block");
    assert.equal(argv[at + 1], "thread-1");
    const after = argv.slice(at + 2);
    assert.deepEqual(after.slice(0, 3), ["--json", "-o", '"C:\\o\\final.txt"']);
    assert.equal(argv.at(-1), "-");
    for (const group of [
      ["--ignore-user-config"], ["--disable", "apps"], ["--disable", "foo"], ["-c", "windows.sandbox=elevated"],
      ["-c", "model_reasoning_effort=high"], ["-m", "model-a"], ["--skip-git-repo-check"],
    ]) {
      assert.ok(hasSequence(after, group), `after the resume target: ${group.join(" ")} in ${after.join(" ")}`);
    }
  });

  it("subagent, web search and network -c overrides follow effort, after the resume target and before the isolation group", () => {
    const upstream = {
      model: "model-a", effort: "high", subagentModel: "sub-m", subagentEffort: "low", webSearch: "live", networkAccess: true,
    };
    assert.deepEqual(build(iso({ ...upstream, sandbox: "workspace-write", sandboxConfigured: true, session: "thread-1", windowsSandbox: "elevated" }), "win32", "C:\\o\\final.txt"), [
      "exec", "-s", "workspace-write", "resume", "thread-1", "--json", "-o", '"C:\\o\\final.txt"', "-m", "model-a",
      "-c", "model_reasoning_effort=high", "-c", "agents.default_subagent_model=sub-m",
      "-c", "agents.default_subagent_reasoning_effort=low", "-c", "web_search=live",
      "-c", "sandbox_workspace_write.network_access=true",
      "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated", "-",
    ]);
    assert.deepEqual(build(iso({ ...upstream, windowsSandbox: "elevated" }), "win32", "C:\\o\\final.txt"), [
      "exec", "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=elevated",
      "--json", "-o", '"C:\\o\\final.txt"', "-s", "workspace-write", "-m", "model-a",
      "-c", "model_reasoning_effort=high", "-c", "agents.default_subagent_model=sub-m",
      "-c", "agents.default_subagent_reasoning_effort=low", "-c", "web_search=live",
      "-c", "sandbox_workspace_write.network_access=true", "-",
    ]);
  });

  it("never emits a sandbox_mode override, across every platform / resume / isolation / sandbox combination", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      for (const sandbox of ["read-only", "workspace-write", "danger-full-access"]) {
        for (const configured of [true, false]) {
          for (const mode of ["fresh", "session", "last"]) {
            for (const isolated of [true, false]) {
              const opts = (isolated ? iso : plain)({
                sandbox, sandboxConfigured: configured, windowsSandbox: isolated ? "elevated" : null,
                session: mode === "session" ? "thread-1" : null, resumeLast: mode === "last", model: "m", effort: "high",
              });
              const argv = build(opts, platform);
              const label = `${platform}/${sandbox}/configured=${configured}/${mode}/isolated=${isolated}: ${argv.join(" ")}`;
              assert.ok(!argv.some((token) => /sandbox_mode/.test(token)), `sandbox_mode fallback: ${label}`);
              assert.equal(argv.at(-1), "-", `brief stays on stdin: ${label}`);
              const resumeAt = argv.indexOf("resume");
              const sandboxAt = argv.indexOf("-s");
              if (mode === "fresh") {
                assert.equal(resumeAt, -1, label);
                assert.equal(argv[sandboxAt + 1], sandbox, `fresh always passes -s: ${label}`);
              } else {
                assert.ok(resumeAt > 0, label);
                if (configured) assert.ok(sandboxAt > 0 && sandboxAt < resumeAt && argv[sandboxAt + 1] === sandbox, `-s before resume: ${label}`);
                else assert.equal(sandboxAt, -1, `unqualified resume has no -s: ${label}`);
                const isolationTokens = argv.flatMap((token, i) => (["--ignore-user-config", "--disable"].includes(token) || /^windows\./.test(token) ? [i] : []));
                assert.ok(isolationTokens.every((i) => i > resumeAt + 1), `isolation after the resume target: ${label}`);
                assert.ok(!argv.slice(0, resumeAt).includes("-c"), `no -c before resume: ${label}`);
              }
            }
          }
        }
      }
    }
  });

  it("is pure: does not mutate its options and is deterministic", () => {
    const opts = iso({ sandbox: "read-only", sandboxConfigured: true, session: "t", disabledFeatures: ["apps", "x"], windowsSandbox: "elevated" });
    const before = JSON.stringify(opts);
    const first = build(opts, "win32");
    const second = build(opts, "win32");
    assert.equal(JSON.stringify(opts), before);
    assert.deepEqual(first, second);
  });
});

// =============================================================================================
// UNIT: isolation resolution, Windows gating, feature-name validation (plan 4.1, 4.3, 4.7)
// =============================================================================================

describe("resolveIsolation", () => {
  const cases = [
    // [explicit CLI/lane value, resolved lane is read-only, explicit --ignore-user-config, effective]
    [null, false, false, false],
    [undefined, false, false, false],
    [null, true, false, true],
    [undefined, true, false, true],
    [true, false, false, true],
    [true, true, false, true],
    [false, true, false, false],
    [false, false, false, false],
    [null, false, true, true],
    [false, false, true, true],
    [false, true, true, true],
    [true, false, true, true],
  ];
  for (const [explicit, laneReadOnly, ignoreUserConfig, expected] of cases) {
    it(`explicit=${explicit} laneReadOnly=${laneReadOnly} ignoreUserConfig=${ignoreUserConfig} -> ${expected}`, () => {
      assert.equal(fn("resolveIsolation")({ explicit, laneReadOnly, ignoreUserConfig }), expected);
    });
  }
});

describe("windowsRuntimeChecks", () => {
  const checks = (platform, opts, version) => fn("windowsRuntimeChecks")(platform, opts, version);
  it("non-Windows platforms never read the Windows setting or run the process preflight", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
      assert.deepEqual(checks(platform, { ignoreUserConfig: true, sandbox: "read-only" }), { readSandboxSetting: false, preflight: false }, platform);
    }
  });
  it("win32 reads the setting only when the config is being ignored", () => {
    assert.equal(checks("win32", { ignoreUserConfig: true, sandbox: "read-only" }).readSandboxSetting, true);
    assert.equal(checks("win32", { ignoreUserConfig: false, sandbox: "read-only" }).readSandboxSetting, false);
  });
  it("win32 runs the preflight by default (old, unknown or no version, backend not unelevated) for every sandbox except danger-full-access, isolated or not", () => {
    for (const ignoreUserConfig of [true, false]) {
      assert.equal(checks("win32", { ignoreUserConfig, sandbox: "read-only" }).preflight, true);
      assert.equal(checks("win32", { ignoreUserConfig, sandbox: "workspace-write" }).preflight, true);
      assert.equal(checks("win32", { ignoreUserConfig, sandbox: "danger-full-access" }).preflight, false);
    }
    assert.deepEqual(checks("win32", { ignoreUserConfig: true, sandbox: "danger-full-access" }), { readSandboxSetting: true, preflight: false });

    // Extended matrix (plan 2026-10-17 section 5): the same default holds for every version the relay
    // cannot call fixed, and for every backend that is not resolved to unelevated.
    for (const version of [null, undefined, "unknown", FAKE_VERSION, VERSION_OLD, VERSION_UNTESTED_ALPHA]) {
      for (const windowsSandbox of [undefined, null, "elevated"]) {
        for (const ignoreUserConfig of [true, false]) {
          const label = `version=${inspect(version)} windowsSandbox=${inspect(windowsSandbox)} ignoreUserConfig=${ignoreUserConfig}`;
          assert.equal(checks("win32", { ignoreUserConfig, sandbox: "read-only", windowsSandbox }, version).preflight, true, label);
          assert.equal(checks("win32", { ignoreUserConfig, sandbox: "workspace-write", windowsSandbox }, version).preflight, true, label);
          assert.equal(checks("win32", { ignoreUserConfig, sandbox: "danger-full-access", windowsSandbox }, version).preflight, false, label);
        }
      }
    }
  });

  it("Windows runtime checks apply version and backend gates", () => {
    // Readable spot checks first, one per gate.
    const base = { ignoreUserConfig: true, sandbox: "read-only", windowsSandbox: "elevated" };
    assert.deepEqual(checks("win32", base, VERSION_OLD), { readSandboxSetting: true, preflight: true }, "old + elevated: preflight");
    assert.deepEqual(checks("win32", base, VERSION_FIXED), { readSandboxSetting: true, preflight: false }, "fixed: skipped, setting still read");
    assert.deepEqual(checks("win32", base, VERSION_FIXED_ALPHA), { readSandboxSetting: true, preflight: false }, "the measured alpha counts as fixed");
    assert.deepEqual(checks("win32", base, VERSION_UNTESTED_ALPHA), { readSandboxSetting: true, preflight: true }, "an untested alpha does not");
    assert.deepEqual(checks("win32", { ...base, windowsSandbox: "unelevated" }, VERSION_OLD), { readSandboxSetting: true, preflight: false }, "resolved unelevated: skipped on an old CLI");
    assert.deepEqual(checks("win32", { ...base, windowsSandbox: null }, VERSION_OLD), { readSandboxSetting: true, preflight: true }, "unknown backend stays conservative");
    assert.deepEqual(checks("win32", { ignoreUserConfig: false, sandbox: "workspace-write" }, VERSION_OLD), { readSandboxSetting: false, preflight: true }, "non-isolated, unknown backend, old CLI");
    assert.deepEqual(checks("win32", { ignoreUserConfig: false, sandbox: "workspace-write" }, VERSION_FIXED), { readSandboxSetting: false, preflight: false }, "non-isolated, fixed CLI: skipped, no configuration read");
    assert.deepEqual(checks("linux", base, VERSION_OLD), { readSandboxSetting: false, preflight: false }, "non-Windows never checks");

    // Then the full matrix. Independent of the predicate under test: the known-fixed versions are
    // listed literally.
    const FIXED = [VERSION_FIXED, VERSION_FIXED_ALPHA, "codex-cli 0.163.1", "0.164.0", "1.0.0"];
    const NOT_FIXED = [
      null, undefined, "", "unknown", FAKE_VERSION, VERSION_OLD, VERSION_UNTESTED_ALPHA,
      "codex-cli 0.163.0-rc.1", "0.163.0+build.007",
    ];
    for (const platform of ["win32", "linux", "darwin"]) {
      for (const sandbox of ["read-only", "workspace-write", "danger-full-access", undefined]) {
        for (const windowsSandbox of ["elevated", "unelevated", null, undefined]) {
          for (const version of [...FIXED, ...NOT_FIXED]) {
            for (const ignoreUserConfig of [true, false]) {
              const win = platform === "win32";
              const expected = {
                // The configuration-read rule is unchanged: win32 and a run that ignores user config.
                readSandboxSetting: win && ignoreUserConfig,
                preflight: win && sandbox !== "danger-full-access" && windowsSandbox !== "unelevated" && !FIXED.includes(version),
              };
              const label = `${platform} sandbox=${inspect(sandbox)} windowsSandbox=${inspect(windowsSandbox)} version=${inspect(version)} ignoreUserConfig=${ignoreUserConfig}`;
              assert.deepEqual(checks(platform, { ignoreUserConfig, sandbox, windowsSandbox }, version), expected, label);
            }
          }
        }
      }
    }
  });
});

// =============================================================================================
// UNIT: Windows Desktop ACL fix predicate and sandbox failure hint
// (plan 2026-10-17-codex-desktop-coexist.md, section 4: "Version interpretation", "Exact sandbox failure hint")
// =============================================================================================

describe("hasWindowsDesktopAclFix", () => {
  const fixed = (version) => fn("hasWindowsDesktopAclFix")(version);

  it("Desktop ACL fix accepts supported version output", () => {
    const accepted = [
      // The two measured real outputs, bare and with surrounding whitespace / line endings.
      "codex-cli 0.163.0", "0.163.0", "  codex-cli 0.163.0  ", " \t0.163.0\n ", "codex-cli 0.163.0\n", "codex-cli 0.163.0\r\n",
      // A tab after the prefix, and more than one separator character.
      "codex-cli\t0.163.0", "codex-cli   0.163.0", "codex-cli \t 0.163.0",
      // Later stable cores; components compare numerically, not as strings.
      "0.163.1", "codex-cli 0.163.1", "0.163.12", "0.164.0", "codex-cli 0.164.0", "0.1000.0", "1.0.0", "codex-cli 1.0.0", "10.0.0",
      // The tested Desktop alpha, and only on core 0.163.0.
      "codex-cli 0.163.0-alpha.10.2", "0.163.0-alpha.10.2", "  codex-cli 0.163.0-alpha.10.2\n",
    ];
    for (const input of accepted) assert.equal(fixed(input), true, inspect(input));
  });

  it("Desktop ACL fix rejects unsupported or unknown output", () => {
    const rejected = [
      // Older cores, including the failing 0.162.1 and the default fixture version.
      "0.162.1", "codex-cli 0.162.1", "0.162.999", "0.9.999", "0.0.0", FAKE_VERSION,
      // Prereleases other than the one measured alpha, and the measured alpha on any other core.
      "0.163.0-alpha.10.1", "0.163.0-alpha.10.3", "0.163.0-alpha.10", "0.163.0-alpha.10.20", "0.163.0-alpha.10.2.1",
      "0.163.0-ALPHA.10.2", "0.163.0-alpha", "0.163.0-rc.1", "0.163.0-beta.1", "0.163.0-",
      "0.164.0-alpha.10.2", "0.163.1-alpha.10.2", "0.162.9-alpha.10.2", "1.0.0-alpha.10.2", "codex-cli 0.163.0-alpha.10.1",
      // Build metadata is never known fixed.
      "0.163.0+build.007", "codex-cli 0.163.0+build", "0.163.0-alpha.10.2+build.1", "1.0.0+x",
      // Missing patch, v prefix, alternate or case-changed prefix, no separator, signs.
      "0.163", "codex-cli 0.163", "163", "0.163.", "v0.163.0", "codex-cli v0.163.0", "+0.163.0", "-0.163.0",
      "codex 0.163.0", "Codex-CLI 0.163.0", "CODEX-CLI 0.163.0", "codex-cli: 0.163.0", "codex-cli0.163.0", "codex-cli-0.163.0",
      "codex_cli 0.163.0", "codex-cli\n0.163.0",
      // Extra text or additional output lines.
      "codex-cli 0.163.0 (extra)", "codex-cli 0.163.0 codex-cli 0.163.0", "codex-cli 0.163.0\nextra", "codex-cli 0.163.0\ncodex-cli 0.163.0",
      "warning: noisy\ncodex-cli 0.163.0", "version codex-cli 0.163.0", "codex-cli 0.163.0.", "codex-cli 0.163.0.1", "0.163.0 0.163.0",
      "0.163.0\n0.163.0", "codex-cli 0.163.x", "codex-cli  codex-cli 0.163.0",
      // Unknown, empty and non-version strings.
      "unknown", "", "   ", "\n\t", "codex-cli", "codex-cli ", "not a version",
    ];
    for (const input of rejected) assert.equal(fixed(input), false, inspect(input));

    // Strings only: anything else is false, and never throws (an object that would match if it were
    // coerced or trimmed must not be accepted).
    const wouldMatchIfCoerced = {
      toString() { return "codex-cli 0.163.0"; },
      trim() { return "0.163.0"; },
    };
    const nonStrings = [
      null, undefined, 163, 0.163, NaN, true, false, {}, [], ["codex-cli 0.163.0"], ["0.163.0"],
      wouldMatchIfCoerced, new String("codex-cli 0.163.0"), () => "0.163.0",
    ];
    for (const input of nonStrings) assert.equal(fixed(input), false, inspect(input));
    assert.equal(fn("hasWindowsDesktopAclFix")(), false, "no argument");
  });
});

describe("sandboxFailureHint", () => {
  const hint = (result, platform) => fn("sandboxFailureHint")(result, platform);
  const failed = ({ version = VERSION_OLD, backend = "elevated", sandbox = "read-only", reasons = ["setup refresh had errors"] } = {}) => ({
    status: "sandbox_failed",
    codexVersion: version,
    windowsSandbox: backend,
    sandbox,
    sandboxFailureReasons: reasons,
  });
  const REASON_SETS = [["blocked by policy"], ["setup refresh had errors", "blocked by policy"]];

  it("sandbox failure hint selects every branch independently of host", () => {
    const cases = [];
    const add = (platform, overrides, branch, why) => cases.push({ platform, overrides, branch, why });

    // Branch 1: non-Windows is selected first, whatever the version, backend or sandbox says.
    for (const platform of ["linux", "darwin", "freebsd"]) {
      for (const version of [VERSION_FIXED, VERSION_FIXED_ALPHA, VERSION_OLD, null, "unknown"]) {
        for (const backend of ["elevated", "unelevated", null]) {
          for (const sandbox of ["read-only", "danger-full-access"]) {
            add(platform, { version, backend, sandbox }, "nonWindows", `${platform} version=${inspect(version)} backend=${inspect(backend)} sandbox=${sandbox}`);
          }
        }
      }
    }

    // Branch 2: Windows AND (resolved unelevated OR known-fixed version OR danger-full-access, amendment A3).
    add("win32", { version: VERSION_FIXED, backend: "elevated" }, "notAclCause", "win32 fixed + elevated");
    add("win32", { version: VERSION_FIXED_ALPHA, backend: "elevated" }, "notAclCause", "win32 fixed alpha + elevated");
    add("win32", { version: VERSION_FIXED, backend: null }, "notAclCause", "win32 fixed + unknown backend");
    add("win32", { version: VERSION_FIXED, backend: "unelevated" }, "notAclCause", "win32 fixed + unelevated");
    add("win32", { version: VERSION_OLD, backend: "unelevated" }, "notAclCause", "win32 old + unelevated (branch 2 wins over branch 3)");
    add("win32", { version: null, backend: "unelevated" }, "notAclCause", "win32 null version + unelevated");
    add("win32", { version: "unknown", backend: "unelevated" }, "notAclCause", "win32 unknown version + unelevated");
    add("win32", { version: FAKE_VERSION, backend: "unelevated" }, "notAclCause", "win32 fake version + unelevated");
    add("win32", { version: VERSION_OLD, backend: "elevated", sandbox: "danger-full-access" }, "notAclCause", "win32 old + elevated + danger-full-access (A3)");
    add("win32", { version: VERSION_OLD, backend: null, sandbox: "danger-full-access" }, "notAclCause", "win32 old + unknown backend + danger-full-access (A3)");
    add("win32", { version: null, backend: "elevated", sandbox: "danger-full-access" }, "notAclCause", "win32 null version + elevated + danger-full-access (A3)");

    // Branch 3: the remaining Windows cases.
    add("win32", { version: VERSION_OLD, backend: "elevated", sandbox: "read-only" }, "mayPredateFix", "win32 old + elevated + read-only");
    add("win32", { version: VERSION_OLD, backend: "elevated", sandbox: "workspace-write" }, "mayPredateFix", "win32 old + elevated + workspace-write");
    add("win32", { version: VERSION_OLD, backend: null }, "mayPredateFix", "win32 old + unknown backend");
    add("win32", { version: VERSION_UNTESTED_ALPHA, backend: "elevated" }, "mayPredateFix", "win32 untested alpha + elevated");
    add("win32", { version: null, backend: "elevated" }, "mayPredateFix", "win32 null version (failed probe) + elevated");
    add("win32", { version: null, backend: null }, "mayPredateFix", "win32 null version + unknown backend");
    add("win32", { version: "unknown", backend: null }, "mayPredateFix", "win32 unknown version + unknown backend");
    add("win32", { version: FAKE_VERSION, backend: "elevated" }, "mayPredateFix", "win32 fake version + elevated");
    add("win32", { version: VERSION_OLD, backend: "elevated", sandbox: "(Codex config on resume)" }, "mayPredateFix", "win32 old + elevated + unqualified resume (not danger-full-access)");

    for (const { platform, overrides, branch, why } of cases) {
      for (const reasons of REASON_SETS) {
        const result = failed({ ...overrides, reasons });
        const before = JSON.parse(JSON.stringify(result));
        assert.equal(hint(result, platform), expectedHint(reasons, branch), `${why}; reasons=${reasons.join("|")}`);
        assert.deepEqual(result, before, `${why}: the result must not be mutated`);
      }
    }
  });
});

describe("isValidFeatureName", () => {
  const valid = (value) => fn("isValidFeatureName")(value);
  it("accepts the model-token shape", () => {
    for (const name of ["apps", "a", "A1", "web_search", "foo.bar", "foo:bar", "foo/bar", "foo-bar", "1abc", "multi_agent"]) {
      assert.equal(valid(name), true, name);
    }
  });
  it("rejects empty, whitespace, flag-shaped, shell-metacharacter and non-string values", () => {
    const bad = ["", " ", "a b", "a\tb", "a\nb", "apps\n", "-apps", "--apps", ".apps", "_apps", ":x", "/x", "a&b", "a|b", "a;b", "a$b", "a`b",
      'a"b', "a'b", "a%b", "a^b", "a>b", "a<b", "a(b", "a)b", "a*b", "a?b", "a!b", "a\\b", "a=b", "a,b", "ápps"];
    for (const name of bad) assert.equal(valid(name), false, JSON.stringify(name));
    for (const value of [undefined, null, 42, {}, []]) assert.equal(valid(value), false, String(value));
  });
});

// =============================================================================================
// UNIT: Windows sandbox-setting scanner (plan 4.2)
// =============================================================================================

describe("scanWindowsSandbox", () => {
  const scan = (input) => fn("scanWindowsSandbox")(input);
  const t = (...rows) => rows.join("\n");
  const found = (value) => ({ status: "found", value });
  const missing = { status: "missing-key" };
  const pick = (result) => (result.status === "found" ? { status: "found", value: result.value } : { status: result.status });
  // The mention rule's fixed reason. After the first line that holds a multiline delimiter or ends with
  // an array or inline table still open, a later line that mentions windows or sandbox (anywhere, comments
  // and string bodies included) or holds a complete escape (\u + 4 hex digits, \U + 8 or \x + 2; a Windows
  // path such as C:\Users is not one) is invalid, final, naming that line. The reason deliberately keeps
  // the words "follows a multiline string delimiter".
  const MENTION_REASON = /windows or sandbox follows a multiline string delimiter or a multi-line value/;
  /** `(result, label)` check: invalid with the mention reason, ending `(line N)`. */
  const mentionAt = (line) => (result, label) => {
    assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
    assert.match(result.reason, MENTION_REASON, `${label}: ${result.reason}`);
    assert.match(result.reason, new RegExp(`\\(line ${line}\\)$`), `${label}: ${result.reason}`);
  };

  describe("extracts only the supported target", () => {
    const FOUND = {
      "plain table": [t("[windows]", 'sandbox = "elevated"', ""), "elevated"],
      "single-quoted unelevated": [t("[windows]", "sandbox = 'unelevated'", ""), "unelevated"],
      "no trailing newline": [t("[windows]", 'sandbox = "elevated"'), "elevated"],
      "UTF-8 BOM": [`\uFEFF${t("[windows]", 'sandbox = "elevated"', "")}`, "elevated"],
      "CRLF": [t("[windows]", 'sandbox = "unelevated"', "").replace(/\n/g, "\r\n"), "unelevated"],
      "BOM + CRLF + comments": [`\uFEFF# top\r\n\r\n[windows]\r\n# why\r\nsandbox = "elevated" # trailing\r\n`, "elevated"],
      "trailing comment without space": [t("[windows]", 'sandbox = "elevated"#c'), "elevated"],
      "whitespace around =": [t("[windows]", '  sandbox   =   "elevated"   '), "elevated"],
      "tab indent and tight =": [t("[windows]", '\tsandbox="elevated"'), "elevated"],
      "double-quoted table name": [t('["windows"]', 'sandbox = "elevated"'), "elevated"],
      "single-quoted table name": [t("['windows']", 'sandbox = "elevated"'), "elevated"],
      "top-level dotted key": [t('windows.sandbox = "elevated"', 'other = 1'), "elevated"],
      "dotted key with spaces around the dot": [t('windows . sandbox = "elevated"'), "elevated"],
      "dotted key with quoted components": [t('"windows"."sandbox" = "unelevated"'), "unelevated"],
      "dotted key, mixed quoting, tight =": [t(`'windows' . "sandbox"='elevated'`), "elevated"],
      "among unrelated tables and keys": [
        t('model = "x"', "[mcp_servers.docs]", 'command = "y"', "[windows]", "other = 1", 'sandbox = "elevated"', "[profiles.dev]", 'sandbox = "unelevated"'),
        "elevated",
      ],
      "valid target before an unrelated multiline value": [
        t("[windows]", 'sandbox = "elevated"', "[other]", 'note = """', "hello", '"""', ""),
        "elevated",
      ],
      "multiline delimiter only inside a full-line comment": [t('# note = """', "[windows]", 'sandbox = "elevated"'), "elevated"],
      "non-ASCII unrelated content": [t('name = "Ünïcode ✓ 日本"', "[windows]", 'sandbox = "elevated"'), "elevated"],
    };
    for (const [name, [text, value]] of Object.entries(FOUND)) {
      it(`found: ${name}`, () => {
        assert.deepEqual(pick(scan(text)), found(value));
        assert.deepEqual(pick(scan(Buffer.from(text, "utf8"))), found(value), "Buffer input");
      });
    }

    it("found: Buffer with a raw BOM and an invalid-UTF-8 unrelated line", () => {
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('junk = "'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"\n[windows]\nsandbox = "elevated"\n'),
      ]);
      assert.deepEqual(pick(scan(bytes)), found("elevated"));
    });

    it("found: target at EOF after a very long run of unrelated lines", () => {
      const filler = "key = 1\n".repeat(200_000);
      assert.deepEqual(pick(scan(`${filler}[windows]\nsandbox = "elevated"`)), found("elevated"));
    });
  });

  describe("a multiline delimiter outside a value position fails closed", () => {
    const PADDED_WINDOWS = `windows = ${" ".repeat(4097)}{ sandbox = "unelevated" }\n`;
    const PAD = " ".repeat(5000);

    it("invalid: stray delimiter hides a following padded windows assignment", () => {
      const result = scan(`note = invalid """\n${PADDED_WINDOWS}`);
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
    });

    it("invalid: stray delimiter after a valid target does not let the target stand", () => {
      const result = scan(`windows.sandbox = "elevated"\nnote = invalid """\n${PADDED_WINDOWS}`);
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
    });

    // A delimiter that is not in a value position must fail closed whatever precedes it on the line,
    // with or without a valid target earlier in the file.
    const W = `windows = ${" ".repeat(4097)}{ sandbox = "unelevated" }\n`;
    const TARGET = 'windows.sandbox = "elevated"\n';
    const BAD_POSITIONS = {
      "in the key position of an inline table": 'note = { """\n',
      "bare at line start at top level": '"""\n',
      "after an invalid value and a comma at top level": 'note = invalid, """\n',
      "after a second =": 'note = a = """\n',
      "after a complete value": 'note = 1 """\n',
      "after a table header": '[other] """\n',
      "after an array element without a comma": 'note = [1 """\n',
    };
    for (const [name, delimiterLine] of Object.entries(BAD_POSITIONS)) {
      it(`invalid: a delimiter ${name} hides a padded windows assignment (target absent)`, () => {
        const result = scan(delimiterLine + W);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
      it(`invalid: a delimiter ${name} does not let a present target stand`, () => {
        const result = scan(TARGET + delimiterLine + W);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
    }

    it("invalid: a closed multi-line array does not make a later top-level delimiter look like an element", () => {
      const result = scan(t("arr = [", "1,", "]", '"""', W));
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
    });

    it("invalid: a line-start delimiter after an array element without a comma fails closed", () => {
      const result = scan(t("arr = [", "1", '"""', W));
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
    });

    it("control: a 4097-byte string line inside a valid multiline value stays missing-key", () => {
      assert.deepEqual(pick(scan(`note = """\n${"x".repeat(4097)}\n"""\n`)), missing);
    });

    // Guards: valid TOML keeps its previous classification.
    it("guard: a valid multiline value still scans as before", () => {
      const result = scan(t('note = """', "abc", '"""', "[windows]", 'sandbox = "elevated"', ""));
      // The existing sawMultiline rule already makes a sandbox key after any delimiter invalid.
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      assert.match(result.reason, /follows a multiline string delimiter/);
    });

    it("guard: a multi-line array element line starting with a delimiter still scans as before", () => {
      const result = scan(t("arr = [", "'''x'''", '"""y""",', "]", "[windows]", 'sandbox = "unelevated"', ""));
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      // From fix loop 3 the tracker losing its place inside the array (the comma-less element) is reported first.
      assert.match(result.reason, /cannot follow/);
      assert.match(result.reason, /\(line 3\)$/);
    });

    it("guard: inline multiline strings in an array still scan as before", () => {
      const result = scan(t(`a = ["""x""", '''y''']`, 'windows.sandbox = "elevated"', ""));
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      assert.match(result.reason, /follows a multiline string delimiter/);
    });

    const OPENS_IN_VALUE_POSITION = {
      "after =": `note = """\n${PAD}\n"""\n`,
      "after = (literal)": `note = '''\n${PAD}\n'''\n`,
      "after a tight =": `note="""\n${PAD}\n"""\n`,
      "first on a multi-line array element line": `arr = [\n"""\n${PAD}\n""",\n]\n`,
      "indented, first on a multi-line array element line": `arr = [\n  """\n${PAD}\n"""\n]\n`,
      "after [": `a = ["""\n${PAD}\n"""]\n`,
      "after ,": `a = [1, """\n${PAD}\n"""]\n`,
      "after `b =` inside an inline table": `a = {b = """\n${PAD}\n"""}\n`,
      "after `,` inside an inline table": `a = {b = 1, c = """\n${PAD}\n"""}\n`,
      "after `[[` in a nested array": `a = [[ """\n${PAD}\n"""]]\n`,
      "after `[` inside an inline table": `a = {b = [ """\n${PAD}\n"""]}\n`,
      "after `{` inside an array": `a = [{b = """\n${PAD}\n"""}]\n`,
      "after a quoted key": `"k" = """\n${PAD}\n"""\n`,
      "after a dotted key": `a.b = """\n${PAD}\n"""\n`,
      "after a table header": `[t]\nnote = """\n${PAD}\n"""\n`,
      "first on a line after a comma on an earlier array line": `arr = [\n1,\n"""\n${PAD}\n"""\n]\n`,
      "first on a line after a comment and a blank line in an array": `arr = [\n1,\n# comment\n\n"""\n${PAD}\n"""\n]\n`,
      "first on a line after a comment and a blank line following [": `arr = [\n# comment\n\n"""\n${PAD}\n"""\n]\n`,
      "as an array element after a closing delimiter and a comma": `a = ["""x""", """\n${PAD}\n"""]\n`,
      "first on a line after a closing delimiter and a comma on a previous line": `arr = [\n"""x""",\n"""\n${PAD}\n"""\n]\n`,
    };
    for (const [name, text] of Object.entries(OPENS_IN_VALUE_POSITION)) {
      it(`guard: a 5000-byte string line inside a multiline value opened ${name} is still skipped as content`, () => {
        assert.deepEqual(pick(scan(text)), missing);
      });
    }

    // Review loop 2, finding 1: an unterminated single-line string leaves the value position, so a
    // delimiter on a later line is not an array element. Invalid TOML in any case: fail closed.
    const UNTERMINATED = { "literal": "'unterminated", "basic": '"unterminated', "basic ending in a backslash escape": '"unterminated\\' };
    const THIRD_LINES = { '"""': '"""', "'''": "'''" };
    for (const [stringName, openLine] of Object.entries(UNTERMINATED)) {
      for (const [delimName, delimiter] of Object.entries(THIRD_LINES)) {
        const text = `arr = [\n${openLine}\n${delimiter}\n`;
        it(`invalid: an unterminated ${stringName} string in an array then a ${delimName} line hides a padded windows assignment (target absent)`, () => {
          const result = scan(text + W);
          assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        });
        it(`invalid: an unterminated ${stringName} string in an array then a ${delimName} line does not let a present target stand`, () => {
          const result = scan(TARGET + text + W);
          assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        });
      }
    }
    for (const [stringName, openLine] of Object.entries({ "literal": "note = 'unterminated", "basic": 'note = "unterminated' })) {
      it(`invalid: an unterminated ${stringName} string value then a delimiter line hides a padded windows assignment (target absent)`, () => {
        const result = scan(`${openLine}\n"""\n${W}`);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
      it(`invalid: an unterminated ${stringName} string value then a delimiter line does not let a present target stand`, () => {
        const result = scan(`${TARGET}${openLine}\n"""\n${W}`);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
    }

    // Review loop 2, finding 2: a long comment is comment content. It must not reset the value
    // context, and a delimiter inside it is comment text. With the 1 MiB cap these 5000-byte lines
    // are ordinary lines, parsed like any other.
    const LONG_COMMENT = "c".repeat(5000);
    const LONG_X = "x".repeat(5000);
    const LONG_COMMENT_CASES = {
      "on its own line inside an array": `arr = [\n# ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`,
      "trailing elements on the opening line": `arr = [ 1, 2, # ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`,
      "right after the opening bracket": `arr = [ # ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`,
      "containing a delimiter after 4200 bytes": `arr = [\n# ${"c".repeat(4200)} """ ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`,
      "containing a literal delimiter after 4200 bytes": `arr = [\n# ${"c".repeat(4200)} ''' ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`,
    };
    for (const [name, text] of Object.entries(LONG_COMMENT_CASES)) {
      it(`guard: a long comment ${name} keeps the array context (missing-key)`, () => {
        assert.deepEqual(pick(scan(text)), missing);
      });
      it(`guard: a long comment ${name}, then a later [windows] table (present target)`, () => {
        const result = scan(`${text}[windows]\nsandbox = "elevated"\n`);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.match(result.reason, /follows a multiline string delimiter/);
      });
    }

    // A long element line (`1, # <long comment>`) is no longer special: it is an ordinary line that is
    // not a key/value line, so the array context carries on (missing-key), and a sandbox key after the
    // delimiter still hits the sawMultiline rule. (Was: "too long to verify" while the cap was 4 KiB.)
    it("a long trailing comment on an array element line parses normally: missing-key, and a later sandbox key follows a delimiter", () => {
      const text = `arr = [\n1, # ${LONG_COMMENT}\n"""\n${LONG_X}\n""",\n]\n`;
      assert.deepEqual(pick(scan(text)), missing);
      const result = scan(`${text}[windows]\nsandbox = "elevated"\n`);
      assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      assert.match(result.reason, /follows a multiline string delimiter/);
    });

    // Guards: short valid strings and a long single-line string value stay unaffected.
    it("guard: a short valid literal string before a valid long multiline value stays missing-key", () => {
      assert.deepEqual(pick(scan(`note = 'ok'\narr = [\n"""\n${LONG_X}\n""",\n]\n`)), missing);
    });
    it("guard: a short valid basic string with an escaped quote before a valid long multiline value stays missing-key", () => {
      assert.deepEqual(pick(scan(`note = "ok \\" esc"\narr = [\n"""\n${LONG_X}\n""",\n]\n`)), missing);
    });
    it("guard: short valid strings inside an array before a valid long multiline value stay missing-key", () => {
      assert.deepEqual(pick(scan(`arr = [\n'ok',\n"fine \\\\",\n"""\n${LONG_X}\n""",\n]\n`)), missing);
    });
    it("guard: a long single-line string value before a valid long multiline value", () => {
      assert.deepEqual(pick(scan(`note = "${"y".repeat(5000)}"\narr = [\n"""\n${LONG_X}\n""",\n]\n`)), missing);
    });

    // Review loop 3: an array of long multiline strings keeps its array context, so the second
    // element's opening delimiter (after `""", `) is a value, not a stray delimiter. It was invalid
    // while 5000-byte lines were "overlong" and reset the context.
    const ARRAY_OF_LONG = `arr = ["""${LONG_X}\n""", """\n${LONG_X}\n"""]\n`;
    it("an array of long multiline strings is missing-key", () => {
      assert.deepEqual(pick(scan(ARRAY_OF_LONG)), missing);
    });
    it("an array of long multiline strings after a valid target is found: the sawMultiline rule only affects sandbox keys after a delimiter", () => {
      assert.deepEqual(pick(scan(`windows.sandbox = "elevated"\n${ARRAY_OF_LONG}`)), found("elevated"));
      assert.deepEqual(pick(scan(`[windows]\nsandbox = "elevated"\n[other]\n${ARRAY_OF_LONG}`)), found("elevated"));
    });
    it("an array of long multiline strings before a sandbox key is invalid (a sandbox key follows a delimiter)", () => {
      for (const text of [`${ARRAY_OF_LONG}[windows]\nsandbox = "elevated"\n`, `${ARRAY_OF_LONG}windows.sandbox = "elevated"\n`]) {
        const result = scan(text);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.match(result.reason, /follows a multiline string delimiter/);
      }
    });
  });

  // Once a multiline string has been seen, a header-looking line inside the string may have been
  // recorded as a fake section, so the recorded section and kind cannot be trusted. Under the mention
  // rule every later line that mentions windows or sandbox is invalid, final, so a windows inline table
  // after the string, in any spelling of the key and whether or not `sandbox` appears on the line, is
  // invalid at that line. A windows inline table that itself opens the multiline string or does not close
  // on its own line is rejected on its opening line as an inline table (the kept root-windows check).
  describe("an inline table on a windows-capable key after a multiline string delimiter fails closed", () => {
    const VARIANTS = [];
    for (const delim of ['"""', "'''"]) {
      for (const [eolName, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) VARIANTS.push({ label: `${delim} ${eolName}`, delim, eol });
    }
    // A closed multiline string whose body is a header-looking line.
    const fakeString = (delim, header) => [`note = ${delim}`, header, delim];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const INLINE_REASON = /inline table/;

    // Invalid by the mention rule, naming the mentioning line.
    const expectMentionInvalid = (text, label, line) => mentionAt(line)(scan(text), label);
    // `line`, when given, is the 1-based line the verdict must name: the reason ends with `(line N)`.
    const expectInlineTableInvalid = (text, label, line) => {
      const result = scan(text);
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.match(result.reason, INLINE_REASON, `${label}: ${result.reason}`);
      if (line !== undefined) assert.match(result.reason, new RegExp(`\\(line ${line}\\)$`), `${label}: ${result.reason}`);
    };

    // Red 1: the repro. The windows line comes after the string, the target is absent.
    for (const { label, delim, eol } of VARIANTS) {
      it(`invalid: a fake [other] header in a string, then windows = { sandbox = ... } (target absent) [${label}]`, () => {
        expectMentionInvalid(doc(eol, ...fakeString(delim, "[other]"), 'windows = { sandbox = "unelevated" }'), label, 4);
      });
    }

    // Red 2: the same with a valid dotted target before the string. It must not stand.
    for (const { label, delim, eol } of VARIANTS) {
      it(`invalid: a fake [other] header in a string, then windows = { sandbox = ... } after a valid target [${label}]`, () => {
        expectMentionInvalid(doc(eol, TARGET, ...fakeString(delim, "[other]"), 'windows = { sandbox = "unelevated" }'), label, 5);
      });
    }

    // Red 3: other fake headers (an array header makes the recorded kind "array"; a dotted header a deeper section).
    for (const header of ["[[other]]", "[a.b]"]) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a fake ${header} header in a string, then windows = { sandbox = ... } (target absent) [${label}]`, () => {
          expectMentionInvalid(doc(eol, ...fakeString(delim, header), 'windows = { sandbox = "unelevated" }'), `${header} ${label}`, 4);
        });
        it(`invalid: a fake ${header} header in a string, then windows = { sandbox = ... } after a valid target [${label}]`, () => {
          expectMentionInvalid(doc(eol, TARGET, ...fakeString(delim, header), 'windows = { sandbox = "unelevated" }'), `${header} ${label}`, 5);
        });
      }
    }

    // Case 4: an inline table opened on one line and closed on a later one (TOML 1.1 style), after the
    // fake header. The `windows = {` line is line 4 (3 rows of string, then the table); it mentions
    // windows after the multiline string, so the mention rule names it, whether or not a `sandbox` key
    // follows (the mention is on line 4, before any later `sandbox` line).
    const MULTI_LINE_BODY = {
      "a sandbox key inside": 'sandbox = "unelevated"',
      "no sandbox key inside (x = 1)": "x = 1",
    };
    for (const [name, body] of Object.entries(MULTI_LINE_BODY)) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a fake [other] header in a string, then a multi-line windows inline table with ${name} [${label}]`, () => {
          expectMentionInvalid(doc(eol, ...fakeString(delim, "[other]"), "windows = {", body, "}"), `${name} ${label}`, 4);
        });
      }
    }

    // Red 5: a quoted windows key.
    const QUOTED = {
      "double-quoted key": '"windows" = { sandbox = "unelevated" }',
      "single-quoted key": "'windows' = { sandbox = 'unelevated' }",
    };
    for (const [name, line] of Object.entries(QUOTED)) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a fake [other] header in a string, then a ${name} inline table [${label}]`, () => {
          expectMentionInvalid(doc(eol, ...fakeString(delim, "[other]"), line), `${name} ${label}`, 4);
        });
      }
    }

    // Guard: an escaped component may spell `windows` (or `sandbox`), so it is already invalid. Status only.
    for (const { label, delim, eol } of VARIANTS) {
      it(`guard: a fake [other] header in a string, then an escaped-key windows inline table is invalid [${label}]`, () => {
        const result = scan(doc(eol, ...fakeString(delim, "[other]"), '"\\u0077indows" = { sandbox = "unelevated" }'));
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
    }

    // Red 6: nothing about sandbox on the line. The line still mentions windows after the string, so the
    // mention rule makes it invalid on its own, whatever the recorded section says.
    const NO_SANDBOX_TEXT = {
      "windows = { x = 1 }": "windows = { x = 1 }",
      "windows={x=1}": "windows={x=1}",
      "windows = {}": "windows = {}",
      "double-quoted key": '"windows" = { x = 1 }',
      "single-quoted key": "'windows' = { x = 1 }",
    };
    for (const [name, line] of Object.entries(NO_SANDBOX_TEXT)) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a fake [other] header in a string, then \`${name}\` with no sandbox text on the line [${label}]`, () => {
          expectMentionInvalid(doc(eol, ...fakeString(delim, "[other]"), line), `${name} ${label}`, 4);
        });
      }
    }

    // Control: after the same string and fake header a line that does not mention windows or sandbox is unaffected.
    for (const { label, delim, eol } of VARIANTS) {
      it(`control: a fake [other] header in a string, then an inline table on an unrelated key is missing-key [${label}]`, () => {
        const result = scan(doc(eol, ...fakeString(delim, "[other]"), "other = { a = 1 }"));
        assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
      });
    }
    // Changed by the mention rule: these used to be missing-key (windows = 1 and windows.x were not an
    // inline table on the windows key), but any line that mentions windows after a multiline string is invalid.
    const MENTIONS_NOT_INLINE_TABLES = {
      "a non-inline-table value on windows": "windows = 1",
      "an inline table under a dotted windows key (windows.x)": "windows.x = { a = 1 }",
    };
    for (const [name, line] of Object.entries(MENTIONS_NOT_INLINE_TABLES)) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a fake [other] header in a string, then ${name} still mentions windows (line 4) [${label}]`, () => {
          expectMentionInvalid(doc(eol, ...fakeString(delim, "[other]"), line), `${name} ${label}`, 4);
        });
      }
    }

    for (const { label, delim, eol } of VARIANTS) {
      it(`control: a valid target before an unrelated multiline string and an unrelated inline table stays found [${label}]`, () => {
        const text = doc(eol, "[windows]", 'sandbox = "elevated"', "[misc]", `note = ${delim}`, "text", delim, "other = { a = 1 }");
        assert.deepEqual(pick(scan(text)), found("elevated"));
      });
    }

    // Existing behaviour guard: with no multiline string the recorded section is real, so `[other]` then
    // `windows = { ... }` assigns other.windows, which is not the target.
    it("guard: with no multiline string, windows = { a = 1 } under [other] is other.windows and is missing-key", () => {
      for (const eol of ["\n", "\r\n"]) {
        assert.deepEqual(pick(scan(doc(eol, "[other]", "windows = { a = 1 }"))), missing);
      }
    });

    // A multiline string opened inside the windows inline table itself, before any earlier delimiter.
    // Valid TOML. The windows line ends inside the string, so the table does not close on its own line,
    // the header-looking body line is a fake section, and the closing line may carry `sandbox`. No
    // delimiter was seen before the windows line, so the old after-a-delimiter guards do not apply and
    // the verdict must come from the windows line itself: line 1, or line 2 when the target line is
    // prepended. A BOM does not shift line numbers.
    const IN_TABLE_TAILS = {
      "a bare sandbox key after the string": ', x = 1, sandbox = "unelevated" }',
      'a quoted "sandbox" key after the string': ', "sandbox" = "unelevated" }',
    };
    const inTableRows = (delim, tail) => [`windows = { note = ${delim}`, "[other]", `${delim}${tail}`];
    for (const [name, tail] of Object.entries(IN_TABLE_TAILS)) {
      for (const { label, delim, eol } of VARIANTS) {
        it(`invalid: a multiline string opened inside a windows inline table, then ${name} (target absent) [${label}]`, () => {
          expectInlineTableInvalid(doc(eol, ...inTableRows(delim, tail)), `${name} ${label}`, 1);
        });
        it(`invalid: a multiline string opened inside a windows inline table, then ${name}, after a valid target [${label}]`, () => {
          expectInlineTableInvalid(doc(eol, TARGET, ...inTableRows(delim, tail)), `${name} ${label}`, 2);
        });
      }
    }
    for (const { label, delim, eol } of VARIANTS) {
      it(`invalid: a multiline string opened inside a windows inline table, with a UTF-8 BOM before it [${label}]`, () => {
        const text = `﻿${doc(eol, ...inTableRows(delim, IN_TABLE_TAILS["a bare sandbox key after the string"]))}`;
        expectInlineTableInvalid(text, label, 1);
      });
    }

    // A TOML 1.1 inline table that spans lines with no multiline string anywhere: the `windows = {` line
    // does not close its table, so it is invalid on its own (line 1), whether or not a `sandbox` key follows.
    // No delimiter axis here, only LF and CRLF.
    for (const [name, body] of Object.entries(MULTI_LINE_BODY)) {
      for (const [eolName, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
        it(`invalid: a multi-line windows inline table with ${name}, no multiline string anywhere [${eolName}]`, () => {
          expectInlineTableInvalid(doc(eol, "windows = {", body, "}"), `${name} ${eolName}`, 1);
        });
      }
    }

    // Controls for the above, none of which may change with the fix.
    for (const [eolName, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
      it(`control: windows = { x = 1 } alone, closed on its own line, is missing-key [${eolName}]`, () => {
        assert.deepEqual(pick(scan(doc(eol, "windows = { x = 1 }"))), missing);
      });
      it(`control: [other] then a multi-line windows = { x = 1 } is other.windows and is missing-key [${eolName}]`, () => {
        assert.deepEqual(pick(scan(doc(eol, "[other]", "windows = {", "x = 1", "}"))), missing);
      });
    }
    // A multiline string opened inside an inline table on an unrelated key, whose closing line carries
    // `sandbox`. The real paths are other.note and other.sandbox (neither is windows.sandbox), but line 3
    // mentions sandbox after line 1's multiline delimiter, so the mention rule makes it invalid.
    for (const { label, delim, eol } of VARIANTS) {
      it(`invalid: a multiline string opened inside an inline table on an unrelated key, closing line with sandbox, is a mention (line 3) [${label}]`, () => {
        expectMentionInvalid(doc(eol, `other = { note = ${delim}`, "[x]", `${delim}, sandbox = 1 }`), label, 3);
      });
    }
  });

  // A line that starts inside an open array or inline table (the value-context tracker's bracket stack
  // is non-empty) must not be read as a table header or as a key/value line in the recorded section:
  // an array element such as `["other"]` fakes a header, and a key nested in an inline table is
  // attributed to the recorded section. (Fix loop 2 pinned this with a continuation-line skip; the
  // mention rule replaces the skip: such lines only matter when they mention windows or sandbox, and
  // every later line that does is now invalid.) A root `windows = {` that does not close on its own
  // line stays invalid at its opening line.
  describe("a line after an open array or inline table is never read as a header or key (was the continuation-line rule)", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const eachEol = (name, build, check) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => check(scan(doc(eol, ...build)), `${name} ${eolName}`));
      }
    };
    const eachDelimAndEol = (name, build, check) => {
      for (const delim of DELIMS) {
        for (const [eolName, eol] of EOLS) {
          it(`${name} [${delim} ${eolName}]`, () => check(scan(doc(eol, ...build(delim))), `${name} ${delim} ${eolName}`));
        }
      }
    };
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isInvalid = (result, label) => assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);

    // Red 1: an array element that looks like a header, then the windows inline table that opens a
    // multiline string. Line 1 opens a multi-line array, so line 4 (which mentions windows) is a mention.
    // The fake `["other"]` must not hide it.
    eachDelimAndEol(
      'invalid: a fake ["other"] array element, then a windows inline table opening a multiline string (target absent)',
      (d) => ["arr = [", '["other"]', ", 1]", `windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`],
      mentionAt(4),
    );
    eachDelimAndEol(
      'invalid: a fake ["other"] array element, then a windows inline table opening a multiline string, after a valid target',
      (d) => [TARGET, "arr = [", '["other"]', ", 1]", `windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`],
      mentionAt(5),
    );

    // Red 2: an array element that looks like `[windows]` is not a header, but it mentions windows after
    // line 1 opened a multi-line array, so it is a mention (line 2). (Loop 2 had it missing-key: the
    // element was skipped. Before that it read as found/elevated: fail-open.)
    eachEol('invalid: a fake ["windows"] array element after a multi-line array opens mentions windows (line 2)',
      ["arr = [", '["windows"]', ", 1]", 'sandbox = "elevated"'], mentionAt(2));

    // Red 3: a fake header in an array under the real [windows] table cannot hide the real target, and the
    // real target after a multi-line array is a mention (line 5). (Loop 2 had it found/elevated.)
    eachEol('invalid: a fake ["other"] array element under [windows], then a sandbox key, is a mention (line 5)',
      ["[windows]", "arr = [", '["other"]', "]", 'sandbox = "elevated"'], mentionAt(5));

    // Red 4: a key inside an inline table is nested under that key (windows.other.sandbox), not defined in
    // the recorded section; it mentions sandbox after the multi-line inline table opens (line 3). (Loop 2
    // had it missing-key; before that it read as found/elevated.)
    eachEol("invalid: sandbox inside a multi-line inline table under [windows] is a mention (line 3)",
      ["[windows]", "other = {", 'sandbox = "elevated"', "}"], mentionAt(3));

    // Red 5: a `windows = { ... }` nested inside an unrelated inline table is other.windows, not the root
    // windows key, but it mentions windows after the multi-line inline table opens (line 3), so it is a
    // mention. (Loop 2 had it found/elevated.)
    eachEol("invalid: windows = { x = 1 } nested inside a multi-line inline table on an unrelated key is a mention (line 3)",
      [TARGET, "other = {", "windows = { x = 1 }", "}"], mentionAt(3));

    // Red 6: nested array and inline table, a fake `["windows"]` element at the innermost level. It mentions
    // windows after line 1 opened a multi-line array (line 3). (Loop 2 had it missing-key.)
    eachEol('invalid: a fake ["windows"] element inside a nested array and inline table is a mention (line 3)',
      ["a = [", "{ b = [", '["windows"]', "]}", "]", 'sandbox = "elevated"'], mentionAt(3));

    // Control 7, changed by the mention rule: a real [windows] table with an array whose element is the
    // flag --sandbox. `-` is a bare-key character, so `"--sandbox"` is not a whole-token mention; the real
    // sandbox key after the array is (line 5), because line 2 opened a multi-line array. (Loop 2 had it
    // found/elevated; the first mention rule, which matched substrings, named line 3.)
    eachEol("invalid: an array element naming --sandbox is not a mention, so the real sandbox key after the array is (line 5)",
      ["[windows]", "args = [", '"--sandbox",', "]", 'sandbox = "elevated"'], mentionAt(5));

    // Control 8: a non-literal windows.sandbox stays invalid when it spans lines. (The multi-line root
    // `windows = {` / `x = 1` / `}` is pinned in the loop-1 block above.)
    eachEol("control: sandbox = { opened on one line and closed on the next under [windows] is invalid",
      ["[windows]", "sandbox = {", "}"], isInvalid);
    eachEol("control: a multi-line array assigned to windows.sandbox is invalid",
      ["windows.sandbox = [", '"elevated"', "]"], isInvalid);

    // Control 9: an array of multiline strings, then a [windows] header, stays invalid through the
    // delimiter wording of the mention rule (the header is line 4).
    eachDelimAndEol(
      "control: an array of multiline strings, then a [windows] header, is invalid because windows follows a delimiter (line 4)",
      (d) => [`arr = [ ${d}`, "x", `${d} ]`, "[windows]", 'sandbox = "elevated"'],
      mentionAt(4),
    );

    // A bracket that never closes (invalid TOML) must not hide later lines, including a real `[windows]`
    // table. Fail closed: a document that ends with an array or inline table still open (the tracker not
    // "unknown") is invalid. (On the base this read as found/elevated.) When a later line mentions
    // windows or sandbox, the mention rule names that line before the end of the file is reached.
    const isStillOpenInvalid = (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.match(result.reason, /still open/, `${label}: ${result.reason}`);
    };
    eachEol("invalid: an array that never closes hides a later [windows] table, so the header line is a mention (line 2)",
      ["a = [", "[windows]", 'sandbox = "elevated"'], mentionAt(2));
    // Unlike the array above, the `]` of the `[windows]` header on line 2 is a mismatched closer inside
    // the open inline table, so from fix loop 3 the tracker losing its place is reported at that line
    // before the document can end with the table still open.
    eachEol("invalid: an inline table that never closes hides a later [windows] table, so the scan cannot follow the header line",
      ["a = {", "[windows]", 'sandbox = "elevated"'], (result, label) => {
        assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
        assert.match(result.reason, /cannot follow/, `${label}: ${result.reason}`);
        assert.match(result.reason, /\(line 2\)$/, `${label}: ${result.reason}`);
      });
    eachEol("invalid: an array that never closes, with nothing after it, ends with it still open",
      ["a = [", "1,"], isStillOpenInvalid);
    // The same as the first case with no trailing newline: the verdict must not depend on the final EOL.
    for (const [eolName, eol] of EOLS) {
      it(`invalid: an array that never closes hides a later [windows] table, with no trailing newline [${eolName}]`, () => {
        const result = scan(["a = [", "[windows]", 'sandbox = "elevated"'].join(eol));
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
      });
    }

    // Controls, which must not change: closed brackets are fine, a target before the first multi-line
    // value stays found, and an unclosed multiline string at EOF is invalid when a mention follows it.
    eachEol("control: an array that closes on a later line is missing-key", ["a = [", "1,", "]"], isMissing);
    eachEol("control: a valid [windows] target before a closed multi-line array stays found",
      ["[windows]", 'sandbox = "elevated"', "a = [", "1", "]"], isFound);
    eachDelimAndEol(
      "control: an unclosed multiline string at EOF, then a [windows] header, is invalid because windows follows the delimiter (line 2)",
      (d) => [`note = ${d}`, "[windows]", 'sandbox = "elevated"'],
      mentionAt(2),
    );
  });

  // A multiline string that is still open when the file ends. Everything after its opening delimiter is
  // string body, so the scan could classify nothing after it, and a file like that is invalid TOML. Before,
  // the scan ended with the string open and a target above it read as found. The verdict names the last line
  // of the file (the last line scanned, as for an array or inline table still open at the end, so trailing
  // blank lines count and a final line feed adds no line). A string open inside an array or inline table is
  // the innermost open construct, so its reason wins over the bracket's. A verdict that a line already gave
  // (the tracker's, the mention rule's, a duplicate or malformed target) is final and wins over this one.
  describe("a multiline string still open at the end of the file fails closed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const WIN = "[windows]";
    const ELEVATED = 'sandbox = "elevated"';
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `${CANNOT_FOLLOW} (line ${line})`, label);
    };
    const stringOpenAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `a multiline string is still open at the end of the file (line ${line})`, label);
    };
    // One `it` per case and line ending, each run with a final line ending and without one. A row list never
    // ends in an empty row (that would add a line to one form only).
    const each = (name, rows, check) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => check(scan(doc(eol, ...rows)), `${name} ${eolName}`));
        it(`${name}, with no final line ending [${eolName}]`, () => check(scan(rows.join(eol)), `${name} no final EOL ${eolName}`));
      }
    };
    const eachDelim = (name, build, check) => {
      for (const d of DELIMS) {
        for (const [eolName, eol] of EOLS) {
          it(`${name} [${d} ${eolName}]`, () => check(scan(doc(eol, ...build(d))), `${name} ${d} ${eolName}`));
          it(`${name}, with no final line ending [${d} ${eolName}]`, () => check(scan(build(d).join(eol)), `${name} ${d} no final EOL ${eolName}`));
        }
      }
    };

    describe("a string that never closes", () => {
      eachDelim("invalid: a string opened after a valid target, with text on the opening line (line 2)",
        (d) => [TARGET, `a = ${d}unterminated`], stringOpenAt(2));
      eachDelim("invalid: a string opened alone on the last line after a valid target (line 2)",
        (d) => [TARGET, `a = ${d}`], stringOpenAt(2));
      eachDelim("invalid: a string opened after a valid [windows] target (line 3)",
        (d) => [WIN, ELEVATED, `a = ${d}x`], stringOpenAt(3));
      eachDelim("invalid: a string opened alone in the file, with no target (line 1)",
        (d) => [`a = ${d}unterminated`], stringOpenAt(1));
      eachDelim("invalid: the body lines that follow the opening count, the last line is named (line 4)",
        (d) => [TARGET, `a = ${d}`, "body one", "body two"], stringOpenAt(4));
      eachDelim("invalid: a body line that ends with an = is body, not a missing value (line 3)",
        (d) => [TARGET, `a = ${d}`, "b ="], stringOpenAt(3));
      eachDelim("invalid: a second string opened after a closed one on the previous line (line 3)",
        (d) => [TARGET, `a = ${d}x${d}`, `b = ${d}y`], stringOpenAt(3));
      eachDelim("invalid: a string opened after a closed multi-line string (line 5)",
        (d) => [TARGET, `a = ${d}`, "x", d, `b = ${d}`], stringOpenAt(5));

      for (const [eolName, eol] of EOLS) {
        it(`invalid: blank lines after the open string count, a final line feed does not (line 4) [${eolName}]`, () => {
          stringOpenAt(4)(scan(`${TARGET}${eol}a = """${eol}${eol}${eol}`), `blank lines ${eolName}`);
          stringOpenAt(2)(scan(`${TARGET}${eol}a = """${eol}`), `one final line feed ${eolName}`);
        });
        it(`invalid: the reason never echoes the opening line (line 2) [${eolName}]`, () => {
          const result = scan(doc(eol, TARGET, 'a = """CANARY-open-8b3'));
          stringOpenAt(2)(result, `canary ${eolName}`);
          assert.ok(!JSON.stringify(result).includes("CANARY-open-8b3"), `${eolName}: reason leaked configuration content: ${JSON.stringify(result)}`);
        });
      }
    });

    describe("a string that is the innermost open construct wins over the array or inline table", () => {
      eachDelim("invalid: a string opened inside an array on a later line, not the array (line 3)",
        (d) => [TARGET, "a = [", `${d}x`], stringOpenAt(3));
      eachDelim("invalid: a string opened inside an array on the opening line (line 2)",
        (d) => [TARGET, `a = [${d}x`], stringOpenAt(2));
      eachDelim("invalid: a string opened inside an array after an element, with body lines (line 5)",
        (d) => [TARGET, "a = [", "1,", `${d}x`, "body"], stringOpenAt(5));
      eachDelim("invalid: a string opened inside an inline table (line 2)",
        (d) => [TARGET, `a = { b = ${d}x`], stringOpenAt(2));
      eachDelim("invalid: a string opened inside nested brackets (line 4)",
        (d) => [TARGET, "a = [", "{ b = [", `${d}x`], stringOpenAt(4));
    });

    describe("a basic string whose body does not close it", () => {
      // `\"` is an escaped quote, so the `"""` it leaves is only two quotes: the string stays open. A line-ending
      // backslash is an escape too. An odd run of backslashes escapes the quote; an even run does not.
      each('invalid: a body ending with an escaped quote and two more quotes (line 2)', [TARGET, 'a = """x\\"""'], stringOpenAt(2));
      each("invalid: an escaped quote and two more quotes on a body line (line 3)", [TARGET, 'a = """', 'x\\"""'], stringOpenAt(3));
      each("invalid: a body ending with a line-ending backslash (line 2)", [TARGET, 'a = """x\\'], stringOpenAt(2));
      each("invalid: an odd run of backslashes before the quotes (line 2)", [TARGET, 'a = """x\\\\\\"""'], stringOpenAt(2));
    });

    describe("a verdict from an earlier line is final", () => {
      eachDelim("invalid: a missing value before the string is reported, not the open string (line 1)",
        (d) => ["a =", `b = ${d}`], cannotFollowAt(1));
      eachDelim("invalid: trailing content after a complete value is reported, not the open string (line 2)",
        (d) => [TARGET, `x = 1 ${d}`, `a = ${d}open`], cannotFollowAt(2));
      eachDelim("invalid: a mention after the opening is reported, not the open string (line 3)",
        (d) => [TARGET, `a = ${d}x`, "sandbox"], mentionAt(3));
      eachDelim("invalid: a duplicate target is reported, not the open string (line 2)",
        (d) => [TARGET, TARGET, `a = ${d}x`], (result, label) => {
          assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
          assert.equal(result.reason, "windows.sandbox is defined more than once (line 2)", label);
        });
      eachDelim("invalid: a malformed target is reported, not the open string (line 2)",
        (d) => [WIN, "sandbox = nope", `a = ${d}x`], (result, label) => {
          assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
          assert.match(result.reason, /^windows\.sandbox is not a supported literal .* \(line 2\)$/, label);
        });
    });

    describe("valid files keep their result", () => {
      // A string that closes, whatever the last line looks like. The target is above, so no later line may
      // mention windows or sandbox; with no target the result is missing-key.
      eachDelim("found: a string that closes on the last line (no final line ending in the second form)",
        (d) => [TARGET, `a = ${d}x`, `y${d}`], isFound);
      eachDelim("found: a string closed on its own line", (d) => [TARGET, `a = ${d}`, "x", d], isFound);
      eachDelim("found: a one-line string", (d) => [TARGET, `a = ${d}x${d}`], isFound);
      eachDelim("found: a one-line string followed by a comment", (d) => [TARGET, `a = ${d}x${d} # c`], isFound);
      eachDelim("found: two closed strings in a row", (d) => [TARGET, `a = ${d}x${d}`, `b = ${d}y${d}`], isFound);
      eachDelim("found: a closed multi-line string, then a value", (d) => [TARGET, `a = ${d}`, "x", d, "b = 1"], isFound);
      eachDelim("missing-key: a closed multi-line string and no target", (d) => [`a = ${d}`, "x", d], isMissing);
      eachDelim("missing-key: a one-line string and no target", (d) => [`a = ${d}x${d}`], isMissing);

      // A closing delimiter may carry one or two extra quotes, which belong to the string.
      each('found: a basic string closed with an extra quote ("""x"""")', [TARGET, 'a = """x""""'], isFound);
      each("found: a literal string closed with an extra quote ('''x'''')", [TARGET, "a = '''x''''"], isFound);
      each('found: a basic string closed with two extra quotes', [TARGET, 'a = """x"""""'], isFound);
      // An even run of backslashes does not escape the quote; a backslash means nothing in a literal string.
      each("found: an escaped backslash before the closing quotes of a basic string", [TARGET, 'a = """x\\\\"""'], isFound);
      each("found: a backslash before the closing quotes of a literal string", [TARGET, "a = '''x\\'''"], isFound);
      each("found: escaped quotes in the body of a basic string that then closes", [TARGET, 'a = """', 'say \\"hi\\"', '"""'], isFound);
    });
  });

  // The continuation-line rule trusts the value-context tracker's bracket stack. When the tracker loses
  // its place inside an open bracket (a closer that does not match the bracket on top of the stack, or
  // an unterminated single-line string, either of which makes the tracker "unknown" while the stack is
  // non-empty), the lines after it cannot be classified, so the document fails closed at that line
  // instead of letting a later `sandbox` key read as a top-level or `[windows]` key. Closers with an
  // empty stack keep their existing handling; losing the place with no bracket open is pinned in the
  // top-level block below.
  describe("the tracker losing its place inside a bracket fails closed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const each = (name, rows, check) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => check(scan(doc(eol, ...rows)), `${name} ${eolName}`));
      }
    };
    // Invalid, with a reason saying the scan cannot follow the document and ending with `(line N)`.
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.match(result.reason, /cannot follow/, `${label}: ${result.reason}`);
      assert.match(result.reason, new RegExp(`\\(line ${line}\\)$`), `${label}: ${result.reason}`);
    };
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);

    // Red 1-3: an unterminated single-line string inside an open bracket.
    each("invalid: an unterminated string inside an inline table under [windows] hides a later sandbox key (line 3)",
      ["[windows]", "other = {", 'note = "unterminated', 'sandbox = "elevated"', "}"], cannotFollowAt(3));
    each("invalid: an unterminated string inside an array, with nothing after it (line 2)",
      ["a = [", '"unterminated'], cannotFollowAt(2));
    each("invalid: an unterminated string inside an array after a valid target does not let the target stand (line 3)",
      [TARGET, "a = [", '"unterminated'], cannotFollowAt(3));

    // Red 4-5: a closer that does not match the open bracket on top of the stack, on a later line.
    each("invalid: a } closing an open array under [windows] hides a later sandbox key (line 3)",
      ["[windows]", "other = [", "}", 'sandbox = "elevated"', "]"], cannotFollowAt(3));
    each("invalid: a ] closing an open inline table under [windows] hides a later sandbox key (line 3)",
      ["[windows]", "other = {", "]", 'sandbox = "elevated"', "}"], cannotFollowAt(3));

    // Red 6: the mismatch on the same line as the opener, alone and after a valid [windows] target. (Today
    // these are already invalid, because the document ends with the bracket still open, so they are red
    // on the reason: the verdict must name the mismatch, not the end of the file.)
    each("invalid: a } closing an open array on the same line (line 1)", ["a = [ 1 }"], cannotFollowAt(1));
    each("invalid: a ] closing an open inline table on the same line (line 1)", ["a = { b = 1 ]"], cannotFollowAt(1));
    each("invalid: a } closing an open array on the same line, after a valid [windows] target (line 3)",
      ["[windows]", 'sandbox = "elevated"', "a = [ 1 }"], cannotFollowAt(3));
    each("invalid: a ] closing an open inline table on the same line, after a valid [windows] target (line 3)",
      ["[windows]", 'sandbox = "elevated"', "a = { b = 1 ]"], cannotFollowAt(3));

    // Red 7: the same as red 2 with a literal string.
    each("invalid: an unterminated literal string inside an array, with nothing after it (line 2)",
      ["a = [", "'unterminated"], cannotFollowAt(2));

    // Controls 8-10: none of these may change.
    each("control: valid nesting of arrays and inline tables on one line is missing-key",
      ["a = [ [1], { b = 1 } ]"], isMissing);
    each("invalid: a valid multi-line nesting, then a [windows] header, is a mention (line 4; loop 3 had it found)",
      ["a = [", "{ b = [1, 2] },", "]", "[windows]", 'sandbox = "elevated"'], mentionAt(4));
    each("control: closer characters inside strings in an array are missing-key",
      ["a = [ \"}\", ']' ]"], isMissing);
    each("invalid: closer characters in a comment in an array, then a [windows] header, is a mention (line 3; loop 3 had it found)",
      ["a = [ # } ]", "1 ]", "[windows]", 'sandbox = "elevated"'], mentionAt(3));
    each("control: table and array-of-tables headers are unaffected",
      ["[a]", "[[b]]", "[windows]", 'sandbox = "elevated"'], isFound);
    // (The same loss of place with no bracket open is pinned in the top-level block below.)
  });

  // From fix loop 4 the tracker going "unknown" anywhere is final, not only inside a bracket: the lines
  // after a syntax error the tracker cannot follow (an unterminated single-line string, a stray multiline
  // delimiter in a non-value position) cannot be classified either, so the document is invalid at that
  // line. Before, with no bracket open, the scanner skipped the bad line and kept classifying, so a real
  // `[windows]` target after it read as found (and a fake header hid a real target).
  describe("the tracker losing its place at the top level fails closed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const each = (name, rows, check) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => check(scan(doc(eol, ...rows)), `${name} ${eolName}`));
      }
    };
    const eachDelimAndEol = (name, build, check) => {
      for (const delim of ['"""', "'''"]) {
        for (const [eolName, eol] of EOLS) {
          it(`${name} [${delim} ${eolName}]`, () => check(scan(doc(eol, ...build(delim))), `${name} ${delim} ${eolName}`));
        }
      }
    };
    // Invalid, with a reason saying the scan cannot follow the document and ending with `(line N)`.
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.match(result.reason, /cannot follow/, `${label}: ${result.reason}`);
      assert.match(result.reason, new RegExp(`\\(line ${line}\\)$`), `${label}: ${result.reason}`);
    };

    // Red 1: an unterminated string, then a real [windows] table and a nested key. (Today found/elevated.)
    each("invalid: an unterminated string at the top level, then a [windows] table (line 1)",
      ['note = "unterminated', "[windows]", "other = {", 'sandbox = "elevated"', "}"], cannotFollowAt(1));
    // Red 2: an unterminated string, then a fake array-element header and a dotted key. (Today missing-key.)
    each("invalid: an unterminated string at the top level, then a fake array element and a dotted key (line 1)",
      ['note = "unterminated', "arr = [", '["other"]', ", 1]", 'windows.sandbox = "unelevated"'], cannotFollowAt(1));
    // Red 3: the literal-string variant. (Today found/elevated.)
    each("invalid: an unterminated literal string at the top level, then a [windows] table (line 1)",
      ["note = 'unterminated", "[windows]", 'sandbox = "elevated"'], cannotFollowAt(1));
    // The loop-3 control that pinned today's `found` for this, now invalid at its line.
    each("invalid: a top-level unterminated string with no bracket open is final too (line 1)",
      ['note = "unterminated', "[windows]", 'sandbox = "elevated"'], cannotFollowAt(1));
    // Red 5: a stray multiline delimiter after a complete value. Today it is invalid only because the
    // later sandbox key follows a delimiter (reason "follows a multiline string delimiter", line 3); the
    // tracker goes unknown on line 1, so the verdict names line 1.
    eachDelimAndEol("invalid: a stray multiline delimiter after a complete value, then a [windows] table (line 1)",
      (d) => [`note = 1 ${d}`, "[windows]", 'sandbox = "elevated"'], cannotFollowAt(1));
  });

  // A missing value. A line that ends (or reaches a `#` comment) outside any string, with no array or
  // inline table open, while the tracker still expects a value (right after the `=`), is invalid TOML the
  // scan cannot follow: `a =` is not a value, and the lines after it cannot be classified. The verdict is
  // the tracker's cannot-follow reason at that line and, like every tracker verdict, final: a target before
  // or after it, and any later line, does not change it. Before, `windows.sandbox = "elevated"` / `a =` read
  // as found, `a =` before the target hid the gap the same way, and `[windows]` / `sandbox =` was rejected
  // only as "not a supported literal". With an array or inline table open a line ending after the `=` or a
  // comma is legal (the value goes on in the next line), and inside a multiline string body nothing is
  // tracked, so those keep their result.
  describe("a missing value at the end of a line cannot be followed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const WIN = "[windows]";
    const ELEVATED = 'sandbox = "elevated"';
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `${CANNOT_FOLLOW} (line ${line})`, label);
    };
    // One `it` per case and line ending; a case whose gap is its last row also runs with no line ending after it.
    const gap = (name, rows, line) => {
      for (const [eolName, eol] of EOLS) {
        it(`invalid: ${name} (line ${line}) [${eolName}]`, () => cannotFollowAt(line)(scan(doc(eol, ...rows)), `${name} ${eolName}`));
        if (line === rows.length) {
          it(`invalid: ${name} (line ${line}), with no final line ending [${eolName}]`,
            () => cannotFollowAt(line)(scan(rows.join(eol)), `${name} no final EOL ${eolName}`));
        }
      }
    };
    // `rows` where a valid document can put them: after the target (found) and alone (missing-key), with and
    // without a final line ending, and, for rows with no open construct, before [windows] (found).
    const control = (name, rows, { before = false } = {}) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => {
          const builds = { "with a final line ending": (parts) => doc(eol, ...parts), "with no final line ending": (parts) => parts.join(eol) };
          for (const [endName, build] of Object.entries(builds)) {
            isFound(scan(build([TARGET, ...rows])), `${name} ${eolName}, after the target, ${endName}`);
            isMissing(scan(build(rows)), `${name} ${eolName}, no target, ${endName}`);
            if (before) isFound(scan(build([...rows, WIN, ELEVATED])), `${name} ${eolName}, before [windows], ${endName}`);
          }
        });
      }
    };

    describe("the gap after a valid target, or alone", () => {
      gap("a missing value after a valid dotted target", [TARGET, "a ="], 2);
      gap("a missing value after a valid [windows] target", [WIN, ELEVATED, "a ="], 3);
      gap("a missing value alone in the file", ["a ="], 1);
      gap("a missing value with a tight =", [TARGET, "a="], 2);
      gap("a missing value on a quoted key", [TARGET, '"k" ='], 2);
      gap("a missing value on a literal-quoted key", [TARGET, "'k' ="], 2);
      gap("a missing value on a dotted key", [TARGET, "a.b ="], 2);
      gap("a missing value on an indented key", [TARGET, "  \ta ="], 2);
      gap("a missing value followed by a blank line", [TARGET, "a =", ""], 2);
      gap("a missing value followed by a comment line", [TARGET, "a =", "# comment"], 2);

      // Blanks after the = are still a missing value.
      const BLANKS = { "a space": "a = ", "two spaces": "a =  ", "a tab": "a =\t", "spaces and a tab": "a =  \t " };
      for (const [name, row] of Object.entries(BLANKS)) gap(`trailing blanks after the =: ${name}`, [TARGET, row], 2);

      // A comment after the = is not a value either: the line ends at the comment.
      gap("a comment after the =", [TARGET, "a = # comment"], 2);
      gap("a tight comment after the =", [TARGET, "a =# comment"], 2);
      gap("a comment after the =, alone in the file", ["a = # comment"], 1);
      gap("a comment after the =, then a blank line", [TARGET, "a = # comment", ""], 2);

      // After a closed multi-line value the next line starts at a key again, so a gap there is a gap.
      gap("a missing value after a closed multi-line array", [TARGET, "a = [", "1,", "]", "b ="], 5);
      gap("a missing value after a closed multi-line inline table", [TARGET, "a = {", "b = 1", "}", "c ="], 5);
      for (const d of DELIMS) {
        gap(`a missing value after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "b ="], 5);
      }
      for (const [eolName, eol] of EOLS) {
        it(`invalid: a missing value on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`﻿${doc(eol, "a =", TARGET)}`), `BOM ${eolName}`);
        });
      }
    });

    describe("the gap before the target is final", () => {
      gap("a missing value before a valid dotted target", ["a =", TARGET], 1);
      gap("a missing value before a valid [windows] target", ["a =", WIN, ELEVATED], 1);
      gap("a missing value with trailing blanks before a valid target", ["a = ", TARGET], 1);
      gap("a missing value with a comment before a valid target", ["a = # comment", TARGET], 1);
      gap("a missing value, a blank line and a comment before a valid target", ["a =", "", "# comment", TARGET], 1);
      gap("a missing value after other lines, before a valid target", ["b = 1", "[other]", "c =", TARGET], 3);
    });

    describe("the target itself, and a dotted key under another table", () => {
      // The tracker judges the line before the target-literal check, so these no longer read as
      // "windows.sandbox is not a supported literal ...": the reason is the cannot-follow one.
      gap("the target key under [windows] has no value", [WIN, "sandbox ="], 2);
      gap("the target key under [windows] has trailing blanks and no value", [WIN, "sandbox = "], 2);
      gap("the target key under [windows] has a comment and no value", [WIN, "sandbox = # comment"], 2);
      gap("the target key under [windows] has no value, then the real key", [WIN, "sandbox =", ELEVATED], 2);
      gap("the dotted target has no value", ["windows.sandbox ="], 1);
      gap("the dotted target has no value, then the real key", ["windows.sandbox =", TARGET], 1);
      gap("a dotted key under another table has no value", ["[other]", "x.y ="], 2);
      gap("a dotted key under another table has no value, then [windows] and the real key", ["[other]", "x.y =", WIN, ELEVATED], 2);
    });

    describe("the verdict is final and fixed text", () => {
      gap("a later target does not replace it (duplicate)", [TARGET, "a =", TARGET], 2);
      gap("a later malformed target does not replace it", [TARGET, "a =", "windows.sandbox = 'nope'"], 2);
      gap("a later [windows] table and real key do not replace it", [TARGET, "a =", WIN, ELEVATED], 2);
      gap("a later missing value does not replace it", ["a =", "b ="], 1);
      gap("a later multiline delimiter does not replace it", ["a =", 'b = """', "x", '"""'], 1);
      gap("a later trailing-content gap does not replace it", ["a =", "other = 1 x"], 1);
      gap("trailing content on an earlier line keeps its own line over a later missing value", ["other = 1 x", "a ="], 1);
      for (const [eolName, eol] of EOLS) {
        it(`invalid: the reason never echoes the key of the line with the missing value (line 2) [${eolName}]`, () => {
          const result = scan(doc(eol, TARGET, "CANARY-gap-4d2 ="));
          cannotFollowAt(2)(result, `canary ${eolName}`);
          assert.ok(!JSON.stringify(result).includes("CANARY-gap-4d2"), `${eolName}: reason leaked configuration content: ${JSON.stringify(result)}`);
        });
      }
    });

    describe("valid files keep their result", () => {
      // An array or inline table that is open at the end of the line waits for a value legally.
      control("a multi-line array whose lines end waiting for a value", ["a = [", "1,", "2,", "]"]);
      control("a multi-line array that ends a line after a comma and before a value", ["a = [1,", "2]"]);
      control("a multi-line array with a comment line inside it", ["a = [ 1,", "  # comment", "  2 ]"]);
      control("a multi-line array that opens with a comment", ["a = [ # comment", "1 ]"]);
      control("an empty multi-line array", ["a = [", "]"]);
      control("a multi-line array of arrays", ["a = [", "[1, 2],", "[3],", "]"]);
      control("a multi-line inline table", ["a = {", "b = 1,", "}"]);

      // A value on the same line as the =, with or without a comment, and lines that hold no key at all.
      control("a value followed by a comment", ["a = 1 # c"], { before: true });
      control("a string followed by a tight comment", ['a = "x"# c'], { before: true });
      control("an empty basic string", ['a = ""'], { before: true });
      control("an empty literal string", ["a = ''"], { before: true });
      control("a value, then a missing-looking comment", ["a = 1 # b ="], { before: true });
      control("a table header with a comment", ["[other] # c"], { before: true });
      control("empty and comment-only lines", ["", "# c", "   ", "\t# c", ""], { before: true });
      control("a comment that ends with an =", ["# a ="], { before: true });

      // Inside a multiline string nothing is tracked, so a body line that ends with an = is no gap.
      for (const d of DELIMS) {
        control(`a multiline string (${d}) placed after the target`, [`b = ${d}`, "x", d]);
        control(`a multiline string (${d}) whose body has a line that ends with an =`, [`b = ${d}`, "c =", d]);
        control(`a multiline string (${d}) whose body has a line that ends with an = and a blank`, [`b = ${d}`, "c = ", "", d]);
        control(`a multiline string (${d}) whose opening line ends with an =`, [`b = ${d}c =`, "x", d]);
        control(`a multiline string (${d}) closed on its line, followed by a value`, [`b = ${d}x${d}`, "c = 1"]);
      }
    });
  });

  // A key position that is not a key followed by `=`. A key position is the start of a line with no array
  // or inline table open, or the place after `{` or `,` inside an inline table. Once key characters have
  // started there (a bare component, or a quoted one), only blanks, a `.` between components, more of the
  // same component and the `=` may follow on that line. Anything else is invalid TOML the scan cannot
  // follow: a second component with no `.` between (`a b = 1`, `"a"b = 1`), a closer, comma or bracket
  // right after key characters (`x = { a }`), and a `.` with no component before or after it (`.a = 1`,
  // `a..b = 1`, `a. = 1`). So is an `=` with no key before it (`= 5`), and so is a line that ends, or
  // reaches a `#` comment, after key characters with no `=` while no array or inline table is open (`a`,
  // `a.b # c`, `a.`). The verdict is the tracker's cannot-follow reason at that line and, like every
  // tracker verdict, final: a target before or after it, and any later line, does not change it. Before,
  // `windows.sandbox = "elevated"` / `a`, `a b = 1` and `= 5` all read as found (the tracker skipped
  // every character of a key position except the `=`), and a gap before the target hid it the same way.
  describe("a key position that is not a key followed by an = cannot be followed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const WIN = "[windows]";
    const ELEVATED = 'sandbox = "elevated"';
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `${CANNOT_FOLLOW} (line ${line})`, label);
    };
    // One `it` per case and line ending; with `eof`, a case whose gap is its last row also runs with no line
    // ending after it (the last line is then scanned when the file ends).
    const gap = (name, rows, line, eof = false) => {
      for (const [eolName, eol] of EOLS) {
        it(`invalid: ${name} (line ${line}) [${eolName}]`, () => cannotFollowAt(line)(scan(doc(eol, ...rows)), `${name} ${eolName}`));
        if (eof && line === rows.length) {
          it(`invalid: ${name} (line ${line}), with no final line ending [${eolName}]`,
            () => cannotFollowAt(line)(scan(rows.join(eol)), `${name} no final EOL ${eolName}`));
        }
      }
    };
    // A one-line gap in the places a document can hold it: after a valid dotted target, alone in the file, and
    // before the target (the verdict is final, so a gap before the target is the one reported).
    const gapAt = (name, row) => {
      gap(`${name}, after a dotted target`, [TARGET, row], 2);
      gap(`${name}, alone in the file`, [row], 1);
      gap(`${name}, before a dotted target`, [row, TARGET], 1);
    };
    // The same, and also after and before a valid [windows] table target, with and without a final line ending.
    const gapAtFull = (name, row) => {
      gap(`${name}, after a dotted target`, [TARGET, row], 2, true);
      gap(`${name}, alone in the file`, [row], 1, true);
      gap(`${name}, before a dotted target`, [row, TARGET], 1);
      gap(`${name}, after a [windows] target`, [WIN, ELEVATED, row], 3, true);
      gap(`${name}, before a [windows] target`, [row, WIN, ELEVATED], 1);
    };
    // `rows` where a valid document can put them: after the target (found) and alone (missing-key), with and
    // without a final line ending, and, for rows with no open construct, before [windows] (found).
    const control = (name, rows, { before = false } = {}) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => {
          const builds = { "with a final line ending": (parts) => doc(eol, ...parts), "with no final line ending": (parts) => parts.join(eol) };
          for (const [endName, build] of Object.entries(builds)) {
            isFound(scan(build([TARGET, ...rows])), `${name} ${eolName}, after the target, ${endName}`);
            isMissing(scan(build(rows)), `${name} ${eolName}, no target, ${endName}`);
            if (before) isFound(scan(build([...rows, WIN, ELEVATED])), `${name} ${eolName}, before [windows], ${endName}`);
          }
        });
      }
    };

    // Item 1a: the line ends, or reaches a `#` comment, after key characters with no `=`.
    describe("a line that ends, or reaches a comment, after key characters with no =", () => {
      const NO_EQUALS = {
        "a bare key": "a",
        "a bare key, then a comment": "a # c",
        "a bare key, then a tight comment": "a#c",
        "a bare key with blanks around it": "  a  ",
        "a tab-indented bare key": "\ta",
        "a basic-quoted key": '"a"',
        "a literal-quoted key": "'a'",
        "a quoted key, a blank and a comment": '"a" # c',
        "an empty quoted key": '""',
        "a dotted key": "a.b",
        "a three-part dotted key": "a.b.c",
        "a dotted key, then a comment": "a.b # c",
        "a key ending in a dot": "a.",
        "a key ending in a dot after a blank": "a .",
        "a key ending in a dot, then a comment": "a. # c",
        "a dotted key with a quoted first part": '"a".b',
        "a dotted key with a quoted last part": 'a."b"',
        "a key of non-ASCII characters": "ключ",
      };
      for (const [name, row] of Object.entries(NO_EQUALS)) gapAt(name, row);
      for (const name of ["a bare key", "a bare key, then a comment", "a basic-quoted key", "a key ending in a dot", "a dotted key with a quoted first part"]) {
        gapAtFull(`${name} (every place)`, NO_EQUALS[name]);
      }

      for (const [eolName, eol] of EOLS) {
        it(`invalid: a key with no = on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`﻿${doc(eol, "a", TARGET)}`), `BOM ${eolName}`);
        });
        it(`invalid: a key with no = alone on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`﻿${doc(eol, "a")}`), `BOM alone ${eolName}`);
        });
      }

      // The next line starts at a key again after a closed multi-line value, and right after a table header.
      gap("a key with no = after a closed multi-line array", [TARGET, "a = [", "1,", "]", "b"], 5);
      gap("a key with no = after a closed multi-line inline table", [TARGET, "a = {", "b = 1", "}", "c"], 5);
      gap("a key with no = after a one-line multiline string (the string is closed)", [TARGET, 'a = """x"""', "b"], 3);
      for (const d of DELIMS) {
        gap(`a key with no = after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "b"], 5);
        gap(`a dotted key with no = after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "b.c"], 5);
      }
      gap("a key with no = right after a table header", ["[other]", "a"], 2);
      gap("a key with no = right after a [windows] header, before the real key", [WIN, "a", ELEVATED], 2);
      gap("a key with no = right after an array-of-tables header", ["[[other]]", "a"], 2);
      gap("a key with no = after a key and value", ["b = 1", "a"], 2, true);

      // The target's own key with no value, and a key with no = that is just before it or beside it.
      gap("the dotted target key with no =", ["windows.sandbox"], 1, true);
      gap("the dotted target key with no =, then the real key", ["windows.sandbox", TARGET], 1);
      gap("the target key under [windows] with no =", [WIN, "sandbox"], 2, true);
      gap("the target key under [windows] with no =, then the real key", [WIN, "sandbox", ELEVATED], 2);
      gap("a key with no = then a comment line then the real key", ["a", "# comment", TARGET], 1);
    });

    // Item 1a, with an inline table open: a key never spans lines, so a line that ends, or reaches a `#`
    // comment, after key characters with no `=` is a gap at that line in a multi-line inline table too (the
    // key state does not carry over to the next line, and the next line's `=` or `}` is not what is judged).
    // `line` is the line of `rows` that holds the gap (1-based); each case runs in the places a document can
    // hold it: after a dotted target, alone, before it, and after and before a [windows] table target.
    describe("a line that ends, or reaches a comment, after key characters with no =, with an inline table open", () => {
      const gapBlock = (name, rows, line) => {
        gap(`${name}, after a dotted target`, [TARGET, ...rows], line + 1);
        gap(`${name}, alone in the file`, rows, line);
        gap(`${name}, before a dotted target`, [...rows, TARGET], line);
        gap(`${name}, after a [windows] target`, [WIN, ELEVATED, ...rows], line + 2);
        gap(`${name}, before a [windows] target`, [...rows, WIN, ELEVATED], line);
      };

      // The review repros.
      gapBlock("a bare key alone on a line of a multi-line inline table", ["x = {", "a", "}"], 2);
      gapBlock("a bare key and a comment on a line of a multi-line inline table", ["x = {", "a # c", "}"], 2);
      gapBlock("a key ending the opening line, its = on the next line", ["x = { a", "= 1 }"], 1);
      gapBlock("a basic-quoted key alone on a line of a multi-line inline table", ["x = {", '"a"', "}"], 2);
      gapBlock("a dotted key alone on a line of a multi-line inline table", ["x = {", "a.b", "}"], 2);
      gapBlock("a key ending the opening line of an inline table inside an array, its = on the next line", ["x = [ { a", "= 1 } ]"], 1);

      // The same with the other key shapes, a comment shape, blanks, a later line and a deeper table.
      gapBlock("a literal-quoted key alone on a line of a multi-line inline table", ["x = {", "'a'", "}"], 2);
      gapBlock("a three-part dotted key alone on a line of a multi-line inline table", ["x = {", "a.b.c", "}"], 2);
      gapBlock("a key ending in a dot alone on a line of a multi-line inline table", ["x = {", "a.", "}"], 2);
      gapBlock("a key ending in a dot after a blank alone on a line of a multi-line inline table", ["x = {", "a .", "}"], 2);
      gapBlock("a key and a tight comment on a line of a multi-line inline table", ["x = {", "a#c", "}"], 2);
      gapBlock("a key with blanks around it on a line of a multi-line inline table", ["x = {", "  a  ", "}"], 2);
      gapBlock("a tab-indented key on a line of a multi-line inline table", ["x = {", "\ta", "}"], 2);
      gapBlock("a dotted key and a comment on a line of a multi-line inline table", ["x = {", "a.b # c", "}"], 2);
      gapBlock("a key of non-ASCII characters on a line of a multi-line inline table", ["x = {", "ключ", "}"], 2);
      gapBlock("a key after a pair and a comma on the line before it", ["x = {", "a = 1,", "b", "}"], 3);
      gapBlock("a key after a pair and a comma on the opening line", ["x = { a = 1,", "b", "}"], 2);
      gapBlock("a key with no = after a pair on a line of its own", ["x = {", "a = 1,", "b # c", "c = 2", "}"], 3);
      gapBlock("a key alone on a line of a multi-line inline table, with no closer after it", ["x = {", "a"], 2);
      gapBlock("a key ending the opening line, with no line after it", ["x = { a"], 1);
      gapBlock("a key ending the opening line, then a comment", ["x = { a # c", "}"], 1);
      gapBlock("a key ending the line after a nested opener", ["x = { y = {", "a", "} }"], 2);
      gapBlock("a key ending the opening line of a nested inline table", ["x = { y = { a", "= 1 } }"], 1);
      gapBlock("a key alone on a line of a multi-line inline table in a multi-line array", ["x = [", "{", "a", "}", "]"], 3);
      gapBlock("a key ending a line of an inline table in a multi-line array, its = on the next line", ["x = [", "{ a", "= 1 },", "]"], 2);
      gapBlock("a key in the second inline table of a multi-line array", ["x = [", "{ a = 1 },", "{ b", "= 2 }", "]"], 3);
      gapBlock("a quoted key and a comment on a line of a multi-line inline table", ['x = {', '"a" # c', "}"], 2);
      // The end of the file: the last line is scanned when the file ends, with the table still open.
      gap("a key ending the opening line, with no final line ending", [TARGET, "x = { a"], 2, true);
      gap("a key alone on the last line of an open inline table, with no final line ending", [TARGET, "x = {", "a"], 3, true);
      gap("a key and a comment on the last line of an open inline table, with no final line ending", [TARGET, "x = {", "a # c"], 3, true);

      // The verdict is final: nothing after the gap replaces it, and the line is never echoed.
      gap("a later [windows] table and real key do not replace a key with no = in an inline table", [TARGET, "x = {", "a", "}", WIN, ELEVATED], 3);
      gap("a later duplicate target does not replace a key with no = in an inline table", [TARGET, "x = {", "a", "}", TARGET], 3);
      gap("a later gap does not replace a key with no = in an inline table", [TARGET, "x = {", "a", "b c = 1", "}"], 3);
      gap("an earlier trailing-content gap wins over a key with no = in an inline table", [TARGET, "other = 1 x", "x = {", "a", "}"], 2);
      for (const [eolName, eol] of EOLS) {
        it(`invalid: the reason never echoes the key alone on a line of an inline table (line 3) [${eolName}]`, () => {
          const result = scan(doc(eol, TARGET, "x = {", "CANARY-key-open-9f1", "}"));
          cannotFollowAt(3)(result, `canary ${eolName}`);
          assert.ok(!JSON.stringify(result).includes("CANARY-key"), `${eolName}: reason leaked configuration content: ${JSON.stringify(result)}`);
        });
      }

      // Valid TOML that must keep its result: a line may end with an opener, a comma or a value, a closer may
      // stand alone, and comment and blank lines may sit anywhere between the pairs. After the target found,
      // alone missing-key (an open multi-line value, so never before [windows]).
      control("found: a multi-line inline table whose pairs end in a comma", ["x = {", "a = 1,", "b.c = 2", "}"]);
      control("found: a multi-line inline table with a comment line before a pair", ["x = {", "# c", "a = 1", "}"]);
      control("found: a multi-line inline table with a blank line", ["x = {", "", "}"]);
      control("found: a multi-line inline table with a blank line between pairs", ["x = {", "a = 1,", "", "b = 2", "}"]);
      control("found: a multi-line inline table with a whitespace-only line", ["x = {", "   ", "\t", "}"]);
      control("found: a multi-line inline table with comment lines of key-like text", ["x = {", "# a", "  # a b = 1", "a = 1,", "# = 5", "}"]);
      control("found: a multi-line array", ["x = [", "1,", "2", "]"]);
      control("found: a multi-line array of inline tables", ["x = [", "{ a = 1 },", "]"]);
      control("found: a multi-line array with an inline table on lines of its own", ["x = [", "{", "a = 1", "},", "{ b.c = 2 }", "]"]);
      control("found: a multi-line inline table whose opening line ends with a pair and a comma", ["x = { a = 1,", "b = 2 }"]);
      control("found: a multi-line inline table whose last line closes a nested inline table", ["x = { y = {", "a = 1", "}, z = 2 }"]);
      control("found: a multi-line inline table of nested inline tables", ["x = {", "y = {", "a = 1", "},", "z = { b.c = 2 }", "}"]);
      control("found: a multi-line inline table with a comment after the opener", ["x = { # open", "a = 1,", "b = 2 # last", "}"]);
      control("found: a multi-line inline table of dotted, quoted and literal keys", ["x = {", "a.b = 1,", "'c' = 2,", '"d e" = 3', "}"]);
      control("found: a multi-line inline table whose closer stands alone after a trailing comma", ["x = {", "a = 1,", "}"]);
      control("found: a multi-line inline table of non-ASCII keys", ["x = {", "ключ = 1,", "日本語.b = 2", "}"]);
      control("found: a multi-line inline table holding multi-line arrays", ["x = {", "a = [", "1,", "2", "],", "b = 3", "}"]);
      control("found: a multi-line inline table with a one-line array and a value on each line", ["x = {", "a = [1, 2],", "b = { c = 1 }", "}"]);
      control("found: a multi-line array of arrays", ["x = [", "[1, 2],", "[3]", "]"]);
      control("found: an inline table closed on its line, then a key on the next line", ["x = { a = 1 }", "b = 2"]);
      control("found: a multi-line inline table closed, then a dotted key on the next line", ["x = {", "a = 1", "}", "b.c = 2"]);
    });

    // Item 1b: a second key component with no `.` between.
    describe("a second key component with no . between", () => {
      const TWO_PARTS = {
        "two bare words": "a b = 1",
        "a quoted part, then a bare word": '"a" b = 1',
        "a bare word, then a quoted part": 'a "b" = 1',
        "two literal-quoted parts": "'a' 'b' = 1",
        "a literal-quoted part, then a bare word": "'a' b = 1",
        "a dotted key, then a bare word": "a.b c = 1",
        "a quoted part glued to a bare word": '"a"b = 1',
        "a bare word glued to a quoted part": 'a"b" = 1',
        "a literal-quoted part glued to a bare word": "'a'b = 1",
        "three bare words": "a b c = 1",
        "two bare words, with no =": "a b",
        "two bare words, with a tight =": "a b=1",
        "two tab-separated bare words": "a\tb = 1",
        "two bare words spelling the target": 'windows sandbox = "elevated"',
      };
      for (const [name, row] of Object.entries(TWO_PARTS)) gapAt(name, row);
      for (const name of ["two bare words", "a quoted part glued to a bare word", "two bare words spelling the target"]) {
        gapAtFull(`${name} (every place)`, TWO_PARTS[name]);
      }

      const IN_TABLE = {
        "two bare words in an inline table": "x = { a b = 1 }",
        "two bare words after a comma in an inline table": "x = { a = 1, b c = 2 }",
        "a quoted part, then a bare word in an inline table": 'x = { "a" b = 1 }',
        "a dotted key, then a bare word in an inline table": "x = { a.b c = 1 }",
        "a quoted part glued to a bare word in an inline table": "x = { 'a'b = 1 }",
        "two bare words in a nested inline table": "x = { y = { a b = 1 } }",
        "two bare words in an inline table in an array": "x = [ { a b = 1 } ]",
      };
      for (const [name, row] of Object.entries(IN_TABLE)) gapAt(name, row);
      gapAtFull("two bare words in an inline table (every place)", IN_TABLE["two bare words in an inline table"]);

      gap("two bare words on a line of a multi-line inline table", [TARGET, "x = {", "a b = 1", "}"], 3);
      gap("two bare words after a closed multi-line array", [TARGET, "a = [", "1,", "]", "b c = 1"], 5);
      for (const d of DELIMS) {
        gap(`two bare words after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "b c = 1"], 5);
      }
      gap("two bare words right after a table header", ["[other]", "a b = 1"], 2);
      gap("the target's two parts with no dot between, under [windows]", [WIN, 'sandbox sandbox = "elevated"'], 2);
    });

    // Item 1c: a `.` with no component before or after it.
    describe("a . with no component before or after it", () => {
      const DOTS = {
        "a leading dot": ".a = 1",
        "a doubled dot": "a..b = 1",
        "a trailing dot before the =": "a. = 1",
        "a trailing doubled dot": "a.. = 1",
        "a lone dot as the key": ". = 1",
        "a lone dot with a tight =": ".=1",
        "two dots with a blank between": "a . . b = 1",
        "a trailing dot after a quoted part": '"a". = 1',
        "a leading dot before a quoted part": '.\'a\' = 1',
        "a leading dot after blanks": "  .a = 1",
        "a leading dot on a dotted target": '.windows.sandbox = "elevated"',
        "a doubled dot in the target": 'windows..sandbox = "elevated"',
        "a trailing dot after the target key": 'windows.sandbox. = "elevated"',
      };
      for (const [name, row] of Object.entries(DOTS)) gapAt(name, row);
      for (const name of ["a leading dot", "a doubled dot", "a trailing dot before the =", "a doubled dot in the target"]) {
        gapAtFull(`${name} (every place)`, DOTS[name]);
      }

      const IN_TABLE = {
        "a leading dot in an inline table": "x = { .a = 1 }",
        "a doubled dot in an inline table": "x = { a..b = 1 }",
        "a trailing dot before the = in an inline table": "x = { a. = 1 }",
        "a trailing dot after a comma in an inline table": "x = { a = 1, b. = 2 }",
      };
      for (const [name, row] of Object.entries(IN_TABLE)) gapAt(name, row);
      gap("a trailing dot on a line of a multi-line inline table", [TARGET, "x = {", "a. = 1", "}"], 3);
      gap("a leading dot on a line of a multi-line inline table", [TARGET, "x = {", ".a = 1", "}"], 3);
    });

    // Item 1d: a closer, a comma or a bracket right after key characters in a key position.
    describe("a closer, a comma or a bracket right after key characters in a key position", () => {
      const AFTER_KEY = {
        "a } closing an inline table after a key": "x = { a }",
        "a comma after a key in an inline table": "x = { a, b = 1 }",
        "a } after a key ending in a dot": "x = { a. }",
        "a comma after a key, then a } in an inline table": "x = { a, }",
        "a } after a quoted key": 'x = { "a" }',
        "a comma after a literal-quoted key": "x = { 'a', 'b' = 1 }",
        "a } after a value, a comma and a key": "x = { a = 1, b }",
        "a [ after a key in an inline table": "x = { a [b] = 1 }",
        "a { after a key in an inline table": "x = { a { b = 1 } }",
        "a ] after a key in an inline table": "x = { a ] }",
        "a comma after a key at the top level": "a,",
        "a comma after a key at the top level, then a key and value": "a, b = 1",
        "a [ after a key at the top level": "a [b] = 1",
        "a [ right after a key at the top level": "a[b] = 1",
        "a { after a key at the top level": "a { b = 1 }",
        "a } after a key at the top level": "a }",
        "a ] after a key at the top level": "a ]",
        "a ] after a key at the top level, then an =": "a] = 1",
      };
      for (const [name, row] of Object.entries(AFTER_KEY)) gapAt(name, row);
      for (const name of ["a } closing an inline table after a key", "a comma after a key in an inline table", "a } after a key ending in a dot", "a comma after a key at the top level", "a [ after a key at the top level"]) {
        gapAtFull(`${name} (every place)`, AFTER_KEY[name]);
      }
      gap("a } after a key on a line of a multi-line inline table", [TARGET, "x = {", "a }"], 3);
      gap("a comma after a key on a line of a multi-line inline table", [TARGET, "x = {", "a,", "b = 1", "}"], 3);
    });

    // Item 2: an `=` in a key position with no key before it.
    describe("an = with no key before it", () => {
      const NO_KEY = {
        "an = then a number": "= 5",
        "a blank, then an = and a number": " = 5",
        "an = tight against its value": "=5",
        "an = then a string": '= "x"',
        "a tab, then an = and a number": "\t= 5",
        "an = then an array": "= [1, 2]",
        "an = then an inline table": "= { a = 1 }",
        "an = then a comment": "= # c",
        "an = alone": "=",
        "an = naming the target": '= "windows.sandbox"',
        "an = in an inline table": "x = { = 1 }",
        "an = tight against the brace of an inline table": "x = {= 1}",
        "an = after a comma in an inline table": "x = { a = 1, = 2 }",
        "an = with no key in a nested inline table": "x = { y = { = 1 } }",
      };
      for (const [name, row] of Object.entries(NO_KEY)) gapAt(name, row);
      for (const name of ["an = then a number", "a blank, then an = and a number", "an = then a string", "an = in an inline table"]) {
        gapAtFull(`${name} (every place)`, NO_KEY[name]);
      }
      gap("an = with no key on a line of a multi-line inline table", [TARGET, "x = {", "= 1", "}"], 3);
      gap("an = with no key after a closed multi-line array", [TARGET, "a = [", "1,", "]", "= 5"], 5);
      for (const d of DELIMS) {
        gap(`an = with no key after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "= 5"], 5);
      }
      gap("an = with no key right after a table header", ["[other]", "= 5"], 2);
      gap("an = with no key, then the [windows] table and the real key", ["= 5", WIN, ELEVATED], 1);
      for (const [eolName, eol] of EOLS) {
        it(`invalid: an = with no key on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`﻿${doc(eol, "= 5", TARGET)}`), `BOM ${eolName}`);
        });
      }
    });

    // A bare key holds only A-Za-z0-9_- (bytes >= 0x80 stay accepted). Any other ASCII character in a bare
    // key, in a key position, is invalid TOML the scan cannot follow, at that line; a quoted key, a value and a
    // comment may hold any of them.
    describe("a bare key with an ASCII character TOML never allows in it", () => {
      // Every printable ASCII character that is not in A-Za-z0-9_- and has no other meaning in a key position
      // (= . [ ] { } , # " ' and the blank all have one).
      const OFFENDING = ["!", "$", "%", "&", "(", ")", "*", "+", "/", ":", ";", "<", ">", "?", "@", "\\", "^", "`", "|", "~"];
      const SAMPLE = ["+", "/", "$", "!"];
      const gapBlock = (name, rows, line) => {
        gap(`${name}, after a dotted target`, [TARGET, ...rows], line + 1);
        gap(`${name}, alone in the file`, rows, line);
        gap(`${name}, before a dotted target`, [...rows, TARGET], line);
        gap(`${name}, after a [windows] target`, [WIN, ELEVATED, ...rows], line + 2);
        gap(`${name}, before a [windows] target`, [...rows, WIN, ELEVATED], line);
      };

      // The review repros.
      gapAtFull("a + in a bare key", "a+b = 1");
      gapAtFull("a / in a bare key", "a/b = 1");
      gapAtFull("a $ in a bare key", "a$b = 1");

      // Every such character, in the middle of a bare key.
      for (const c of OFFENDING) gapAt(`${JSON.stringify(c)} in the middle of a bare key`, `a${c}b = 1`);

      // As the first character, as the last character before the blank, and alone.
      for (const c of SAMPLE) {
        gapAt(`${JSON.stringify(c)} as the first character of a bare key`, `${c}a = 1`);
        gapAt(`${JSON.stringify(c)} as the last character of a bare key`, `a${c} = 1`);
        gapAt(`${JSON.stringify(c)} as the whole bare key`, `${c} = 1`);
      }

      // After a dot, in a dotted key.
      gapAt("a + at the start of the second part of a dotted key", "a.+b = 1");
      gapAt("a + in the middle of the second part of a dotted key", "a.b+c = 1");

      // Control characters.
      gapAt("a control character U+0001 in a bare key", "a\x01b = 1");
      gapAt("a control character U+007F in a bare key", "a\x7fb = 1");

      // A non-ASCII bare key with an offending ASCII character in it.
      gapAt("a + in a non-ASCII bare key", "клю+ч = 1");

      // Inside an inline table, on one line.
      gapAt("a + in a bare key of an inline table", "x = { a+b = 1 }");
      gapAt("a / in a bare key after a comma in an inline table", "x = { a = 1, b/c = 2 }");
      gapAt("a $ in a bare key of an inline table in an array", "x = [ { a$b = 1 } ]");
      // And on a line of a multi-line inline table.
      gapBlock("a + in a bare key on a line of a multi-line inline table", ["x = {", "a+b = 1", "}"], 2);

      // After a closed multi-line value the next line starts at a key again, and so it does after a header.
      gap("a + in a bare key after a closed multi-line array", [TARGET, "a = [", "1,", "]", "a+b = 1"], 5);
      gap("a + in a bare key after a closed multi-line inline table", [TARGET, "a = {", "b = 1", "}", "a+b = 1"], 5);
      for (const d of DELIMS) {
        gap(`a + in a bare key after a closed multiline string (${d})`, [TARGET, `a = ${d}`, "x", d, "a+b = 1"], 5);
      }
      gap("a + in a bare key right after a table header", ["[other]", "a+b = 1"], 2);
      gap("a + in a bare key right after a [windows] header, before the real key", [WIN, "a+b = 1", ELEVATED], 2);
      gap("a + in a bare key right after an array-of-tables header", ["[[other]]", "a+b = 1"], 2);

      // The first line, after a UTF-8 BOM.
      for (const [eolName, eol] of EOLS) {
        it(`invalid: a + in a bare key on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`\uFEFF${doc(eol, "a+b = 1", TARGET)}`), `BOM ${eolName}`);
        });
        it(`invalid: a + in a bare key alone on the first line, after a UTF-8 BOM (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`\uFEFF${doc(eol, "a+b = 1")}`), `BOM alone ${eolName}`);
        });
      }

      // The value and what follows it do not matter.
      gapAt("a + in a bare key with a tight =", "a+b=1");
      gapAt("a + in a bare key, then a value and a comment", "a+b = 1 # c");
      gapAt("a + in a bare key, then a string value", 'a+b = "x"');

      // The target itself with an offending character in a bare part: neither found nor missing.
      gap("the dotted target with a + at the end of the last part", ['windows.sandbox+ = "elevated"'], 1, true);
      gap("the dotted target with a + at the end of the first part", ['windows+.sandbox = "elevated"'], 1, true);
      gap("the target key under [windows] with a + at its end", [WIN, 'sandbox+ = "elevated"'], 2, true);
      gap("the dotted target with a + in it, then the real target", ['windows.sandbox+ = "elevated"', TARGET], 1);
      gap("the real target, then the dotted target with a + in it", [TARGET, 'windows.sandbox+ = "elevated"'], 2, true);

      // The verdict is final: a later line does not replace it, and the line is never echoed.
      gap("a later duplicate target does not replace a + in a bare key", [TARGET, "a+b = 1", TARGET], 2);
      gap("a later key with no = does not replace a + in a bare key", ["a+b = 1", "c"], 1);
      gap("an earlier gap wins over a + in a bare key", ["a", "b+c = 1"], 1);
      for (const [eolName, eol] of EOLS) {
        it(`invalid: the reason never echoes the key (a + in a bare key, line 2) [${eolName}]`, () => {
          const result = scan(doc(eol, TARGET, "CANARY+key-9f1 = 1"));
          cannotFollowAt(2)(result, `canary ${eolName}`);
          assert.ok(!JSON.stringify(result).includes("CANARY"), `${eolName}: reason leaked configuration content: ${JSON.stringify(result)}`);
        });
      }

      // Quoted keys may hold every one of these characters, in a table header or not.
      control("found: a basic-quoted key with a +", ['"a+b" = 1'], { before: true });
      control("found: a literal-quoted key with a /", ["'a/b' = 1"], { before: true });
      control("found: a basic-quoted key with a $", ['"a$b" = 1'], { before: true });
      control("found: a quoted key with a blank and a +", ['"a b+c" = 1'], { before: true });
      control("found: a dotted key with a quoted first part holding a +", ['"a+b".c = 1'], { before: true });
      control("found: a dotted key with a quoted last part holding a /", ['a."b/c" = 1'], { before: true });
      control("found: a dotted key of a literal part and a quoted part holding a $", [`'x'."y$z" = 1`], { before: true });
      control("found: every offending character in a basic-quoted key", [`"${OFFENDING.join("").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" = 1`], { before: true });
      control("found: every offending character in a literal-quoted key", [`'${OFFENDING.join("")}' = 1`], { before: true });
      control("found: quoted keys with offending characters in an inline table", [`x = { "a+b" = 1, 'c/d'.e = 2 }`], { before: true });
      control("found: quoted keys with offending characters in a multi-line inline table", ["x = {", '"a+b" = 1,', "'c/d'.e = 2", "}"]);

      // Offending characters in values and in comments.
      control("found: a + in a basic string value", ['a = "x+y"'], { before: true });
      control("found: a / in a literal string value", ["a = 'x/y'"], { before: true });
      control("found: a signed number", ["a = +1"], { before: true });
      control("found: an exponent with a sign", ["a = 1e+5"], { before: true });
      control("found: a date-time with an offset", ["a = 1979-05-27T07:32:00+01:00"], { before: true });
      control("found: a + in a comment after a value", ["a = 1 # x+y"], { before: true });
      control("found: a comment that looks like a key with a +", ["# a+b = 1"], { before: true });
      control("found: an indented comment that looks like a key with a /", ["  # a/b = 1"], { before: true });
      control("found: a + in a value of an inline table", ["x = { a = +1, b = 'c/d' }"], { before: true });
      control("found: a + in a value on a line of a multi-line inline table", ["x = {", "a = +1,", 'b = "c/d"', "}"]);

      // Non-ASCII bare keys stay valid.
      control("found: a Cyrillic bare key", ["ключ = 1"], { before: true });
      control("found: a CJK bare key", ["日本語 = 1"], { before: true });

      // Realistic Codex configuration stays found, with the setting first or in a [windows] table, and missing
      // without it. A windows or sandbox mention after a multi-line value is ambiguous by design (the args array
      // of the MCP block), so the [windows] table goes before that block, not after it.
      const CODEX_HEAD = [
        'sandbox_mode = "workspace-write"',
        "",
        "[sandbox_workspace_write]",
        "network_access = false",
        "",
        "[projects.'C:\\Users\\x\\repo']",
        'trust_level = "trusted"',
      ];
      const CODEX_MCP = [
        "[mcp_servers.x]",
        'command = "npx"',
        "args = [",
        '  "-y",',
        '  "pkg@latest",',
        "]",
      ];
      const CODEX = [...CODEX_HEAD, "", ...CODEX_MCP];
      for (const [eolName, eol] of EOLS) {
        it(`found: a realistic Codex configuration, with and without the setting [${eolName}]`, () => {
          const builds = { "with a final line ending": (rows) => doc(eol, ...rows), "with no final line ending": (rows) => rows.join(eol) };
          for (const [endName, build] of Object.entries(builds)) {
            isFound(scan(build([TARGET, ...CODEX])), `top-level windows.sandbox first, ${eolName}, ${endName}`);
            isFound(scan(build([...CODEX_HEAD, "", WIN, ELEVATED, "", ...CODEX_MCP])), `[windows] table before the MCP block, ${eolName}, ${endName}`);
            isMissing(scan(build(CODEX)), `no setting, ${eolName}, ${endName}`);
          }
        });
      }
    });

    describe("the verdict is final and fixed text", () => {
      // Each of these is a key-position gap on line 2 (or 1) that nothing after it may replace.
      gap("a later duplicate target does not replace a key with no =", [TARGET, "a", TARGET], 2);
      gap("a later malformed target does not replace two key parts", [TARGET, "a b = 1", "windows.sandbox = 'nope'"], 2);
      gap("a later [windows] table and real key do not replace an = with no key", [TARGET, "= 5", WIN, ELEVATED], 2);
      gap("a later dot gap does not replace the first gap", ["a", ".b = 1"], 1);
      gap("a later key with no = does not replace the first key with no =", ["a b = 1", "c"], 1);
      gap("a later multiline delimiter does not replace a key with no =", ["a", 'b = """', "x", '"""'], 1);
      gap("a later trailing-content gap does not replace a key with no =", ["a", "other = 1 x"], 1);
      gap("a later key with no = does not replace a missing value", ["a =", "b"], 1);
      gap("a missing value after a key with no = keeps the first line", ["a", "b ="], 1);
      gap("trailing content on an earlier line keeps its own line over a later key with no =", ["other = 1 x", "a"], 1);
      gap("an earlier trailing-content gap wins over a later = with no key", ["other = 1 x", "= 5"], 1);
      for (const d of DELIMS) {
        gap(`a gap in the first line after a closed multiline string (${d}) wins over a later one`, [`a = ${d}`, "x", d, "b c = 1", "d"], 4);
      }
      // The tracker's verdict wins over the mention rule on the same line, and an earlier mention stays.
      gap("a key with no = that names sandbox, after a multi-line array, is the tracker's gap (line 4)",
        ["x = [", "1", "]", "sandbox"], 4);
      gap("an = with no key that names windows, after a multi-line array, is the tracker's gap (line 4)",
        ["x = [", "1", "]", "= windows"], 4);
      gap("two key parts that name windows and sandbox, after a multi-line inline table, are the tracker's gap (line 4)",
        ["x = {", "a = 1", "}", "windows sandbox = 1"], 4);
      for (const d of DELIMS) {
        gap(`a key with no = that names sandbox, after a multiline string (${d}), is the tracker's gap (line 4)`,
          [`note = ${d}`, "text", d, "sandbox"], 4);
      }
      for (const [eolName, eol] of EOLS) {
        it(`invalid: a mention on an earlier line stays the verdict over a later key with no = (line 4) [${eolName}]`, () => {
          mentionAt(4)(scan(doc(eol, "x = [", "1", "]", WIN, "a")), `mention first ${eolName}`);
        });
      }

      // The reason never echoes the key.
      const CANARY = "CANARY-key-9f1";
      const SHAPES = {
        "a bare key with no =": CANARY,
        "a quoted key with no =": `"${CANARY}"`,
        "a dotted key with no =": `${CANARY}.${CANARY}2`,
        "two key parts": `${CANARY} ${CANARY}2 = 1`,
        "a leading dot": `.${CANARY} = 1`,
        "an = with no key, then a value": `= "${CANARY}"`,
        "a key with no = in an inline table": `x = { ${CANARY} }`,
        "two key parts in an inline table": `x = { ${CANARY} b = 1 }`,
        "a non-ASCII key with no =": `ключ-${CANARY}`,
      };
      for (const [name, row] of Object.entries(SHAPES)) {
        for (const [eolName, eol] of EOLS) {
          it(`invalid: the reason never echoes the key (${name}, line 2) [${eolName}]`, () => {
            const result = scan(doc(eol, TARGET, row));
            cannotFollowAt(2)(result, `canary ${name} ${eolName}`);
            assert.ok(!JSON.stringify(result).includes("CANARY-key"), `${eolName}: reason leaked configuration content: ${JSON.stringify(result)}`);
          });
        }
      }
    });

    describe("valid files keep their result", () => {
      // Lines that hold no key at all: blank, whitespace-only and comment lines, including comments that look like gaps.
      const NOISE = ["", "   ", "\t", "# a b", "  # = 5", "# a", "#=", "\t# a . b", "# x = { a }", "#.a"];
      control("blank, whitespace-only and comment lines that look like gaps", NOISE, { before: true });
      for (const [eolName, eol] of EOLS) {
        it(`found: such lines around the target [${eolName}]`, () => {
          isFound(scan(doc(eol, ...NOISE, TARGET, ...NOISE)), `around a dotted target ${eolName}`);
          isFound(scan(doc(eol, ...NOISE, WIN, ...NOISE, ELEVATED, ...NOISE)), `around a [windows] table target ${eolName}`);
          isMissing(scan(doc(eol, ...NOISE)), `no target ${eolName}`);
        });
        it(`found: the same lines around the target, after a UTF-8 BOM [${eolName}]`, () => {
          isFound(scan(`﻿${doc(eol, "# a b", TARGET, "  # = 5")}`), `BOM ${eolName}`);
          isFound(scan(`﻿${doc(eol, "a.b = 1", TARGET)}`), `BOM key ${eolName}`);
          isMissing(scan(`﻿${doc(eol, "a.b = 1")}`), `BOM key, no target ${eolName}`);
        });
      }

      // Table headers keep their handling, however much of a key they look like.
      control("a table header", ["[a]"], { before: true });
      control("a table header with blanks and a dot", ["[ a . b ]"], { before: true });
      control("an array-of-tables header", ["[[a]]"], { before: true });
      control("a table header with a comment", ["[a] # c"], { before: true });
      control("a quoted table header", ["['a'.\"b\"]"], { before: true });
      control("a table header, a key and a value", ["[a]", "b = 1", "[c.d]", "e.f = 2"], { before: true });
      for (const [eolName, eol] of EOLS) {
        it(`found: the [windows] header and the real key, with and without a comment or a final line ending [${eolName}]`, () => {
          isFound(scan(doc(eol, WIN, ELEVATED)), `plain ${eolName}`);
          isFound(scan([WIN, ELEVATED].join(eol)), `no final EOL ${eolName}`);
          isFound(scan(doc(eol, `${WIN} # c`, `${ELEVATED} # c`)), `comments ${eolName}`);
          isFound(scan(doc(eol, "[a]", WIN, ELEVATED, "[b]")), `between other tables ${eolName}`);
        });
      }

      // Dotted, quoted and bare keys of every shape that is valid.
      const KEYS = {
        "a dotted key": "a.b = 1",
        "a dotted key with blanks around the dot": "a . b = 1",
        "a dotted key with a blank before the dot": "a .b=1",
        "a dotted key with a blank after the dot": "a. b=1",
        "a dotted key with a quoted first part": '"a".b = 1',
        "a dotted key with a quoted last part": 'a."b" = 1',
        "a dotted key of literal-quoted parts": "'a'.'b' = 1",
        "a dotted key of mixed quoted parts": `'a' . "b" . c = 1`,
        "a quoted key with a blank inside": '"a b" = 1',
        "a literal-quoted key with a blank inside": "'a b' = 1",
        "a quoted key with a dot inside": '"a.b" = 1',
        "an empty quoted key": '"" = 1',
        "an empty literal-quoted key": "'' = 1",
        "a key with no blanks around the =": "a=1",
        "a key with tabs around the =": "a\t=\t1",
        "a key with blanks before the =": "a   = 1",
        "an indented key": "  a = 1",
        "a key of letters, digits, a dash and an underscore": "a-b_c = 1",
        "an all-digit key": "1234 = 1",
        "a key that starts with a dash": "-a = 1",
        "a key of non-ASCII characters": "ключ = 1",
        "a dotted key of non-ASCII characters": "ключ.ключ2 = 1",
        "a quoted key of non-ASCII characters": '"ключ" = 1',
        "a CJK key": "日本語 = 1",
        "a key that names windows": "windowsx = 1",
        "a key with a value that is a quoted =": 'a = "= 5"',
        "a key with a value that is a quoted dot key": "a = 'b.c'",
        "a value followed by a comment that looks like a gap": "a = 1 # b c = 1",
        "a string value followed by a comment that looks like a gap": 'a = "x y" # = 5',
      };
      for (const [name, row] of Object.entries(KEYS)) control(`found: ${name}`, [row], { before: true });
      control("found: every valid key shape in a row", Object.values(KEYS), { before: true });

      // Arrays and inline tables, on one line and across lines.
      const ONE_LINE = {
        "a one-line array": "x = [1, 2]",
        "an array of inline tables": "x = [ { a = 1 }, { b.c = 2 } ]",
        "an inline table": "x = { a = 1, b.c = 2 }",
        "an inline table with quoted and dotted keys": "x = { \"a b\" = 1, 'c'.d = 2, e . f = 3 }",
        "an inline table with a trailing comma": "x = { a = 1, }",
        "an empty inline table": "x = {}",
        "an empty inline table with a blank": "x = { }",
        "nested inline tables": "x = { a = { b = 1 }, c = { d.e = 2 } }",
        "an inline table with an array": "x = { a = [1, 2], b = [ { c = 1 } ] }",
        "a tight inline table": "x = {a=1,b.c=2}",
        "an inline table with non-ASCII keys": "x = { ключ = 1, 日本語.b = 2 }",
      };
      for (const [name, row] of Object.entries(ONE_LINE)) control(`found: ${name}`, [row], { before: true });
      control("found: a multi-line array", ["x = [", "1,", "2", "]"]);
      control("found: a multi-line array with a trailing comma", ["x = [", "  1,", "  2,", "]"]);
      control("found: a multi-line array of inline tables", ["x = [", "  { a = 1 },", "  { b.c = 2 },", "]"]);
      control("found: a multi-line inline table", ["x = {", "  a = 1,", "  b.c = 2", "}"]);
      control("found: a multi-line inline table, as the first multi-line form pins it", ["a = {", "b = 1,", "}"]);
      control("found: a multi-line inline table with a comment line inside", ["x = {", "# c", "a = 1,", "b = 2", "}"]);
      control("found: a multi-line inline table of dotted and quoted keys", ["x = {", '  "a b" = 1,', "  c.d = 2,", "  'e' = 3", "}"]);
      control("found: a multi-line inline table holding arrays and inline tables", ["x = {", "  a = [1, 2],", "  b = { c = 1 }", "}"]);

      // Multiline strings whose body lines look like the gaps. Nothing in a body is tracked, so these keep
      // today's result: with the target before the string, found; with no target, missing-key.
      for (const d of DELIMS) {
        control(`found: a multiline string (${d}) whose body lines look like gaps`, [`x = ${d}`, "a", "a b = 1", "= 5", d]);
        control(`found: a multiline string (${d}) whose body lines look like dot and closer gaps`, [`x = ${d}`, "a.", ".a = 1", "x = { a }", "a,", d]);
        control(`found: a multiline string (${d}) whose opening line looks like a gap`, [`x = ${d}a b`, "= 5", d]);
        control(`found: a multiline string (${d}) whose closing line looks like a gap`, [`x = ${d}`, `a b = 1 ${d}`]);
        control(`found: a multiline string (${d}) closed on one line, then a valid key`, [`x = ${d}a b = 1${d}`, "a.b = 2"]);
        // With the target after the string, the body lines are not what is reported: the target line is, by the mention rule.
        for (const [eolName, eol] of EOLS) {
          it(`invalid: a multiline string (${d}) with gap-looking body lines, then the target, is the mention at the target (line 6) [${eolName}]`, () => {
            mentionAt(6)(scan(doc(eol, `x = ${d}`, "a", "a b = 1", "= 5", d, TARGET)), `${d} ${eolName}`);
          });
        }
      }

      // A file with none of these gaps and no target is still missing-key.
      control("missing-key: a plain file with no gaps and no target", ["a = 1", "[b]", "c.d = 2", 'e = "x"', "[[f]]", "g = [1, 2]"], { before: true });
      for (const [eolName, eol] of EOLS) {
        it(`missing-key: keys, headers, comments and values, with no target [${eolName}]`, () => {
          isMissing(scan(doc(eol, "# top", "a = 1", "[b]", "c.d = { e = 2 }", "", "[[f]]", 'g = "x"', "h = [ 1, 2 ]  # c")), `no target ${eolName}`);
          isMissing(scan(doc(eol, "sandbox = 1", "windowsx = 2", "[sandbox_workspace_write]", "a = 1")), `near-misses ${eolName}`);
        });
      }
    });
  });

  // The trailing-content rule. Once a value is complete (a quoted string, the close of a multiline string,
  // a closed `]` or `}`, or a bare scalar such as a number, boolean, inf/nan, date or time), only spaces
  // and tabs, a `#` comment, a `,` (while an array or inline table is open) or the closer of the open
  // bracket may follow it. Anything else, `other = [] sandbox = "unelevated"` for one, is invalid TOML the
  // scan cannot follow: the tracker goes unknown, which is final, so the verdict is invalid at the line
  // holding the trailing content and what follows it can no longer pass as a real key. A bare scalar runs
  // over [A-Za-z0-9_+\-.:]; one space continues it only when what came before is exactly a date
  // (YYYY-MM-DD) and a digit follows (a local date-time such as `1979-05-27 07:32:00`). A character that
  // cannot start a value (not whitespace, `#`, a quote, `[`, `{`, or a `]` closing an open array) is not
  // a value either. A table header line keeps its permissive handling. Valid TOML keeps its result.
  describe("trailing content after a complete value", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const WIN = "[windows]";
    const ELEVATED = 'sandbox = "elevated"';
    const UNELEVATED = 'sandbox = "unelevated"';
    // One `it` per case and line ending.
    const each = (name, rows, check) => {
      for (const [eolName, eol] of EOLS) {
        it(`${name} [${eolName}]`, () => check(scan(doc(eol, ...rows)), `${name} ${eolName}`));
      }
    };
    const eachDelim = (name, build, check) => {
      for (const delim of DELIMS) {
        for (const [eolName, eol] of EOLS) {
          it(`${name} [${delim} ${eolName}]`, () => check(scan(doc(eol, ...build(delim))), `${name} ${delim} ${eolName}`));
        }
      }
    };
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    // Invalid with exactly the tracker-lost-its-place reason, naming the line that holds the trailing content.
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `${CANNOT_FOLLOW} (line ${line})`, label);
    };
    const gap = (name, rows, line) => each(`invalid: ${name} (line ${line})`, rows, cannotFollowAt(line));

    describe("anything but a comment, a comma or the closer after a complete value cannot be followed", () => {
      // The headline repro: today found/elevated, so the later sandbox key reads as a real one.
      gap("the headline repro, an empty array then a sandbox assignment under [windows], then the real key",
        [WIN, `other = [] ${UNELEVATED}`, ELEVATED], 2);
      gap("the headline repro without the real key (2 lines)", [WIN, `other = [] ${UNELEVATED}`], 2);
      for (const [eolName, eol] of EOLS) {
        it(`invalid: the 2-line repro with no final line ending (line 2) [${eolName}]`, () => {
          cannotFollowAt(2)(scan([WIN, `other = [] ${UNELEVATED}`].join(eol)), `no final EOL ${eolName}`);
        });
        it(`invalid: the headline repro after a UTF-8 BOM, on the first line (line 1) [${eolName}]`, () => {
          cannotFollowAt(1)(scan(`\uFEFF${doc(eol, `other = [] ${UNELEVATED}`, 'windows.sandbox = "elevated"')}`), `BOM ${eolName}`);
        });
      }

      // The family: every kind of complete value followed by a sandbox assignment (spec "Gap" section).
      const COMPLETE_VALUES = {
        "an empty array": "[]",
        "an empty inline table": "{}",
        "a basic string": '"x"',
        "a literal string": "'x'",
        "an integer": "1",
        "a boolean": "true",
        "a date": "1979-05-27",
        "a local date-time with a space": "1979-05-27 07:32:00",
      };
      for (const [name, value] of Object.entries(COMPLETE_VALUES)) {
        gap(`${name} followed by a sandbox assignment under [windows], then the real key`,
          [WIN, `other = ${value} ${UNELEVATED}`, ELEVATED], 2);
      }

      // The same at the top level, where the trailing text is a dotted windows.sandbox key.
      gap("an integer followed by windows.sandbox at the top level, then the real key",
        ['other = 1 windows.sandbox = "unelevated"', 'windows.sandbox = "elevated"'], 1);
      gap("a basic string followed by windows.sandbox at the top level, then the real key",
        ['other = "x" windows.sandbox = "unelevated"', 'windows.sandbox = "elevated"'], 1);

      // After a multiline string closes.
      eachDelim("invalid: a multiline string's closing line followed by a sandbox assignment (line 2)",
        (d) => [`other = ${d}`, `x${d} ${UNELEVATED}`], cannotFollowAt(2));
      eachDelim("invalid: a multiline string's closing line followed by a sandbox assignment, under [windows] with the real key (line 3)",
        (d) => [WIN, `other = ${d}`, `x${d} ${UNELEVATED}`, ELEVATED], cannotFollowAt(3));
      eachDelim("invalid: a multiline string closed on its own line, then a sandbox assignment (line 1)",
        (d) => [`other = ${d}x${d} ${UNELEVATED}`], cannotFollowAt(1));
      eachDelim("invalid: a multiline string's closing line followed by something that names neither windows nor sandbox (line 3)",
        (d) => [WIN, `other = ${d}`, `x${d} y = 1`, ELEVATED], cannotFollowAt(3));

      // Inside arrays and inline tables.
      gap("a sandbox word after an element inside a closed array", [WIN, "other = [1 sandbox]", ELEVATED], 2);
      gap("a sandbox assignment after a value inside an inline table", [WIN, 'other = { a = 1 sandbox = "u" }', ELEVATED], 2);
      gap("two strings in an array with no comma", [WIN, 'other = [ "a" "b" ]', ELEVATED], 2);
      gap("two keys in an inline table with no comma", [WIN, "other = { a = 1 b = 2 }", ELEVATED], 2);
      gap("two elements on one line of a multi-line array with no comma", [WIN, "other = [", "1 2,", "]"], 3);
      gap("two strings on consecutive lines of a multi-line array with no comma",
        [WIN, "other = [", '"a"', '"b"', "]", ELEVATED], 4);
      gap("two keys on one line of a multi-line inline table with no comma", [WIN, "other = {", "a = 1 b = 2", "}"], 3);
      gap("a scalar after the closing ] of a multi-line array", [WIN, "other = [", "1,", "] 2"], 4);
      gap("a scalar after the closing } of a multi-line inline table", [WIN, "other = {", "a = 1", "} 2"], 4);

      // "Anything else", whether or not it names windows or sandbox.
      const AFTER_COMPLETE = {
        "two integers": "other = 1 2",
        "two booleans": "other = true false",
        "two strings": 'other = "x" "y"',
        "a string, then a bare word": 'other = "x" y',
        "a bare word, then a string": 'other = x "y"',
        "an integer, then a quote with no space": 'other = 1"x"',
        "a string, then an integer with no space": 'other = "x"1',
        "an array, then an integer with no space": "other = [1]2",
        "a second =": 'other = "x" = 2',
        "an integer, then an array": "other = 1 [2]",
        "a string, then an inline table": 'other = "x" { a = 1 }',
        "an empty array, then another": "other = [] []",
        "an empty inline table, then an integer": "other = {} 1",
        "a comma after a scalar with no bracket open": "other = 1, 2",
        "a comma after a closed array with no bracket open": "other = [1],",
        "a comma after a string with no bracket open": 'other = "x", 1',
      };
      for (const [name, row] of Object.entries(AFTER_COMPLETE)) {
        gap(`${name} after a complete value`, [WIN, row, ELEVATED], 2);
      }

      // A bare scalar ends at any character outside [A-Za-z0-9_+\-.:], and only a date takes one space
      // and a digit to become a date-time.
      const NOT_A_DATE_TIME = {
        "a date, two spaces, a time": "other = 1979-05-27  07:32:00",
        "a date, a tab, a time": "other = 1979-05-27\t07:32:00",
        "a date, a space, then a word": "other = 1979-05-27 x",
        "a date-time with T, a space, a time": "other = 1979-05-27T07:32:00 07:32:00",
        "a time, a space, a time": "other = 07:32:00 07:32:00",
        "a space date-time, a space, a time": "other = 1979-05-27 07:32:00 07:32:00",
        "an integer, a space, an integer": "other = 1979 05",
      };
      for (const [name, row] of Object.entries(NOT_A_DATE_TIME)) {
        gap(`${name} is a complete value followed by more`, [WIN, row, ELEVATED], 2);
      }

      // A character that cannot start a value, in a value position.
      const NOT_A_VALUE = {
        "a stray character after =": "other = @",
        "a comma straight after =": "other = ,",
        "a second = straight after =": "other = =",
        "a comma straight after [": "other = [,]",
        "two commas in an array": "other = [1,,2]",
        "a stray character inside an array": "other = [ @ ]",
        "a comma straight after = in an inline table": "other = { a = , }",
        "a } straight after = in an inline table": "other = { a = }",
      };
      for (const [name, row] of Object.entries(NOT_A_VALUE)) {
        gap(`${name} is not a value`, [WIN, row, ELEVATED], 2);
      }

      // The verdict is final and fixed text: the first verdict wins and the line is never echoed.
      gap("the first verdict wins over a later malformed target (line 1, not line 2)",
        ["other = 1 x", "windows.sandbox = 'nope'"], 1);
      each("invalid: the reason never echoes the trailing content (line 2)", [WIN, "other = 1 CANARY-trailing-7c1", ELEVATED],
        (result, label) => {
          cannotFollowAt(2)(result, label);
          assert.ok(!JSON.stringify(result).includes("CANARY-trailing-7c1"), `${label}: reason leaked configuration content: ${JSON.stringify(result)}`);
        });

      // A multiline delimiter on a table header line stays unknown (this one is invalid today as well).
      eachDelim("unchanged: a multiline delimiter on a table header line is still unknown (line 1)",
        (d) => [`[other] ${d}`, WIN, ELEVATED], cannotFollowAt(1));
    });

    describe("valid TOML keeps its result", () => {
      const FIRST_TABLE = [WIN, ELEVATED, "[other]"];
      const FIRST_TOP = ['windows.sandbox = "elevated"'];
      // Run `rows` where a document can put them: after the windows setting (found/elevated), with no
      // windows setting at all (missing-key), and, for a single line that is not a delimiter, before it
      // (found/elevated; a line holding a delimiter would make the later [windows] line a mention).
      const checkRows = (rows, eol, label) => {
        const run = (where, parts, check) => check(scan(doc(eol, ...parts)), `${label} / ${where}`);
        run("after [windows] and [other]", [...FIRST_TABLE, ...rows], isFound);
        run("after a top-level windows.sandbox", [...FIRST_TOP, ...rows], isFound);
        run("with no windows setting", rows, isMissing);
        if (rows.length === 1 && !/"""|'''/.test(rows[0])) run("before [windows]", [...rows, WIN, ELEVATED], isFound);
      };
      const eachRows = (name, rows) => {
        for (const [eolName, eol] of EOLS) {
          it(`${name} [${eolName}]`, () => checkRows(rows, eol, `${name} ${eolName}`));
        }
      };

      // Every bare scalar and date, as a value and inside arrays and inline tables, with comments and
      // blanks, on one line and across lines.
      const forms = (v) => ({
        "bare": [`value = ${v}`],
        "with a comment": [`value = ${v} # comment`],
        "with a tight comment": [`value = ${v}# comment`],
        "with trailing blanks": [`value = ${v}  \t`],
        "in an array": [`value = [${v}, ${v}]`],
        "in a spaced array": [`value = [ ${v} , ${v} ]`],
        "in a tight array": [`value = [${v},${v}]`],
        "in an array with a trailing comma": [`value = [${v}, ${v},]`],
        "in an inline table": [`value = { a = ${v}, b = ${v} }`],
        "in a tight inline table": [`value = {a=${v},b=${v}}`],
        "in a spaced inline table": [`value = { a = ${v} , b = ${v} }`],
        "in a multi-line array": ["value = [", `  ${v},`, `  ${v} # comment`, "]"],
        "in a multi-line array with comments and trailing commas": ["value = [ # open", `  ${v}, # one`, `  ${v},`, "  # nothing more", "] # close"],
        "in a comma-first multi-line array": ["value = [", `  ${v}`, `  , ${v}`, "]"],
        "in a multi-line inline table": ["value = {", `  a = ${v},`, `  b = ${v}`, "}"],
      });
      const checkForms = (v, eol, label) => {
        for (const [formName, rows] of Object.entries(forms(v))) checkRows(rows, eol, `${label} ${formName}`);
      };

      const SCALARS = [
        "1", "+1_000", "-17", "0xDEAD_BEEF", "0o755", "0b1101", "3.14", "-0.01", "5e+22", "6.626e-34",
        "inf", "+inf", "-inf", "nan", "true", "false",
      ];
      for (const v of SCALARS) {
        for (const [eolName, eol] of EOLS) {
          it(`found: the scalar ${v} in every position [${eolName}]`, () => checkForms(v, eol, `${v} ${eolName}`));
        }
      }

      const DATES = [
        "1979-05-27T07:32:00Z",
        "1979-05-27 07:32:00Z",
        "1979-05-27T00:32:00-07:00",
        "1979-05-27 00:32:00.999999-07:00",
        "1979-05-27 00:32:00+05:30",
        "1979-05-27T07:32:00",
        "1979-05-27 07:32:00",
        "1979-05-27 07:32:00.999999",
        "1979-05-27",
        "07:32:00",
        "00:32:00.999999",
        "1979-05-27t07:32:00z",
        "1979-05-27 07:32:00z",
        "1979-05-27t00:32:00-07:00",
        "1979-05-27t07:32:00",
      ];
      for (const v of DATES) {
        for (const [eolName, eol] of EOLS) {
          it(`found: the date or time ${v} in every position [${eolName}]`, () => checkForms(v, eol, `${v} ${eolName}`));
        }
      }
      // The spec's mixed array and inline table.
      eachRows("found: dates of both shapes in one array", ["value = [1979-05-27 07:32:00, 1979-05-28]"]);
      eachRows("found: a date-time and a boolean in one inline table", ["value = { d = 1979-05-27 07:32:00, b = true }"]);
      eachRows("found: a multi-line array of date-times", ["value = [", "  1979-05-27 07:32:00,", "  1979-05-28", "]"]);

      // Strings, brackets and their combinations, with comments.
      const STRUCTURES = {
        "a basic string": ['value = "x"'],
        "a literal string": ["value = 'x'"],
        "a basic string with a comment": ['value = "x" # c'],
        "a literal string with a tight comment": ["value = 'x'# c"],
        "a basic string holding # and brackets": ['value = "a # [b] {c}" # c'],
        "a literal string holding # and quotes": ["value = 'a # \"b\"' # c"],
        "a basic string with an escaped quote": ['value = "a \\" b" # c'],
        "an empty array": ["value = []"],
        "an empty array with a space": ["value = [ ]"],
        "an empty inline table": ["value = {}"],
        "an empty inline table with a space": ["value = { }"],
        "an empty array with a comment": ["value = [] # c"],
        "an empty inline table with a comment": ["value = {} # c"],
        "an array with a trailing comma": ["value = [1, 2, ]"],
        "an array with a tight trailing comma": ["value = [1, 2,]"],
        "an array with a comment": ["value = [1, 2] # c"],
        "an inline table with a comment": ["value = { a = 1 } # c"],
        "nested arrays": ["value = [[1, 2], [3]]"],
        "tight nested arrays": ["value = [[1, 2],[3]]"],
        "empty brackets in an array": ["value = [ [ ], { } ]"],
        "inline tables in an array": ["value = [{ a = 1 }, { b = [2, 3] }]"],
        "arrays and inline tables in an inline table": ["value = { a = [1, 2], b = { c = 3 } }"],
        "an inline table with a trailing comma": ["value = { a = 1, }"],
        "an inline table with quoted and dotted keys": ["value = { \"a b\" = 1, 'c' = \"x\", d.e = true }"],
        "closer characters inside strings in an array": ['value = ["a]", \'b}\', "c,d"]'],
        "a spaced array of strings": ["value = [ \"x\" , 'y' ]"],
        "a multiline string with a comment": ['value = """x""" # c'],
        "a multiline literal string with a comment": ["value = '''x''' # c"],
        "a one-line multiline string": ['value = """x"""'],
        "a one-line multiline string with trailing blanks": ['value = """x"""   '],
        "an array of multiline strings": ["value = [\"\"\"x\"\"\", '''y''']"],
        "an inline table of multiline strings with a comment": ["value = { a = \"\"\"x\"\"\", b = '''y''' } # c"],
        "a multi-line array": ["value = [", "  1,", "  2", "]"],
        "a multi-line array with comments and trailing commas":
          ["value = [ # open", "  1, # one", "  # between", "  2,", "] # close"],
        "a comma-first multi-line array": ["value = [", "  1", "  , 2", "]"],
        "a multi-line array of arrays": ["value = [", "  [1, 2],", "  [3],", "]"],
        "a multi-line array of inline tables": ["value = [", "  { a = [1, 2], b = \"x\" }, # first", "  { a = [3] },", "]"],
        "a multi-line array of strings": ["value = [", '  "a",', "  'b',", '  "c" # last', "]"],
        "a multi-line inline table": ["value = {", "  a = 1,", '  b = "x" # last', "}"],
        "a multi-line string": ['value = """', "x", '"""'],
        "a multi-line string closed with a comment": ['value = """', "x", '""" # c'],
        "a multi-line literal string closed with a comment": ["value = '''", "x", "''' # c"],
        "key forms": ["a-b_c = 1", '"quoted key" = "v"', "'lit key' = 'v'", "a . b = 1979-05-27 07:32:00", "c.d.e = true"],
        "a dotted table header": ["[other.x]"],
        "a spaced table header": ["[ other . x ]"],
        "a quoted table header": ["['other'.\"x\"]"],
        "an array-of-tables header": ["[[other.list]]"],
        "a table header with a comment": ["[other.x] # c"],
        "an array-of-tables header with a comment": ["[[other.list]] # c"],
        "a table header with a backslash literal key": ["[projects.'C:\\\\x']"],
        // Rule 1: the rest of a table header line keeps today's permissive handling (parseHeader validates it).
        "a table header with text after it": ["[other] junk"],
      };
      for (const [name, rows] of Object.entries(STRUCTURES)) eachRows(`found: ${name}`, rows);

      // A realistic Codex config. With the windows setting first the result is found; without it, missing-key.
      // The flat form keeps every array and inline table on one line, and carries a backslash path in a
      // table header; the multi-line form uses multi-line arrays and inline tables and a project path with
      // no backslash. Neither choice is needed now: after a trigger only a complete escape (`\u` + 4 hex
      // digits, `\U` + 8, `\x` + 2) is a mention, so a Windows path such as `C:\Users\me` is safe in both
      // forms (the mention-rule tests below pin that).
      const CODEX_FLAT = [
        'model = "model-config"',
        'model_reasoning_effort = "high"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'notify = ["node", "notify.js"]',
        "tool_timeout_sec = 60",
        "startup_timeout_sec = 10.5",
        "hide_agent_reasoning = false",
        "[sandbox_workspace_write]",
        "network_access = false",
        "[mcp_servers.docs]",
        'command = "npx"',
        'args = ["-y", "docs-mcp"]',
        'env = { "API_URL" = "https://example.invalid", DEBUG = true }',
        "startup_timeout_sec = 20",
        "tool_timeout_sec = 120.5",
        "enabled = true",
        "[profiles.review]",
        'sandbox_mode = "read-only"',
        'approval_policy = "never"',
        "[projects.'C:\\\\x']",
        'trust_level = "trusted"',
        "[[notice.items]]",
        'name = "a"',
      ];
      const CODEX_MULTILINE = [
        'model = "model-config"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        "notify = [",
        '  "node", # the notifier',
        '  "notify.js",',
        "]",
        "tool_timeout_sec = 60",
        "startup_timeout_sec = 10.5",
        "[sandbox_workspace_write]",
        "network_access = false",
        "[mcp_servers.docs]",
        'command = "npx"',
        "args = [",
        '  "-y",',
        '  "docs-mcp",',
        "]",
        "env = {",
        '  "API_URL" = "https://example.invalid",',
        "  DEBUG = true,",
        "}",
        "enabled = true",
        "[profiles.review]",
        'sandbox_mode = "read-only"',
        "[projects.'/home/me/x']",
        'trust_level = "trusted"',
        "[[notice.items]]",
        'name = "a"',
      ];
      const REALISTIC = { "flat": CODEX_FLAT, "multi-line": CODEX_MULTILINE };
      for (const [kind, config] of Object.entries(REALISTIC)) {
        each(`found: [windows] sandbox = elevated first, then a realistic ${kind} Codex config`, [WIN, ELEVATED, ...config], isFound);
        each(`found: a top-level windows.sandbox = elevated first, then a realistic ${kind} Codex config`,
          ['windows.sandbox = "elevated"', ...config], isFound);
        each(`missing-key: a realistic ${kind} Codex config with no windows setting`, config, isMissing);
      }
      each("found: a realistic flat Codex config, then [windows] sandbox = elevated last", [...CODEX_FLAT, WIN, ELEVATED], isFound);
    });

    // A lone carriage return. TOML allows a CR only as the first half of a CRLF line ending, so only a CR
    // immediately followed by a line feed is a line ending's; any other "\r" is a lone CR. The tracker used
    // to skip it as whitespace, so `other = [1\r]` after a real windows.sandbox read as found and, alone,
    // as missing-key. The scan is now invalid, final, with the cannot-follow reason, naming the line that
    // holds the lone CR, wherever on the line it sits: after a complete value, in a value or key position,
    // on a table header line, in a comment, in a single-line string or in a multiline string body. A file
    // with CR-only (old Mac) line endings is one line full of lone CRs. A CR that ends the file has no line
    // feed after it either, so it is lone too, however much it looks like the CR of a last CRLF line (the
    // scan used to strip it: `windows.sandbox = "elevated"` LF `other = 1` CR read as found, and
    // `other = 1` CR as missing-key).
    // Every row below puts the CR in the middle of the line, never right before the line ending (a row
    // ending in a CR is a plain CRLF line ending in the LF run), so both line endings see the same lone
    // CR. The end-of-file section is the exception: it puts the final CR after the last row, with no line
    // ending after it. Test titles never hold the CR itself.
    describe("a lone carriage return is invalid TOML the scan cannot follow", () => {
      // The same rows with no line ending after the last one.
      const eachNoFinalEol = (name, rows, check) => {
        for (const [eolName, eol] of EOLS) {
          it(`${name}, with no final line ending [${eolName}]`, () => check(scan(rows.join(eol)), `${name} no final EOL ${eolName}`));
        }
      };
      // One document given as raw text (its own line endings).
      const raw = (name, text, check) => it(name, () => check(scan(text), name));

      describe("the review repro", () => {
        gap("a lone CR inside an array after a real windows.sandbox key", ['windows.sandbox = "elevated"', "other = [1\r]"], 2);
        gap("a lone CR inside an array, alone in the file", ["other = [1\r]"], 1);
        eachNoFinalEol("invalid: a lone CR inside an array after a real windows.sandbox key (line 2)",
          ['windows.sandbox = "elevated"', "other = [1\r]"], cannotFollowAt(2));
        eachNoFinalEol("invalid: a lone CR inside an array, alone in the file (line 1)", ["other = [1\r]"], cannotFollowAt(1));
        gap("a lone CR inside an array under [windows] before the real key", [WIN, "other = [1\r]", ELEVATED], 2);
        gap("a lone CR inside an array under [windows] after the real key", [WIN, ELEVATED, "other = [1\r]"], 3);
      });

      describe("after a complete value", () => {
        const VALUES = {
          "a bare integer": "1",
          "a bare boolean": "true",
          "a date": "1979-05-27",
          "a basic string": '"x"',
          "a literal string": "'x'",
          "an empty array": "[]",
          "a closed array": "[1]",
          "an empty inline table": "{}",
          "a closed inline table": "{ a = 1 }",
          "a one-line multiline basic string": '"""x"""',
          "a one-line multiline literal string": "'''x'''",
        };
        const WHAT_FOLLOWS = {
          "a space": "\r ",
          "a comment": "\r# note",
          "a tab and a comment": "\r\t# note",
        };
        for (const [name, value] of Object.entries(VALUES)) {
          for (const [followsName, follows] of Object.entries(WHAT_FOLLOWS)) {
            gap(`a lone CR after ${name}, then ${followsName}, under [windows] with the real key`,
              [WIN, `other = ${value}${follows}`, ELEVATED], 2);
          }
        }
        gap("a lone CR in a local date-time where the space goes", [WIN, "other = 1979-05-27\r07:32:00", ELEVATED], 2);
        gap("a lone CR inside a time", [WIN, "other = 07:32\r:00", ELEVATED], 2);
        gap("a lone CR after a scalar at the top level, then windows.sandbox", ["other = 1\r # note", 'windows.sandbox = "elevated"'], 1);
        gap("a lone CR after a scalar with nothing else in the file", ["other = 1\r # note"], 1);

        // After a multiline string's closing delimiter (the delimiter's line, and the one-line form).
        eachDelim("invalid: a lone CR after a multiline string's closing delimiter, then a comment, under [windows] with the real key (line 3)",
          (d) => [WIN, `other = ${d}`, `x${d}\r # note`, ELEVATED], cannotFollowAt(3));
        eachDelim("invalid: a lone CR after a multiline string's closing delimiter, then a space (line 2)",
          (d) => [`other = ${d}`, `x${d}\r `], cannotFollowAt(2));
        eachDelim("invalid: a lone CR after a multiline string closed on its own line, under [windows] with the real key (line 2)",
          (d) => [WIN, `other = ${d}x${d}\r # note`, ELEVATED], cannotFollowAt(2));
      });

      describe("inside arrays and inline tables", () => {
        gap("a lone CR after a closed inner array inside an array", [WIN, "other = [[1]\r, 2]", ELEVATED], 2);
        gap("a lone CR after a closed array inside an inline table", [WIN, "other = { a = [1]\r }", ELEVATED], 2);
        gap("a lone CR after a closed inline table inside an array", [WIN, "other = [{ a = 1 }\r, 2]", ELEVATED], 2);
        gap("a lone CR after a scalar inside an array", [WIN, "other = [1\r, 2]", ELEVATED], 2);
        gap("a lone CR after a string inside an inline table", [WIN, 'other = { a = "x"\r }', ELEVATED], 2);
        gap("a lone CR before the closing } of an inline table", [WIN, "other = { a = 1\r}", ELEVATED], 2);
        gap("a lone CR after an element on a line of a multi-line array", [WIN, "other = [", "1\r,", "2", "]", ELEVATED], 3);
        gap("a lone CR after a comma on a line of a multi-line array", [WIN, "other = [", "1,\r 2", "]", ELEVATED], 3);
        gap("a lone CR after a value on a line of a multi-line inline table", [WIN, "other = {", "a = 1\r,", "b = 2", "}", ELEVATED], 3);
        gap("a lone CR on the line that closes a multi-line array", [WIN, "other = [", "1,", "]\r # note", ELEVATED], 4);
        gap("a lone CR on the line that closes a multi-line inline table", [WIN, "other = {", "a = 1", "}\r # note", ELEVATED], 4);
        eachDelim("invalid: a lone CR in a multiline string inside an array (line 3)",
          (d) => [WIN, "other = [", `${d}a\rb${d},`, "]", ELEVATED], cannotFollowAt(3));
      });

      describe("in a multiline string body", () => {
        eachDelim("invalid: a lone CR in a body on the opening line (line 2)",
          (d) => [WIN, `other = ${d}a\rb`, "text", d, ELEVATED], cannotFollowAt(2));
        eachDelim("invalid: a lone CR in a body line between the delimiters (line 3)",
          (d) => [WIN, `other = ${d}`, "a\rb", d, ELEVATED], cannotFollowAt(3));
        eachDelim("invalid: a body line that starts with a lone CR (line 3)",
          (d) => [WIN, `other = ${d}`, "\rb", d, ELEVATED], cannotFollowAt(3));
        eachDelim("invalid: a lone CR on the closing line, before the delimiter (line 3)",
          (d) => [WIN, `other = ${d}`, `x\r${d}`, ELEVATED], cannotFollowAt(3));
        eachDelim("invalid: a lone CR in the second body line of a longer string (line 4)",
          (d) => [WIN, `other = ${d}`, "first", "se\rcond", d, ELEVATED], cannotFollowAt(4));
        eachDelim("invalid: a lone CR in a body with no windows setting at all (line 2)",
          (d) => [`other = ${d}`, "a\rb", d], cannotFollowAt(2));
        // The tracker's verdict wins over the mention rule on the same line.
        eachDelim("invalid: a lone CR in a body line that also mentions sandbox gets the cannot-follow reason (line 3)",
          (d) => [WIN, `other = ${d}`, "a\rsandbox", d], cannotFollowAt(3));
      });

      describe("in a value position and in a key position", () => {
        const VALUE_ROWS = {
          "straight after the =": "other =\r1",
          "after the = and a space": "other = \r1",
          "before a string value": 'other =\r"x"',
          "before an array value": "other = \r[1]",
          "right after an array's [": "other = [\r1]",
          "after a comma in an array": "other = [1,\r2]",
          "in an inline table's value position": "other = { a =\r1 }",
        };
        for (const [name, row] of Object.entries(VALUE_ROWS)) {
          gap(`a lone CR ${name}, under [windows] with the real key`, [WIN, row, ELEVATED], 2);
          gap(`a lone CR ${name}, alone in the file`, [row], 1);
        }
        const KEY_ROWS = {
          "in a bare key": "other\r = 1",
          "before a key": "\rother = 1",
          "between a key and the =": "other \r= 1",
          "in a dotted key": "a.\rb = 1",
          "after a dotted key part": "a\r.b = 1",
          "in a quoted key": '"a\rb" = 1',
          "in an inline table's key position after a comma": "other = { a = 1,\r b = 2 }",
          "right after an inline table's opening brace": "other = {\ra = 1 }",
          "in a quoted key inside an inline table": 'other = { "a\rb" = 1 }',
        };
        for (const [name, row] of Object.entries(KEY_ROWS)) {
          gap(`a lone CR ${name}, under [windows] with the real key`, [WIN, row, ELEVATED], 2);
          gap(`a lone CR ${name}, alone in the file`, [row], 1);
        }
        gap("a lone CR in a key after a real windows.sandbox key", ['windows.sandbox = "elevated"', "other\r = 1"], 2);
      });

      describe("on a table header line", () => {
        const HEADER_ROWS = {
          "text after a table header": "[other]\r x",
          "a comment after a table header": "[other]\r# note",
          "inside the brackets of a table header": "[other\r]",
          "before the key inside a table header's brackets": "[\rother]",
          "in a dotted table header": "[other.\rx]",
          "text after an array-of-tables header": "[[other]]\r x",
          "inside an array-of-tables header": "[[other]\r]",
        };
        for (const [name, row] of Object.entries(HEADER_ROWS)) {
          gap(`a lone CR ${name}, before [windows] and the real key`, [row, WIN, ELEVATED], 1);
          gap(`a lone CR ${name}, after the real key`, [WIN, ELEVATED, row], 3);
        }
        gap("a lone CR after the [windows] header, then the real key", ["[windows]\r # note", ELEVATED], 1);
        gap("a lone CR inside the [windows] header's brackets, then the real key", ["[windows\r]", ELEVATED], 1);
      });

      describe("in a comment, a basic string and a literal string", () => {
        gap("a lone CR in a full-line comment, then a sandbox assignment on the same line, under [windows] with the real key",
          [WIN, `# note\r ${UNELEVATED}`, ELEVATED], 2);
        gap("a lone CR in a full-line comment, then a sandbox assignment, with no real key", [WIN, `# note\r ${UNELEVATED}`], 2);
        gap("a lone CR in a comment that is only the #", [WIN, "#\r x", ELEVATED], 2);
        gap("a lone CR in a trailing comment after a scalar", [WIN, `other = 1 # note\r ${UNELEVATED}`, ELEVATED], 2);
        gap("a lone CR in a trailing comment after a closed array", [WIN, "other = [1] # note\r x", ELEVATED], 2);
        gap("a lone CR in a trailing comment after the real key", [WIN, `${ELEVATED} # note\r x`], 2);
        gap("a lone CR in a comment on a line of an open multi-line array", [WIN, "other = [", "# note\r 1,", "]", ELEVATED], 3);
        gap("a lone CR in a trailing comment after an element of an open multi-line array", [WIN, "other = [", "1, # note\r 2", "]", ELEVATED], 3);

        gap("a lone CR in a basic string", [WIN, 'other = "a\rb"', ELEVATED], 2);
        gap("a lone CR in a literal string", [WIN, "other = 'a\rb'", ELEVATED], 2);
        gap("a lone CR in a basic string, alone in the file", ['other = "a\rb"'], 1);
        gap("a lone CR in a literal string, alone in the file", ["other = 'a\rb'"], 1);
        gap("a lone CR in a basic string inside an array", [WIN, 'other = ["a\rb"]', ELEVATED], 2);
        gap("a lone CR in a literal string inside an inline table", [WIN, "other = { a = 'x\ry' }", ELEVATED], 2);
        gap("a lone CR in the real key's own string value", [WIN, 'sandbox = "ele\rvated"'], 2);
      });

      describe("a line of its own", () => {
        gap("a line holding a lone CR then a sandbox assignment, under [windows] with the real key",
          [WIN, `\r${UNELEVATED}`, ELEVATED], 2);
        gap("a line holding a lone CR then a sandbox assignment, with no real key", [WIN, `\r${UNELEVATED}`], 2);
        gap("a line holding a lone CR then a windows.sandbox assignment at the top level",
          ['\rwindows.sandbox = "unelevated"', 'windows.sandbox = "elevated"'], 1);
        gap("a line holding only two CRs (the second is the line ending's)", [WIN, "\r\r", ELEVATED], 2);
        gap("a line holding a space, a lone CR and a space", [WIN, " \r ", ELEVATED], 2);
        gap("a lone CR before a table header", [WIN, "\r[other]", ELEVATED], 2);
      });

      describe("two CRs before a line feed, and CR-only line endings", () => {
        // CR CR LF: the second CR is the line ending's, the first is lone.
        raw("invalid: two CRs before the line feed leave one lone CR (line 1)", "other = 1\r\r\n", cannotFollowAt(1));
        raw("invalid: two CRs before the line feed on the last line, after a CRLF real key (line 3)",
          '[windows]\r\nsandbox = "elevated"\r\nother = 1\r\r\n', cannotFollowAt(3));
        raw("invalid: three CRs before the line feed on a line of a CRLF file (line 2)",
          '[windows]\r\nother = [1]\r\r\r\nsandbox = "elevated"\r\n', cannotFollowAt(2));

        // CR-only line endings: the file is one long line that holds lone CRs.
        raw("invalid: a CR-only file, with a CR after the last line (line 1)", '[windows]\rsandbox = "elevated"\r', cannotFollowAt(1));
        raw("invalid: a CR-only file, with no CR after the last line (line 1)", '[windows]\rsandbox = "elevated"', cannotFollowAt(1));
        raw("invalid: a CR-only file that starts with a comment (line 1)", '# note\r[windows]\rsandbox = "elevated"\r', cannotFollowAt(1));
        raw("invalid: a CR-only file with a top-level windows.sandbox (line 1)", 'windows.sandbox = "elevated"\rother = 1\r', cannotFollowAt(1));
        raw("invalid: a CR-only file with a header and a key but no windows setting (line 1)", "[other]\ra = 1\r", cannotFollowAt(1));
        raw("invalid: a CR-only file with two assignments (line 1)", "a = 1\rb = 2\r", cannotFollowAt(1));
        raw("invalid: a CR-only part after an LF line names its own line (line 2)", 'a = 1\n[windows]\rsandbox = "elevated"\r', cannotFollowAt(2));
      });

      // A CR that ends the file has no line feed after it, so it is lone: nothing strips it. The invalid
      // line is the last line, the one holding that CR. `eofCr` joins the rows with the line ending and
      // adds one CR after the last row, so the [LF] form of the first two cases is the review repro
      // verbatim, and the [CRLF] form of the target-on-the-last-line case has a CRLF before it.
      describe("a CR at the end of the file with no line feed after it", () => {
        const eofCr = (name, rows, line) => {
          for (const [eolName, eol] of EOLS) {
            it(`invalid: ${name} (line ${line}) [${eolName}]`, () => cannotFollowAt(line)(scan(`${rows.join(eol)}\r`), `${name} ${eolName}`));
          }
        };
        const eofCrDelim = (name, build, line) => {
          for (const d of DELIMS) {
            for (const [eolName, eol] of EOLS) {
              it(`invalid: ${name} (line ${line}) [${d} ${eolName}]`, () => cannotFollowAt(line)(scan(`${build(d).join(eol)}\r`), `${name} ${d} ${eolName}`));
            }
          }
        };

        describe("the review repro", () => {
          eofCr("windows.sandbox first, then a last line `other = 1` ending in a CR", ['windows.sandbox = "elevated"', "other = 1"], 2);
          eofCr("no target, a single line `other = 1` ending in a CR", ["other = 1"], 1);
        });

        describe("the target and the rest of the last line", () => {
          eofCr("the real key itself is the last line and ends in a CR", [WIN, ELEVATED], 2);
          eofCr("a top-level windows.sandbox is the only line and ends in a CR", ['windows.sandbox = "elevated"'], 1);
          eofCr("a top-level windows.sandbox is the last line and ends in a CR", ["other = 1", 'windows.sandbox = "elevated"'], 2);
          // The old CRLF-file case, which expected found: its [CRLF] form is that very text.
          eofCr("the last line is a value and a comment ending in a CR, after the real key", [WIN, ELEVATED, "other = [1] # note"], 3);
          eofCr("the last line is a comment ending in a CR, after the real key", [WIN, ELEVATED, "# note"], 3);
          eofCr("the last line is a table header ending in a CR, after the real key", [WIN, ELEVATED, "[other]"], 3);
          eofCr("the last line is a table header ending in a CR, with no real key", ["[other]"], 1);
        });

        describe("an empty last line that is just a CR", () => {
          eofCr("a CR on a line of its own after LF-ended lines holding the real key", [WIN, ELEVATED, ""], 3);
          eofCr("a CR on a line of its own after several empty lines", ["other = 1", "", ""], 3);
          eofCr("a CR on a line of its own after a comment", ["# note", ""], 2);
          raw("invalid: a file that is just a CR (line 1)", "\r", cannotFollowAt(1));
          raw("invalid: a file that is a line feed then a CR (line 2)", "\n\r", cannotFollowAt(2));
          raw("invalid: a file that is a CRLF then a CR (line 2)", "\r\n\r", cannotFollowAt(2));
          raw("invalid: a file that is two CRs (line 1)", "\r\r", cannotFollowAt(1));
          raw("invalid: a last line holding two CRs and no line feed (line 1)", "other = 1\r\r", cannotFollowAt(1));
        });

        describe("a last line that is part of a larger value", () => {
          eofCr("the CR ends the line of an array that is still open, so the open array never gets to be the reason", [WIN, "other = [", "1,"], 3);
          eofCrDelim("the CR ends a multiline string's body line", (d) => [WIN, `other = ${d}`, "body"], 3);
          eofCrDelim("the CR ends a multiline string's closing line", (d) => [WIN, `other = ${d}`, `x${d}`], 3);
          eofCrDelim("the CR ends the one-line form of a multiline string", (d) => [WIN, `other = ${d}x${d}`], 2);
        });

        describe("the verdict is final and fixed text", () => {
          eofCr("trailing content on an earlier line keeps its own line over the CR at the end", ["other = 1 x", "other = 1"], 1);
          eofCr("a lone CR on an earlier line keeps its own line over the CR at the end", ["other = [1\r]", "other = 1"], 1);
          for (const [eolName, eol] of EOLS) {
            it(`invalid: the reason never echoes the last line holding the CR (line 3) [${eolName}]`, () => {
              const result = scan(`${[WIN, ELEVATED, 'other = "CANARY-eof-cr-7a1"'].join(eol)}\r`);
              cannotFollowAt(3)(result, `canary ${eolName}`);
              assert.ok(!JSON.stringify(result).includes("CANARY-eof-cr-7a1"), `the reason leaked configuration content: ${JSON.stringify(result)}`);
            });
          }
        });
      });

      describe("the verdict is final and fixed text", () => {
        gap("the first lone CR line wins over a later lone CR line and a later malformed target",
          ["other = [1\r]", "x\ry", "windows.sandbox = 'nope'"], 1);
        gap("a lone CR line wins over a later line with trailing content", ["other = 1\r # note", "other = 1 x"], 1);
        gap("unchanged: trailing content on an earlier line keeps its own line over a later lone CR", ["other = 1 x", "other = [1\r]"], 1);
        each("invalid: the reason never echoes the line holding the lone CR (line 2)", [WIN, 'other = ["CANARY-cr-5e3"\r]', ELEVATED],
          (result, label) => {
            cannotFollowAt(2)(result, label);
            assert.ok(!JSON.stringify(result).includes("CANARY-cr-5e3"), `${label}: reason leaked configuration content: ${JSON.stringify(result)}`);
          });
      });

      describe("valid files keep their result", () => {
        // Every CR in a text is the first half of a CRLF line ending.
        const onlyCrlf = (text) => text.includes("\r\n") && text.split("\r").length === text.split("\n").length;
        it("found: a CRLF file, values followed by comments", () => {
          const text = doc("\r\n", WIN, `${ELEVATED} # note`, "other = 1 # note", 'text = "x" # note', "list = [1, 2] # note",
            "tbl = { a = [1] } # note", "multi = [ # open", "  1, # one", "  2,", "] # close", "[other] # note", "value = 1979-05-27 07:32:00 # note");
          assert.ok(onlyCrlf(text), "every CR is part of a CRLF line ending");
          isFound(scan(text), "CRLF values with comments");
        });
        it("missing-key: a CRLF file, values followed by comments, with no windows setting", () => {
          const text = doc("\r\n", "other = 1 # note", "list = [1, 2] # note", "[other] # note", 'text = "x" # note');
          assert.ok(onlyCrlf(text), "every CR is part of a CRLF line ending");
          isMissing(scan(text), "CRLF values with comments, no windows setting");
        });
        for (const [eolName, eol] of EOLS) {
          it(`found: the last line has no line ending, a value followed by a comment [${eolName}]`, () => {
            isFound(scan([WIN, ELEVATED, "other = [1, 2] # note"].join(eol)), `no final EOL ${eolName}`);
          });
          it(`found: the last line has no line ending, the real key itself [${eolName}]`, () => {
            isFound(scan([WIN, ELEVATED].join(eol)), `no final EOL, real key ${eolName}`);
          });
        }
        // A CR before a line feed is a line ending's, even on the last line of the file or on a line of its
        // own. (The same last line ending in a CR with no line feed is lone: see the end-of-file section.)
        raw("found: the last line ends in a CRLF, the lines before it in LF", '[windows]\nsandbox = "elevated"\nother = [1] # note\r\n', isFound);
        raw("found: the last line is the real key and ends in a CRLF, the line before it in LF", '[windows]\nsandbox = "elevated"\r\n', isFound);
        raw("found: a last line that is a CRLF of its own after the real key in a CRLF file", '[windows]\r\nsandbox = "elevated"\r\n\r\n', isFound);
        raw("found: a last line that is a CRLF of its own after the real key, the lines before it in LF", '[windows]\nsandbox = "elevated"\n\r\n', isFound);
        raw("missing-key: a file that is just a CRLF", "\r\n", isMissing);
        raw("missing-key: a CRLF file holding one unrelated value", "other = 1\r\n", isMissing);
        // A backslash and the letter r are an escape, not a CR.
        each("found: a backslash and the letter r in a basic string are an escape, not a CR", [WIN, ELEVATED, "[other]", 'value = "a\\rb"'], isFound);
        each("missing-key: a backslash and the letter r in a basic string, with no windows setting", ["[other]", 'value = "a\\rb"'], isMissing);
      });
    });
  });

  // The mention rule (the user's one simple rule instead of per-bypass patching). Ambiguity starts after
  // the first line that either (a) contains a multiline delimiter (`"""` or `'''`, outside a full-line
  // comment) or (b) ends with an array or inline table still open. On every LATER line, a mention of
  // windows or sandbox as a whole token anywhere (key, value, string body, comment, any case) or a
  // complete escape (`\u` + 4 hex digits, `\U` + 8, `\x` + 2, hex in either case; TOML 1.1 allows \xHH;
  // any of them can spell either name in a quoted key) makes the scan invalid, final, naming that line.
  // An incomplete backslash sequence is not an escape, so a Windows path such as `C:\Users\me` is not a
  // mention. A token is not preceded or followed by a bare-key character [A-Za-z0-9_-], so
  // `sandbox_mode`, `[sandbox_workspace_write]`, `windows-foo`, `xwindows`, `sandbox2` and `--sandbox`
  // are not mentions. The triggering line itself never counts. A target before the first trigger stays
  // found while no later line mentions either name, and a config with neither trigger is unaffected. The
  // value tracker's verdict wins on the same line: a line that also holds trailing content after a complete
  // value is rejected by the trailing-content rule (the cannot-follow reason), not by the mention rule.
  describe("a mention of windows or sandbox after a multiline string or a multi-line value fails closed", () => {
    const EOLS = [["LF", "\n"], ["CRLF", "\r\n"]];
    const DELIMS = ['"""', "'''"];
    const doc = (eol, ...rows) => rows.join(eol) + eol;
    const TARGET = 'windows.sandbox = "elevated"';
    const isFound = (result, label) => assert.deepEqual(pick(result), found("elevated"), `${label}: ${JSON.stringify(pick(result))}`);
    const isMissing = (result, label) => assert.deepEqual(pick(result), missing, `${label}: ${JSON.stringify(pick(result))}`);
    // The value tracker's verdict always wins over the mention rule on the same line: a line that holds
    // trailing content after a complete value is invalid with this reason, naming that line.
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollowAt = (line) => (result, label) => {
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(result.reason, `${CANNOT_FOLLOW} (line ${line})`, label);
    };
    // One `it` per case, run on LF and CRLF (and on both delimiters when the rows depend on one).
    const eachCase = (name, build, check) => {
      it(name, () => {
        for (const d of DELIMS) {
          for (const [eolName, eol] of EOLS) check(scan(doc(eol, ...build(d))), `${d} ${eolName}`);
        }
      });
    };

    // Triggers, each as the rows that come first (the next line is rows.length + 1).
    const TRIGGERS = {
      "a multiline string": (d) => [`note = ${d}`, "text", d],
      "a multiline string on one line": (d) => [`note = ${d}x${d}`],
      "a delimiter in a trailing comment": (d) => [`note = 1 # ${d}`],
      "a multi-line array": () => ["arr = [", "1,", "]"],
      "a multi-line inline table": () => ["tbl = {", "k = 1", "}"],
    };
    // What a later line may mention. Every one of these is invalid after any trigger.
    const MENTIONS = {
      "a dotted windows.sandbox key": TARGET,
      "a bare sandbox key": 'sandbox = "elevated"',
      "a [windows] header": "[windows]",
      "a windows key": "windows = 1",
      "a value naming sandbox": 'other = "sandbox"',
      "a full-line comment naming windows": "# windows",
      "a trailing comment naming sandbox": "other = 1 # sandbox",
      "mixed case Windows": "Windows = 1",
      "mixed case SANDBOX": "SANDBOX = 1",
      "an escaped quoted key (\\u)": '"\\u0073andbox" = 1',
      "an escaped quoted key (\\U)": '"\\U00000077indows" = 1',
      "a \\u escape in a value": 'other = "\\u0041"',
      "an escaped quoted key (\\x)": '"\\x73andbox" = 1',
      "a \\x escape in a value": 'other = "\\x41"',
    };
    for (const [triggerName, trigger] of Object.entries(TRIGGERS)) {
      for (const [mentionName, line] of Object.entries(MENTIONS)) {
        const nextLine = trigger('"""').length + 1;
        eachCase(`invalid: ${mentionName} after ${triggerName} (line ${nextLine})`,
          (d) => [...trigger(d), line], mentionAt(nextLine));
      }
    }

    // A mention inside the multiline string's own body counts: the body lines are later lines.
    const BODY_MENTIONS = {
      "windows": "see windows here",
      "sandbox": "sandbox in the text",
      "mixed case": "Windows And SANDBOX",
      "a \\u escape": "snow \\u2603",
    };
    for (const [name, body] of Object.entries(BODY_MENTIONS)) {
      eachCase(`invalid: ${name} in the body of a multiline string (line 2)`,
        (d) => [`note = ${d}`, body, d], mentionAt(2));
    }

    // The triggering line itself never counts, whatever it mentions.
    const TRIGGER_LINE_MENTIONS = {
      "a multi-line array whose first line names sandbox": ['a = [ "sandbox",', "1 ]"],
      "a multi-line inline table whose first line names windows": ["a = { windows = 1,", "b = 2 }"],
      "a multi-line array whose first line holds a \\u escape": ['a = [ "\\u0041",', "1 ]"],
    };
    for (const [name, rows] of Object.entries(TRIGGER_LINE_MENTIONS)) {
      for (const [eolName, eol] of EOLS) {
        it(`missing-key: ${name} is the trigger line and does not count [${eolName}]`, () => {
          isMissing(scan(doc(eol, ...rows)), `${name} ${eolName}`);
        });
      }
    }
    eachCase("missing-key: a multiline string whose opening line names windows is the trigger line and does not count",
      (d) => [`note = ${d} windows`, "x", d], (result, label) => isMissing(result, label));
    eachCase("missing-key: a one-line multiline string naming sandbox is the trigger line and does not count",
      (d) => [`note = ${d}sandbox${d}`], (result, label) => isMissing(result, label));
    // The closing line of a multi-line value is a later line, so a mention there counts.
    eachCase("invalid: the closing line of a multi-line array that names sandbox is a mention (line 2)",
      () => ["a = [", '1, "sandbox" ]'], mentionAt(2));

    // A target before the first trigger stays found while no later line mentions windows or sandbox.
    eachCase("found: a dotted target before a multiline string, with nothing later naming windows or sandbox",
      (d) => [TARGET, `note = ${d}`, "text", d, "other = 1"], (result, label) => isFound(result, label));
    eachCase("found: a [windows] table before a multi-line array, with nothing later naming windows or sandbox",
      () => ["[windows]", 'sandbox = "elevated"', "arr = [", "1,", "]", "[other]", "x = 1"], (result, label) => isFound(result, label));
    eachCase("found: a dotted target before a multi-line inline table, with nothing later naming windows or sandbox",
      () => [TARGET, "tbl = {", "k = 1", "}", "other = 1"], (result, label) => isFound(result, label));
    eachCase("invalid: a target before a multiline string does not stand when a later line names windows (line 5)",
      (d) => [TARGET, `note = ${d}`, "x", d, 'windows.sandbox = "unelevated"'], mentionAt(5));

    // A config with neither trigger is unaffected: single-line arrays and inline tables are closed on their
    // own line, and comments and headers may name windows or sandbox freely.
    eachCase("found: a [windows] table with no multiline value anywhere",
      () => ["# windows settings", "[windows]", 'sandbox = "elevated" # sandbox', "[other]", "x = 1"], (result, label) => isFound(result, label));
    eachCase("found: single-line arrays and inline tables are not triggers",
      () => ["a = [ 1, 2 ]", "b = { c = 1 }", TARGET], (result, label) => isFound(result, label));
    eachCase("missing-key: a config with no target and no trigger is unaffected",
      () => ["a = [ 1 ]", "[other]", "x = 1"], (result, label) => isMissing(result, label));

    // Codex loop-5 repros: the closing line of a multi-line value is followed by a sandbox assignment. The
    // closer is followed by more content, so the trailing-content rule rejects line 3 before the mention
    // rule is consulted, and the verdict is the tracker's cannot-follow reason, not the mention reason.
    eachCase("invalid: a closing ] followed by a sandbox assignment, then a real sandbox key (line 3)",
      () => ["[windows]", "other = [", '] sandbox = "unelevated"', 'sandbox = "elevated"'], cannotFollowAt(3));
    eachCase("invalid: a closing ] followed by a sandbox assignment, with no later line (line 3)",
      () => ["[windows]", "other = [", '] sandbox = "unelevated"'], cannotFollowAt(3));
    eachCase("invalid: a closing } followed by a sandbox assignment, then a real sandbox key (line 3)",
      () => ["[windows]", "other = {", '} sandbox = "unelevated"', 'sandbox = "elevated"'], cannotFollowAt(3));
    eachCase("invalid: a closing } followed by a sandbox assignment, with no later line (line 3)",
      () => ["[windows]", "other = {", '} sandbox = "unelevated"'], cannotFollowAt(3));

    // The reason is fixed text plus a line number: it never echoes configuration content.
    eachCase("invalid: the mention reason never echoes the mentioning line",
      (d) => [`note = ${d}`, "CANARY-mention-3d9 sandbox", d], (result, label) => {
        mentionAt(2)(result, label);
        assert.ok(!JSON.stringify(result).includes("CANARY-mention-3d9"), `${label}: reason leaked configuration content: ${JSON.stringify(result)}`);
      });
    // The first verdict wins: line 2 (`sandbox = 1` inside the open array holds trailing content after the
    // bare scalar `sandbox`, so the trailing-content rule rejects it) is final, and the later malformed
    // target on line 4 does not replace it.
    eachCase("invalid: the first verdict wins over a later malformed target (line 2, not line 4)",
      () => ["a = [", "sandbox = 1", "]", 'windows.sandbox = "nope"'], cannotFollowAt(2));

    // TOML 1.1 allows \xHH escapes in basic strings and quoted keys, so `"\x77indows"` spells windows and
    // `"\x73andbox"` spells sandbox without either name appearing as a token or a \u escape. After a
    // trigger, a complete \x escape (\x + 2 hex digits) is a mention. (HEAD rejected these through the
    // removed escaped-key guard; the mention rule's escape check must cover \x, not only \u and \U.)
    const ESCAPED_X_TABLE = '"\\x77indows" = { "\\x73andbox" = "unelevated" }';
    eachCase("invalid: a fake [other] header in a string, then an \\x-escaped windows inline table (target absent) (line 4)",
      (d) => [`note = ${d}`, "[other]", d, ESCAPED_X_TABLE], mentionAt(4));
    eachCase("invalid: a fake [other] header in a string, then an \\x-escaped windows inline table, after a valid target (line 5)",
      (d) => [TARGET, `note = ${d}`, "[other]", d, ESCAPED_X_TABLE], mentionAt(5));
    eachCase("invalid: an \\x-escaped dotted key \"\\x77indows\".\"\\x73andbox\" after a multiline string (target absent) (line 4)",
      (d) => [`note = ${d}`, "[other]", d, '"\\x77indows"."\\x73andbox" = "unelevated"'], mentionAt(4));
    eachCase("invalid: an \\x-escaped dotted key \"\\x77indows\".\"\\x73andbox\" after a multiline string, after a valid target (line 5)",
      (d) => [TARGET, `note = ${d}`, "[other]", d, '"\\x77indows"."\\x73andbox" = "unelevated"'], mentionAt(5));
    // This one names windows as a plain token as well, so it is already a mention without the \x check.
    eachCase("invalid: windows.\"\\x73andbox\" after a multiline string (target absent) (line 4)",
      (d) => [`note = ${d}`, "[other]", d, 'windows."\\x73andbox" = "unelevated"'], mentionAt(4));
    eachCase("invalid: windows.\"\\x73andbox\" after a multiline string, after a valid target (line 5)",
      (d) => [TARGET, `note = ${d}`, "[other]", d, 'windows."\\x73andbox" = "unelevated"'], mentionAt(5));
    for (const d of DELIMS) {
      for (const [eolName, eol] of EOLS) {
        it(`invalid: the \\x-escaped windows inline table with a UTF-8 BOM before the document (line 4) [${d} ${eolName}]`, () => {
          const text = `\uFEFF${doc(eol, `note = ${d}`, "[other]", d, ESCAPED_X_TABLE)}`;
          mentionAt(4)(scan(text), `${d} ${eolName}`);
        });
      }
    }
    // A complete \x escape (\x + 2 hex digits) in a value after a multi-line array (it cannot be told from a name by the line alone).
    eachCase("invalid: an \\x escape in a value after a multi-line array is a mention (line 3)",
      () => ["a = [", "1 ]", 'note = "\\x41"'], mentionAt(3));

    // An escape counts only when it is complete. After a trigger, a backslash sequence is an escape (and so
    // a mention) only when it is `\u` + 4 hex digits, `\U` + 8 hex digits or `\x` + 2 hex digits, the hex in
    // either case. Characters after the required digits do not matter: `\u00771` is the escape `\u0077`
    // followed by a 1. Anything else (the `\U` of `C:\Users`, `\u12`, `\xZ1`, `\U1234567` followed by a
    // quote) is not an escape. Codex writes Windows project keys like `[projects.'C:\Users\me\repo']` itself,
    // so a later line holding one must not make the scan ambiguous. The whole-word mention rule is unchanged.
    // The cases below run after both trigger kinds (a multi-line array and a multiline string, on both
    // delimiters), on LF and CRLF, once alone and once after a valid target.
    const ESCAPE_TRIGGERS = [
      ["a multi-line array", ["a = [", " 1,", "]"]],
      ...DELIMS.map((d) => [`a multiline string (${d})`, [`note = ${d}`, "text", d]]),
    ];
    // Valid: the rows stay found with the target first and missing-key without one.
    const eachValid = (name, rows) => {
      it(`valid: ${name}: found with the target first, missing-key without it`, () => {
        for (const [triggerName, trigger] of ESCAPE_TRIGGERS) {
          for (const [eolName, eol] of EOLS) {
            const label = `${triggerName} ${eolName}`;
            isFound(scan(doc(eol, TARGET, ...trigger, ...rows)), `${label}, target first`);
            isMissing(scan(doc(eol, ...trigger, ...rows)), `${label}, no target`);
          }
        }
      });
    };
    // Invalid: the first of the rows is a mention, named by its line, with or without a target before the trigger.
    const eachMention = (name, rows) => {
      it(`invalid: ${name}: a mention at its own line`, () => {
        for (const [triggerName, trigger] of ESCAPE_TRIGGERS) {
          for (const [eolName, eol] of EOLS) {
            const label = `${triggerName} ${eolName}`;
            mentionAt(trigger.length + 1)(scan(doc(eol, ...trigger, ...rows)), `${label}, no target`);
            mentionAt(trigger.length + 2)(scan(doc(eol, TARGET, ...trigger, ...rows)), `${label}, target first`);
          }
        }
      });
    };

    // The repro: Codex writes `[projects.'C:\Users\...']` keys itself on Windows.
    const PROJECT = ["[projects.'C:\\Users\\me\\repo']", 'trust_level = "trusted"'];
    eachCase("found: a valid target, a multi-line array, then a Windows project table (the repro)",
      () => [TARGET, "a = [", " 1,", "]", ...PROJECT], isFound);
    eachCase("found: a valid target, a multiline string, then a Windows project table",
      (d) => [TARGET, `note = ${d}`, "text", d, ...PROJECT], isFound);
    eachCase("missing-key: a multi-line array, then a Windows project table, with no target",
      () => ["a = [", " 1,", "]", ...PROJECT], isMissing);
    eachCase("missing-key: a multiline string, then a Windows project table, with no target",
      (d) => [`note = ${d}`, "text", d, ...PROJECT], isMissing);

    // Text that is not an escape, in the places a Windows path or a stray backslash can sit: a table header
    // key, a value, a key, and an element of a multi-line array (itself a trigger).
    const NOT_ESCAPES = {
      "a Windows path": "C:\\Users\\me",
      "a longer Windows path": "C:\\Users\\me\\repo",
      "a path ending in a bare \\x": "C:\\x",
      "\\u with 2 hex digits": "\\u12",
      "\\u with 3 hex digits": "\\u123",
      "\\u with non-hex characters": "\\uGGGG",
      "a bare \\u": "\\u",
      "\\x with a non-hex first character": "\\xZ1",
      "\\x with 1 hex digit": "\\x1",
      "\\U with 7 hex digits": "\\U1234567",
      "a bare \\U": "\\U",
    };
    const NOT_ESCAPE_SHAPES = {
      "a literal-string table header": (b) => [`[projects.'${b}']`, 'trust_level = "trusted"'],
      "a literal-string value": (b) => [`path = '${b}'`],
      "a literal-string key": (b) => [`'${b}' = 1`],
      "an element of a multi-line array": (b) => ["paths = [", `  '${b}',`, "]"],
    };
    for (const [bodyName, body] of Object.entries(NOT_ESCAPES)) {
      for (const [shapeName, shape] of Object.entries(NOT_ESCAPE_SHAPES)) {
        eachValid(`${bodyName} in ${shapeName} is not an escape`, shape(body));
      }
    }

    // A realistic Codex config on Windows: a multi-line notify array, project tables keyed by Windows paths
    // and an MCP server whose command is a Windows path. With the windows setting FIRST the result is found;
    // with it LAST the `[windows]` line is a mention, by design (the fix is to move it to the top).
    const WINDOWS_CODEX = (...before) => [
      'model = "model-config"',
      'sandbox_mode = "workspace-write"',
      "notify = [",
      '  "node",',
      '  "notify.js",',
      "]",
      ...before,
      "[projects.'C:\\Users\\me\\repo']",
      'trust_level = "trusted"',
      "[projects.'C:\\Users\\me\\other']",
      'trust_level = "untrusted"',
      "[mcp_servers.x]",
      "command = 'C:\\Program Files\\nodejs\\node.exe'",
    ];
    const WINDOWS_CODEX_FORMS = {
      "a multi-line notify array": () => WINDOWS_CODEX(),
      "a multi-line notify array and a multiline string": (d) => WINDOWS_CODEX(`developer_instructions = ${d}`, "Be careful.", d),
    };
    for (const [name, build] of Object.entries(WINDOWS_CODEX_FORMS)) {
      eachCase(`found: [windows] sandbox = elevated first, then a Windows Codex config with ${name}`,
        (d) => ["[windows]", 'sandbox = "elevated"', ...build(d)], isFound);
      eachCase(`found: windows.sandbox = unelevated first, then a Windows Codex config with ${name}`,
        (d) => ['windows.sandbox = "unelevated"', ...build(d)],
        (result, label) => assert.deepEqual(pick(result), found("unelevated"), `${label}: ${JSON.stringify(pick(result))}`));
      eachCase(`missing-key: a Windows Codex config with ${name} and no windows setting`, build, isMissing);
      eachCase(`invalid: a Windows Codex config with ${name}, then [windows] sandbox = elevated, is a mention at the [windows] line`,
        (d) => [...build(d), "[windows]", 'sandbox = "elevated"'], mentionAt(build('"""').length + 1));
    }

    // Complete escapes are still mentions, in a quoted key or a string value, with the hex in either case and
    // with more characters after the required digits. The first of the rows is the mention.
    const ESCAPES = {
      "\\u0077indows (\\u + 4 hex digits)": "\\u0077indows",
      "\\u0073andbox": "\\u0073andbox",
      "sa\\u006Edbox (upper-case hex)": "sa\\u006Edbox",
      "sa\\u006edbox (lower-case hex)": "sa\\u006edbox",
      "\\uAbCd (mixed-case hex)": "\\uAbCd",
      "\\u00771 (\\u + 4 hex digits, then more hex)": "\\u00771",
      "\\U00000077indows (\\U + 8 hex digits)": "\\U00000077indows",
      "wi\\U0000006Edows (upper-case hex)": "wi\\U0000006Edows",
      "wi\\U0000006edows (lower-case hex)": "wi\\U0000006edows",
      "\\U000000771 (\\U + 8 hex digits, then more hex)": "\\U000000771",
      "\\x77indows (\\x + 2 hex digits)": "\\x77indows",
      "a\\x7Ab (upper-case hex)": "a\\x7Ab",
      "a\\x7ab (lower-case hex)": "a\\x7ab",
      "\\x771 (\\x + 2 hex digits, then more hex)": "\\x771",
      "a Windows path ending in a complete \\u0077": "C:\\Users\\u0077",
      "a complete \\u0077 before the \\U of a Windows path": "\\u0077\\Users",
    };
    const ESCAPE_SHAPES = {
      "a quoted key": (b) => [`"${b}" = 1`],
      "a string value": (b) => [`other = "${b}"`],
      "a quoted table header": (b) => [`["${b}"]`],
    };
    for (const [escapeName, body] of Object.entries(ESCAPES)) {
      for (const [shapeName, shape] of Object.entries(ESCAPE_SHAPES)) {
        eachMention(`${escapeName} in ${shapeName}`, shape(body));
      }
    }
    // The escaped windows inline table from the Codex-found bypass, after each trigger.
    const ESCAPED_NAMES = '"\\u0077indows" = { "\\u0073andbox" = "unelevated" }';
    eachCase("invalid: a multiline string, then an escaped windows inline table (line 4)",
      (d) => [`note = ${d}`, "text", d, ESCAPED_NAMES], mentionAt(4));
    eachCase("invalid: a multi-line array, then an escaped windows inline table (line 4)",
      () => ["a = [", " 1,", "]", ESCAPED_NAMES], mentionAt(4));
    // A Windows path line is not a mention and does not hide a complete escape on a later line.
    eachCase("invalid: a Windows project table, then an escaped windows key on a later line (line 6)",
      (d) => [`note = ${d}`, "text", d, ...PROJECT, '"\\u0077indows" = 1'], mentionAt(6));
    eachCase("invalid: a multi-line array, a Windows project table, then an escaped windows key (line 6)",
      () => ["a = [", " 1,", "]", ...PROJECT, '"\\u0077indows" = 1'], mentionAt(6));

    // Whole tokens only: after a trigger, a line that merely contains the letters of windows or sandbox
    // inside a longer bare-key word is not a mention. Both triggers, LF and CRLF, both delimiters.
    const TOKEN_TRIGGERS = {
      "a multi-line array": () => ["arr = [", "1,", "]"],
      "a multiline string": (d) => [`note = ${d}`, "text", d],
    };
    const NOT_MENTIONS = {
      "sandbox_mode = ...": 'sandbox_mode = "read-only"',
      "a [sandbox_workspace_write] header": "[sandbox_workspace_write]",
      "windows-foo = ...": "windows-foo = 1",
      "xwindows = ...": "xwindows = 1",
      "sandbox2 = ...": "sandbox2 = 1",
      "a --sandbox flag in a one-line array": 'args = [ "--sandbox" ]',
    };
    for (const [triggerName, trigger] of Object.entries(TOKEN_TRIGGERS)) {
      for (const [name, line] of Object.entries(NOT_MENTIONS)) {
        eachCase(`missing-key: ${name} after ${triggerName} is not a whole-token mention`,
          (d) => [...trigger(d), line], (result, label) => isMissing(result, label));
      }
    }
    // ... while a token is a mention however it is bounded by non-key characters. (A quoted token that stood
    // alone on its line, `"windows"` or `'sandbox'`, is a key with no `=`, which the tracker now rejects before
    // the mention rule is consulted, so the quoted keys carry a value.)
    const TOKEN_MENTIONS = {
      "a spaced header [ windows ]": "[ windows ]",
      'a quoted "windows" key': '"windows" = 1',
      "a literal-quoted 'sandbox' key": "'sandbox' = 1",
      "a dotted a.sandbox key": "a.sandbox = 1",
      "a comment # Windows note": "# Windows note",
      "an upper-case SANDBOX key": "SANDBOX = 1",
    };
    for (const [triggerName, trigger] of Object.entries(TOKEN_TRIGGERS)) {
      for (const [name, line] of Object.entries(TOKEN_MENTIONS)) {
        const nextLine = trigger('"""').length + 1;
        eachCase(`invalid: ${name} after ${triggerName} is a whole-token mention (line ${nextLine})`,
          (d) => [...trigger(d), line], mentionAt(nextLine));
      }
    }

    // A realistic Codex config: sandbox_mode keys, a [sandbox_workspace_write] table, a multi-line notify
    // array, an MCP server with a multi-line args array and an env inline table, and a profile. None of its
    // lines is a mention, so with the windows setting FIRST the result is found; with it LAST (after the
    // multi-line values) the `[windows]` line is a mention, by design (the fix is to move it to the top).
    const REALISTIC = [
      'model = "model-config"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "notify = [",
      '  "node",',
      '  "notify.js",',
      "]",
      "[sandbox_workspace_write]",
      "network_access = false",
      "[mcp_servers.docs]",
      'command = "npx"',
      "args = [",
      '  "-y",',
      '  "docs-mcp",',
      "]",
      'env = { "API_URL" = "https://example.invalid" }',
      "[profiles.review]",
      'sandbox_mode = "read-only"',
    ];
    eachCase("missing-key: a realistic config with no windows setting is unaffected",
      () => REALISTIC, (result, label) => isMissing(result, label));
    eachCase("found: [windows] sandbox = elevated first, then a realistic config",
      () => ["[windows]", 'sandbox = "elevated"', ...REALISTIC], (result, label) => isFound(result, label));
    eachCase("found: windows.sandbox = unelevated first, then a realistic config",
      () => ['windows.sandbox = "unelevated"', ...REALISTIC],
      (result, label) => assert.deepEqual(pick(result), found("unelevated"), `${label}: ${JSON.stringify(pick(result))}`));
    eachCase(`invalid: a realistic config, then [windows] sandbox = elevated, is a mention at the [windows] line (line ${REALISTIC.length + 1})`,
      () => [...REALISTIC, "[windows]", 'sandbox = "elevated"'], mentionAt(REALISTIC.length + 1));
    eachCase("invalid: a multiline developer_instructions string, then windows.sandbox, is a mention (line 4)",
      (d) => [`developer_instructions = ${d}`, "Be careful.", d, 'windows.sandbox = "elevated"'], mentionAt(4));

    // The Codex-found bypasses and the loop-1 to loop-4 repros, kept in one place as a regression table:
    // every one of them must be invalid whatever the exact reason. (Their reasons are pinned in the blocks
    // above.) LF and CRLF, both delimiters where one appears.
    const BYPASSES = {
      "1. a fake [other] header in a string, then windows = { sandbox = ... }": (d) => [`note = ${d}`, "[other]", d, 'windows = { sandbox = "unelevated" }'],
      "1. the same after a valid dotted target": (d) => [TARGET, `note = ${d}`, "[other]", d, 'windows = { sandbox = "unelevated" }'],
      "2. a fake [[other]] header in a string": (d) => [`note = ${d}`, "[[other]]", d, 'windows = { sandbox = "unelevated" }'],
      "2. a fake [a.b] header in a string": (d) => [`note = ${d}`, "[a.b]", d, 'windows = { sandbox = "unelevated" }'],
      "3. windows = { note = <d> opening a string, closing with a bare sandbox key": (d) => [`windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`],
      '3. the same with a quoted "sandbox" key on the closing line': (d) => [`windows = { note = ${d}`, "[other]", `${d}, "sandbox" = "unelevated" }`],
      "3. the same after a valid dotted target": (d) => [TARGET, `windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`],
      "4. a fake [\"other\"] array element, then windows = { note = <d> ...": (d) => ["arr = [", '["other"]', ", 1]", `windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`],
      '5. a fake ["windows"] array element, then a top-level sandbox key': () => ["arr = [", '["windows"]', ", 1]", 'sandbox = "elevated"'],
      "6. a sandbox key inside a multi-line inline table under [windows]": () => ["[windows]", "other = {", 'sandbox = "elevated"', "}"],
      "7. an unterminated string inside an inline table under [windows]": () => ["[windows]", "other = {", 'note = "unterminated', 'sandbox = "elevated"', "}"],
      "7. an unterminated literal string inside an array": () => ["a = [", "'unterminated"],
      "7. a } closing an open array under [windows]": () => ["[windows]", "other = [", "}", 'sandbox = "elevated"', "]"],
      "7. a ] closing an open inline table under [windows]": () => ["[windows]", "other = {", "]", 'sandbox = "elevated"', "}"],
      "7. a top-level unterminated string, then a [windows] table": () => ['note = "unterminated', "[windows]", 'sandbox = "elevated"'],
      "7. a stray multiline delimiter after a complete value": (d) => [`note = 1 ${d}`, "[windows]", 'sandbox = "elevated"'],
      "8. ] sandbox = ... closing a multi-line array, then a sandbox key": () => ["[windows]", "other = [", '] sandbox = "unelevated"', 'sandbox = "elevated"'],
      "8. the same without the last line": () => ["[windows]", "other = [", '] sandbox = "unelevated"'],
      "8. } sandbox = ... closing a multi-line inline table, then a sandbox key": () => ["[windows]", "other = {", '} sandbox = "unelevated"', 'sandbox = "elevated"'],
      "8. the same without the last line (inline table)": () => ["[windows]", "other = {", '} sandbox = "unelevated"'],
    };
    for (const [name, build] of Object.entries(BYPASSES)) {
      eachCase(`bypass repro stays invalid: ${name}`, build, (result, label) => {
        assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      });
    }
    // The BOM variant of repro 3 (a BOM does not shift line numbers or hide the first line).
    for (const d of DELIMS) {
      for (const [eolName, eol] of EOLS) {
        it(`bypass repro stays invalid: 3. the same with a UTF-8 BOM before it [${d} ${eolName}]`, () => {
          const result = scan(`\uFEFF${doc(eol, `windows = { note = ${d}`, "[other]", `${d}, x = 1, sandbox = "unelevated" }`)}`);
          assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        });
      }
    }
  });

  describe("returns missing-key, never an error, when there is no target", () => {
    const MISSING = {
      "empty input": "",
      "only a BOM": "\uFEFF",
      "only comments and blank lines": t("# a", "", "   ", "# b"),
      "unrelated tables only": t("[mcp_servers.x]", 'command = "y"', "[profiles.dev]", 'model = "z"'),
      "top-level sandbox key is not windows.sandbox": 'sandbox = "elevated"',
      "[windows] without the key": t("[windows]", "sandbox_private_desktop = true"),
      "literal key \"windows.sandbox\" is not the dotted key": '"windows.sandbox" = "elevated"',
      "literal single-quoted key 'windows.sandbox'": "'windows.sandbox' = 'elevated'",
      "profile table": t("[profiles.dev.windows]", 'sandbox = "elevated"'),
      "nested table under windows": t("[windows.nested]", 'sandbox = "elevated"'),
      "dotted key below another table": t("[other]", 'windows.sandbox = "elevated"'),
      "array of tables named windows": t("[[windows]]", 'sandbox = "elevated"'),
      "array of tables under another name": t("[[tools.windows]]", 'sandbox = "elevated"'),
      "key under a table that follows [windows]": t("[windows]", "foo = 1", "[other]", 'sandbox = "elevated"'),
      "target-looking text in a full-line comment": t("[windows]", '# sandbox = "elevated"'),
      "[windows] header only inside a comment": t("# [windows]", 'sandbox = "elevated"'),
      "target-looking text inside another key's value": t("[windows]", 'description = "sandbox = elevated"'),
      "unrelated unsupported syntax (unterminated header)": t("[oops", "x = 1"),
      "unrelated multi-line array": t("list = [", "  1,", "  2,", "]"),
      // Raw junk bytes with no = (the old fixture, `00 01 02 ff fe 0a 80 81`) are a key with no =, pinned as
      // invalid below; here the same bytes sit where TOML allows them, in a string value and in a comment.
      "binary junk inside a string value and a comment": Buffer.concat([
        Buffer.from('junk = "'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.from('"\n# '), Buffer.from([0x80, 0x81]), Buffer.from("\n"),
      ]),
    };
    for (const [name, text] of Object.entries(MISSING)) {
      it(`missing-key: ${name}`, () => {
        assert.deepEqual(pick(scan(text)), missing);
      });
    }

    // Was missing-key before the key-position rule: a line of key characters with no = is one the scan cannot follow.
    it("invalid, no longer missing-key: binary junk with no = cannot be followed (line 1)", () => {
      assert.deepEqual(scan(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x80, 0x81])), {
        status: "invalid",
        reason: "the scan cannot follow the syntax here and cannot classify the lines after it (line 1)",
      });
    });

    // Was missing-key before the missing-value fix: a line that ends right after `=` is one the scan cannot follow.
    it("invalid, no longer missing-key: unrelated unsupported syntax (dangling =) cannot be followed (line 1)", () => {
      assert.deepEqual(scan(t("weird = ", "= 5")), {
        status: "invalid",
        reason: "the scan cannot follow the syntax here and cannot classify the lines after it (line 1)",
      });
    });
  });

  describe("rejects a present but unusable target as invalid", () => {
    const INVALID = {
      "wrong case": t("[windows]", 'sandbox = "Elevated"'),
      "upper case": t("[windows]", 'sandbox = "ELEVATED"'),
      "padded value": t("[windows]", 'sandbox = " elevated"'),
      "trailing space in value": t("[windows]", 'sandbox = "elevated "'),
      "unknown value": t("[windows]", 'sandbox = "other"'),
      "empty value": t("[windows]", 'sandbox = ""'),
      "bare word": t("[windows]", "sandbox = elevated"),
      "integer": t("[windows]", "sandbox = 1"),
      "boolean": t("[windows]", "sandbox = true"),
      "array": t("[windows]", 'sandbox = ["elevated"]'),
      "inline table value": t("[windows]", "sandbox = { x = 1 }"),
      "trailing junk after the value": t("[windows]", 'sandbox = "elevated" junk'),
      "two scalars": t("[windows]", 'sandbox = "elevated" "unelevated"'),
      "unterminated string": t("[windows]", 'sandbox = "elevated'),
      "mismatched quotes": t("[windows]", `sandbox = 'elevated"`),
      "no value": t("[windows]", "sandbox ="),
      "escaped value (basic string)": t("[windows]", 'sandbox = "elev\\u0061ted"'),
      "escaped value (literal string)": t("[windows]", "sandbox = 'elev\\u0061ted'"),
      "multiline basic string": t("[windows]", 'sandbox = """elevated"""'),
      "multiline literal string": t("[windows]", "sandbox = '''elevated'''"),
      "multiline value across lines": t("[windows]", 'sandbox = """', "elevated", '"""'),
      "duplicate in the table": t("[windows]", 'sandbox = "elevated"', 'sandbox = "elevated"'),
      "duplicate with different values": t("[windows]", 'sandbox = "elevated"', 'sandbox = "unelevated"'),
      "table plus top-level dotted key": t('windows.sandbox = "elevated"', "[windows]", 'sandbox = "elevated"'),
      "two top-level dotted keys": t('windows.sandbox = "elevated"', 'windows . sandbox = "unelevated"'),
      "dotted key duplicated with mixed quoting": t('windows.sandbox = "elevated"', `"windows"."sandbox" = 'elevated'`),
      "second [windows] table repeats the key": t("[windows]", 'sandbox = "elevated"', "[other]", "x = 1", "[windows]", 'sandbox = "elevated"'),
      "valid target then an invalid later target": t("[windows]", 'sandbox = "elevated"', "[other]", "[windows]", "sandbox = bare"),
      "duplicate placed near EOF": t('windows.sandbox = "elevated"', "k = 1\n".repeat(50_000), "[windows]", 'sandbox = "elevated"'),
      "inline table defining the target": t('windows = { sandbox = "elevated" }'),
      "inline table, no spaces": t('windows={sandbox="elevated"}'),
      "multiline delimiter before the table": t('note = """', "x", '"""', "[windows]", 'sandbox = "elevated"'),
      "multiline string, then a [windows] header with no target (a mention, by the mention rule)": t('note = """', "hello", "world", '"""', "[windows]", "other = 1"),
      "single-line triple quote before the dotted key": t("note = '''x'''", 'windows.sandbox = "elevated"'),
      "unclosed multiline delimiter before the target": t('note = """', "[windows]", 'sandbox = "elevated"'),
      "valid target followed (after a delimiter) by another target-looking line": t("[windows]", 'sandbox = "elevated"', 'note = """', "x", '"""', "[windows]", 'sandbox = "elevated"'),
    };
    for (const [name, text] of Object.entries(INVALID)) {
      it(`invalid: ${name}`, () => {
        const result = scan(text);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.equal(typeof result.reason, "string");
        assert.ok(result.reason.length > 0, "reason must say something");
      });
    }

    it("never echoes the rejected value or any configuration line in its reason", () => {
      const canary = "CANARY-9f3a7c";
      const inputs = [
        t("[windows]", `sandbox = "${canary}"`),
        t("[windows]", `sandbox = ${canary}`),
        t("[windows]", 'sandbox = "elevated"', `sandbox = "${canary}"`),
        t(`note = """${canary}`, "[windows]", 'sandbox = "elevated"'),
        t(`windows = { sandbox = "${canary}" }`),
      ];
      for (const text of inputs) {
        const result = scan(text);
        assert.equal(result.status, "invalid", text);
        assert.ok(!JSON.stringify(result).includes(canary), `reason leaked configuration content: ${JSON.stringify(result)}`);
      }
    });
  });

  describe("bounded line storage", () => {
    const cap = () => {
      const bound = R().MAX_CONFIG_LINE_BYTES;
      assert.ok(Number.isSafeInteger(bound) && bound > 0, "relay.mjs must export MAX_CONFIG_LINE_BYTES");
      return bound;
    };
    const over = () => "x".repeat(cap() + 1024);
    // A comment line of exactly `size` bytes (without its newline).
    const comment = (size) => `#${"c".repeat(size - 1)}`;
    const TOO_LONG = /^a line is longer than the 1 MiB limit \(line \d+\)$/;
    it("the cap is 1 MiB", () => {
      assert.equal(cap(), 1024 * 1024);
    });
    // Review loop 3: any line longer than the cap is invalid, whatever it holds. There is no
    // "clearly unrelated" discard any more: the line's bytes are never inspected.
    it("any line longer than the cap is invalid with a fixed reason, even when it looks unrelated", () => {
      for (const text of [
        t(`other = "${over()}"`, "[windows]", 'sandbox = "elevated"'),
        t(`other = "${over()}"`),
        t(`# ${over()}`, "[windows]", 'sandbox = "elevated"'),
        t("[windows]", 'sandbox = "elevated"', `note = "${over()}"`),
      ]) {
        const result = scan(text);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.match(result.reason, TOO_LONG);
      }
    });
    it("an overlong line that looks like the target is invalid and the reason does not echo the line", () => {
      const result = scan(t("[windows]", `sandbox = "elevated" # ${over()}`));
      assert.equal(result.status, "invalid");
      assert.ok(!JSON.stringify(result).includes("xxxxxxxx"), "must not echo the line");
      assert.match(result.reason, TOO_LONG);
    });
    // A line is the bytes before its "\n"; a trailing "\r" counts toward the cap.
    it("a line of exactly the cap is parsed normally; one byte over is invalid", () => {
      const limit = cap();
      assert.deepEqual(pick(scan(t(comment(limit), "[windows]", 'sandbox = "elevated"', ""))), found("elevated"));
      assert.deepEqual(pick(scan(t(comment(limit), "[windows]", 'sandbox = "elevated"'))), found("elevated"), "no trailing newline");
      assert.deepEqual(pick(scan(comment(limit))), missing, "a cap-sized line at EOF without a newline");
      for (const text of [t(comment(limit + 1), "[windows]", 'sandbox = "elevated"', ""), comment(limit + 1)]) {
        const result = scan(text);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.match(result.reason, TOO_LONG);
        assert.ok(!result.reason.includes("ccc"), "the reason must not echo the line");
      }
    });
    it("a trailing CR counts toward the cap: cap bytes before the newline pass, cap + 1 fail", () => {
      const limit = cap();
      assert.deepEqual(pick(scan(`${comment(limit - 1)}\r\n[windows]\r\nsandbox = "elevated"\r\n`)), found("elevated"));
      assert.equal(scan(`${comment(limit)}\r\n[windows]\r\nsandbox = "elevated"\r\n`).status, "invalid");
    });
    it("the reason names the line number (and only that) of the first overlong line", () => {
      const limit = cap();
      const result = scan(t("a = 1", "b = 2", comment(limit + 5), "c = 3", comment(limit + 9), ""));
      assert.deepEqual(result, { status: "invalid", reason: "a line is longer than the 1 MiB limit (line 3)" });
      assert.equal(scan(comment(limit + 1)).reason, "a line is longer than the 1 MiB limit (line 1)");
    });
    it("an earlier invalid verdict is kept when a later line is overlong", () => {
      const result = scan(t("[windows]", "sandbox = bare", comment(cap() + 1), ""));
      assert.equal(result.status, "invalid");
      assert.match(result.reason, /not a supported literal/);
    });
    it("a line well over the cap does not break the lines after it: the verdict is still the overlong line's", () => {
      const result = scan(t(`# ${"c".repeat(3 * cap())}`, "[windows]", 'sandbox = "elevated"', ""));
      assert.equal(result.status, "invalid");
      assert.match(result.reason, /line 1\)$/);
    });
  });

  // Plan 4.2: "Discard an overlong line only when safely identified as unrelated; otherwise return an
  // ambiguity error." A line over the cap is never inspected, so it is never safely identified as
  // unrelated: it is an error, and a target hidden behind padding is never silently treated as blank.
  // Lines at or under the cap, however padded, are parsed normally.
  describe("overlong lines fail closed", () => {
    const bound = () => {
      const value = R().MAX_CONFIG_LINE_BYTES;
      assert.ok(Number.isSafeInteger(value) && value > 0, "relay.mjs must export MAX_CONFIG_LINE_BYTES");
      return value;
    };
    const spaces = (n) => " ".repeat(n);
    const TARGET = 'sandbox = "unelevated"';
    const expectInvalid = (text, label) => {
      const result = scan(text);
      assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
      assert.equal(typeof result.reason, "string", label);
      assert.ok(result.reason.length > 0, `${label}: reason must say something`);
      assert.ok(!result.reason.includes("   "), `${label}: the reason must not echo the line`);
    };

    it("a target hidden behind leading padding is never missed: found up to the cap, invalid once the line outgrows it", () => {
      const limit = bound();
      for (let pad = limit - TARGET.length - 4; pad <= limit - TARGET.length + 4; pad += 1) {
        const total = pad + TARGET.length;
        const result = scan(t("[windows]", `${spaces(pad)}${TARGET}`));
        assert.notEqual(result.status, "missing-key", `pad ${pad} (line ${total} bytes, bound ${limit}): the target was dropped`);
        if (total > limit) assert.equal(result.status, "invalid", `pad ${pad} (line ${total} bytes, bound ${limit}): ${JSON.stringify(pick(result))}`);
        else assert.deepEqual(pick(result), found("unelevated"), `pad ${pad} (line ${total} bytes): a line inside the bound is parsed normally`);
      }
    });

    it("a target behind 4097 and 5000 bytes of padding is an ordinary line: found", () => {
      for (const pad of [4097, 5000, 65536]) {
        assert.deepEqual(pick(scan(t("[windows]", `${spaces(pad)}${TARGET}`, ""))), found("unelevated"), `${pad} spaces`);
        assert.deepEqual(pick(scan(t(`${spaces(pad)}windows.sandbox = "unelevated"`, ""))), found("unelevated"), `${pad} spaces, dotted`);
      }
    });

    it("a target hidden behind padding beyond the cap is invalid for spaces, tabs, and without a trailing newline", () => {
      const over = bound() + 1024;
      expectInvalid(t("[windows]", `${spaces(over)}${TARGET}`, ""), "spaces, newline");
      expectInvalid(t("[windows]", `${spaces(over)}${TARGET}`), "spaces, EOF");
      expectInvalid(t("[windows]", `${"\t".repeat(over)}${TARGET}`, ""), "tabs");
      expectInvalid(t("[windows]", `${spaces(bound() + 1)}${TARGET}`, ""), "one byte over");
      expectInvalid(t("[windows]", `${spaces(3 * bound())}${TARGET}`, ""), "three times over");
      expectInvalid(t("[windows]", `${spaces(over)}${TARGET}`, "").replace(/\n/g, "\r\n"), "CRLF");
    });

    it("the equivalent top-level windows.sandbox form behind padding is invalid too", () => {
      const over = spaces(bound() + 1024);
      expectInvalid(t(`${over}windows.sandbox = "unelevated"`, ""), "dotted key behind padding");
      expectInvalid(t(`${over}"windows"."sandbox" = "unelevated"`, ""), "quoted dotted key behind padding");
      expectInvalid(t(`${over}windows . sandbox = 'unelevated'`), "spaced dotted key behind padding, EOF");
    });

    it("a duplicate hidden behind padding is rejected, whether it follows or precedes the valid definition", () => {
      const over = spaces(bound() + 1024);
      expectInvalid(t("[windows]", 'sandbox = "elevated"', `${over}sandbox = "unelevated"`, ""), "different value after");
      expectInvalid(t("[windows]", 'sandbox = "elevated"', `${over}sandbox = "elevated"`, ""), "same value after");
      expectInvalid(t("[windows]", `${over}sandbox = "unelevated"`, 'sandbox = "elevated"', ""), "before");
      expectInvalid(t('windows.sandbox = "elevated"', `${over}windows.sandbox = "unelevated"`, ""), "top-level form after");
      expectInvalid(t('windows.sandbox = "elevated"', "[windows]", `${over}sandbox = "unelevated"`, ""), "table form after a dotted key");
    });

    it("an overlong line holding an incomplete dotted key is invalid, not blank", () => {
      const over = spaces(bound() + 512);
      const CASES = {
        "windows. <padding> sandbox": `windows.${over}sandbox = "unelevated"`,
        "windows <padding> .sandbox": `windows${over}.sandbox = "unelevated"`,
        "windows . <padding> sandbox": `windows .${over}sandbox = "unelevated"`,
        "quoted windows. <padding> quoted sandbox": `"windows".${over}"sandbox" = "unelevated"`,
        "windows.sandbox <padding> =": `windows.sandbox${over}= "unelevated"`,
      };
      for (const [label, line] of Object.entries(CASES)) expectInvalid(t(line, ""), `top level: ${label}`);
      expectInvalid(t("[windows]", `sandbox${over}= "unelevated"`, ""), "inside [windows]: sandbox <padding> =");
      expectInvalid(t("[windows]", 'sandbox = "elevated"', `windows.${over}sandbox = "unelevated"`, ""), "after a valid target, top-level-looking key inside [windows]");
    });

    // `windows = <padding>{ sandbox = "..." }` defines windows.sandbox through an inline table. The
    // line is over the cap, so it is invalid whatever it holds (and under the cap it is an unsupported
    // inline table, also invalid).
    const INLINE = '{ sandbox = "unelevated" }';
    it("an overlong assignment to the windows ancestor whose value starts beyond the cap is invalid", () => {
      const over = spaces(bound() + 1);
      const CASES = {
        "windows = <padding>{ sandbox }": `windows = ${over}${INLINE}`,
        "windows=<padding>{ sandbox }": `windows=${over}${INLINE}`,
        "indented key and padded =": `  windows  =  ${over}${INLINE}`,
        "tab padding": `windows =${"\t".repeat(bound() + 1)}${INLINE}`,
        "double-quoted windows": `"windows" = ${over}${INLINE}`,
        "single-quoted windows": `'windows' = ${over}${INLINE}`,
        "escaped windows": `"\\u0077indows" = ${over}${INLINE}`,
        "padding then a plain string value": `windows = ${over}"elevated"`,
      };
      for (const [label, line] of Object.entries(CASES)) {
        expectInvalid(t(line, ""), `${label}, newline`);
        expectInvalid(t(line), `${label}, EOF`);
        expectInvalid(t(line, "other = 1"), `${label}, then an unrelated key`);
      }
    });

    it("the ancestor assignment is invalid at every padding length around the cap boundary (an inline table at or under it, an overlong line over it)", () => {
      const limit = bound();
      for (let pad = limit - 14 - INLINE.length; pad <= limit - 6 - INLINE.length; pad += 1) {
        const text = t(`windows = ${spaces(pad)}${INLINE}`, "");
        const result = scan(text);
        assert.equal(result.status, "invalid", `pad ${pad} (line ${10 + pad + INLINE.length} bytes, bound ${limit}): ${JSON.stringify(pick(result))}`);
        assert.match(result.reason, 10 + pad + INLINE.length > limit ? /1 MiB limit/ : /inline table/, `pad ${pad}`);
      }
    });

    it("an ancestor assignment hidden behind padding is not hidden by a valid definition elsewhere", () => {
      const over = spaces(bound() + 1);
      const hidden = `windows = ${over}${INLINE}`;
      const result = scan(t('windows.sandbox = "elevated"', hidden, ""));
      assert.notDeepEqual(pick(result), found("elevated"), "the earlier valid definition must not win over a hidden redefinition");
      expectInvalid(t('windows.sandbox = "elevated"', hidden, ""), "after a valid dotted definition");
      expectInvalid(t('windows.sandbox = "elevated"', hidden), "after a valid dotted definition, EOF");
      expectInvalid(t('windows.sandbox = "elevated"', `"windows" = ${over}${INLINE}`, ""), "double-quoted ancestor after a valid definition");
      expectInvalid(t('windows.sandbox = "elevated"', `"\\u0077indows" = ${over}${INLINE}`, ""), "escaped ancestor after a valid definition");
      expectInvalid(t(hidden, 'windows.sandbox = "elevated"', ""), "before a valid dotted definition");
      expectInvalid(t(hidden, "[windows]", 'sandbox = "elevated"', ""), "before a valid [windows] table");
    });

    it("inside [windows], a key that could be the target followed by padding is invalid, not blank", () => {
      const over = spaces(bound() + 1);
      const CASES = {
        "sandbox = <padding>value": `sandbox = ${over}"unelevated"`,
        "sandbox=<padding>value": `sandbox=${over}"unelevated"`,
        "sandbox = <padding>inline table": `sandbox = ${over}{ x = 1 }`,
        "double-quoted sandbox = <padding>": `"sandbox" = ${over}"unelevated"`,
        "escaped sandbox = <padding>": `"\\u0073andbox" = ${over}"unelevated"`,
        "sandbox.sub = <padding>": `sandbox.sub = ${over}1`,
        "sandbox <padding> .sub": `sandbox${over}.sub = 1`,
        "sandbox <padding> =": `sandbox${over}= "unelevated"`,
      };
      for (const [label, line] of Object.entries(CASES)) {
        expectInvalid(t("[windows]", line, ""), label);
        expectInvalid(t("[windows]", 'sandbox = "elevated"', line, ""), `${label}, after a valid target`);
      }
      expectInvalid(t('["\\u0077indows"]', `sandbox = ${over}"unelevated"`, ""), "an escaped [windows] header, then the padded key");
    });

    // Review loop 3: an overlong assignment to a different key is no longer discarded (the line is never
    // inspected), so it is invalid; the same line under the cap is an ordinary unrelated assignment.
    it("an overlong assignment to a different key is invalid, even though the same line under the cap is unrelated", () => {
      const LINES = {
        "other = <padding>{ sandbox }": (pad) => `other = ${pad}${INLINE}`,
        "windows_extra = <padding>{ sandbox }": (pad) => `windows_extra = ${pad}${INLINE}`,
        "windowsx = <padding>{ sandbox }": (pad) => `windowsx = ${pad}${INLINE}`,
        "profiles.dev = <padding>{ sandbox }": (pad) => `profiles.dev = ${pad}${INLINE}`,
        "double-quoted other": (pad) => `"other" = ${pad}${INLINE}`,
      };
      for (const [label, line] of Object.entries(LINES)) {
        for (const text of [t(line(spaces(bound() + 1)), "[windows]", 'sandbox = "elevated"'), t(line(spaces(bound() + 1)), "")]) {
          const result = scan(text);
          assert.equal(result.status, "invalid", `${label}: ${JSON.stringify(pick(result))}`);
          assert.match(result.reason, /1 MiB limit/, label);
        }
        const short = spaces(5000);
        assert.deepEqual(pick(scan(t(line(short), "[windows]", 'sandbox = "elevated"'))), found("elevated"), `${label} (5000-byte padding)`);
        assert.deepEqual(pick(scan(t(line(short), ""))), missing, `${label} (5000-byte padding): no target anywhere`);
      }
      assert.equal(scan(t("[windows]", `foo = ${spaces(bound() + 1)}${INLINE}`, 'sandbox = "elevated"')).status, "invalid", "a different key inside [windows]");
      assert.deepEqual(pick(scan(t("[windows]", `foo = ${spaces(5000)}${INLINE}`, 'sandbox = "elevated"'))), found("elevated"), "a different key inside [windows] (5000-byte padding)");
    });

    it("never echoes any part of an overlong line", () => {
      const canary = "CANARY-ovl-31";
      const over = spaces(bound() + 512);
      for (const text of [
        t("[windows]", `sandbox = "${canary}" # ${over}`),
        t(`windows.sandbox = "${canary}" # ${over}`),
        t("[windows]", 'sandbox = "elevated"', `sandbox = "${canary}" # ${over}`),
      ]) {
        const result = scan(text);
        assert.equal(result.status, "invalid", text.slice(0, 60));
        assert.ok(!JSON.stringify(result).includes(canary), `reason leaked the line: ${JSON.stringify(result)}`);
      }
    });

    // Review loop 3: there is no discard of an overlong line any more. These shapes were discarded when
    // their line outgrew 4 KiB; now they are invalid over the cap and ordinary lines under it.
    it("an overlong line that looks unrelated is invalid; the same shapes with a 5000-byte value are parsed normally", () => {
      for (const [size, expectOver] of [[bound() + 1024, true], [5000, false]]) {
        const long = "x".repeat(size);
        const KEEP = {
          "full-line comment": t(`# ${long}`, "[windows]", 'sandbox = "elevated"'),
          "different key inside [windows]": t("[windows]", `sandbox_private_desktop = "${long}"`, 'sandbox = "elevated"'),
          "different dotted key at top level": t(`profiles.dev.notes = "${long}"`, "[windows]", 'sandbox = "elevated"'),
          "different key in another table": t("[other]", `sandbox = "${long}"`, "[windows]", 'sandbox = "elevated"'),
          "different key after the target": t("[windows]", 'sandbox = "elevated"', `note = "${long}"`),
        };
        for (const [label, text] of Object.entries(KEEP)) {
          if (expectOver) assert.equal(scan(text).status, "invalid", label);
          else assert.deepEqual(pick(scan(text)), found("elevated"), `${label} (${size} bytes)`);
        }
        const noTarget = t(`note = "${long}"`, "[windows]", "other = 1");
        if (expectOver) assert.equal(scan(noTarget).status, "invalid", "no target at all, overlong");
        else assert.deepEqual(pick(scan(noTarget)), missing, "no target at all stays missing-key");
      }
    });
  });

  // Plan 4.2: "If there is no target definition or target-looking ambiguous candidate, return missing
  // key, including when unrelated unsupported syntax exists. Unsupported unrelated content must not
  // become general configuration validation." A long line is not target-looking just for being long:
  // lines up to the 1 MiB cap are parsed normally (4097 bytes is no longer special), so these harmless
  // configurations stay missing-key. Over the cap a line is invalid whatever it holds (see above).
  describe("long unrelated content is not a validation failure", () => {
    const bound = () => {
      const value = R().MAX_CONFIG_LINE_BYTES;
      assert.ok(Number.isSafeInteger(value) && value > 0, "relay.mjs must export MAX_CONFIG_LINE_BYTES");
      return value;
    };
    const spaces = (n) => " ".repeat(n);
    const sizes = () => [4097, 5000, 64 * 1024, bound() - 16];
    const expectMissing = (text, label) => {
      const result = scan(text);
      assert.equal(result.status, "missing-key", `${label}: ${JSON.stringify(result)}`);
    };

    it("a multiline basic string holding a 4097-byte line, with no sandbox anywhere, is missing-key", () => {
      for (const size of sizes()) {
        const x = "x".repeat(size);
        expectMissing(t('note = """', x, '"""', ""), `${size} bytes, newline`);
        expectMissing(t('note = """', x, '"""'), `${size} bytes, EOF`);
        expectMissing(t('note = """', x, '"""', "").replace(/\n/g, "\r\n"), `${size} bytes, CRLF`);
        expectMissing(t("[other]", "a = 1", 'note = """', x, '"""', "[more]", "b = 2", ""), `${size} bytes between unrelated tables`);
        expectMissing(t('note = """first', "second", x, "fourth", '"""', ""), `${size} bytes among shorter lines of the same string`);
      }
    });

    it("a multiline literal string holding a 4097-byte line, with no sandbox anywhere, is missing-key", () => {
      for (const size of sizes()) {
        expectMissing(t("note = '''", "x".repeat(size), "'''", ""), `${size} bytes`);
      }
    });

    it("a table header followed by 4097 bytes of trailing whitespace, with no sandbox anywhere, is missing-key", () => {
      for (const size of sizes()) {
        expectMissing(t(`[other]${spaces(size)}`, "k = 1", ""), `${size} spaces, then a key`);
        expectMissing(t(`[other]${spaces(size)}`, ""), `${size} spaces, newline`);
        expectMissing(t(`[other]${spaces(size)}`), `${size} spaces, EOF`);
        expectMissing(t(`[other]${"\t".repeat(size)}`, "k = 1", ""), `${size} tabs`);
        expectMissing(t(`[other]${spaces(size)}`, "k = 1", "").replace(/\n/g, "\r\n"), `${size} spaces, CRLF`);
        expectMissing(t("a = 1", `[other.nested]${spaces(size)}`, "k = 1", "[more]", "b = 2"), `${size} spaces, between unrelated tables`);
      }
    });

    it("a table header followed by padding and then a comment is missing-key", () => {
      for (const size of sizes()) {
        expectMissing(t(`[other]${spaces(Math.min(size, bound() - 128))}# a trailing comment after the padding`, "k = 1", ""), `${size} spaces, then a comment`);
      }
    });

    it("a padded header does not hide a real target defined before or after it", () => {
      assert.deepEqual(pick(scan(t("[other]" + spaces(5000), "k = 1", "[windows]", 'sandbox = "elevated"', ""))), found("elevated"), "padded header, then the target");
      assert.deepEqual(pick(scan(t("[windows]", 'sandbox = "unelevated"', "[other]" + spaces(5000), "k = 1", ""))), found("unelevated"), "the target, then a padded header");
    });

    it("the same long lines are invalid once they pass the cap, with a fixed reason", () => {
      for (const text of [
        t('note = """', "x".repeat(bound() + 1), '"""', ""),
        t("note = '''", "x".repeat(bound() + 1), "'''", ""),
        t(`[other]${spaces(bound() + 1)}`, "k = 1", ""),
        t(`[other]${spaces(bound() + 1)}# a comment`, "k = 1", ""),
        t("[windows]", 'sandbox = "elevated"', "[other]" + spaces(bound() + 1), "k = 1", ""),
      ]) {
        const result = scan(text);
        assert.equal(result.status, "invalid", JSON.stringify(pick(result)));
        assert.match(result.reason, /^a line is longer than the 1 MiB limit \(line \d+\)$/);
      }
    });

    // Guard, not compatibility: a target after a multiline delimiter stays ambiguous (plan 4.2),
    // whether or not a long line sits inside the string.
    it("a target after a multiline string holding a long line stays ambiguous", () => {
      const x = "x".repeat(5000);
      for (const [label, text] of Object.entries({
        "basic string": t('note = """', x, '"""', "[windows]", 'sandbox = "elevated"', ""),
        "literal string": t("note = '''", x, "'''", "[windows]", 'sandbox = "elevated"', ""),
        "dotted key after the string": t('note = """', x, '"""', 'windows.sandbox = "elevated"', ""),
      })) {
        const result = scan(text);
        assert.equal(result.status, "invalid", label);
        assert.match(result.reason, /follows a multiline string delimiter/, label);
      }
    });
  });

  // Plan 4.2: only "simple, unescaped quoted" keys are recognised. A basic-string key with an escape
  // (s is "s") may or may not name the target, and the scanner never decodes escapes, so any
  // place the target could be defined through one must be unsupported/ambiguous: neither found nor
  // missing-key.
  describe("escaped key forms that could name the target are ambiguous", () => {
    const C = "CANARY-esc-4d2";
    const ESCAPED = {
      "escaped key inside [windows]": t("[windows]", `"\\u0073andbox" = "${C}"`),
      "escaped key inside [windows], \\U form": t("[windows]", `"\\U00000073andbox" = "${C}"`),
      "escaped key inside [windows], escape mid-word": t("[windows]", `"sand\\u0062ox" = "${C}"`),
      "escaped key inside [windows], valid-looking value": t("[windows]", '"\\u0073andbox" = "unelevated"'),
      "escaped key inside [windows], after a valid target": t("[windows]", 'sandbox = "elevated"', `"\\u0073andbox" = "${C}"`),
      "escaped key inside [windows], before a valid target": t("[windows]", `"\\u0073andbox" = "${C}"`, 'sandbox = "elevated"'),
      "dotted key with an escaped sandbox component": t(`"windows"."\\u0073andbox" = "${C}"`),
      "dotted key with an escaped windows component": t(`"\\u0077indows".sandbox = "${C}"`),
      "dotted key with both components escaped": t(`"\\u0077indows"."\\u0073andbox" = "${C}"`),
      "dotted key, escaped component, spaced dots": t(`windows . "\\u0073andbox" = "${C}"`),
      "escaped table header followed by the key": t('["\\u0077indows"]', `sandbox = "${C}"`),
      "escaped table header followed by a valid-looking key": t('["\\u0077indows"]', 'sandbox = "elevated"'),
      "escaped table header followed by an escaped key": t('["\\u0077indows"]', `"\\u0073andbox" = "${C}"`),
      "inline table with an escaped sandbox key": t(`windows = { "\\u0073andbox" = "${C}" }`),
      "inline table with an escaped sandbox key, no spaces": t(`windows={"\\u0073andbox"="${C}"}`),
      "inline table under an escaped windows key": t(`"\\u0077indows" = { sandbox = "${C}" }`),
    };
    for (const [name, text] of Object.entries(ESCAPED)) {
      it(`invalid: ${name}`, () => {
        for (const input of [text, Buffer.from(text, "utf8")]) {
          const result = scan(input);
          assert.notEqual(result.status, "found", `${name}: an escaped key was accepted as a definition: ${JSON.stringify(pick(result))}`);
          assert.notEqual(result.status, "missing-key", `${name}: an escaped key that could name the target was ignored`);
          assert.equal(result.status, "invalid", name);
          assert.equal(typeof result.reason, "string");
          assert.ok(result.reason.length > 0, "reason must say something");
        }
      });
    }

    it("the reason never echoes the key, the value or any configuration line", () => {
      for (const [name, text] of Object.entries(ESCAPED)) {
        const dump = JSON.stringify(scan(text));
        for (const leaked of [C, "u0073", "u0077", "U00000073", "u0062"]) {
          assert.ok(!dump.includes(leaked), `${name}: reason leaked ${leaked}: ${dump}`);
        }
      }
    });

    it("escaped keys that cannot be the target do not poison an unrelated table or a later valid target", () => {
      const KEEP = {
        "escaped table name elsewhere": [t('[profiles."a\\tb"]', "x = 1", "[windows]", 'sandbox = "elevated"'), found("elevated")],
        "escaped key in an unrelated table": [t("[other]", '"na\\u006de" = 1', "[windows]", 'sandbox = "unelevated"'), found("unelevated")],
        "escaped key in a later unrelated table": [t("[windows]", 'sandbox = "elevated"', "[other]", '"na\\u006de" = 1'), found("elevated")],
        "escaped unrelated header and nothing else": [t('[servers."a\\u0020b"]', 'command = "x"'), missing],
      };
      for (const [name, [text, expected]] of Object.entries(KEEP)) {
        assert.deepEqual(pick(scan(text)), expected, name);
      }
    });
  });
});

// =============================================================================================
// UNIT: reading the configuration file with fixed-size reads (plan 4.2)
// =============================================================================================

describe("readWindowsSandboxSetting", () => {
  /** In-memory fs stand-in recording what the reader asks for. Supports both readSync call forms. */
  function scriptedIo(content, { openError, readError, missing } = {}) {
    const calls = { opens: [], reads: [], closes: [] };
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "", "utf8");
    let cursor = 0;
    const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const stat = () => { if (missing) throw enoent(); return { size: bytes.length, isFile: () => true, isDirectory: () => false }; };
    const io = {
      existsSync: () => !missing,
      statSync: stat, lstatSync: stat, fstatSync: stat,
      openSync(path) {
        calls.opens.push(String(path));
        if (missing) throw enoent();
        if (openError) throw Object.assign(new Error(`${openError}: simulated`), { code: openError });
        cursor = 0;
        return 3;
      },
      readSync(fd, buffer, a, b, c) {
        const form = typeof a === "object" && a !== null ? { offset: a.offset ?? 0, length: a.length ?? buffer.length - (a.offset ?? 0), position: a.position } : { offset: a, length: b, position: c };
        calls.reads.push({ fd, ...form });
        if (readError) throw Object.assign(new Error(`${readError}: simulated`), { code: readError });
        const at = form.position === null || form.position === undefined ? cursor : Number(form.position);
        const count = Math.min(form.length, Math.max(0, bytes.length - at));
        bytes.copy(buffer, form.offset, at, at + count);
        cursor = at + count;
        return count;
      },
      closeSync(fd) { calls.closes.push(fd); },
    };
    return { io, calls };
  }
  /** Exactly n bytes of short unrelated comment/blank lines. */
  function padTo(n) {
    let out = "";
    let remaining = n;
    while (remaining > 0) {
      const size = Math.min(80, remaining);
      out += size === 1 ? "\n" : `#${"p".repeat(size - 2)}\n`;
      remaining -= size;
    }
    return out;
  }
  const read = (path, io) => fn("readWindowsSandboxSetting")(path, io);
  const SAMPLE = lines("[windows]", 'sandbox = "elevated"', "");

  it("reports a missing file without treating it as an error", () => {
    const { io, calls } = scriptedIo("", { missing: true });
    assert.equal(read("/x/config.toml", io).status, "missing-file");
    assert.equal(calls.closes.length, 0, "nothing was opened, so nothing to close");
  });

  it("returns the scanner's verdict for a readable file and closes the descriptor", () => {
    const { io, calls } = scriptedIo(SAMPLE);
    const result = read("/x/config.toml", io);
    assert.equal(result.status, "found");
    assert.equal(result.value, "elevated");
    assert.deepEqual(calls.opens, ["/x/config.toml"]);
    assert.equal(calls.closes.length, 1);
    assert.equal(read("/x/config.toml", scriptedIo(lines("[a]", "b = 1")).io).status, "missing-key");
    assert.equal(read("/x/config.toml", scriptedIo(lines("[windows]", "sandbox = nope")).io).status, "invalid");
  });

  it("an existing file that cannot be opened is unreadable, not missing", () => {
    for (const code of ["EACCES", "EPERM", "EISDIR", "EBUSY"]) {
      const { io } = scriptedIo(SAMPLE, { openError: code });
      assert.equal(read("/x/config.toml", io).status, "unreadable", code);
    }
  });

  it("an I/O failure after opening is unreadable and still closes the descriptor", () => {
    const { io, calls } = scriptedIo(SAMPLE, { readError: "EIO" });
    assert.equal(read("/x/config.toml", io).status, "unreadable");
    assert.equal(calls.closes.length, 1, "descriptor closed after the failed read");
  });

  it("reads in fixed-size pieces and finds the target at every offset around a chunk boundary", () => {
    const chunk = R().CONFIG_READ_CHUNK_BYTES;
    const target = '[windows]\nsandbox = "elevated"\n';
    for (let shift = -target.length - 2; shift <= 3; shift += 1) {
      // Pad with unrelated comment lines so the target starts at byte (chunk + shift).
      const { io, calls } = scriptedIo(`${padTo(chunk + shift)}${target}`);
      const result = read("/x/config.toml", io);
      assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `shift ${shift}`);
      assert.ok(calls.reads.length >= 1);
      assert.ok(calls.reads.every((entry) => entry.length <= chunk), `every read stays within CONFIG_READ_CHUNK_BYTES (shift ${shift})`);
    }
  });

  // A CR is the first half of a CRLF line ending only when a line feed follows it. The reader hands the
  // scanner fixed-size pieces, so the CR and its line feed can fall into two reads, and the last read can
  // end in a CR with nothing after it. `place` pads the file with comment lines so that the CR at
  // `body[crIndex]` lands at byte (chunk - 1 + shift): shift 0 makes it the last byte of the first read,
  // -1 the one before it, 1 the first byte of the second read.
  describe("a CR at a read boundary", () => {
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollow = (line) => ({ status: "invalid", reason: `${CANNOT_FOLLOW} (line ${line})` });
    const lineCount = (text) => text.split("\n").length - 1;
    const SHIFTS = [-3, -2, -1, 0, 1, 2, 3];
    const place = (body, crIndex, shift) => {
      assert.equal(body[crIndex], "\r", "crIndex points at a CR");
      const pad = padTo(R().CONFIG_READ_CHUNK_BYTES - 1 + shift - crIndex);
      const text = `${pad}${body}`;
      assert.equal(Buffer.from(text)[R().CONFIG_READ_CHUNK_BYTES - 1 + shift], 0x0d, `the CR sits at byte ${R().CONFIG_READ_CHUNK_BYTES - 1 + shift}`);
      return { text, lines: lineCount(pad) };
    };

    it("a CRLF split across two reads stays a line ending: the CR ends one read, the line feed starts the next", () => {
      const body = '[windows]\r\nsandbox = "elevated"\r\n';
      for (const [which, crIndex] of [["the header's", body.indexOf("\r")], ["the real key's", body.lastIndexOf("\r")]]) {
        for (const shift of SHIFTS) {
          const { text } = place(body, crIndex, shift);
          const { io, calls } = scriptedIo(text);
          const result = read("/x/config.toml", io);
          assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `${which} CR, shift ${shift}: ${JSON.stringify(result)}`);
          assert.ok(calls.reads.length >= 2, "the file takes more than one read");
        }
      }
    });

    it("a CRLF split across two reads on an unrelated line stays valid, with and without the real key", () => {
      const body = 'other = [1] # note\r\n[windows]\nsandbox = "elevated"\n';
      const without = "other = [1] # note\r\n[other]\n";
      for (const shift of SHIFTS) {
        const withKey = read("/x/config.toml", scriptedIo(place(body, body.indexOf("\r"), shift).text).io);
        assert.deepEqual({ status: withKey.status, value: withKey.value }, { status: "found", value: "elevated" }, `shift ${shift}: ${JSON.stringify(withKey)}`);
        const noKey = read("/x/config.toml", scriptedIo(place(without, without.indexOf("\r"), shift).text).io);
        assert.equal(noKey.status, "missing-key", `no real key, shift ${shift}: ${JSON.stringify(noKey)}`);
      }
    });

    it("a last read that ends in a CR with no line feed after it is invalid, at every offset around the boundary", () => {
      const bodies = {
        "the real key is the last line": '[windows]\nsandbox = "elevated"\r',
        "the review repro, `other = 1` after the real key": 'windows.sandbox = "elevated"\nother = 1\r',
        "no target, one unrelated line": "other = 1\r",
        "the last line is just the CR": '[windows]\nsandbox = "elevated"\n\r',
      };
      for (const [name, body] of Object.entries(bodies)) {
        for (const shift of SHIFTS) {
          const { text, lines } = place(body, body.length - 1, shift);
          const { io } = scriptedIo(text);
          const expectedLine = lines + body.split("\n").length;
          assert.deepEqual(read("/x/config.toml", io), cannotFollow(expectedLine), `${name}, shift ${shift}`);
        }
      }
    });

    it("a CR that ends one read and is followed by something other than a line feed is lone", () => {
      const body = '[windows]\nsandbox = "elevated"\r# note\n';
      for (const shift of SHIFTS) {
        const { text, lines } = place(body, body.indexOf("\r"), shift);
        assert.deepEqual(read("/x/config.toml", scriptedIo(text).io), cannotFollow(lines + 2), `shift ${shift}`);
      }
    });
  });

  // The missing-value verdict (a line that ends where a value is expected) and the open-multiline-string
  // verdict (checked once the last read is in) must not depend on where a read ends: the scanner joins a
  // line that spans two reads, and a read may end on the `=`, inside a delimiter or on the last byte of the
  // file. `placeAt` pads the file with comment lines so that `body[index]` lands at byte (chunk - 1 + shift).
  describe("a missing value and an open multiline string at a read boundary", () => {
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollow = (line) => ({ status: "invalid", reason: `${CANNOT_FOLLOW} (line ${line})` });
    const stringOpen = (line) => ({ status: "invalid", reason: `a multiline string is still open at the end of the file (line ${line})` });
    const SHIFTS = [-3, -2, -1, 0, 1, 2, 3];
    const TARGET = 'windows.sandbox = "elevated"';
    const lineCount = (text) => text.split("\n").length - 1;
    const placeAt = (body, index, shift) => {
      const at = R().CONFIG_READ_CHUNK_BYTES - 1 + shift;
      const pad = padTo(at - index);
      assert.equal(Buffer.byteLength(pad), at - index, "the padding is exactly as long as asked");
      return { text: `${pad}${body}`, lines: lineCount(pad) };
    };
    const check = (body, index, expected) => {
      for (const shift of SHIFTS) {
        const { text, lines } = placeAt(body, index, shift);
        assert.deepEqual(read("/x/config.toml", scriptedIo(text).io), expected(lines), `${JSON.stringify(body)} at ${index}, shift ${shift}`);
      }
    };

    it("a missing value is invalid at every offset around the boundary, with the line ending in the next read or the file ending", () => {
      for (const eol of ["\n", "\r\n"]) {
        const body = `${TARGET}${eol}a =`;
        check(`${body}${eol}`, body.lastIndexOf("="), (lines) => cannotFollow(lines + 2));
        check(body, body.lastIndexOf("="), (lines) => cannotFollow(lines + 2));
        check(`${body}${eol}`, body.length - 1 + eol.length, (lines) => cannotFollow(lines + 2));
      }
    });

    it("a missing value before the target is invalid at line 1 of the body, whichever read it falls in", () => {
      const body = `a = # comment\n${TARGET}\n`;
      check(body, body.indexOf("#"), (lines) => cannotFollow(lines + 1));
    });

    it("an open multiline string is invalid at every offset around the boundary, naming the last line", () => {
      for (const d of ['"""', "'''"]) {
        for (const eol of ["\n", "\r\n"]) {
          const oneLine = `${TARGET}${eol}a = ${d}unterminated`;
          check(oneLine, oneLine.lastIndexOf(d), (lines) => stringOpen(lines + 2));
          check(oneLine, oneLine.length - 1, (lines) => stringOpen(lines + 2));
          check(`${oneLine}${eol}`, oneLine.lastIndexOf(d), (lines) => stringOpen(lines + 2));
          const withBody = `${TARGET}${eol}a = ${d}${eol}body one${eol}body two`;
          check(withBody, withBody.lastIndexOf(d), (lines) => stringOpen(lines + 4));
          check(withBody, withBody.length - 1, (lines) => stringOpen(lines + 4));
        }
      }
    });

    it("a multiline string that closes across the boundary, and a line that holds a value, stay found", () => {
      for (const d of ['"""', "'''"]) {
        const closed = `${TARGET}\na = ${d}x\ny${d}\nb = 1 # c\n`;
        for (const index of [closed.indexOf(d), closed.lastIndexOf(d), closed.indexOf("b =")]) {
          for (const shift of SHIFTS) {
            const { text } = placeAt(closed, index, shift);
            const result = read("/x/config.toml", scriptedIo(text).io);
            assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `${d} at ${index}, shift ${shift}: ${JSON.stringify(result)}`);
          }
        }
      }
    });
  });

  // The key-position verdict (a key with no `=`, a second key part, a dot with no part, an `=` with no key)
  // must not depend on where a read ends either: the scanner joins a line that spans two reads, and the
  // tracker's key state lives across lines, not across reads. `placeAt` pads the file with comment lines so
  // that `body[index]` lands at byte (chunk - 1 + shift); `placeBytes` does the same for a body whose
  // characters are not all one byte (a read can then end inside a multi-byte character).
  describe("a malformed key at a read boundary", () => {
    const CANNOT_FOLLOW = "the scan cannot follow the syntax here and cannot classify the lines after it";
    const cannotFollow = (line) => ({ status: "invalid", reason: `${CANNOT_FOLLOW} (line ${line})` });
    const FOUND = { status: "found", value: "elevated" };
    const SHIFTS = [-3, -2, -1, 0, 1, 2, 3];
    const TARGET = 'windows.sandbox = "elevated"';
    const lineCount = (text) => text.split("\n").length - 1;
    const placeAt = (body, index, shift) => {
      const at = R().CONFIG_READ_CHUNK_BYTES - 1 + shift;
      const pad = padTo(at - index);
      assert.equal(Buffer.byteLength(pad), at - index, "the padding is exactly as long as asked");
      return { text: `${pad}${body}`, lines: lineCount(pad) };
    };
    const placeBytes = (body, byteIndex, shift) => {
      const at = R().CONFIG_READ_CHUNK_BYTES - 1 + shift;
      const pad = padTo(at - byteIndex);
      assert.equal(Buffer.byteLength(pad), at - byteIndex, "the padding is exactly as long as asked");
      return { bytes: Buffer.concat([Buffer.from(pad), Buffer.from(body, "utf8")]), lines: lineCount(pad) };
    };
    const check = (body, index, expected) => {
      for (const shift of SHIFTS) {
        const { text, lines } = placeAt(body, index, shift);
        assert.deepEqual(read("/x/config.toml", scriptedIo(text).io), expected(lines), `${JSON.stringify(body)} at ${index}, shift ${shift}`);
      }
    };

    it("a key with no = is invalid at every offset around the boundary, with the line ending in the next read or the file ending", () => {
      for (const eol of ["\n", "\r\n"]) {
        const body = `${TARGET}${eol}a`;
        check(body, body.length - 1, (lines) => cannotFollow(lines + 2));
        check(`${body}${eol}`, body.length - 1, (lines) => cannotFollow(lines + 2));
        check(`${body}${eol}`, body.length - 1 + eol.length, (lines) => cannotFollow(lines + 2));
        const dotted = `${TARGET}${eol}a.b # c${eol}`;
        for (const mark of [".", "#", "c"]) check(dotted, dotted.lastIndexOf(mark), (lines) => cannotFollow(lines + 2));
        const trailingDot = `${TARGET}${eol}a.`;
        check(trailingDot, trailingDot.length - 1, (lines) => cannotFollow(lines + 2));
        check(`${trailingDot}${eol}`, trailingDot.length - 1, (lines) => cannotFollow(lines + 2));
      }
    });

    it("a second key part is invalid however the line splits across reads", () => {
      for (const eol of ["\n", "\r\n"]) {
        const body = `${TARGET}${eol}a b = 1${eol}`;
        const row = body.indexOf("a b");
        for (const index of [row, row + 1, row + 2, row + 4, row + 6]) check(body, index, (lines) => cannotFollow(lines + 2));
        const quoted = `${TARGET}${eol}"a"b = 1${eol}`;
        for (const index of [quoted.indexOf('"a"'), quoted.indexOf('"a"') + 2, quoted.indexOf('"a"') + 3]) {
          check(quoted, index, (lines) => cannotFollow(lines + 2));
        }
        const inline = `${TARGET}${eol}x = { a b = 1 }${eol}`;
        for (const index of [inline.indexOf("{"), inline.indexOf("a b"), inline.indexOf("b ="), inline.indexOf("}")]) {
          check(inline, index, (lines) => cannotFollow(lines + 2));
        }
      }
    });

    it("a dot with no part, an = with no key and a closer after a key are invalid at every offset around the boundary", () => {
      const rows = ["a. = 1", ".a = 1", "a..b = 1", "= 5", "=5", "x = { = 1 }", "x = { a. }", "x = { a }", "x = { a, b = 1 }"];
      for (const eol of ["\n", "\r\n"]) {
        for (const row of rows) {
          const body = `${TARGET}${eol}${row}${eol}`;
          const start = body.indexOf(row);
          for (let offset = 0; offset < row.length; offset += 1) {
            check(body, start + offset, (lines) => cannotFollow(lines + 2));
          }
        }
      }
    });

    it("a gap before the target is the verdict, whichever read it falls in", () => {
      for (const [row, target] of [["a", TARGET], ["= 5", "[windows]\nsandbox = \"elevated\""], ["a b = 1", TARGET], [".a = 1", TARGET]]) {
        const body = `${row}\n${target}\n`;
        for (const index of [0, row.length - 1, row.length]) check(body, index, (lines) => cannotFollow(lines + 1));
      }
    });

    it("a key line longer than a read is judged as a whole line", () => {
      const spaces = " ".repeat(R().CONFIG_READ_CHUNK_BYTES + 100);
      const tests = {
        "a key, then more blanks than a read holds, with no =": [`${TARGET}\na${spaces}\n`, cannotFollow(2)],
        "a key, a long run of blanks, then a comment, with no =": [`${TARGET}\na${spaces}# c\n`, cannotFollow(2)],
        "a key, a long run of blanks, then a second key part": [`${TARGET}\na${spaces}b = 1\n`, cannotFollow(2)],
        "a long run of blanks, then an = with no key": [`${TARGET}\n${spaces}= 5\n`, cannotFollow(2)],
        "a key, a long run of blanks, then a valid =": [`${TARGET}\na${spaces}= 1\n`, FOUND],
        "a dotted key whose dot is a read away from its parts": [`${TARGET}\na${spaces}.${spaces}b = 1\n`, FOUND],
        "a dotted key whose dot has no part after it": [`${TARGET}\na${spaces}.${spaces}\n`, cannotFollow(2)],
      };
      for (const [name, [text, expected]] of Object.entries(tests)) {
        const { io, calls } = scriptedIo(text);
        assert.deepEqual(read("/x/config.toml", io), expected, name);
        assert.ok(calls.reads.length >= 2, `${name}: the file takes more than one read`);
        assert.ok(calls.reads.every((entry) => entry.length <= R().CONFIG_READ_CHUNK_BYTES), `${name}: every read stays within CONFIG_READ_CHUNK_BYTES`);
      }
    });

    it("a key with no = in an open inline table is invalid at every offset around the boundary", () => {
      // [rows after the target, index in rows of the line that holds the gap]
      const cases = [
        [["x = {", "a", "}"], 1], // the key alone on a line of a multi-line inline table
        [["x = {", "a # c", "}"], 1],
        [["x = {", '"a"', "}"], 1],
        [["x = {", "a.b", "}"], 1],
        [["x = { a", "= 1 }"], 0], // the key ends the opening line, its = on the next line
        [["x = [ { a", "= 1 } ]"], 0],
      ];
      for (const eol of ["\n", "\r\n"]) {
        for (const [rows, gapIndex] of cases) {
          const body = `${TARGET}${eol}${rows.join(eol)}${eol}`;
          const start = `${[TARGET, ...rows.slice(0, gapIndex)].join(eol)}${eol}`.length;
          // Every byte of the gap line and of the line ending after it.
          for (let offset = 0; offset < rows[gapIndex].length + eol.length; offset += 1) {
            check(body, start + offset, (lines) => cannotFollow(lines + gapIndex + 2));
          }
        }
        const atEnd = `${TARGET}${eol}x = {${eol}a`;
        check(atEnd, atEnd.length - 1, (lines) => cannotFollow(lines + 3));
        const openingAtEnd = `${TARGET}${eol}x = { a`;
        check(openingAtEnd, openingAtEnd.length - 1, (lines) => cannotFollow(lines + 2));
      }
    });

    it("a valid multi-line inline table stays found wherever a read ends inside it", () => {
      const body = lines(
        TARGET, "x = {", "  a = 1,", "", "  # c", "  b.c = 2,", '  "d e" = { f = [', "    1,", "    2", "  ] }", "}", "y = [", "  { a = 1 },", "  {", "    b = 2", "  }", "]", "",
      );
      for (let index = TARGET.length + 1; index < body.length; index += 1) {
        for (const shift of SHIFTS) {
          const { text } = placeAt(body, index, shift);
          const result = read("/x/config.toml", scriptedIo(text).io);
          assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `index ${index}, shift ${shift}: ${JSON.stringify(result)}`);
        }
      }
    });

    it("valid keys stay found wherever a read ends inside them", () => {
      const body = lines(
        TARGET, "a.b = 1", '"a b" . c = 2', "'q'.r=3", "x = { a = 1, b.c = 2 }", "y = [ { a = 1 }, { b.c = 2 } ]", "z = {", "  d = 1,", "  e.f = 2", "}", "[h.i]", "[[j]]", "k=1", "# a b", "  # = 5", "",
      );
      for (let index = TARGET.length + 1; index < body.length; index += 1) {
        for (const shift of SHIFTS) {
          const { text } = placeAt(body, index, shift);
          const result = read("/x/config.toml", scriptedIo(text).io);
          assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `index ${index}, shift ${shift}: ${JSON.stringify(result)}`);
        }
      }
    });

    it("a key of multi-byte characters stays found, and a gap among them is invalid, wherever a read ends inside a character", () => {
      const valid = `${TARGET}\nключ = 1\n"日本語".ключ2 = 2\nx = { ключ = 1, b.c = 2 }\n`;
      const gapped = `${TARGET}\nключ\n`;
      const twoParts = `${TARGET}\nключ ключ2 = 1\n`;
      const total = Buffer.byteLength(valid);
      for (let byteIndex = Buffer.byteLength(TARGET) + 1; byteIndex < total; byteIndex += 1) {
        for (const shift of [-1, 0, 1]) {
          const { bytes } = placeBytes(valid, byteIndex, shift);
          const result = read("/x/config.toml", scriptedIo(bytes).io);
          assert.deepEqual({ status: result.status, value: result.value }, { status: "found", value: "elevated" }, `valid, byte ${byteIndex}, shift ${shift}: ${JSON.stringify(result)}`);
        }
      }
      for (const [name, body] of [["a key with no =", gapped], ["two key parts", twoParts]]) {
        for (let byteIndex = Buffer.byteLength(TARGET) + 1; byteIndex < Buffer.byteLength(body); byteIndex += 1) {
          for (const shift of [-1, 0, 1]) {
            const { bytes, lines } = placeBytes(body, byteIndex, shift);
            assert.deepEqual(read("/x/config.toml", scriptedIo(bytes).io), cannotFollow(lines + 2), `${name}, byte ${byteIndex}, shift ${shift}`);
          }
        }
      }
    });
  });

  // Review loop 3: the 1 MiB line cap holds across fixed-size reads. A line spans many chunks, so it
  // is counted across `write` calls, and nothing past the cap is buffered.
  it("a line crossing many chunk boundaries is parsed normally up to the cap and invalid one byte over", () => {
    const chunk = R().CONFIG_READ_CHUNK_BYTES;
    const limit = R().MAX_CONFIG_LINE_BYTES;
    const target = '[windows]\nsandbox = "elevated"\n';
    assert.ok(limit > 4 * chunk, "the cap spans many chunks");
    for (const [size, status] of [[chunk + 7, "found"], [3 * chunk - 1, "found"], [limit - 1, "found"], [limit, "found"], [limit + 1, "invalid"], [limit + chunk, "invalid"]]) {
      const { io, calls } = scriptedIo(`#${"c".repeat(size - 1)}\n${target}`);
      const result = read("/x/config.toml", io);
      assert.equal(result.status, status, `a ${size}-byte comment line: ${JSON.stringify(result)}`);
      if (status === "found") assert.equal(result.value, "elevated", `${size} bytes`);
      else assert.deepEqual(result, { status: "invalid", reason: "a line is longer than the 1 MiB limit (line 1)" }, `${size} bytes`);
      assert.ok(calls.reads.every((entry) => entry.length <= chunk), `every read stays within CONFIG_READ_CHUNK_BYTES (${size} bytes)`);
    }
  });

  it("an overlong final line without a newline is invalid across chunk reads, and the line number counts the lines before it", () => {
    const limit = R().MAX_CONFIG_LINE_BYTES;
    const { io } = scriptedIo(`a = 1\nb = 2\n${"y".repeat(limit + 1)}`);
    assert.deepEqual(read("/x/config.toml", io), { status: "invalid", reason: "a line is longer than the 1 MiB limit (line 3)" });
  });

  it("reads an empty file as a missing key", () => {
    assert.equal(read("/x/config.toml", scriptedIo("").io).status, "missing-key");
  });
});

// =============================================================================================
// UNIT: bounded value nesting in the config scanner (plan 4.2, review loop 4)
//
// The scanner's value-context tracker holds one entry per open array or inline table. Input such as
// `arr = [` followed by millions of `[` lines (each far under the 1 MiB line cap) used to grow it
// without limit. A value that nests deeper than MAX_CONFIG_NESTING_DEPTH (256) is now invalid, with a
// fixed reason and the line of the offending bracket, and memory stays bounded whatever the input.
// =============================================================================================

/**
 * fs stand-in that makes its bytes on demand, so a multi-megabyte input is never held as one string or
 * buffer. `parts` is a list of { text, repeat = 1 } (text is never empty); `onRead(stats)` runs before
 * each read. Reads are filled across part boundaries, like a regular file's. Self-contained on
 * purpose: its source text is also evaluated inside memory-limited child processes (see
 * LAZY_CHILD_SCRIPT).
 */
function makeLazyIo(parts, onRead) {
  const MAX_REPEATS_PER_PIECE = 4096;
  function* pieces() {
    for (const { text, repeat = 1 } of parts) {
      for (let left = repeat; left > 0; left -= MAX_REPEATS_PER_PIECE) {
        yield Buffer.from(text.repeat(Math.min(left, MAX_REPEATS_PER_PIECE)), "utf8");
      }
    }
  }
  const source = pieces();
  const stats = { opens: 0, closes: 0, reads: 0, maxRequest: 0, served: 0 };
  let current = Buffer.alloc(0);
  let at = 0;
  return {
    stats,
    io: {
      openSync() { stats.opens += 1; return 3; },
      closeSync() { stats.closes += 1; },
      readSync(fd, buffer, a, b) {
        const objectForm = typeof a === "object" && a !== null;
        const offset = objectForm ? a.offset ?? 0 : a;
        const length = objectForm ? a.length ?? buffer.length - offset : b;
        stats.reads += 1;
        stats.maxRequest = Math.max(stats.maxRequest, length);
        if (onRead) onRead(stats);
        let count = 0;
        while (count < length) {
          if (at >= current.length) {
            const next = source.next();
            if (next.done) break;
            current = next.value;
            at = 0;
            continue;
          }
          const take = Math.min(length - count, current.length - at);
          current.copy(buffer, offset + count, at, at + take);
          at += take;
          count += take;
        }
        stats.served += count;
        return count;
      },
    },
  };
}

// Child-process program: imports relay.mjs by file URL and scans a lazily generated input through
// readWindowsSandboxSetting. Every `sampleEvery` reads it forces a full garbage collection (the child
// runs with --expose-gc) and records the live heap, so the report says how much memory the scan
// actually kept alive, not how much garbage it made.
const LAZY_CHILD_SCRIPT = `
const [relayUrl, partsJson, sampleEveryText] = process.argv.slice(1);
${makeLazyIo.toString()}
const relay = await import(relayUrl);
const sampleEvery = Number(sampleEveryText);
let baseline = 0;
let peak = 0;
const { io, stats } = makeLazyIo(JSON.parse(partsJson), (s) => {
  if (s.reads % sampleEvery !== 1) return;
  global.gc();
  const live = process.memoryUsage().heapUsed;
  if (s.reads === 1) baseline = live;
  peak = Math.max(peak, live);
});
const result = relay.readWindowsSandboxSetting("/virtual/config.toml", io);
console.log("RELAY_CHILD " + JSON.stringify({ result, reads: stats.reads, maxRequest: stats.maxRequest, served: stats.served, closes: stats.closes, growthBytes: peak - baseline }));
`;

describe("config scanner: value nesting is bounded (review loop 4)", () => {
  const CAP = 256;
  const scan = (input) => fn("scanWindowsSandbox")(input);
  const readSetting = (path, io) => fn("readWindowsSandboxSetting")(path, io);
  const t = (...rows) => rows.join("\n");
  const open = (n) => "[".repeat(n);
  const close = (n) => "]".repeat(n);
  const tooDeep = (line) => ({ status: "invalid", reason: `a value nests deeper than ${CAP} levels (line ${line})` });
  const FOUND = { status: "found", value: "elevated" };
  const MISSING = { status: "missing-key" };
  const TARGET = 'windows.sandbox = "elevated"';
  const TABLE_TARGET = t("[windows]", 'sandbox = "elevated"');
  const lineCap = () => R().MAX_CONFIG_LINE_BYTES;
  // The mention rule's verdict, exactly: a line that mentions windows or sandbox after a multi-line value.
  const mention = (line) => ({
    status: "invalid",
    reason: `windows or sandbox follows a multiline string delimiter or a multi-line value, so windows.sandbox is ambiguous (line ${line})`,
  });

  /** String and Buffer input must give the same verdict. */
  const scanBoth = (text) => {
    const viaString = scan(text);
    assert.deepEqual(scan(Buffer.from(text, "utf8")), viaString, "string and Buffer input must agree");
    return viaString;
  };

  const arrays = () => "array";
  const tables = () => "table";
  const alternating = (i) => (i % 2 === 0 ? "array" : "table");
  const alternatingFromTable = (i) => (i % 2 === 0 ? "table" : "array");
  /** `n` nested openers (arrays or inline tables, as kindAt(i) says) around a scalar: valid TOML while n <= CAP. */
  function nested(n, kindAt) {
    let before = "";
    let after = "";
    for (let i = 0; i < n; i += 1) {
      if (kindAt(i) === "table") {
        before += "{ k = ";
        after = ` }${after}`;
      } else {
        before += "[";
        after = `]${after}`;
      }
    }
    return `${before}1${after}`;
  }
  /** Exactly `size` bytes of newline-terminated comment lines (and, at most, one blank line). */
  function commentPad(size) {
    let text = "";
    let lineCount = 0;
    for (let left = size; left > 0;) {
      const n = Math.min(80, left);
      text += n === 1 ? "\n" : `#${"p".repeat(n - 2)}\n`;
      left -= n;
      lineCount += 1;
    }
    return { text, lineCount };
  }

  /**
   * `body` is valid TOML nested at most CAP deep: it parses, and a target before it is found. A target after it
   * is found too unless the body leaves a bracket open at the end of a line (`multiLine`): then the target line
   * mentions windows after a multi-line value, so the mention rule makes it invalid, naming that line.
   */
  function expectParses(body, label, multiLine = false) {
    assert.deepEqual(scanBoth(`${body}\n`), MISSING, `${label}: no target`);
    assert.deepEqual(scanBoth(body), MISSING, `${label}: no target, no trailing newline`);
    const bodyLines = body.split("\n").length;
    assert.deepEqual(scanBoth(`${body}\n${TARGET}\n`), multiLine ? mention(bodyLines + 1) : FOUND, `${label}: dotted target after`);
    assert.deepEqual(scanBoth(`${body}\n${TABLE_TARGET}\n`), multiLine ? mention(bodyLines + 1) : FOUND, `${label}: [windows] table target after`);
    assert.deepEqual(scanBoth(`${TARGET}\n${body}\n`), FOUND, `${label}: dotted target before`);
  }
  /** `body` opens its 257th bracket on `line` (counting from the first line of `body`). */
  function expectTooDeep(body, line, label) {
    assert.deepEqual(scanBoth(`${body}\n`), tooDeep(line), `${label}: alone`);
    assert.deepEqual(scanBoth(body), tooDeep(line), `${label}: no trailing newline`);
    assert.deepEqual(scanBoth(`${TARGET}\n${body}\n`), tooDeep(line + 1), `${label}: a valid target before it`);
    assert.deepEqual(scanBoth(`${body}\n${TARGET}\n`), tooDeep(line), `${label}: a valid target after it`);
    assert.deepEqual(scanBoth(`${body}\n${TABLE_TARGET}\n`), tooDeep(line), `${label}: a [windows] table target after it`);
  }

  describe("a value nested exactly to the cap is valid TOML and still parses", () => {
    // The depth is the number of arrays plus inline tables open at once, not the number ever opened.
    const AT_CAP = {
      "256 nested arrays on one line": `a = ${nested(CAP, arrays)}`,
      "256 nested inline tables on one line": `a = ${nested(CAP, tables)}`,
      "256 alternating arrays and inline tables, an array outermost": `a = ${nested(CAP, alternating)}`,
      "256 alternating inline tables and arrays, an inline table outermost": `a = ${nested(CAP, alternatingFromTable)}`,
      "255 nested arrays holding two sibling arrays (the depth returns to 256 after a close)": `a = ${open(255)}[1], [2]${close(255)}`,
      "two values in a row, each 256 deep (512 brackets in all)": t(`a = ${nested(CAP, arrays)}`, `b = ${nested(CAP, arrays)}`),
      "255 nested arrays": `a = ${nested(CAP - 1, arrays)}`,
      "256 nested arrays, one bracket per line": t("a = [", ...Array(255).fill("0, ["), ...Array(CAP).fill("]")),
      "thousands of shallow sibling arrays (depth never above 3)": t("a = [", ...Array(3000).fill("0, [1, [2]],"), "0", "]"),
    };
    // These bodies end a line with a bracket still open, so a target after them is a mention, not found.
    const MULTI_LINE_AT_CAP = new Set([
      "256 nested arrays, one bracket per line",
      "thousands of shallow sibling arrays (depth never above 3)",
    ]);
    for (const [name, body] of Object.entries(AT_CAP)) {
      it(`parses: ${name}`, () => {
        expectParses(body, name, MULTI_LINE_AT_CAP.has(name));
      });
    }

    it("parses: a multiline string at the innermost level of a 256-deep value is skipped as content", () => {
      const body = `a = ${open(CAP)} """\nx = 1\n"""${close(CAP)}`;
      assert.deepEqual(scanBoth(`${body}\n`), MISSING);
      assert.deepEqual(scanBoth(`${TARGET}\n${body}\n`), FOUND);
    });
  });

  describe("one level past the cap is invalid, with the line of the offending bracket", () => {
    // [body, line of the 257th bracket]. Lines start at 1.
    const OVER = {
      "257 nested arrays on one line": [`a = ${nested(CAP + 1, arrays)}`, 1],
      "257 nested inline tables on one line": [`a = ${nested(CAP + 1, tables)}`, 1],
      "257 alternating, an array as the 257th": [`a = ${nested(CAP + 1, alternating)}`, 1],
      "257 alternating, an inline table as the 257th": [`a = ${nested(CAP + 1, alternatingFromTable)}`, 1],
      "256 arrays, then an inline table as the 257th": [`a = ${nested(CAP + 1, (i) => (i < CAP ? "array" : "table"))}`, 1],
      "255 nested arrays, a sibling array, then a 257th level in the next sibling": [`a = ${open(255)}[1], [[2]]${close(255)}`, 1],
      "a single line of 300,000 `[` (far under the line cap)": [`a = ${open(300_000)}`, 1],
      "one `[` per line: the 257th bracket is on line 257": [t("a = [", ...Array(CAP).fill("0, [")), 257],
      "256 on line 1, the 257th (an array) on line 2": [t(`a = ${open(CAP)}`, "[1]"), 2],
      "256 on line 1, the 257th (an inline table) on line 2": [t(`a = ${open(CAP)}`, "{ k = 1 }"), 2],
      "blank and comment lines before the 257th, which is on line 5": [t(`a = ${open(CAP)}`, "", "# note", "", "0, [1]"), 5],
      "a staggered value (100 + 100 + 56 = 256, then one more on line 4)": [t(`a = ${open(100)}`, `0, ${open(100)}`, `0, ${open(56)}`, "0, [1]"), 4],
      "one `[` per line, the 257th an inline table on line 257": [t("a = [", ...Array(255).fill("0, ["), "0, { k = 1 }"), 257],
    };
    for (const [name, [body, line]] of Object.entries(OVER)) {
      it(`invalid: ${name}`, () => {
        expectTooDeep(body, line, name);
      });
    }

    it("invalid with the same reason for CRLF line endings and a BOM", () => {
      const crlf = t("a = [", ...Array(CAP).fill("0, ["), "").replace(/\n/g, "\r\n");
      assert.deepEqual(scan(crlf), tooDeep(257));
      assert.deepEqual(scan(`﻿${crlf}`), tooDeep(257));
      assert.deepEqual(scan(`﻿a = ${open(CAP + 1)}\r\n`), tooDeep(1));
    });

    it("a line that is itself the target and nests too deeply is invalid", () => {
      for (const text of [`windows.sandbox = ${open(CAP + 1)}\n`, `[windows]\nsandbox = ${open(CAP + 1)}\n`]) {
        assert.equal(scanBoth(text).status, "invalid", text.slice(0, 40));
      }
    });

    it("the reason is fixed text plus a line number: it never echoes configuration content", () => {
      const canary = "CANARY-nest-7c1";
      for (const text of [
        `${canary} = ${open(CAP + 1)} "${canary}-value"\n`,
        `["${canary}"]\nk = ${open(CAP + 1)}\n`,
        `${canary}.x = ${nested(CAP + 1, arrays)}\n`,
        `k = { ${canary} = ${open(CAP + 1)} }\n`,
      ]) {
        const result = scanBoth(text);
        assert.equal(result.status, "invalid", text.slice(0, 40));
        assert.match(result.reason, /^a value nests deeper than 256 levels \(line \d+\)$/);
        assert.ok(!JSON.stringify(result).includes(canary), `reason leaked configuration content: ${JSON.stringify(result)}`);
      }
    });
  });

  describe("the verdict is final", () => {
    const DEEP = `a = ${open(CAP + 1)}`;

    it("stays invalid whatever follows the too-deep value", () => {
      const AFTER = {
        "a valid dotted target": [TARGET],
        "a valid [windows] target": ["[windows]", 'sandbox = "elevated"'],
        "the value closed again, then a valid target": [close(CAP + 1), TARGET],
        "a duplicate target": [TARGET, TARGET],
        "a malformed target": ["[windows]", "sandbox = nope"],
        "more too-deep nesting": [`b = ${open(300)}`],
        "an overlong line": [`# ${"c".repeat(lineCap())}`],
        "an unterminated string": ['note = "unterminated'],
        "a stray multiline delimiter": ['note = 1 """'],
        "a long run of unrelated lines": Array(2000).fill("k = 1"),
      };
      for (const [name, rows] of Object.entries(AFTER)) {
        assert.deepEqual(scanBoth(t(DEEP, ...rows, "")), tooDeep(1), name);
      }
    });

    it("keeps an earlier invalid verdict: the first verdict wins", () => {
      const EARLIER = {
        "a duplicate target": [t(TARGET, TARGET), /^windows\.sandbox is defined more than once \(line 2\)$/],
        "a malformed target": [t("[windows]", "sandbox = nope"), /^windows\.sandbox is not a supported literal \(expected "elevated" or "unelevated"\) \(line 2\)$/],
        "windows.sandbox declared as a table": ["[windows.sandbox]", /^windows\.sandbox is declared as a table \(line 1\)$/],
        "an escaped key that may name the target": ['windows."\\u0073andbox" = 1', /^an escaped key may name windows\.sandbox; escaped keys are unsupported \(line 1\)$/],
        "an overlong line": [`# ${"c".repeat(lineCap())}`, /^a line is longer than the 1 MiB limit \(line 1\)$/],
      };
      for (const [name, [earlier, reason]] of Object.entries(EARLIER)) {
        for (const text of [t(earlier, DEEP, ""), t(earlier, DEEP, TARGET, "")]) {
          const result = scan(text);
          assert.equal(result.status, "invalid", name);
          assert.match(result.reason, reason, `${name}: the earlier verdict must stand`);
          assert.ok(!result.reason.includes("nests deeper"), `${name}: the nesting verdict must not replace it`);
        }
      }
    });
  });

  // The verdict must not depend on where the fixed-size reads happen to split the input.
  describe("streamed through fixed-size reads", () => {
    const chunk = () => R().CONFIG_READ_CHUNK_BYTES;

    // `arr = [` is line 1 and holds bracket 1; line k (k >= 2) is a single `[`, bracket k. So the 257th
    // bracket is on line 257, and nothing after it matters.
    it("`arr = [` then 2,000,000 lines of `[` is invalid at line 257 (lazy input, never materialised)", { timeout: 120_000 }, () => {
      const { io, stats } = makeLazyIo([{ text: "arr = [\n" }, { text: "[\n", repeat: 2_000_000 }]);
      const result = readSetting("/x/config.toml", io);
      assert.deepEqual(result, tooDeep(257));
      assert.ok(stats.reads > 1, "the input is read in many pieces");
      assert.ok(stats.maxRequest <= chunk(), `every read stays within CONFIG_READ_CHUNK_BYTES (asked for ${stats.maxRequest})`);
      assert.deepEqual([stats.opens, stats.closes], [1, 1], "the descriptor is opened once and closed");
    });

    // Line 1 holds bracket 1; line k (k >= 2) is `{ k = [`: the `{` is bracket 2k-2 and the `[` bracket
    // 2k-1. Bracket 257 is the `[` on line 129 (2 * 129 - 1).
    it("`arr = [` then 1,000,000 lines of `{ k = [` (arrays and inline tables) is invalid at line 129", { timeout: 120_000 }, () => {
      const { io, stats } = makeLazyIo([{ text: "arr = [\n" }, { text: "{ k = [\n", repeat: 1_000_000 }]);
      assert.deepEqual(readSetting("/x/config.toml", io), tooDeep(129));
      assert.ok(stats.maxRequest <= chunk(), `every read stays within CONFIG_READ_CHUNK_BYTES (asked for ${stats.maxRequest})`);
    });

    it("a single line of 300,000 `[` is invalid at line 1, however it splits across reads", () => {
      const { io, stats } = makeLazyIo([{ text: "a = " }, { text: "[", repeat: 300_000 }, { text: "\n" }, { text: 'windows.sandbox = "elevated"\n' }]);
      assert.deepEqual(readSetting("/x/config.toml", io), tooDeep(1));
      assert.ok(stats.maxRequest <= chunk(), `every read stays within CONFIG_READ_CHUNK_BYTES (asked for ${stats.maxRequest})`);
    });

    it("the cap and the line number do not depend on where a read boundary falls", () => {
      // 257 brackets, the last on body line 257; and exactly 256 brackets, then closed, with the target
      // first (a target after a multi-line value would be a mention, not a way to prove the cap parses).
      const over = t("a = [", ...Array(CAP).fill("0, ["), "");
      const atCap = t(TARGET, "a = [", ...Array(CAP - 1).fill("0, ["), ...Array(CAP).fill("]"), "");
      for (let shift = -6; shift <= 6; shift += 1) {
        // Pad with comment lines so that the last opening bracket sits at byte (chunk + shift): within a
        // few bytes of the end of the first read, on either side of it.
        const overPad = commentPad(chunk() - over.lastIndexOf("[") + shift);
        const overResult = readSetting("/x/config.toml", makeLazyIo([{ text: overPad.text }, { text: over }]).io);
        assert.deepEqual(overResult, tooDeep(overPad.lineCount + 257), `too deep, shift ${shift}`);
        const capPad = commentPad(chunk() - atCap.lastIndexOf("[") + shift);
        const capResult = readSetting("/x/config.toml", makeLazyIo([{ text: capPad.text }, { text: atCap }]).io);
        assert.deepEqual(capResult, FOUND, `exactly at the cap, shift ${shift}`);
      }
    });
  });

  // Memory stays bounded whatever the input. The child runs with a small old-space limit and with
  // --expose-gc, forcing a full collection every few reads and recording the live heap, so the checks
  // cover both "survives under a hard limit" and "keeps nothing alive that grows with the input".
  describe("bounded memory in a memory-limited process", () => {
    const HEAP_LIMIT_MB = 32;
    const CHILD_TIMEOUT_MS = 120_000;
    // Measured on the unfixed scanner: ~22.6 MB of live heap after 2,000,000 lines (8 bytes per tracker
    // entry, plus the grown backing store). The bounded scanner keeps well under 1 MB alive.
    const MAX_LIVE_GROWTH_BYTES = 4 * 1024 * 1024;

    function runLimited(parts) {
      const started = Date.now();
      const child = spawnSync(process.execPath, [
        `--max-old-space-size=${HEAP_LIMIT_MB}`, "--expose-gc", "--input-type=module", "-e", LAZY_CHILD_SCRIPT,
        RELAY_URL, JSON.stringify(parts), "8",
      ], {
        cwd: tmpdir(),
        env: { PATH: NODE_DIR, ...(IS_WIN ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}) },
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        input: "",
      });
      const reportLine = (child.stdout ?? "").split("\n").find((row) => row.startsWith("RELAY_CHILD "));
      // An out-of-memory abort prints a native stack; the useful line is the FATAL ERROR one.
      const stderrRows = (child.stderr ?? "").trim().split("\n");
      const stderrTail = (stderrRows.find((row) => /FATAL ERROR|heap out of memory/i.test(row)) ?? stderrRows.slice(-2).join(" | ")).slice(-300);
      return {
        report: reportLine ? JSON.parse(reportLine.slice("RELAY_CHILD ".length)) : null,
        why: `exit ${child.status}${child.signal ? ` signal ${child.signal}` : ""}${child.error?.code === "ETIMEDOUT" ? " (timed out)" : ""} after ${Date.now() - started} ms; stderr: ${stderrTail || "(empty)"}`,
        status: child.status,
      };
    }
    function expectBounded(parts, expected) {
      const child = runLimited(parts);
      assert.equal(child.status, 0, `the child must finish under a ${HEAP_LIMIT_MB} MB heap limit: ${child.why}`);
      assert.ok(child.report, `the child printed no report: ${child.why}`);
      assert.ok(
        child.report.growthBytes < MAX_LIVE_GROWTH_BYTES,
        `live heap grew by ${(child.report.growthBytes / 1048576).toFixed(1)} MB while scanning (limit ${MAX_LIVE_GROWTH_BYTES / 1048576} MB): memory is not bounded`,
      );
      assert.deepEqual(child.report.result, expected);
      assert.ok(child.report.maxRequest <= R().CONFIG_READ_CHUNK_BYTES, `every read stays within CONFIG_READ_CHUNK_BYTES (asked for ${child.report.maxRequest})`);
      assert.equal(child.report.closes, 1, "the descriptor is closed");
    }

    it("`arr = [` then 2,000,000 lines of `[`: invalid at line 257 and the live heap stays flat", { timeout: 150_000 }, () => {
      expectBounded([{ text: "arr = [\n" }, { text: "[\n", repeat: 2_000_000 }], tooDeep(257));
    });

    it("`arr = [` then 8,000,000 lines of `[` finishes under a hard 32 MB old-space limit", { timeout: 150_000 }, () => {
      expectBounded([{ text: "arr = [\n" }, { text: "[\n", repeat: 8_000_000 }], tooDeep(257));
    });

    it("a single line of 300,000 `[` is invalid at line 1 under the same limit", { timeout: 150_000 }, () => {
      expectBounded([{ text: "a = " }, { text: "[", repeat: 300_000 }, { text: "\n" }], tooDeep(1));
    });
  });
});

describe("resolveCodexConfigPath", () => {
  const resolvePath = (env, home) => fn("resolveCodexConfigPath")(env, home);
  it("uses $CODEX_HOME/config.toml when CODEX_HOME is set", () => {
    assert.equal(resolvePath({ CODEX_HOME: join("fixture", "codex") }, join("fixture", "home")), join("fixture", "codex", "config.toml"));
  });
  it("otherwise uses <home>/.codex/config.toml", () => {
    assert.equal(resolvePath({}, join("fixture", "home")), join("fixture", "home", ".codex", "config.toml"));
  });
});

// =============================================================================================
// UNIT: outcome mapping (plan 4.5)
// =============================================================================================

describe("mapOutcome", () => {
  const map = (input) => fn("mapOutcome")({
    code: null, signal: null, launchError: false, watchdogFired: false, abortSignal: null, sandboxFailureReasons: [], ...input,
  });
  const SIG = osConstants.signals;

  it("child exited zero -> completed / 0", () => {
    assert.deepEqual(map({ code: 0 }), { status: "completed", exitCode: 0 });
  });
  it("non-zero exit -> failed with the child's code", () => {
    assert.deepEqual(map({ code: 7 }), { status: "failed", exitCode: 7 });
    assert.deepEqual(map({ code: 1 }), { status: "failed", exitCode: 1 });
  });
  it("death by signal -> failed with 128 + signal number", () => {
    assert.deepEqual(map({ code: null, signal: "SIGKILL" }), { status: "failed", exitCode: 128 + SIG.SIGKILL });
    assert.deepEqual(map({ code: null, signal: "SIGTERM" }), { status: "failed", exitCode: 128 + SIG.SIGTERM });
  });
  it("no code and no usable signal -> failed / 1", () => {
    assert.deepEqual(map({ code: null, signal: null }), { status: "failed", exitCode: 1 });
    assert.deepEqual(map({ code: null, signal: "SIGNOTREAL" }), { status: "failed", exitCode: 1 });
  });
  it("launch error -> failed / 1", () => {
    assert.deepEqual(map({ launchError: true }), { status: "failed", exitCode: 1 });
  });
  it("watchdog -> timeout, never success, never exit 0", () => {
    assert.deepEqual(map({ code: 0, watchdogFired: true }), { status: "timeout", exitCode: 1 });
    assert.deepEqual(map({ code: 1, watchdogFired: true }), { status: "timeout", exitCode: 1 });
    assert.deepEqual(map({ code: 7, watchdogFired: true }), { status: "timeout", exitCode: 7 });
    assert.deepEqual(map({ code: null, signal: "SIGTERM", watchdogFired: true }), { status: "timeout", exitCode: 128 + SIG.SIGTERM });
  });
  it("relay abort -> aborted with 128 + the abort signal's number", () => {
    assert.deepEqual(map({ abortSignal: "SIGTERM" }), { status: "aborted", exitCode: 128 + SIG.SIGTERM });
    assert.deepEqual(map({ abortSignal: "SIGINT" }), { status: "aborted", exitCode: 128 + SIG.SIGINT });
    assert.deepEqual(map({ abortSignal: "SIGHUP" }), { status: "aborted", exitCode: 128 + SIG.SIGHUP });
  });
  it("abort outranks watchdog, which outranks an ordinary failure", () => {
    assert.equal(map({ abortSignal: "SIGTERM", watchdogFired: true, code: 7 }).status, "aborted");
    assert.equal(map({ watchdogFired: true, code: 7 }).status, "timeout");
    assert.equal(map({ launchError: true, watchdogFired: true }).status, "timeout");
  });
  it("a sandbox signature outranks everything and always exits 1", () => {
    const sandboxFailureReasons = ["blocked by policy"];
    for (const extra of [
      { code: 0 }, { code: 7 }, { code: null, signal: "SIGKILL" }, { launchError: true },
      { code: 0, watchdogFired: true }, { abortSignal: "SIGTERM" }, { abortSignal: "SIGINT", watchdogFired: true, code: 3 },
    ]) {
      assert.deepEqual(map({ ...extra, sandboxFailureReasons }), { status: "sandbox_failed", exitCode: 1 }, JSON.stringify(extra));
    }
    assert.deepEqual(map({ code: 0, sandboxFailureReasons: ["setup refresh had errors", "blocked by policy"] }), { status: "sandbox_failed", exitCode: 1 });
  });
  it("tolerates absent optional inputs and does not mutate its input", () => {
    assert.deepEqual(fn("mapOutcome")({ code: 0 }), { status: "completed", exitCode: 0 });
    const input = { code: 5, signal: null, sandboxFailureReasons: [] };
    const before = JSON.stringify(input);
    fn("mapOutcome")(input);
    assert.equal(JSON.stringify(input), before);
  });
});

// =============================================================================================
// UNIT: stderr signature scanner (plan 4.5)
// =============================================================================================

describe("createSandboxSignatureScanner", () => {
  const PHRASES = ["setup refresh had errors", "blocked by policy"];
  const scanAll = (chunks) => {
    const scanner = fn("createSandboxSignatureScanner")();
    for (const chunk of chunks) scanner.write(chunk);
    return [...scanner.reasons()].sort();
  };
  const splitEverywhere = (buffer) => {
    const out = [];
    for (let at = 0; at <= buffer.length; at += 1) out.push([buffer.subarray(0, at), buffer.subarray(at)]);
    return out;
  };

  it("matches each canonical phrase, case-insensitively, reporting the canonical form", () => {
    assert.deepEqual(scanAll([Buffer.from("x\nblocked by policy\ny\n")]), ["blocked by policy"]);
    assert.deepEqual(scanAll([Buffer.from("ERROR: Setup Refresh Had Errors (os error 32)\n")]), ["setup refresh had errors"]);
    assert.deepEqual(scanAll([Buffer.from("command BLOCKED BY POLICY\nSETUP REFRESH HAD ERRORS\n")]), PHRASES.slice().sort());
  });

  it("reports each distinct phrase once however often it appears", () => {
    assert.deepEqual(scanAll([Buffer.from("blocked by policy\n".repeat(50))]), ["blocked by policy"]);
  });

  it("matches at every two-way split point of every phrase", () => {
    for (const phrase of PHRASES) {
      const text = Buffer.from(`prefix é ${phrase} suffix 日本\n`);
      for (const [a, b] of splitEverywhere(text)) {
        assert.deepEqual(scanAll([a, b]), [phrase], `${phrase} split at ${a.length}`);
      }
    }
  });

  it("matches when the stream arrives one byte at a time, and as string chunks", () => {
    for (const phrase of PHRASES) {
      const bytes = [...Buffer.from(`noise\r\n${phrase}\r\nmore`)].map((byte) => Buffer.from([byte]));
      assert.deepEqual(scanAll(bytes), [phrase], phrase);
      assert.deepEqual(scanAll([`noi`, `se ${phrase.slice(0, 5)}`, phrase.slice(5), " end"]), [phrase], `string chunks: ${phrase}`);
    }
  });

  it("matches a phrase split across three chunks", () => {
    assert.deepEqual(scanAll([Buffer.from("xx blocked"), Buffer.from(" by "), Buffer.from("policy yy")]), ["blocked by policy"]);
  });

  it("finds an early signature in a large stream (not only in a tail) and a late one", () => {
    const filler = Buffer.alloc(1024 * 1024, "a filler line that is not a signature\n");
    const scanner = fn("createSandboxSignatureScanner")();
    scanner.write(Buffer.from("blocked by policy\n"));
    for (let i = 0; i < 24; i += 1) scanner.write(filler);
    scanner.write(Buffer.from("trailing setup refresh had errors\n"));
    assert.deepEqual([...scanner.reasons()].sort(), PHRASES.slice().sort());
  });

  it("does not match near-misses or the legitimate read-only denial wording", () => {
    for (const text of [
      "Set-Content : Access to the path 'C:\\repo\\probe.txt' is denied.",
      "Access is denied. (os error 5)",
      "blocked by firewall", "blocked by", "policy", "blocked  by policy", "blocked by policies",
      "setup refresh completed", "setup refresh had error", "refresh had errors",
      "",
    ]) {
      assert.deepEqual(scanAll([Buffer.from(`${text}\n`)]), [], JSON.stringify(text));
    }
  });

  it("starts empty", () => {
    assert.deepEqual(fn("createSandboxSignatureScanner")().reasons(), []);
  });
});

// =============================================================================================
// UNIT: event accumulation — thread id, MCP accounting, decoding (plan 4.6)
// =============================================================================================

describe("createEventAccumulator", () => {
  const feed = (chunks, { end = true } = {}) => {
    const seen = [];
    const acc = fn("createEventAccumulator")({ onLine: (line) => seen.push(line) });
    for (const chunk of chunks) acc.write(chunk);
    if (end) acc.end();
    return { acc, seen };
  };
  const stream = (...events) => Buffer.from(`${events.join("\n")}\n`);
  const mcp = ev.mcp;

  it("deduplicates lifecycle events by item id: one invocation per id", () => {
    const { acc } = feed([stream(
      mcp("item.started", "item_7", "codex_apps", "search", "in_progress"),
      mcp("item.updated", "item_7", "codex_apps", "search", "in_progress"),
      mcp("item.completed", "item_7", "codex_apps", "search", "completed"),
    )]);
    assert.deepEqual(acc.mcpCalls(), { count: 1, names: [{ server: "codex_apps", tool: "search" }] });
  });

  it("counts distinct ids separately even for the same tool, with a single name pair", () => {
    const { acc } = feed([stream(
      mcp("item.completed", "item_1", "codex_apps", "search", "completed"),
      mcp("item.completed", "item_2", "codex_apps", "search", "completed"),
      mcp("item.completed", "item_3", "codex_apps", "search", "completed"),
    )]);
    assert.deepEqual(acc.mcpCalls(), { count: 3, names: [{ server: "codex_apps", tool: "search" }] });
  });

  it("counts started-only and failed invocations", () => {
    const { acc } = feed([stream(
      mcp("item.started", "item_1", "alpha", "ping", "in_progress"),
      mcp("item.started", "item_2", "beta", "run", "in_progress"),
      mcp("item.completed", "item_2", "beta", "run", "failed", { error: { message: "denied" } }),
    )]);
    assert.equal(acc.mcpCalls().count, 2);
  });

  it("stores distinct {server, tool} pairs sorted deterministically, whatever the arrival order", () => {
    const events = [
      mcp("item.completed", "i1", "beta", "search", "completed"),
      mcp("item.completed", "i2", "alpha", "search", "completed"),
      mcp("item.completed", "i3", "beta", "list", "completed"),
      mcp("item.completed", "i4", "alpha", "list", "completed"),
      mcp("item.completed", "i5", "alpha", "list", "completed"),
    ];
    const expected = [
      { server: "alpha", tool: "list" }, { server: "alpha", tool: "search" },
      { server: "beta", tool: "list" }, { server: "beta", tool: "search" },
    ];
    assert.deepEqual(feed([stream(...events)]).acc.mcpCalls(), { count: 5, names: expected });
    assert.deepEqual(feed([stream(...[...events].reverse())]).acc.mcpCalls(), { count: 5, names: expected });
  });

  it("ignores items that are not MCP tool calls and events that are not item lifecycle events", () => {
    const { acc } = feed([stream(
      ev.command("c1", "git status", "clean"), ev.message("m1", "hello"),
      JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "hm" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
      ev.thread("t"),
    )]);
    assert.deepEqual(acc.mcpCalls(), { count: 0, names: [] });
  });

  it("never copies arguments, results or errors into the summary", () => {
    const { acc } = feed([stream(
      mcp("item.completed", "item_9", "github", "list_prs", "failed", {
        arguments: { q: "CANARY-ARG" }, result: { content: "CANARY-RES" }, error: { message: "CANARY-ERR" },
      }),
    )]);
    const dump = JSON.stringify([acc.mcpCalls(), acc.warnings()]);
    for (const canary of ["CANARY-ARG", "CANARY-RES", "CANARY-ERR"]) assert.ok(!dump.includes(canary), canary);
  });

  it("counts recognisable MCP items that have no id conservatively, per record, and warns", () => {
    const { acc } = feed([stream(
      mcp("item.started", undefined, "alpha", "ping", "in_progress"),
      mcp("item.completed", undefined, "alpha", "ping", "completed"),
      mcp("item.started", null, "alpha", "ping", "in_progress"),
      mcp("item.completed", "item_1", "beta", "run", "completed"),
    )]);
    assert.equal(acc.mcpCalls().count, 4, "three id-less records + one id'd invocation");
    assert.ok(acc.warnings().some((warning) => /mcp/i.test(warning)), `warnings: ${JSON.stringify(acc.warnings())}`);
  });

  it("raises no warning when every MCP item carries an id", () => {
    const { acc } = feed([stream(mcp("item.completed", "item_1", "beta", "run", "completed"))]);
    assert.deepEqual(acc.warnings(), []);
  });

  it("keeps warnings bounded however many malformed items arrive", () => {
    const record = `${mcp("item.completed", undefined, "alpha", "ping", "completed")}\n`;
    const { acc } = feed([Buffer.from(record.repeat(5000))]);
    assert.equal(acc.mcpCalls().count, 5000);
    assert.ok(acc.warnings().length <= 100, `warnings grew to ${acc.warnings().length}`);
  });

  it("extracts the thread id from each supported event shape; a later id replaces an earlier one", () => {
    const shapes = [
      [{ type: "thread.started", thread_id: "t-snake" }, "t-snake"],
      [{ type: "thread.started", threadId: "t-camel" }, "t-camel"],
      [{ type: "x", thread: { thread_id: "t-nested" } }, "t-nested"],
      [{ type: "x", thread: { id: "t-nested-id" } }, "t-nested-id"],
    ];
    for (const [event, expected] of shapes) assert.equal(feed([stream(JSON.stringify(event))]).acc.threadId(), expected);
    assert.equal(feed([stream(ev.thread("first"), ev.thread("second"))]).acc.threadId(), "second");
    assert.equal(feed([stream(JSON.stringify({ type: "turn.completed" }))]).acc.threadId(), null);
  });

  it("preserves non-JSON progress lines and keeps parsing after them", () => {
    const { acc, seen } = feed([Buffer.from(`Reading prompt from stdin...\n{not json\n${mcp("item.started", "i1", "a", "b", "in_progress")}\n${ev.thread("t-after")}\n`)]);
    assert.deepEqual(seen.slice(0, 2), ["Reading prompt from stdin...", "{not json"]);
    assert.equal(seen.length, 4);
    assert.equal(acc.mcpCalls().count, 1);
    assert.equal(acc.threadId(), "t-after");
  });

  it("emits each non-blank line once, in order, without the line terminator", () => {
    const { seen } = feed([Buffer.from("one\n\n  \ntwo\nthree\n")]);
    assert.deepEqual(seen, ["one", "two", "three"]);
  });

  it("flushes a final event that has no trailing newline when the stream ends", () => {
    const last = ev.thread("t-last");
    const { acc, seen } = feed([Buffer.from(`${mcp("item.started", "i1", "a", "b", "in_progress")}\n${last}`)]);
    assert.equal(acc.threadId(), "t-last");
    assert.deepEqual(seen.at(-1), last);
    assert.equal(acc.mcpCalls().count, 1);
  });

  it("does not report the unterminated final line before end()", () => {
    const { acc } = feed([Buffer.from(ev.thread("t-pending"))], { end: false });
    assert.equal(acc.threadId(), null);
    acc.end();
    assert.equal(acc.threadId(), "t-pending");
  });

  it("decodes a multibyte character split at every byte boundary, and accounts correctly", () => {
    const tool = "recherche-日本-🔍";
    const line = `${mcp("item.started", "i1", "srv-é", tool, "in_progress")}\n${ev.thread("thr-日本")}`;
    const bytes = Buffer.from(line, "utf8");
    for (let at = 0; at <= bytes.length; at += 1) {
      const { acc, seen } = feed([bytes.subarray(0, at), bytes.subarray(at)]);
      assert.deepEqual(acc.mcpCalls(), { count: 1, names: [{ server: "srv-é", tool }] }, `split at ${at}`);
      assert.equal(acc.threadId(), "thr-日本", `split at ${at}`);
      assert.ok(seen.every((entry) => !entry.includes("\uFFFD")), `no replacement character at split ${at}`);
    }
  });

  it("handles one-byte chunks and CRLF line endings", () => {
    const text = `${mcp("item.started", "i1", "a", "b", "in_progress")}\r\n${ev.thread("t-crlf")}\r\n`;
    const { acc } = feed([...Buffer.from(text)].map((byte) => Buffer.from([byte])));
    assert.equal(acc.mcpCalls().count, 1);
    assert.equal(acc.threadId(), "t-crlf");
  });
});

// =============================================================================================
// UNIT: Windows process preflight (plan 4.7)
// =============================================================================================

describe("checkNodeRepl", () => {
  const CSV_HEAD = '"node_repl.exe","1234","Console","1","12,345 K"';
  function check(result) {
    const calls = [];
    const stub = (file, args, options) => {
      calls.push({ file, args, options });
      if (result instanceof Error) throw result;
      return { status: 0, signal: null, error: undefined, stdout: "", stderr: "", ...result };
    };
    return { outcome: fn("checkNodeRepl")(stub), calls };
  }

  it("invokes tasklist.exe directly with the documented filter, bounded in time and output", () => {
    const { calls } = check({ stdout: "" });
    assert.equal(calls.length, 1);
    const [{ file, args, options }] = calls;
    assert.equal(String(file).toLowerCase(), "tasklist.exe");
    assert.deepEqual(args, ["/FI", "IMAGENAME eq node_repl.exe", "/FO", "CSV", "/NH"]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 2000, `timeout ${options.timeout}`);
    assert.ok(Number.isFinite(options.maxBuffer) && options.maxBuffer > 0 && options.maxBuffer <= 16 * 1024 * 1024, `maxBuffer ${options.maxBuffer}`);
  });

  it("running: an exact, case-insensitive image-name match in the first CSV column", () => {
    assert.equal(check({ stdout: `${CSV_HEAD}\r\n` }).outcome.status, "running");
    assert.equal(check({ stdout: '"NODE_REPL.EXE","9","Console","1","1 K"\r\n' }).outcome.status, "running");
    assert.equal(check({ stdout: `"other.exe","1","Console","1","1 K"\r\n${CSV_HEAD}\r\n` }).outcome.status, "running");
  });

  it("not-running: only different image names (no substring or other-column matching)", () => {
    assert.equal(check({ stdout: '"node.exe","12","Console","1","1 K"\r\n' }).outcome.status, "not-running");
    for (const row of [
      '"node_repl.exe.old","1","Console","1","1 K"',
      '"xnode_repl.exe","1","Console","1","1 K"',
      '"notepad.exe","123","Console","1","node_repl.exe - untitled"',
    ]) {
      assert.equal(check({ stdout: `${row}\r\n` }).outcome.status, "not-running", row);
    }
  });

  it("not-running: tasklist's English 'no tasks' notice is the normal no-match answer, not malformed output", () => {
    assert.equal(check({ stdout: "INFO: No tasks are running which match the specified criteria.\r\n" }).outcome.status, "not-running");
  });

  it("unavailable (never an exception) for a missing executable, timeout, denial, signal, or malformed output", () => {
    const enoent = Object.assign(new Error("spawnSync tasklist.exe ENOENT"), { code: "ENOENT" });
    const etimedout = Object.assign(new Error("spawnSync tasklist.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    for (const [label, result] of [
      ["ENOENT", { status: null, error: enoent }],
      ["timeout", { status: null, signal: "SIGKILL", error: etimedout }],
      ["access denied", { status: 1, stdout: "", stderr: "ERROR: Access denied\r\n" }],
      ["killed by signal", { status: null, signal: "SIGTERM" }],
      ["malformed", { stdout: "this is not csv at all\r\nneither is this\r\n" }],
      ["binary", { stdout: "\u0000\u0001\u0002" }],
      ["thrown", new Error("boom")],
    ]) {
      const { outcome } = check(result);
      assert.equal(outcome.status, "unavailable", label);
    }
  });
});

// =============================================================================================
// INTEGRATION: ordinary and isolated argv, resume placement, result contract
// =============================================================================================

describe("integration: argv and result contract", { concurrency: 4 }, () => {
  it("ordinary fresh run: legacy argv, the fixture binary and fixture home, no isolation fields set", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.outLines(ev.thread("thread-fresh-1")), op.final("FINAL-OK")] });
    const run = await fx.run([]);
    expectOutcome(run, "completed", 0);

    const exec = onlyExec(fx);
    assert.deepEqual(exec.argv, ["exec", "--json", "-o", join(run.outDir, "final.txt"), "-s", "workspace-write", "-"]);
    assert.equal(exec.stdin, "TEST-BRIEF", "the brief travels on stdin");
    assert.equal(run.result.codexVersion, FAKE_VERSION, "the fixture binary answered the version probe");
    assert.ok(fx.invocations().some((entry) => entry.kind === "version"));
    assert.ok(samePath(exec.env.CODEX_HOME, fx.codexHome), "child saw the fixture CODEX_HOME");
    assert.ok(!exec.env.keys.some((key) => /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)), `child env keys: ${exec.env.keys}`);

    const { result } = run;
    for (const field of [...LEGACY_RESULT_FIELDS, ...NEW_RESULT_FIELDS]) assert.ok(field in result, `result.${field}`);
    assert.equal(result.schema, "delegate-relay.result.v1");
    assert.equal(result.threadId, "thread-fresh-1");
    assert.equal(result.finalMessage, "FINAL-OK");
    assert.equal(result.isolated, false);
    assert.deepEqual(result.disabledFeatures, []);
    assert.equal(result.windowsSandbox, null);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.mcpCalls, { count: 0, names: [] });
    assert.equal(result.mcpViolation, false);
    assert.deepEqual(result.sandboxFailureReasons, []);
    assert.equal(result.childExitCode, 0);
    assert.equal(result.watchdogFired, false);
    assert.equal(result.abortSignal, null);
    assert.equal(fx.traceCount("preflight"), IS_WIN ? 1 : 0, "preflight runs on Windows sandboxed runs only");
    assert.deepEqual(fx.configTouches(), [], "no configuration is read for a non-isolated run");
  });

  it("isolated fresh run: isolation group at exec level, bare backend token, backend preserved from the fixture config", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.outLines(ev.thread("thread-iso-1")), op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated"]);
    expectOutcome(run, "completed", 0);
    const exec = onlyExec(fx);
    assert.deepEqual(exec.argv, ["exec", ...ISOLATION_GROUP, "--json", "-o", join(run.outDir, "final.txt"), "-s", "read-only", "-"]);
    assert.equal(run.result.isolated, true);
    assert.ok(run.result.disabledFeatures.includes("apps"));
    assert.equal(run.result.windowsSandbox, IS_WIN ? "elevated" : null);
    expectWarnings(run.result, [RE.noModel]);
  });

  it("isolated resume by id: sandbox before resume; isolation and backend after the target", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--session", "thread-abc"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, [
      "exec", "-s", "read-only", "resume", "thread-abc", "--json", "-o", join(run.outDir, "final.txt"), ...ISOLATION_GROUP, "-",
    ]);
    assert.equal(run.result.session, "thread-abc");
  });

  it("isolated resume --last: same placement, plus the global-last warning", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--resume-last"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, [
      "exec", "-s", "read-only", "resume", "--last", "--json", "-o", join(run.outDir, "final.txt"), ...ISOLATION_GROUP, "-",
    ]);
    expectWarnings(run.result, [RE.noModel, RE.resumeLast]);
    const text = warningMatches(run.result, RE.resumeLast)[0];
    assert.ok(run.stderr.includes(text), "the warning is written to the relay's stderr");
    assert.ok(!readFileSync(run.result.stderrPath, "utf8").includes(text), "relay warnings are kept out of the captured child stderr");
  });

  it("unqualified isolated resume carries no -s and does not impose the relay's default sandbox", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--isolated", "--session", "thread-abc", "--model", "model-test"]);
    expectOutcome(run, "completed", 0);
    const argv = onlyExec(fx).argv;
    assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "thread-abc"]);
    assert.ok(!argv.includes("-s"), argv.join(" "));
    assert.equal(run.result.sandbox, "(Codex config on resume)");
    assert.equal(run.result.isolated, true);
    // The resume's sandbox is unknown, so the old-version process preflight stays conservative (Windows only).
    assert.equal(fx.traceCount("preflight"), IS_WIN ? 1 : 0, "unqualified resume keeps the conservative preflight on Windows");
  });

  it("resume: model, effort and backend -c arguments all follow the target", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--session", "thread-abc", "--model", "model-test", "--effort", "high"]);
    expectOutcome(run, "completed", 0);
    const argv = onlyExec(fx).argv;
    const at = argv.indexOf("resume");
    assert.deepEqual(argv.slice(0, at), ["exec", "-s", "read-only"]);
    const after = argv.slice(at + 2);
    for (const group of [["-c", "model_reasoning_effort=high"], ["-m", "model-test"], ["--ignore-user-config"], ["--disable", "apps"], ...(IS_WIN ? [["-c", "windows.sandbox=elevated"]] : [])]) {
      assert.ok(hasSequence(after, group), `${group.join(" ")} after the target: ${argv.join(" ")}`);
    }
    assert.equal(argv.at(-1), "-");
    assert.ok(!argv.some((token) => /sandbox_mode/.test(token)));
    assert.equal(run.result.warnings.filter((w) => RE.noModel.test(w)).length, 0, "an explicit model suppresses the no-model warning");
  });

  it("isolated read-only run with --web-search: the mode reaches Codex after the isolation group and is recorded", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--web-search", "live", "--model", "model-test"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, [
      "exec", ...ISOLATION_GROUP, "--json", "-o", join(run.outDir, "final.txt"), "-s", "read-only",
      "-m", "model-test", "-c", "web_search=live", "-",
    ]);
    assert.equal(run.result.isolated, true);
    assert.equal(run.result.webSearch, "live");
    assert.equal(run.result.networkAccess, false);
  });

  it("a read-only lane overridden with --sandbox workspace-write --network-access stays isolated and passes the upstream overrides", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.lanes({ review: { implementer: "codex", readOnly: true, model: "model-lane" } });
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--lane", "review", "--sandbox", "workspace-write", "--network-access", "--subagent-model", "sub-m", "--subagent-effort", "low"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, [
      "exec", ...ISOLATION_GROUP, "--json", "-o", join(run.outDir, "final.txt"), "-s", "workspace-write",
      "-m", "model-lane", "-c", "agents.default_subagent_model=sub-m", "-c", "agents.default_subagent_reasoning_effort=low",
      "-c", "sandbox_workspace_write.network_access=true", "-",
    ]);
    assert.equal(run.result.isolated, true, "the lane is read-only, so the isolation default holds under an explicit sandbox");
    assert.equal(run.result.networkAccess, true);
    assert.equal(run.result.subagentModel, "sub-m");
    assert.equal(run.result.subagentEffort, "low");
  });

  it("isolated resume --last with the upstream overrides: every -c after the target, isolation group last", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run([
      "--sandbox", "workspace-write", "--isolated", "--resume-last", "--model", "model-test", "--effort", "high",
      "--subagent-model", "sub-m", "--subagent-effort", "low", "--web-search", "cached", "--network-access",
    ]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, [
      "exec", "-s", "workspace-write", "resume", "--last", "--json", "-o", join(run.outDir, "final.txt"),
      "-m", "model-test", "-c", "model_reasoning_effort=high", "-c", "agents.default_subagent_model=sub-m",
      "-c", "agents.default_subagent_reasoning_effort=low", "-c", "web_search=cached",
      "-c", "sandbox_workspace_write.network_access=true", ...ISOLATION_GROUP, "-",
    ]);
    expectWarnings(run.result, [RE.resumeLast]);
  });

  it("explicit sandbox on a resume without isolation: -s before resume, legacy shape otherwise", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--sandbox", "workspace-write", "--session", "thread-abc"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(onlyExec(fx).argv, ["exec", "-s", "workspace-write", "resume", "thread-abc", "--json", "-o", join(run.outDir, "final.txt"), "-"]);
  });

  it("the feature list is deduplicated in stable order and always keeps apps under isolation", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--isolated", "--model", "m", "--disable", "web_search", "--disable", "foo", "--disable", "web_search", "--disable", "apps"]);
    expectOutcome(run, "completed", 0);
    const argv = onlyExec(fx).argv;
    const disables = argv.flatMap((token, i) => (token === "--disable" ? [argv[i + 1]] : []));
    assert.equal(new Set(disables).size, disables.length, `no duplicates: ${disables}`);
    assert.deepEqual([...disables].sort(), ["apps", "foo", "web_search"]);
    assert.ok(disables.indexOf("web_search") < disables.indexOf("foo"), "user-specified features keep first-seen order");
    assert.deepEqual([...run.result.disabledFeatures].sort(), ["apps", "foo", "web_search"]);
  });

  it("a feature disable without isolation is passed through alone; apps is not added", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--disable", "foo"]);
    expectOutcome(run, "completed", 0);
    const argv = onlyExec(fx).argv;
    assert.deepEqual(argv.slice(0, 3), ["exec", "--disable", "foo"]);
    assert.ok(!argv.includes("--ignore-user-config") && !argv.includes("apps"), argv.join(" "));
    assert.equal(run.result.isolated, false);
    assert.deepEqual(run.result.disabledFeatures, ["foo"]);
  });

  it("--clean-env does not imply isolation, and --isolated does not imply --clean-env", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const clean = await fx.run(["--clean-env"]);
    expectOutcome(clean, "completed", 0);
    assert.equal(clean.result.isolated, false);
    assert.equal(clean.result.cleanEnv, true);
    assert.ok(!onlyExec(fx).argv.includes("--ignore-user-config"));
    fx.scenario({ steps: [op.final("ok")] });
    const isolated = await fx.run(["--isolated", "--model", "m"]);
    expectOutcome(isolated, "completed", 0);
    assert.equal(isolated.result.cleanEnv, false);
    assert.equal(isolated.result.isolated, true);
  });

  it("existing validation survives: --keep-env needs --clean-env; --session and --resume-last conflict", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const keep = await fx.run(["--keep-env", "PATH"], { noOutDir: true });
    assert.equal(keep.code, 2);
    assert.match(keep.stderr, /--keep-env requires --clean-env/);
    const both = await fx.run(["--session", "t1", "--resume-last"], { noOutDir: true });
    assert.equal(both.code, 2);
    assert.match(both.stderr, /mutually exclusive/);
    assert.equal(fx.invocations().length, 0, "Codex is never launched on a usage error");
  });
});

// =============================================================================================
// INTEGRATION: isolation defaults and precedence through fleet lanes (plan 4.1)
// =============================================================================================

describe("integration: isolation defaults, precedence and opt-out", { concurrency: 4 }, () => {
  const LANES = {
    plan: { implementer: "codex", readOnly: true },
    rosandbox: { implementer: "codex", sandbox: "read-only" },
    "ro-optout": { implementer: "codex", readOnly: true, isolated: false },
    "ro-iso": { implementer: "codex", readOnly: true, isolated: true },
    ww: { implementer: "codex", sandbox: "workspace-write" },
    "ww-iso": { implementer: "codex", sandbox: "workspace-write", isolated: true },
    plain: { implementer: "codex" },
    "ro-model": { implementer: "codex", readOnly: true, model: "model-lane" },
  };

  async function isolationOf(t, args) {
    const fx = makeFixture(t);
    fx.lanes(LANES);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(args);
    expectOutcome(run, "completed", 0);
    const argv = onlyExec(fx).argv;
    const bundled = argv.includes("--ignore-user-config");
    assert.equal(argv.some((token, i) => token === "--disable" && argv[i + 1] === "apps"), bundled, `--disable apps travels with --ignore-user-config: ${argv.join(" ")}`);
    assert.equal(run.result.isolated, bundled, `result.isolated matches argv: ${argv.join(" ")}`);
    assert.equal(run.result.disabledFeatures.includes("apps"), bundled);
    return { run, argv, bundled };
  }

  const CASES = [
    // [title, args, expected isolation]
    ["read-only readOnly lane defaults to isolated", ["--lane", "plan"], true],
    ["read-only sandbox lane defaults to isolated", ["--lane", "rosandbox"], true],
    ["lane isolated:false beats the read-only default", ["--lane", "ro-optout"], false],
    ["lane isolated:true on a read-only lane", ["--lane", "ro-iso"], true],
    ["--no-isolated beats the read-only default", ["--lane", "plan", "--no-isolated"], false],
    ["--isolated beats lane isolated:false", ["--lane", "ro-optout", "--isolated"], true],
    ["--no-isolated beats lane isolated:true", ["--lane", "ww-iso", "--no-isolated"], false],
    ["workspace-write lane is not isolated by default", ["--lane", "ww"], false],
    ["lane isolated:true on a workspace-write lane", ["--lane", "ww-iso"], true],
    ["a lane with no sandbox is not isolated", ["--lane", "plain"], false],
    ["explicit write sandbox does not hide the captured read-only lane default", ["--lane", "plan", "--sandbox", "workspace-write"], true],
    ["--read-only on a read-only lane keeps the default", ["--lane", "plan", "--read-only"], true],
    ["standalone --read-only without a lane does not enable isolation", ["--read-only"], false],
    ["standalone --read-only plus --isolated", ["--read-only", "--isolated"], true],
    ["no flags, no lane", [], false],
    ["write-capable sandbox plus --isolated is allowed", ["--sandbox", "workspace-write", "--isolated"], true],
    ["explicit --ignore-user-config enables the whole bundle", ["--ignore-user-config"], true],
    ["--no-isolated then --ignore-user-config keeps the bundle", ["--no-isolated", "--ignore-user-config"], true],
    ["--ignore-user-config then --no-isolated keeps the bundle", ["--ignore-user-config", "--no-isolated"], true],
    ["last explicit switch wins: --isolated then --no-isolated", ["--isolated", "--no-isolated"], false],
    ["last explicit switch wins: --no-isolated then --isolated", ["--no-isolated", "--isolated"], true],
  ];
  for (const [title, args, expected] of CASES) {
    it(`${title}`, { timeout: 60_000 }, async (t) => {
      const { bundled } = await isolationOf(t, args);
      assert.equal(bundled, expected);
    });
  }

  it("an explicit write sandbox on a read-only lane changes -s but leaves isolation on", { timeout: 60_000 }, async (t) => {
    const { argv } = await isolationOf(t, ["--lane", "plan", "--sandbox", "workspace-write"]);
    assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
  });

  it("a lane sandbox applies on resume: -s before resume, taken from the lane", { timeout: 60_000 }, async (t) => {
    const { argv } = await isolationOf(t, ["--lane", "rosandbox", "--session", "thread-abc"]);
    assert.deepEqual(argv.slice(0, 4), ["exec", "-s", "read-only", "resume"]);
  });

  it("an explicit CLI or lane model suppresses the no-model warning; its absence raises it", { timeout: 60_000 }, async (t) => {
    const noModel = await isolationOf(t, ["--lane", "plan"]);
    assert.ok(warningMatches(noModel.run.result, RE.noModel).length >= 1, JSON.stringify(noModel.run.result.warnings));
    const cli = await isolationOf(t, ["--lane", "plan", "--model", "model-test"]);
    assert.equal(warningMatches(cli.run.result, RE.noModel).length, 0, JSON.stringify(cli.run.result.warnings));
    const lane = await isolationOf(t, ["--lane", "ro-model"]);
    assert.equal(lane.run.result.model, "model-lane");
    assert.equal(warningMatches(lane.run.result, RE.noModel).length, 0, JSON.stringify(lane.run.result.warnings));
  });

  it("a non-isolated run raises no no-model warning", { timeout: 60_000 }, async (t) => {
    const plain = await isolationOf(t, ["--lane", "ww"]);
    assert.equal(warningMatches(plain.run.result, RE.noModel).length, 0);
  });
});

// =============================================================================================
// INTEGRATION: invalid feature tokens are rejected before launch (plan 4.3)
// =============================================================================================

describe("integration: invalid --disable values", { concurrency: 4 }, () => {
  const BAD = [
    ["empty", ""], ["whitespace", "a b"], ["flag-shaped", "--json"], ["leading dash", "-apps"],
    ["ampersand", "a&b"], ["pipe", "a|b"], ["percent", "a%b"], ["quote", 'a"b'],
  ];
  for (const [label, value] of BAD) {
    it(`rejects a ${label} feature name before artifact preparation and launch`, { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      const outDir = fx.outDir("never");
      const run = await fx.run(["--disable", value], { outDir });
      assert.equal(run.code, 2, `stderr: ${run.stderr}`);
      assert.equal(run.result, null, "usage errors publish no result");
      assert.ok(!existsSync(outDir), "no artifact directory was created");
      assert.equal(fx.invocations().length, 0, "Codex was not launched");
    });
  }

  // The accepted shape is ^[A-Za-z0-9][A-Za-z0-9._:/-]*$: the first character must be a letter or digit.
  // The diagnostic has to say so, or "_apps" and ".apps" look like they should be accepted.
  for (const value of ["_apps", ".apps", "-apps", "a&b"]) {
    it(`the diagnostic for an invalid --disable ${JSON.stringify(value)} says the value must start with a letter or digit`, { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      const run = await fx.run(["--disable", value], { noOutDir: true });
      assert.equal(run.code, 2, run.stderr);
      assert.match(run.stderr, /invalid --disable/);
      assert.match(run.stderr, START_WITH_ALNUM, `the diagnostic must state the first-character rule:\n${run.stderr}`);
      assert.equal(fx.invocations().length, 0, "Codex was not launched");
    });
  }

  it("rejects --disable with no value", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const run = await fx.run(["--disable"], { noOutDir: true });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /--disable requires a value/);
  });

  it("accepts model-token-shaped names and passes them through untouched", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--disable", "a.b_c:d/e-f"]);
    expectOutcome(run, "completed", 0);
    assert.ok(hasSequence(onlyExec(fx).argv, ["--disable", "a.b_c:d/e-f"]));
  });
});

// =============================================================================================
// INTEGRATION: Windows configuration reader and backend preservation (plan 4.2)
// =============================================================================================

describe("integration: Windows sandbox setting", { concurrency: 4 }, () => {
  const isolatedArgs = ["--read-only", "--isolated", "--model", "model-test"];

  it("emits the bare backend token as one exact argument through the .cmd shim (elevated and unelevated)", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    for (const value of ["elevated", "unelevated"]) {
      const fx = makeFixture(t);
      fx.config(lines("[windows]", `sandbox = "${value}"`, ""));
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "completed", 0);
      const argv = onlyExec(fx).argv;
      assert.ok(hasSequence(argv, ["-c", `windows.sandbox=${value}`]), `${value}: ${argv.join(" ")}`);
      assert.equal(argv.filter((token) => token.includes("windows.sandbox")).length, 1);
      assert.equal(run.result.windowsSandbox, value);
      assert.deepEqual(run.result.warnings, []);
    }
  });

  it("reads only $CODEX_HOME/config.toml, and only for isolated runs", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(WIN_ELEVATED);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(isolatedArgs);
    expectOutcome(run, "completed", 0);
    const touched = fx.configTouches();
    assert.ok(touched.length >= 1, "the reader ran");
    assert.ok(touched.every((path) => samePath(path, fx.configPath)), `unexpected configuration paths read: ${touched.join(", ")}`);

    const other = makeFixture(t);
    other.config(WIN_ELEVATED);
    other.scenario({ steps: [op.final("ok")] });
    const plain = await other.run(["--model", "m"]);
    expectOutcome(plain, "completed", 0);
    assert.deepEqual(other.configTouches(), [], "no reader for a non-isolated run");
    assert.ok(!onlyExec(other).argv.some((token) => token.startsWith("windows.")));
  });

  it("falls back to <home>/.codex/config.toml when CODEX_HOME is unset", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const path = fx.config(lines("[windows]", 'sandbox = "unelevated"', ""), { underHome: true });
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(isolatedArgs, { env: { CODEX_HOME: null } });
    expectOutcome(run, "completed", 0);
    assert.ok(fx.configTouches().every((touched) => samePath(touched, path)), fx.configTouches().join(", "));
    assert.ok(hasSequence(onlyExec(fx).argv, ["-c", "windows.sandbox=unelevated"]));
  });

  it("a non-isolated explicit --ignore-user-config run still preserves the backend", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(WIN_ELEVATED);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--no-isolated", "--ignore-user-config", "--model", "m"]);
    expectOutcome(run, "completed", 0);
    assert.ok(hasSequence(onlyExec(fx).argv, ["-c", "windows.sandbox=elevated"]));
    assert.equal(run.result.isolated, true);
  });

  it("BOM, CRLF, comments and a dotted key are extracted; nested tables and the literal key are not", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      [`\uFEFF# c\r\n[windows]\r\nsandbox = "elevated" # trailing\r\n`, "elevated"],
      [lines('windows . "sandbox" = \'unelevated\'', 'model = "x"'), "unelevated"],
    ];
    for (const [text, expected] of cases) {
      const fx = makeFixture(t);
      fx.config(text);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, expected);
      assert.ok(hasSequence(onlyExec(fx).argv, ["-c", `windows.sandbox=${expected}`]));
    }
    for (const text of [
      lines("[profiles.dev.windows]", 'sandbox = "elevated"'),
      '"windows.sandbox" = "elevated"',
      lines("[[windows]]", 'sandbox = "elevated"'),
    ]) {
      const fx = makeFixture(t);
      fx.config(text);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, null, text);
      assert.ok(!onlyExec(fx).argv.some((token) => token.startsWith("windows.")), text);
      expectWarnings(run.result, [RE.keyMissing]);
    }
  });

  it("missing configuration file: warn, no override, dispatch proceeds", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(isolatedArgs);
    expectOutcome(run, "completed", 0);
    assert.equal(run.result.windowsSandbox, null);
    assert.ok(!onlyExec(fx).argv.some((token) => token.startsWith("windows.")));
    expectWarnings(run.result, [RE.configFileMissing]);
    assert.ok(run.stderr.includes(run.result.warnings[0]), "warning also written to stderr");
  });

  it("missing key (and unrelated unsupported syntax): warn, no override, dispatch proceeds", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    for (const text of ["", lines('model = "x"', "[tui]", "theme = 'dark'"), lines('note = """', "free text", '"""', "[other]", "a = 1"), "[oops"]) {
      const fx = makeFixture(t);
      fx.config(text);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, null, JSON.stringify(text));
      expectWarnings(run.result, [RE.keyMissing]);
    }
  });

  // Plan 4.2: unrelated unsupported content must not become a validation failure. A long line (up to
  // the 1 MiB cap, so 4097 bytes included) that is not about the target is a warning (no key found)
  // and the run proceeds. (Over the cap a line is a pre-dispatch failure: see FAIL_CLOSED below.)
  it("long unrelated content (a multiline string with a 4097-byte line, a padded header) is a warning, not a failure", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    for (const text of [
      lines('note = """', "x".repeat(4097), '"""', ""),
      lines(`[other]${" ".repeat(4097)}`, "k = 1", ""),
    ]) {
      const fx = makeFixture(t);
      fx.config(text);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, null);
      expectWarnings(run.result, [RE.keyMissing]);
    }
  });

  const HARD_FAILURES = {
    "invalid value": lines("[windows]", 'sandbox = "CANARY-5b1e"'),
    "bare word": lines("[windows]", "sandbox = CANARY-5b1e"),
    // A top-level dotted key must precede every table header; after [windows] it would be a different key.
    "duplicate definitions": lines('windows.sandbox = "CANARY-5b1e"', "[windows]", 'sandbox = "elevated"'),
    "inline table": 'windows = { sandbox = "CANARY-5b1e" }',
    "multiline ambiguity": lines('note = """', "x", '"""', "[windows]", 'sandbox = "CANARY-5b1e"'),
  };
  for (const [title, text] of Object.entries(HARD_FAILURES)) {
    it(`${title}: pre-dispatch failed / exit 2 with a published result and nothing echoed`, { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.config(text);
      fx.scenario({ steps: [op.final("never")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "failed", 2);
      assert.equal(run.result.childExitCode, null);
      assert.match(run.result.error, /isolation configuration/i);
      assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
      assert.equal(fx.traceCount("preflight"), 0, "a configuration failure exits before any process preflight");
      assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
      assert.equal(run.result.mcpViolation, false);
      for (const surface of [run.stdout, run.stderr, readFileSync(run.resultPath, "utf8")]) {
        assert.ok(!surface.includes("CANARY-5b1e"), "rejected configuration content must never be echoed");
      }
    });
  }

  // Fail-closed additions (plan 4.2): a target hidden behind padding or an escaped key must stop the
  // run before dispatch exactly like the cases above, never fall through to "missing key".
  const FAIL_CLOSED = {
    "target hidden behind overlong padding": () => lines("[windows]", `${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1024)}sandbox = "CANARY-5b1e"`, ""),
    "duplicate hidden behind overlong padding": () => lines("[windows]", 'sandbox = "elevated"', `${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1024)}sandbox = "CANARY-5b1e"`, ""),
    "top-level dotted key hidden behind overlong padding": () => lines(`${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1024)}windows.sandbox = "CANARY-5b1e"`, ""),
    "incomplete dotted key prefix on an overlong line": () => lines(`windows.${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1024)}sandbox = "CANARY-5b1e"`, ""),
    "ancestor assignment with its value beyond the cap": () => lines(`windows = ${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1)}{ sandbox = "CANARY-5b1e" }`, ""),
    "ancestor assignment hidden after a valid dotted definition": () => lines('windows.sandbox = "elevated"', `windows = ${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1)}{ sandbox = "CANARY-5b1e" }`, ""),
    "escaped ancestor key with its value beyond the cap": () => lines(`"\\u0077indows" = ${" ".repeat(R().MAX_CONFIG_LINE_BYTES + 1)}{ sandbox = "CANARY-5b1e" }`, ""),
    "unrelated line over the 1 MiB cap": () => lines(`note = "${"x".repeat(R().MAX_CONFIG_LINE_BYTES + 1)}"`, ""),
    "escaped key inside [windows]": () => lines("[windows]", '"\\u0073andbox" = "CANARY-5b1e"'),
    "escaped dotted key": () => lines('"windows"."\\u0073andbox" = "CANARY-5b1e"'),
    "escaped table header": () => lines('["\\u0077indows"]', 'sandbox = "CANARY-5b1e"'),
    "inline table with an escaped key": () => 'windows = { "\\u0073andbox" = "CANARY-5b1e" }',
  };
  for (const [title, text] of Object.entries(FAIL_CLOSED)) {
    it(`${title}: pre-dispatch failed / exit 2 with a published result and nothing echoed`, { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.config(text());
      fx.scenario({ steps: [op.final("never")] });
      const run = await fx.run(isolatedArgs);
      expectOutcome(run, "failed", 2);
      assert.equal(run.result.childExitCode, null);
      assert.equal(run.result.windowsSandbox, null);
      assert.match(run.result.error, /isolation configuration/i);
      assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
      assert.equal(fx.traceCount("preflight"), 0, "a configuration failure exits before any process preflight");
      assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
      for (const surface of [run.stdout, run.stderr, readFileSync(run.resultPath, "utf8")]) {
        assert.ok(!surface.includes("CANARY-5b1e"), "rejected configuration content must never be echoed");
        assert.ok(!surface.includes("u0073") && !surface.includes("u0077"), "an escaped key must never be echoed");
        assert.ok(!surface.includes(" ".repeat(64)), "padding from an overlong line must never be echoed");
      }
    });
  }

  for (const fault of ["open", "read"]) {
    it(`an existing file that fails on ${fault} (injected I/O error): pre-dispatch failed / exit 2`, { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.config(WIN_ELEVATED);
      fx.scenario({ steps: [op.final("never")] });
      const run = await fx.run(isolatedArgs, { env: { RELAY_TEST_CONFIG_FAULT: fault } });
      expectOutcome(run, "failed", 2);
      assert.equal(run.result.childExitCode, null);
      assert.match(run.result.error, /isolation configuration/i);
      assert.equal(fx.execInvocations().length, 0);
      assert.equal(fx.traceCount("preflight"), 0, "a configuration failure exits before any process preflight");
    });
  }

  it("non-Windows hosts never read the Windows setting and never emit the backend", { skip: IS_WIN ? "POSIX-only observation" : false, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(lines("[windows]", "sandbox = broken CANARY"), {});
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(isolatedArgs);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(fx.configTouches(), []);
    assert.equal(fx.traceCount("preflight"), 0);
    assert.ok(!onlyExec(fx).argv.some((token) => token.startsWith("windows.")));
    assert.equal(run.result.windowsSandbox, null);
  });
});

// =============================================================================================
// INTEGRATION: Windows process preflight (plan 4.7)
// =============================================================================================

describe("integration: process preflight", { concurrency: 4 }, () => {
  it("running node_repl.exe warns and still dispatches", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"], { env: { RELAY_TEST_PREFLIGHT: "running" } });
    expectOutcome(run, "completed", 0);
    expectWarnings(run.result, [RE.nodeRepl]);
    assert.deepEqual(run.result.warnings, [RUNNING_WARNING], "the upgrade-first wording, exactly");
    assert.equal(fx.traceCount("preflight"), 1);
    assert.equal(fx.execInvocations().length, 1, "warn-only: Codex is still launched");
  });

  it("an unavailable or crashing preflight is a non-fatal warning", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    for (const mode of ["unavailable", "throw"]) {
      const fx = makeFixture(t);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(["--model", "m", "--sandbox", "workspace-write"], { env: { RELAY_TEST_PREFLIGHT: mode } });
      expectOutcome(run, "completed", 0);
      expectWarnings(run.result, [RE.preflightUnavailable]);
      // The driver's "unavailable" reports the reason "simulated"; a throwing check is "the check crashed".
      assert.deepEqual(run.result.warnings, [unavailableWarning(mode === "throw" ? "the check crashed" : "simulated")], mode);
    }
  });

  it("a clear preflight adds no warning; on an old or unknown CLI it runs for read-only and workspace-write, isolated or not", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    for (const args of [["--read-only"], ["--sandbox", "workspace-write"], ["--read-only", "--isolated"]]) {
      const fx = isolatedFixture(t);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run([...args, "--model", "m"]);
      expectOutcome(run, "completed", 0);
      assert.equal(fx.traceCount("preflight"), 1, args.join(" "));
      assert.deepEqual(run.result.warnings, [], args.join(" "));
    }
  });

  it("danger-full-access skips the preflight entirely", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--sandbox", "danger-full-access", "--isolated", "--model", "m"], { env: { RELAY_TEST_PREFLIGHT: "running" } });
    expectOutcome(run, "completed", 0);
    assert.equal(fx.traceCount("preflight"), 0);
    assert.deepEqual(run.result.warnings, []);
  });

  it("non-Windows hosts never run the preflight", { skip: IS_WIN ? "POSIX-only observation" : false, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"], { env: { RELAY_TEST_PREFLIGHT: "running" } });
    expectOutcome(run, "completed", 0);
    assert.equal(fx.traceCount("preflight"), 0);
    assert.deepEqual(run.result.warnings, []);
  });

  it("relay warnings never feed the sandbox-failure matcher", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--resume-last"], { env: { RELAY_TEST_PREFLIGHT: "running" } });
    expectOutcome(run, "completed", 0);
    assert.ok(run.result.warnings.length >= 2, JSON.stringify(run.result.warnings));
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });

  // ---- Windows Desktop ACL fix: version- and backend-aware preflight (plan 2026-10-17, sections 4 and 5) ----

  it("fixed Windows CLI skips injected process preflight", { timeout: 60_000 }, async (t) => {
    for (const version of [VERSION_FIXED, VERSION_FIXED_ALPHA]) {
      for (const mode of ["running", "throw"]) {
        const label = `${version} with an injected "${mode}" preflight`;
        const fx = isolatedFixture(t);
        fx.scenario({ version: { stdout: `${version}\n` }, steps: [op.final("ok")] });
        const run = await fx.run(ISOLATED_ARGS, { env: { RELAY_TEST_PREFLIGHT: mode } });
        expectOutcome(run, "completed", 0);
        assert.equal(run.result.windowsSandbox, IS_WIN ? "elevated" : null, `${label}: backend (A5: --isolated resolves it)`);
        assert.equal(run.result.codexVersion, version, label);
        assert.equal(fx.traceCount("preflight"), 0, `${label}: the process preflight must not run`);
        assert.deepEqual(run.result.warnings, [], `${label}: no process warning, neither running nor unavailable`);
        assert.ok(!/node_repl/i.test(run.stderr), `${label}: nothing about node_repl.exe on stderr:\n${run.stderr}`);
        assert.equal(fx.execInvocations().length, 1, `${label}: Codex is dispatched once`);
      }
    }
  });

  it("old and unknown Windows CLI retain upgrade-first warning", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      ["0.162.1", `${VERSION_OLD}\n`, VERSION_OLD],
      ["an untested 0.163.0 alpha", `${VERSION_UNTESTED_ALPHA}\n`, VERSION_UNTESTED_ALPHA],
      ["malformed stdout (a fixed-looking banner with an extra line)", `${VERSION_FIXED}\nextra line\n`, `${VERSION_FIXED}\nextra line`],
      ['the literal "unknown"', "unknown\n", "unknown"],
      ["empty stdout (stored as unknown)", "", "unknown"],
    ];
    for (const [title, stdout, stored] of cases) {
      const fx = isolatedFixture(t);
      fx.scenario({ version: { stdout }, steps: [op.final("ok")] });
      const run = await fx.run(ISOLATED_ARGS, { env: { RELAY_TEST_PREFLIGHT: "running" } });
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, "elevated", title);
      assert.equal(run.result.codexVersion, stored, `${title}: the trimmed probe output is what the result stores`);
      assert.equal(fx.traceCount("preflight"), 1, `${title}: not known fixed, so the preflight runs`);
      assert.deepEqual(run.result.warnings, [RUNNING_WARNING], title);
      assert.ok(run.stderr.includes(RUNNING_WARNING), `${title}: the warning is also written to stderr:\n${run.stderr}`);
      assert.equal(fx.execInvocations().length, 1, `${title}: warn-only, Codex is still launched`);
    }
  });

  it("resolved unelevated skips preflight on old CLI", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(lines("[windows]", 'sandbox = "unelevated"', ""));
    fx.scenario({ version: { stdout: `${VERSION_OLD}\n` }, steps: [op.final("ok")] });
    const run = await fx.run(ISOLATED_ARGS, { env: { RELAY_TEST_PREFLIGHT: "throw" } });
    expectOutcome(run, "completed", 0);
    assert.equal(fx.traceCount("preflight"), 0, "a resolved unelevated backend runs no setup helper, so no preflight");
    assert.equal(run.result.windowsSandbox, "unelevated");
    assert.equal(run.result.codexVersion, VERSION_OLD);
    assert.deepEqual(run.result.warnings, [], "neither the running nor the unavailable warning");
    const argv = onlyExec(fx).argv;
    assert.deepEqual(argv.slice(0, 6), ["exec", "--ignore-user-config", "--disable", "apps", "-c", "windows.sandbox=unelevated"]);
    assert.equal(argv.filter((token) => token.includes("windows.sandbox")).length, 1);
  });

  it("unknown backend retains old-version preflight without broader config access", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      // Not isolated: the fixture's config would resolve elevated, but must not be read at all.
      { title: "non-isolated", fixture: isolatedFixture, args: ["--model", "m"], reads: false, others: [] },
      { title: "isolated, missing configuration file", fixture: makeFixture, args: ISOLATED_ARGS, reads: true, others: [RE.configFileMissing] },
      { title: "isolated, missing [windows] sandbox key", fixture: makeFixture, config: lines('model = "x"', ""), args: ISOLATED_ARGS, reads: true, others: [RE.keyMissing] },
    ];
    for (const { title, fixture, config, args, reads, others } of cases) {
      const fx = fixture(t);
      if (config !== undefined) fx.config(config);
      fx.scenario({ version: { stdout: `${VERSION_OLD}\n` }, steps: [op.final("ok")] });
      const run = await fx.run(args, { env: { RELAY_TEST_PREFLIGHT: "running" } });
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.windowsSandbox, null, `${title}: the backend stays unknown`);
      assert.equal(fx.traceCount("preflight"), 1, `${title}: an unknown backend on an old CLI keeps the conservative preflight`);

      const touches = fx.configTouches();
      if (!reads) {
        assert.deepEqual(touches, [], `${title}: no configuration is read for a non-isolated run`);
      } else {
        assert.ok(touches.length >= 1, `${title}: the reader ran`);
        const distinct = [];
        for (const path of touches) if (!distinct.some((seen) => samePath(seen, path))) distinct.push(path);
        assert.equal(distinct.length, 1, `${title}: distinct configuration paths touched: ${distinct.join(", ")}`);
        assert.ok(samePath(distinct[0], fx.configPath), `${title}: only the resolved fixture config.toml may be touched, saw ${distinct[0]}`);
      }

      // The existing configuration warnings are kept next to the one running-process warning.
      const rest = run.result.warnings.filter((warning) => warning !== RUNNING_WARNING);
      assert.equal(run.result.warnings.length - rest.length, 1, `${title}: exactly one running-process warning: ${JSON.stringify(run.result.warnings)}`);
      expectWarnings({ warnings: rest }, others);
    }
  });

  // ---- Review fix loop 1: boundaries the first test pass left unpinned ----

  it("a known-fixed CLI keeps the other isolation warnings (no model, resume-last) while skipping the preflight", { timeout: 60_000 }, async (t) => {
    const cases = [
      ["no explicit model", ["--read-only", "--isolated"], [RE.noModel]],
      ["resume-last", ["--read-only", "--isolated", "--model", "m", "--resume-last"], [RE.resumeLast]],
      ["no model and resume-last", ["--read-only", "--isolated", "--resume-last"], [RE.noModel, RE.resumeLast]],
    ];
    for (const version of [VERSION_FIXED, VERSION_FIXED_ALPHA]) {
      for (const [title, args, expected] of cases) {
        const label = `${version}, ${title}`;
        const fx = isolatedFixture(t);
        fx.scenario({ version: { stdout: `${version}\n` }, steps: [op.final("ok")] });
        const run = await fx.run(args, { env: { RELAY_TEST_PREFLIGHT: "running" } });
        expectOutcome(run, "completed", 0);
        assert.equal(fx.traceCount("preflight"), 0, `${label}: a known-fixed CLI skips the process preflight`);
        expectWarnings(run.result, expected);
        for (const warning of run.result.warnings) {
          assert.ok(run.stderr.includes(warning), `${label}: the warning is also written to stderr: ${warning}`);
        }
        assert.equal(fx.execInvocations().length, 1, label);
      }
    }
  });

  it("a known-fixed CLI keeps the configuration warnings (missing file, missing key) with no model, and still skips the preflight", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      // The no-model warning is listed first: its text also mentions the user config.
      ["missing configuration file", undefined, [RE.noModel, RE.configFileMissing]],
      ["missing [windows] sandbox key", lines('model = "x"', ""), [RE.noModel, RE.keyMissing]],
    ];
    for (const version of [VERSION_FIXED, VERSION_FIXED_ALPHA]) {
      for (const [title, config, expected] of cases) {
        const label = `${version}, ${title}`;
        const fx = makeFixture(t);
        if (config !== undefined) fx.config(config);
        fx.scenario({ version: { stdout: `${version}\n` }, steps: [op.final("ok")] });
        const run = await fx.run(["--read-only", "--isolated"], { env: { RELAY_TEST_PREFLIGHT: "running" } });
        expectOutcome(run, "completed", 0);
        assert.equal(run.result.windowsSandbox, null, `${label}: the backend stays unknown`);
        assert.ok(fx.configTouches().length >= 1, `${label}: the configuration was read`);
        assert.equal(fx.traceCount("preflight"), 0, `${label}: a known-fixed CLI skips the process preflight`);
        expectWarnings(run.result, expected);
        for (const warning of run.result.warnings) {
          assert.ok(run.stderr.includes(warning), `${label}: the warning is also written to stderr: ${warning}`);
        }
        assert.equal(fx.execInvocations().length, 1, label);
      }
    }
  });

  it("an unqualified resume keeps the conservative preflight on an old CLI, and a known-fixed CLI skips it", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      { title: "--session, not isolated", fixture: makeFixture, args: ["--session", "thread-resume-1", "--model", "m"], version: VERSION_OLD, preflights: 1, others: [] },
      { title: "--resume-last, not isolated", fixture: makeFixture, args: ["--resume-last", "--model", "m"], version: VERSION_OLD, preflights: 1, others: [RE.resumeLast] },
      { title: "--session, isolated (elevated backend)", fixture: isolatedFixture, args: ["--isolated", "--session", "thread-resume-2", "--model", "m"], version: VERSION_OLD, preflights: 1, others: [] },
      { title: "--session, not isolated, known-fixed CLI", fixture: makeFixture, args: ["--session", "thread-resume-3", "--model", "m"], version: VERSION_FIXED, preflights: 0, others: [] },
    ];
    for (const { title, fixture, args, version, preflights, others } of cases) {
      const fx = fixture(t);
      fx.scenario({ version: { stdout: `${version}\n` }, steps: [op.final("ok")] });
      const run = await fx.run(args, { env: { RELAY_TEST_PREFLIGHT: "running" } });
      expectOutcome(run, "completed", 0);
      // The resume still inherits Codex's own sandbox: no -s, and the result says so.
      const argv = onlyExec(fx).argv;
      assert.ok(!argv.includes("-s"), `${title}: ${argv.join(" ")}`);
      assert.equal(run.result.sandbox, "(Codex config on resume)", title);
      assert.equal(fx.traceCount("preflight"), preflights, `${title}: process preflight calls`);
      const running = run.result.warnings.filter((warning) => warning === RUNNING_WARNING);
      assert.equal(running.length, preflights, `${title}: the running-process warning follows the preflight: ${JSON.stringify(run.result.warnings)}`);
      expectWarnings({ warnings: run.result.warnings.filter((warning) => warning !== RUNNING_WARNING) }, others);
    }
  });

  it("an unavailable preflight bounds its reason to 200 characters and falls back to unknown; the whole warning stays under the 600-character cap", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const cases = [
      ["a 500-character reason is cut to its first 200", "A".repeat(200) + "B".repeat(300), "A".repeat(200)],
      ["a reason of exactly 200 characters is kept whole", "C".repeat(200), "C".repeat(200)],
      ["a reason of 201 characters loses only the last", "D".repeat(201), "D".repeat(200)],
      ["a missing reason", undefined, "unknown"],
      ["a null reason", null, "unknown"],
      ["a numeric reason", 42, "unknown"],
      ["an object reason", { code: "EPERM" }, "unknown"],
      ["an array reason", ["denied"], "unknown"],
      ["a boolean reason", true, "unknown"],
    ];
    for (const [title, reason, shown] of cases) {
      const state = reason === undefined ? { status: "unavailable" } : { status: "unavailable", reason };
      const fx = makeFixture(t);
      fx.scenario({ steps: [op.final("ok")] });
      const run = await fx.run(["--model", "m", "--sandbox", "workspace-write"], {
        env: { RELAY_TEST_PREFLIGHT: "state", RELAY_TEST_PREFLIGHT_STATE: JSON.stringify(state) },
      });
      expectOutcome(run, "completed", 0);
      assert.equal(fx.traceCount("preflight"), 1, title);
      assert.deepEqual(run.result.warnings, [unavailableWarning(shown)], title);
      const [warning] = run.result.warnings;
      assert.ok(warning.length < 600, `${title}: ${warning.length} characters is not under the 600-character cap`);
      assert.ok(warning.endsWith("then check codex --version on PATH."), `${title}: the upgrade guidance is intact: ${warning}`);
      assert.ok(run.stderr.includes(warning), `${title}: the warning is also written to stderr`);
      assert.equal(fx.execInvocations().length, 1, `${title}: warn-only, Codex is still launched`);
    }
  });

  it("relay-only warnings that carry a failure signature never classify the run", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    // Two relay-generated warnings that embed a signature phrase: the missing-configuration warning
    // names the config path, and the unavailable-preflight warning names its (injected) reason.
    const codexHome = join(fx.root, "blocked by policy");
    mkdirSync(codexHome);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run(ISOLATED_ARGS, {
      env: {
        CODEX_HOME: codexHome,
        RELAY_TEST_PREFLIGHT: "state",
        RELAY_TEST_PREFLIGHT_STATE: JSON.stringify({ status: "unavailable", reason: "setup refresh had errors" }),
      },
    });
    expectOutcome(run, "completed", 0);
    const { result } = run;
    // Preconditions: both warnings exist, carry their phrase, and were written to the relay's stderr.
    assert.equal(result.warnings.length, 2, JSON.stringify(result.warnings));
    assert.equal(warningMatches(result, /blocked by policy/i).length, 1, "the configuration warning carries the phrase");
    assert.equal(warningMatches(result, /setup refresh had errors/i).length, 1, "the preflight warning carries the phrase");
    for (const warning of result.warnings) assert.ok(run.stderr.includes(warning), `written to the relay's stderr: ${warning}`);
    assert.equal(fx.traceCount("preflight"), 1);
    // The point: neither feeds the scanner or the captured child stderr.
    assert.deepEqual(result.sandboxFailureReasons, []);
    assert.ok(!/blocked by policy|setup refresh had errors/i.test(readFileSync(result.stderrPath, "utf8")), "relay warnings are kept out of the captured child stderr");
    assert.deepEqual(hintLines(run.stdout), [], `no sandbox failure hint; stdout:\n${run.stdout}`);
  });
});

// =============================================================================================
// INTEGRATION: sandbox failure classification (plan 4.5)
// =============================================================================================

describe("integration: sandbox failure classification", { concurrency: 4 }, () => {
  const FILLER_LINE = "filler stderr line that carries no failure signature at all, just bytes\n";

  it("a signature that fell out of the stderr tail still fails the run, with the match in the error", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("early: blocked by policy\n"), op.filler(FILLER_LINE, 4000), op.final("claims success")], exitCode: 0 });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    const { result } = run;
    assert.equal(result.childExitCode, 0, "the child really exited zero");
    assert.deepEqual(result.sandboxFailureReasons, ["blocked by policy"]);
    assert.ok(Array.isArray(result.stderrTail) && result.stderrTail.length > 0, "stderrTail is present on sandbox_failed");
    assert.ok(result.stderrTail.every((line) => !/blocked by policy/i.test(line)), "the signature line is outside the tail");
    assert.match(result.error, /blocked by policy/i, "the error names the match even though the line fell out of the tail");
    assert.ok(statSync(result.stderrPath).size > 64 * 1024, "stderr.txt holds the whole stream");
    assert.match(run.stdout, /sandbox_failed/);
  });

  it("setup refresh failures are recognised; both phrases are reported; matching is case-insensitive", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("ERROR: Setup Refresh Had Errors (os error 32)\n"), op.err("command BLOCKED BY POLICY\n")], exitCode: 0 });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.deepEqual([...run.result.sandboxFailureReasons].sort(), ["blocked by policy", "setup refresh had errors"]);
  });

  it("a signature split across stderr writes is still matched", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("blocked "), op.sleep(60), op.err("by po"), op.sleep(60), op.err("licy\n")], exitCode: 0 });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.deepEqual(run.result.sandboxFailureReasons, ["blocked by policy"]);
  });

  it("a signature outranks a non-zero child exit: sandbox_failed / 1, child exit preserved", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("blocked by policy\n")], exitCode: 7 });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.equal(run.result.childExitCode, 7);
  });

  it("signature plus watchdog timeout: sandbox_failed wins; the watchdog fact is retained", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("blocked by policy\n"), op.hang()] });
    const run = await fx.run(["--timeout", "1s"]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.equal(run.result.watchdogFired, true);
    assert.deepEqual(run.result.sandboxFailureReasons, ["blocked by policy"]);
  });

  it("watchdog timeout alone: status timeout, non-zero exit, watchdogFired", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.hang()] });
    const run = await fx.run(["--timeout", "1s"]);
    assert.ok(run.result, `no result; stderr:\n${run.stderr}`);
    assert.equal(run.result.status, "timeout");
    assert.notEqual(run.result.exitCode, 0);
    assert.equal(run.code, run.result.exitCode);
    assert.equal(run.result.watchdogFired, true);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });

  it("relay abort: status aborted with the signal-derived code; abortSignal recorded", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.marker("started"), op.hang()] });
    const run = await fx.run([], { env: { RELAY_TEST_EMIT_SIGNAL: "SIGTERM", RELAY_TEST_EMIT_AFTER: fx.markerPath("started") } });
    expectOutcome(run, "aborted", 128 + osConstants.signals.SIGTERM);
    assert.equal(run.result.abortSignal, "SIGTERM");
    assert.equal(run.result.signal, "SIGTERM");
    assert.equal(run.result.watchdogFired, false);
  });

  it("signature plus relay abort: sandbox_failed wins; abortSignal is retained", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("blocked by policy\n"), op.sleep(200), op.marker("started"), op.hang()] });
    const run = await fx.run([], { env: { RELAY_TEST_EMIT_SIGNAL: "SIGTERM", RELAY_TEST_EMIT_AFTER: fx.markerPath("started") } });
    expectOutcome(run, "sandbox_failed", 1);
    assert.equal(run.result.abortSignal, "SIGTERM");
    assert.deepEqual(run.result.sandboxFailureReasons, ["blocked by policy"]);
  });

  it("ordinary non-zero exit keeps its mapping: failed with the child's code and a stderr tail", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("plain error\n")], exitCode: 7 });
    const run = await fx.run([]);
    expectOutcome(run, "failed", 7);
    assert.equal(run.result.childExitCode, 7);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
    assert.deepEqual(run.result.stderrTail, ["plain error"]);
  });

  it("a real child signal keeps its mapping (POSIX): failed / 128+signal, signal recorded", { skip: POSIX_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [{ op: "signal", name: "SIGTERM" }] });
    const run = await fx.run([]);
    expectOutcome(run, "failed", 128 + osConstants.signals.SIGTERM);
    assert.equal(run.result.signal, "SIGTERM");
    assert.equal(run.result.childExitCode, null);
  });

  it("a signature plus a real child signal (POSIX): sandbox_failed, signal retained", { skip: POSIX_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.err("blocked by policy\n"), { op: "signal", name: "SIGTERM" }] });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.equal(run.result.signal, "SIGTERM");
  });

  it("a missing codex executable stays codex_unavailable / 127 with zero MCP calls", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t, { shim: false });
    const run = await fx.run([], { path: [fx.emptyBin, ...(IS_WIN ? [SYSTEM32] : [])] });
    expectOutcome(run, "codex_unavailable", 127);
    assert.equal(run.result.childExitCode, null);
    assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
    assert.equal(run.result.mcpViolation, false);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });

  it("a failing version preflight keeps its mapping and is never dispatched", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { exitCode: 3, stderr: "version probe exploded\n" } });
    const run = await fx.run([]);
    expectOutcome(run, "failed", 3);
    assert.equal(fx.execInvocations().length, 0);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });

  it("a signature on the version preflight's stderr is classified too", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { exitCode: 3, stderr: "ERROR: setup refresh had errors (os error 32)\n" } });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.deepEqual(run.result.sandboxFailureReasons, ["setup refresh had errors"]);
    assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
    assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
  });

  // A probe that fails *and* prints a signature is reported as sandbox_failed, which would otherwise
  // hide how the probe failed. The error text must still say: no new result field, and childExitCode
  // stays null because no child was dispatched.
  describe("version-probe failure diagnostics", () => {
    const exitStated = (code) => new RegExp(`\\bexit(?:ed)?(?:\\s+(?:code|status))?\\s*[:=]?\\s*${code}\\b`, "i");

    for (const code of [3, 42]) {
      it(`a probe that exits ${code} with a signature: sandbox_failed / 1, and the error states exit ${code}`, { timeout: 60_000 }, async (t) => {
        const fx = makeFixture(t);
        fx.scenario({ version: { exitCode: code, stderr: "ERROR: setup refresh had errors (os error 32)\n" } });
        const run = await fx.run([]);
        expectOutcome(run, "sandbox_failed", 1);
        const { result } = run;
        assert.match(result.error, exitStated(code), `the error must state the probe's exit code: ${result.error}`);
        assert.match(result.error, /setup refresh had errors/i, "and still name the signature");
        assert.equal(result.childExitCode, null, "no child was dispatched");
        assert.deepEqual(result.sandboxFailureReasons, ["setup refresh had errors"]);
        assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
      });
    }

    it("a probe that fails without a signature already states its exit code (unchanged behaviour)", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ version: { exitCode: 42, stderr: "version probe exploded\n" } });
      const run = await fx.run([]);
      expectOutcome(run, "failed", 42);
      assert.match(run.result.error, exitStated(42), run.result.error);
      assert.equal(run.result.childExitCode, null);
    });

    it("a probe that prints a signature and is then killed by the probe timeout: sandbox_failed / 1, and the error says it timed out", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ version: { stderr: "ERROR: blocked by policy\n", stderrFirst: true, sleepMs: 4000 } });
      const run = await fx.run(["--timeout", "1s"]);
      expectOutcome(run, "sandbox_failed", 1);
      assert.deepEqual(run.result.sandboxFailureReasons, ["blocked by policy"]);
      assert.match(run.result.error, /timed out|time-?out|SIGKILL/i, `the error must say how the probe ended: ${run.result.error}`);
      assert.equal(run.result.childExitCode, null);
      assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
    });

    it("a probe killed by a real signal (POSIX) with a signature: sandbox_failed / 1, and the error names the signal", { skip: POSIX_ONLY, timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ version: { stderr: "ERROR: blocked by policy\n", stderrFirst: true, signal: "SIGTERM" } });
      const run = await fx.run([]);
      expectOutcome(run, "sandbox_failed", 1);
      assert.match(run.result.error, /SIGTERM/, `the error must name the probe's signal: ${run.result.error}`);
      assert.equal(run.result.childExitCode, null);
      assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
    });
  });

  // Plan 4.5: "Feed version-probe stderr through the same matcher." Not only when the probe fails:
  // an installation whose sandbox is broken can print the signature on `--version` and still exit 0.
  it("a signature on a version probe that exits 0 is classified: sandbox_failed / 1 although Codex then exits 0", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({
      version: { stderr: "ERROR: blocked by policy\n", exitCode: 0 },
      steps: [op.outLines(ev.thread("t-probe-zero")), op.final("claims success")],
      exitCode: 0,
    });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    const { result } = run;
    assert.deepEqual(result.sandboxFailureReasons, ["blocked by policy"]);
    assert.match(result.error, /blocked by policy/i, "the error names the match");
    assert.ok(Array.isArray(result.stderrTail), "stderrTail is present on sandbox_failed");
    assert.equal(result.codexVersion, FAKE_VERSION, "the probe's stdout is still the version");
    assert.match(run.stdout, /sandbox_failed/);

    // The probe's stderr is part of the run's recorded stderr, not just matched and forgotten.
    assert.match(readFileSync(result.stderrPath, "utf8"), /blocked by policy/i, "stderr.txt holds the probe's signature");
    assert.ok(result.stderrTail.some((line) => /blocked by policy/i.test(line)), `stderrTail shows the signature: ${JSON.stringify(result.stderrTail)}`);
    // The configured exec really ran: this is a classified completed run, not a pre-dispatch refusal.
    const exec = onlyExec(fx);
    assert.equal(exec.stdin, "TEST-BRIEF", "the brief reached the dispatched Codex");
    assert.equal(result.childExitCode, 0, "Codex ran and exited zero");
    assert.equal(result.threadId, "t-probe-zero", "the dispatched run's thread id is recorded");
    assert.equal(result.finalMessage, "claims success", "the dispatched run's final message is recorded");
    assert.equal(result.finalPath, join(run.outDir, "final.txt"));
    assert.equal(result.watchdogFired, false);
    assert.equal(result.abortSignal, null);
  });

  it("a mixed-case signature on a zero-exit version probe is reported in its canonical form", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { stderr: "ERROR: Setup Refresh Had Errors (os error 32)\n", exitCode: 0 }, steps: [op.final("ok")], exitCode: 0 });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    assert.deepEqual(run.result.sandboxFailureReasons, ["setup refresh had errors"]);
  });

  it("ordinary stderr noise on a zero-exit version probe is not a failure", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { stderr: "warning: a newer codex is available\n", exitCode: 0 }, steps: [op.final("ok")], exitCode: 0 });
    const run = await fx.run([]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
    assert.equal(run.result.codexVersion, FAKE_VERSION);
  });

  // ---- Windows Desktop ACL fix: classification and the printed hint (plan 2026-10-17, sections 4 and 5) ----
  // Skipping the historical process warning must never change how a failing run is classified, and the
  // hint on stdout names the branch that fits this host, this version and this backend.

  it("sandbox failure summary prints the selected hint", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({
      version: { stdout: `${VERSION_FIXED}\n` },
      steps: [op.err("ERROR: setup refresh had errors (os error 32)\n"), op.final("claims success")],
      exitCode: 0,
    });
    const run = await fx.run(ISOLATED_ARGS);
    expectOutcome(run, "sandbox_failed", 1);
    const { result } = run;
    assert.equal(result.windowsSandbox, IS_WIN ? "elevated" : null, "A5: --isolated resolves the backend");
    assert.equal(result.childExitCode, 0, "the child really exited zero");
    assert.deepEqual(result.sandboxFailureReasons, ["setup refresh had errors"]);
    assert.equal(result.schema, "delegate-relay.result.v1");
    assert.equal(result.codexVersion, VERSION_FIXED);
    // A known-fixed CLI on Windows is branch 2; a non-Windows host is branch 1.
    assert.deepEqual(
      hintLines(run.stdout),
      [expectedHint(["setup refresh had errors"], IS_WIN ? "notAclCause" : "nonWindows")],
      `the one printed hint; stdout:\n${run.stdout}`,
    );
  });

  it("fixed version retains successful-probe failure classification", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({
      version: { stdout: `${VERSION_FIXED}\n`, stderr: "ERROR: blocked by policy\n", exitCode: 0 },
      steps: [op.outLines(ev.thread("t-fixed-probe")), op.final("claims success")],
      exitCode: 0,
    });
    const run = await fx.run(ISOLATED_ARGS);
    expectOutcome(run, "sandbox_failed", 1);
    const { result } = run;
    assert.equal(result.windowsSandbox, IS_WIN ? "elevated" : null, "A5: --isolated resolves the backend");
    assert.equal(result.codexVersion, VERSION_FIXED);
    assert.deepEqual(result.sandboxFailureReasons, ["blocked by policy"]);
    assert.match(result.error, /blocked by policy/i, "the error names the match");
    // The probe's stderr is persisted and matched exactly as before.
    assert.match(readFileSync(result.stderrPath, "utf8"), /blocked by policy/i, "stderr.txt holds the probe's signature");
    assert.ok(result.stderrTail.some((line) => /blocked by policy/i.test(line)), `stderrTail shows the signature: ${JSON.stringify(result.stderrTail)}`);
    // The configured exec really ran: this is a classified completed run, not a pre-dispatch refusal.
    const exec = onlyExec(fx);
    assert.equal(exec.stdin, "TEST-BRIEF", "the brief reached the dispatched Codex");
    assert.equal(result.childExitCode, 0, "Codex ran and exited zero");
    assert.equal(result.threadId, "t-fixed-probe");
    // Only the Windows process preflight is skipped; nothing else is suppressed.
    assert.equal(fx.traceCount("preflight"), 0, "a known-fixed CLI skips the process preflight");
    assert.deepEqual(result.warnings, []);
  });

  it("failed version probe keeps existing failure handling", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { exitCode: 3, stderr: "ERROR: setup refresh had errors (os error 32)\n" } });
    const run = await fx.run([]);
    expectOutcome(run, "sandbox_failed", 1);
    const { result } = run;
    assert.equal(result.codexVersion, null, "a failed probe records no version");
    assert.equal(result.childExitCode, null, "no child was dispatched");
    assert.deepEqual(result.sandboxFailureReasons, ["setup refresh had errors"]);
    assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched");
    assert.equal(fx.traceCount("preflight"), 0, "a failed probe exits before any process preflight");
    // No version and no resolved backend: a Windows host cannot rule the ACL conflict out (branch 3).
    assert.deepEqual(
      hintLines(run.stdout),
      [expectedHint(["setup refresh had errors"], IS_WIN ? "mayPredateFix" : "nonWindows")],
      `the one printed hint; stdout:\n${run.stdout}`,
    );
  });

  it("expected write denial remains completed on fixed CLI", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    const denial = "Set-Content : Access is denied.";
    fx.scenario({
      version: { stdout: `${VERSION_FIXED}\n` },
      steps: [op.err(`${denial}\n`), op.outLines(ev.thread("t-fixed-deny"), ev.command("c1", "Set-Content probe.txt", denial)), op.final("write was denied")],
      exitCode: 0,
    });
    const run = await fx.run(ISOLATED_ARGS);
    expectOutcome(run, "completed", 0);
    assert.equal(run.result.codexVersion, VERSION_FIXED);
    assert.deepEqual(run.result.sandboxFailureReasons, [], "an expected write denial is not a sandbox setup failure");
    assert.deepEqual(hintLines(run.stdout), [], `no sandbox failure hint; stdout:\n${run.stdout}`);
    // Pins that this run took the known-fixed path (no process preflight on Windows), not the old one.
    assert.equal(fx.traceCount("preflight"), 0, "a known-fixed CLI skips the process preflight");
  });

  // Plan 4.5: "Retain abort cleanup and result refresh, updating diagnostics ... in the final snapshot."
  // The abort handler prints a summary at once and refreshes result.json after a grace period; what the
  // orchestrator reads on stdout must not contradict the file it is told to trust.
  describe("abort grace period", () => {
    // The driver holds the relay's event loop for 1.5 s after the marker appears and creates
    // <marker>.blocking first; the fake codex writes only after it sees that file, so its output
    // sits unread in the pipes until the abort handler has taken its first snapshot.
    const abortDuringBlock = (fx) => ({
      RELAY_TEST_EMIT_SIGNAL: "SIGTERM",
      RELAY_TEST_EMIT_AFTER: fx.markerPath("started"),
      RELAY_TEST_EMIT_BLOCK_MS: "1500",
    });
    const statusLines = (stdout) => [...stdout.matchAll(/^relay: ([a-z_]+) \(exit (\d+)/gm)];
    const expectBlockedBeforeSignal = (fx) => {
      const events = fx.trace().map((entry) => entry.event);
      assert.ok(events.includes("block-start") && events.includes("block-end"), `the driver never blocked the relay: ${events}`);
      assert.ok(events.indexOf("block-end") < events.indexOf("emit-signal"), "the signal must follow the block");
    };

    it("a sandbox signature that arrives after the abort signal updates the result, and the last printed summary matches it", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ steps: [op.marker("started"), op.wait("started.blocking"), op.err("blocked by policy\n"), op.hang()] });
      const run = await fx.run([], { env: abortDuringBlock(fx) });
      assert.ok(run.result, `no result; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      expectBlockedBeforeSignal(fx);
      // Precondition: the signature was unread at the first snapshot, so only the refresh can know it.
      assert.equal(run.result.status, "sandbox_failed", `the refreshed snapshot must include the late signature; stderr:\n${run.stderr}`);
      assert.deepEqual(run.result.sandboxFailureReasons, ["blocked by policy"]);
      assert.equal(run.result.abortSignal, "SIGTERM");
      assert.equal(run.code, run.result.exitCode, "relay exit code equals result.exitCode");

      const summaries = statusLines(run.stdout);
      assert.ok(summaries.length >= 1, `no status line on stdout:\n${run.stdout}`);
      const last = summaries.at(-1);
      assert.equal(last[1], run.result.status, `the last printed status line "${last[0]}" must equal result.json status "${run.result.status}"; all: ${summaries.map((m) => m[0]).join(" | ")}`);
      assert.equal(Number(last[2]), run.result.exitCode, "the last printed exit code equals result.json exitCode");
    });

    it("MCP calls that arrive after the abort signal reach the final snapshot and the last printed summary", { timeout: 60_000 }, async (t) => {
      const fx = isolatedFixture(t);
      fx.scenario({
        steps: [
          op.marker("started"), op.wait("started.blocking"),
          op.outLines(ev.mcp("item.completed", "item_1", "codex_apps", "search", "completed")),
          op.hang(),
        ],
      });
      const run = await fx.run(["--read-only", "--isolated", "--model", "m"], { env: abortDuringBlock(fx) });
      expectOutcome(run, "aborted", 128 + osConstants.signals.SIGTERM);
      expectBlockedBeforeSignal(fx);
      assert.deepEqual(run.result.mcpCalls, { count: 1, names: [{ server: "codex_apps", tool: "search" }] }, "the refreshed snapshot includes the late MCP call");
      assert.equal(run.result.mcpViolation, true);

      const summaries = statusLines(run.stdout);
      assert.ok(summaries.length >= 1, `no status line on stdout:\n${run.stdout}`);
      const last = summaries.at(-1);
      assert.equal(last[1], run.result.status);
      assert.match(run.stdout.slice(last.index), /MCP VIOLATION/, "the last printed summary must report the violation the final result.json records");
    });

    it("an abort with nothing new during the grace period still ends with a summary that matches result.json", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ steps: [op.marker("started"), op.hang()] });
      const run = await fx.run([], { env: { RELAY_TEST_EMIT_SIGNAL: "SIGTERM", RELAY_TEST_EMIT_AFTER: fx.markerPath("started") } });
      expectOutcome(run, "aborted", 128 + osConstants.signals.SIGTERM);
      const last = statusLines(run.stdout).at(-1);
      assert.ok(last, `no status line on stdout:\n${run.stdout}`);
      assert.equal(last[1], run.result.status);
      assert.equal(Number(last[2]), run.result.exitCode);
    });
  });

  it("a signature phrase that appears only inside an event does not trigger stderr classification", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({
      steps: [op.outLines(ev.thread("t-ev"), ev.command("c1", "Get-ChildItem", "command blocked by policy / setup refresh had errors")), op.final("fine")],
    });
    const run = await fx.run([]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });

  it("the expected read-only 'Access ... is denied' wording is not a sandbox setup failure", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const denial = "Set-Content : Access to the path 'C:\\repo\\codex-isolation-probe.txt' is denied.";
    fx.scenario({
      steps: [op.err(`${denial}\n`), op.outLines(ev.thread("t-deny"), ev.command("c1", "Set-Content probe.txt", denial)), op.final("write was denied")],
    });
    const run = await fx.run(["--read-only", "--model", "m"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
  });
});

// =============================================================================================
// INTEGRATION: MCP accounting (plan 4.6)
// =============================================================================================

describe("integration: MCP-call accounting", { concurrency: 4 }, () => {
  const mcp = ev.mcp;
  const FULL_STREAM = [
    ev.thread("thread-mcp-1"),
    mcp("item.started", "item_7", "codex_apps", "search", "in_progress"),
    mcp("item.updated", "item_7", "codex_apps", "search", "in_progress"),
    mcp("item.completed", "item_7", "codex_apps", "search", "completed"),
    mcp("item.started", "item_8", "codex_apps", "search", "in_progress"),
    mcp("item.completed", "item_8", "codex_apps", "search", "completed"),
    mcp("item.started", "item_9", "github", "list_prs", "in_progress"),
    mcp("item.completed", "item_9", "github", "list_prs", "failed", {
      arguments: { q: "CANARY-ARG" }, result: { content: "CANARY-RES" }, error: { message: "CANARY-ERR" },
    }),
    mcp("item.started", "item_10", "alpha", "ping", "in_progress"),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status", status: "completed", exit_code: 0 } }),
    ev.message("item_2", "done"),
  ];

  it("counts distinct invocations, deduplicates lifecycle events, lists sorted name pairs, and reports a violation without changing the exit", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.outLines(...FULL_STREAM), op.final("done")] });
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.mcpCalls, {
      count: 4,
      names: [{ server: "alpha", tool: "ping" }, { server: "codex_apps", tool: "search" }, { server: "github", tool: "list_prs" }],
    });
    assert.equal(run.result.mcpViolation, true, "MCP use inside an isolated run is a violation");
    assert.equal(run.result.threadId, "thread-mcp-1");
    assert.match(run.stdout, /MCP/i);
    assert.match(run.stdout, /violation/i);
    const persisted = readFileSync(run.resultPath, "utf8");
    for (const canary of ["CANARY-ARG", "CANARY-RES", "CANARY-ERR"]) assert.ok(!persisted.includes(canary), `${canary} must not be copied into result.json`);
  });

  const VIOLATION_CASES = [
    ["isolated run", ["--isolated"], true],
    ["known read-only sandbox without isolation", ["--read-only"], true],
    ["explicit read-only sandbox without isolation", ["--sandbox", "read-only"], true],
    ["workspace-write run without isolation", ["--sandbox", "workspace-write"], false],
    ["default-sandbox run without isolation", [], false],
    ["isolated unqualified resume", ["--isolated", "--session", "thread-x"], true],
    ["read-only resume without isolation", ["--read-only", "--session", "thread-x"], true],
    ["unqualified non-isolated resume: its sandbox is not assumed", ["--session", "thread-x"], false],
  ];
  for (const [title, args, violation] of VIOLATION_CASES) {
    it(`mcpViolation=${violation}: ${title}`, { timeout: 60_000 }, async (t) => {
      const fx = isolatedFixture(t);
      fx.scenario({ steps: [op.outLines(mcp("item.completed", "item_1", "srv", "tool", "completed")), op.final("ok")] });
      const run = await fx.run([...args, "--model", "m"]);
      expectOutcome(run, "completed", 0);
      assert.equal(run.result.mcpCalls.count, 1);
      assert.equal(run.result.mcpViolation, violation);
    });
  }

  it("no MCP calls means no violation, even for an isolated read-only run", { timeout: 60_000 }, async (t) => {
    const fx = isolatedFixture(t);
    fx.scenario({ steps: [op.outLines(ev.thread("t0")), op.final("ok")] });
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
    assert.equal(run.result.mcpViolation, false);
  });

  it("MCP items without ids are counted conservatively per record and raise a warning", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({
      steps: [op.outLines(
        mcp("item.started", undefined, "alpha", "ping", "in_progress"),
        mcp("item.completed", undefined, "alpha", "ping", "completed"),
        mcp("item.completed", "item_1", "beta", "run", "completed"),
      ), op.final("ok")],
    });
    const run = await fx.run(["--sandbox", "workspace-write"]);
    expectOutcome(run, "completed", 0);
    assert.equal(run.result.mcpCalls.count, 3);
    assert.ok(warningMatches(run.result, RE.mcp).length >= 1, JSON.stringify(run.result.warnings));
  });

  it("a multibyte character split across stdout writes and a final event without a newline are accounted correctly", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const first = mcp("item.started", "item_1", "srv", "recherche-日本", "in_progress");
    const last = ev.thread("thread-final-no-newline");
    const bytes = Buffer.from(`${first}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("日", "utf8")) + 1; // inside the 3-byte character
    fx.scenario({
      steps: [op.outBytes(bytes.subarray(0, cut)), op.sleep(80), op.outBytes(bytes.subarray(cut)), op.sleep(80), op.outBytes(Buffer.from(last, "utf8")), op.final("ok")],
    });
    const run = await fx.run(["--sandbox", "workspace-write"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(run.result.mcpCalls, { count: 1, names: [{ server: "srv", tool: "recherche-日本" }] });
    assert.equal(run.result.threadId, "thread-final-no-newline");
    const events = readFileSync(run.result.eventsPath, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(events, [first, last], "events.jsonl preserves both lines, intact");
  });

  it("non-JSON progress lines are preserved in events.jsonl and do not break later accounting", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const lines3 = ["Reading prompt from stdin...", "{not json", mcp("item.started", "item_1", "a", "b", "in_progress"), ev.thread("thread-after-noise")];
    fx.scenario({ steps: [op.outLines(...lines3), op.final("ok")] });
    const run = await fx.run(["--sandbox", "workspace-write"]);
    expectOutcome(run, "completed", 0);
    assert.deepEqual(readFileSync(run.result.eventsPath, "utf8").split("\n").filter(Boolean), lines3);
    assert.equal(run.result.mcpCalls.count, 1);
    assert.equal(run.result.threadId, "thread-after-noise");
  });

  it("pre-dispatch configuration failures report zero MCP calls", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(lines("[windows]", "sandbox = nope"));
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"]);
    expectOutcome(run, "failed", 2);
    assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
    assert.equal(run.result.mcpViolation, false);
  });
});

// =============================================================================================
// INTEGRATION: artifacts, locks and sequential reuse (plan 4.8)
// =============================================================================================

describe("integration: run directories and locks", () => {
  const FROZEN = "2026-01-02T03:04:05.678Z";
  const lockPath = (dir) => join(dir, ".relay.lock");
  const stale = { pid: 4242424, startedAt: "2026-01-02T03:04:05.678Z" };

  it("parallel default directories are distinct even when every relay sees the same timestamp", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.outLines(ev.thread("t-par")), op.final("ok")] });
    const runs = await Promise.all([0, 1, 2, 3].map(() => fx.run([], { noOutDir: true, env: { RELAY_TEST_FREEZE_TIME: FROZEN } })));
    for (const run of runs) expectOutcome(run, "completed", 0);
    const dirs = runs.map((run) => run.outDir);
    assert.equal(new Set(dirs.map((dir) => resolve(dir))).size, 4, `directories collided: ${dirs.join(", ")}`);
    const parent = join(fx.tmp, "delegate-relay");
    for (const dir of dirs) {
      assert.ok(samePath(dirname(dir), parent), `${dir} is not directly beneath ${parent}`);
      assert.ok(!basename(dir).includes(basename(fx.work)), "the repository basename is not embedded in the directory name");
      assert.ok(existsSync(join(dir, "result.json")));
    }
  });

  it("the default run directory is not under the repository being reviewed", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.final("ok")] });
    const run = await fx.run([], { noOutDir: true });
    expectOutcome(run, "completed", 0);
    assert.ok(!resolve(run.outDir).startsWith(resolve(fx.work)));
  });

  it("sequential reuse of an explicit --out-dir succeeds and no stale final/result/events leak into the next run", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    const outDir = fx.outDir("reused");

    fx.scenario({ steps: [op.outLines(ev.thread("t-first")), op.err("first-run stderr\n"), op.final("FIRST-FINAL")] });
    const first = await fx.run([], { outDir, brief: "BRIEF-FIRST" });
    expectOutcome(first, "completed", 0);
    assert.equal(first.result.finalMessage, "FIRST-FINAL");
    assert.ok(!existsSync(lockPath(outDir)), "lock released after the first run");

    fx.scenario({ steps: [] });
    const second = await fx.run([], { outDir, brief: "BRIEF-SECOND" });
    expectOutcome(second, "completed", 0);
    assert.equal(second.result.finalMessage, "", "the first run's final message must not leak");
    assert.equal(second.result.finalPath, null);
    assert.ok(!existsSync(join(outDir, "final.txt")), "stale final.txt cleared");
    assert.equal(readFileSync(join(outDir, "brief.txt"), "utf8"), "BRIEF-SECOND");
    assert.ok(!readFileSync(join(outDir, "events.jsonl"), "utf8").includes("t-first"), "events reset");
    assert.ok(!readFileSync(join(outDir, "stderr.txt"), "utf8").includes("first-run"), "stderr reset");
    assert.equal(second.result.threadId, null);

    fx.scenario({ steps: [op.final("THIRD-FINAL")] });
    const unavailable = await fx.run([], { outDir, brief: "BRIEF-THIRD", path: [fx.emptyBin, ...(IS_WIN ? [SYSTEM32] : [])] });
    expectOutcome(unavailable, "codex_unavailable", 127);
    assert.equal(unavailable.result.finalPath, null, "even a run that never dispatched clears the stale final");
    assert.ok(!existsSync(join(outDir, "final.txt")));
    assert.ok(!existsSync(lockPath(outDir)));
  });

  it("the owner writes {pid, startedAt} into the lock; a concurrent claimant exits 2 without touching anything and the owner is unaffected", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.outLines(ev.thread("owner-thread")), op.marker("started"), op.wait("release"), op.final("OWNER-FINAL")] });
    const outDir = fx.outDir("shared");
    const before = Date.now();
    const owner = fx.start([], { outDir, brief: "BRIEF-OWNER" });
    await fx.waitForMarker(owner, "started", "the owner reached Codex");

    const lockBytes = readFileSync(lockPath(outDir));
    const lock = JSON.parse(lockBytes.toString("utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["pid", "startedAt"]);
    assert.equal(lock.pid, owner.pid, "the lock names the owning relay's pid");
    const startedMs = Date.parse(lock.startedAt);
    assert.ok(Number.isFinite(startedMs) && startedMs >= before - 2000 && startedMs <= Date.now() + 2000, `startedAt ${lock.startedAt}`);

    const loser = await fx.run([], { outDir, brief: "BRIEF-LOSER" });
    assert.equal(loser.code, 2, `loser stderr:\n${loser.stderr}`);
    assert.equal(loser.result, null, "the claimant publishes no result of its own");
    assert.ok(loser.stderr.includes(lockPath(outDir)), "diagnostic names the lock path");
    assert.ok(loser.stderr.includes(String(lock.pid)), "diagnostic shows the owner pid");
    assert.ok(loser.stderr.includes(lock.startedAt), "diagnostic shows the owner start time");
    assert.match(loser.stderr, /this invocation has no result/i);
    assert.match(loser.stderr, /wait/i);
    assert.match(loser.stderr, /stale/i);
    assert.match(loser.stderr, /another .*director/i);
    assert.deepEqual(readFileSync(lockPath(outDir)), lockBytes, "the loser left the owner's lock untouched");
    assert.equal(readFileSync(join(outDir, "brief.txt"), "utf8"), "BRIEF-OWNER");
    assert.ok(!existsSync(join(outDir, "result.json")), "nothing published while the owner is still running");
    for (const name of readdirSync(outDir)) {
      assert.ok(!readFileSync(join(outDir, name), "utf8").includes("BRIEF-LOSER"), `${name} contains the loser's brief`);
    }

    fx.release();
    const finished = await owner.done;
    expectOutcome(finished, "completed", 0);
    assert.equal(finished.result.finalMessage, "OWNER-FINAL");
    assert.ok(!existsSync(lockPath(outDir)), "lock released at exit");

    fx.scenario({ steps: [op.final("AFTER")] });
    const next = await fx.run([], { outDir });
    expectOutcome(next, "completed", 0);
    assert.equal(next.result.finalMessage, "AFTER", "sequential reuse works once the owner is done");
  });

  it("a losing invocation says it has no result even when the directory holds the owner's result, which stays byte-identical", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const outDir = fx.outDir("owned");
    fx.scenario({ steps: [op.final("PRIOR-OWNER-FINAL")] });
    const prior = await fx.run([], { outDir });
    expectOutcome(prior, "completed", 0);
    writeFileSync(lockPath(outDir), JSON.stringify(stale));
    const snapshot = snapshotDir(outDir);

    fx.scenario({ steps: [op.final("INTRUDER-FINAL")] });
    const loser = await fx.run([], { outDir, brief: "BRIEF-INTRUDER" });
    assert.equal(loser.code, 2);
    assert.match(loser.stderr, /this invocation has no result/i);
    assert.ok(loser.stderr.includes(String(stale.pid)) && loser.stderr.includes(stale.startedAt));
    assert.deepEqual(snapshotDir(outDir), snapshot, "every artifact, including result.json, is unchanged");
    assert.equal(fx.execInvocations().length, 1, "only the earlier run launched Codex");
    assert.ok(existsSync(lockPath(outDir)), "a claimant never releases a lock it does not own");
  });

  const BAD_LOCKS = {
    "empty (partially written)": "",
    "truncated JSON": '{"pid": 12',
    "not JSON, with a canary": "garbage CANARY-LOCK-77 that must not be echoed",
    "wrong field types, with a canary": JSON.stringify({ pid: "CANARY-LOCK-77", startedAt: 12345 }),
    "invalid pid": JSON.stringify({ pid: -5, startedAt: stale.startedAt }),
    "unparseable start time, with a canary": JSON.stringify({ pid: 4242, startedAt: "CANARY-LOCK-77 not a date" }),
    "start time with control characters": JSON.stringify({ pid: 4242, startedAt: "2026-01-02T03:04:05.678Z\u001b[31mCANARY-LOCK-77" }),
    "oversized": `{"pid":4242,"startedAt":"${stale.startedAt}","pad":"${"x".repeat(8 * 1024 * 1024)}CANARY-LOCK-77"}`,
  };
  for (const [title, content] of Object.entries(BAD_LOCKS)) {
    it(`unusable lock metadata (${title}): stays occupied, safe unavailable-metadata diagnostic`, { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      const outDir = fx.outDir("odd-lock");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(lockPath(outDir), content);
      const before = sha(readFileSync(lockPath(outDir)));
      fx.scenario({ steps: [op.final("never")] });
      const run = await fx.run([], { outDir });
      assert.equal(run.code, 2, run.stderr.slice(0, 500));
      assert.ok(run.result === null && !existsSync(join(outDir, "result.json")));
      assert.ok(run.stderr.includes(lockPath(outDir)));
      assert.match(run.stderr, /unavailable/i);
      assert.match(run.stderr, /this invocation has no result/i);
      assert.ok(!run.stderr.includes("CANARY-LOCK-77"), "raw lock contents must never be echoed");
      assert.ok(run.stderr.length < 8 * 1024, "the diagnostic stays small");
      assert.equal(sha(readFileSync(lockPath(outDir))), before, "lock untouched");
      assert.equal(fx.execInvocations().length, 0);
    });
  }

  it("a stale lock left by a force-killed relay is a clear failure with recovery guidance, never an automatic takeover", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ steps: [op.marker("started"), op.wait("release")] });
    const outDir = fx.outDir("killed");
    const doomed = fx.start([], { outDir, brief: "BRIEF-DOOMED" });
    await fx.waitForMarker(doomed, "started", "the doomed relay reached Codex");
    const lockBefore = readFileSync(lockPath(outDir));
    const lock = JSON.parse(lockBefore.toString("utf8"));
    doomed.kill("SIGKILL");
    await doomed.done;
    assert.ok(existsSync(lockPath(outDir)), "a force-killed relay cannot clean up; the lock remains");

    fx.scenario({ steps: [op.final("TAKEOVER")] });
    const retry = await fx.run([], { outDir, brief: "BRIEF-RETRY" });
    assert.equal(retry.code, 2, retry.stderr);
    assert.ok(retry.stderr.includes(String(lock.pid)));
    assert.match(retry.stderr, /stale/i);
    assert.match(retry.stderr, /remove/i);
    assert.deepEqual(readFileSync(lockPath(outDir)), lockBefore, "no automatic takeover, even though the owning pid is gone");
    assert.equal(retry.result, null);
    assert.ok(!existsSync(join(outDir, "result.json")));

    rmSync(lockPath(outDir)); // the documented manual recovery
    const recovered = await fx.run([], { outDir, brief: "BRIEF-RECOVERED" });
    expectOutcome(recovered, "completed", 0);
    assert.equal(recovered.result.finalMessage, "TAKEOVER");
  });

  const TERMINAL_PATHS = [
    { name: "completed", scenario: { steps: [op.final("ok")] }, args: [], status: "completed", exit: 0 },
    { name: "child failure", scenario: { steps: [], exitCode: 5 }, args: [], status: "failed", exit: 5 },
    { name: "sandbox_failed", scenario: { steps: [op.err("blocked by policy\n")] }, args: [], status: "sandbox_failed", exit: 1 },
    { name: "watchdog timeout", scenario: { steps: [op.hang()] }, args: ["--timeout", "1s"], status: "timeout", exit: null },
    { name: "version-probe failure", scenario: { version: { exitCode: 3, stderr: "x\n" } }, args: [], status: "failed", exit: 3 },
    { name: "version-probe sandbox failure", scenario: { version: { exitCode: 3, stderr: "blocked by policy\n" } }, args: [], status: "sandbox_failed", exit: 1 },
    {
      name: "handled abort", scenario: { steps: [op.marker("started"), op.hang()] }, args: [], status: "aborted", exit: 128 + osConstants.signals.SIGTERM,
      env: (fx) => ({ RELAY_TEST_EMIT_SIGNAL: "SIGTERM", RELAY_TEST_EMIT_AFTER: fx.markerPath("started") }),
    },
  ];
  for (const path of TERMINAL_PATHS) {
    it(`lock cleanup: ${path.name} releases ownership`, { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario(path.scenario);
      const outDir = fx.outDir("cleanup");
      const run = await fx.run(path.args, { outDir, env: path.env ? path.env(fx) : {} });
      assert.ok(run.result, `no result for ${path.name}; stderr:\n${run.stderr}`);
      assert.equal(run.result.status, path.status);
      if (path.exit !== null) assert.equal(run.code, path.exit);
      else assert.notEqual(run.code, 0);
      assert.ok(!existsSync(lockPath(outDir)), `the lock survived the ${path.name} path`);
    });
  }

  it("lock cleanup: codex_unavailable releases ownership", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t, { shim: false });
    const outDir = fx.outDir("cleanup-unavailable");
    const run = await fx.run([], { outDir, path: [fx.emptyBin, ...(IS_WIN ? [SYSTEM32] : [])] });
    expectOutcome(run, "codex_unavailable", 127);
    assert.ok(!existsSync(lockPath(outDir)));
  });

  it("lock cleanup: an invalid Windows isolation configuration releases ownership", { skip: WIN_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.config(lines("[windows]", "sandbox = nope"));
    const outDir = fx.outDir("cleanup-config");
    const run = await fx.run(["--read-only", "--isolated", "--model", "m"], { outDir });
    expectOutcome(run, "failed", 2);
    assert.ok(!existsSync(lockPath(outDir)));
  });

  it("lock cleanup: a child launch failure releases ownership (POSIX)", { skip: POSIX_ONLY, timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { unlinkShim: true } });
    const outDir = fx.outDir("cleanup-launch");
    const run = await fx.run([], { outDir });
    assert.ok(run.result, run.stderr);
    assert.equal(run.result.status, "failed");
    assert.equal(run.code, run.result.exitCode);
    assert.ok(!existsSync(lockPath(outDir)));
  });

  // Plan 4.8: "Release the owned lock". A lock that has been replaced by another owner is no longer
  // this relay's to release: deleting it would let a third relay start over a live run.
  describe("lock ownership", () => {
    const OTHER = JSON.stringify({ pid: 4242425, startedAt: "2026-05-06T07:08:09.010Z" });
    const swap = { op: "replaceLock", text: OTHER };
    const PATHS = [
      { name: "completed", scenario: { steps: [swap, op.final("ok")] }, status: "completed", exit: 0 },
      { name: "child failure", scenario: { steps: [swap], exitCode: 5 }, status: "failed", exit: 5 },
      { name: "sandbox_failed", scenario: { steps: [swap, op.err("blocked by policy\n")] }, status: "sandbox_failed", exit: 1 },
      {
        name: "handled abort", scenario: { steps: [swap, op.marker("started"), op.hang()] }, status: "aborted", exit: 128 + osConstants.signals.SIGTERM,
        env: (fx) => ({ RELAY_TEST_EMIT_SIGNAL: "SIGTERM", RELAY_TEST_EMIT_AFTER: fx.markerPath("started") }),
      },
    ];
    for (const path of PATHS) {
      it(`${path.name}: a lock replaced by another owner is left in place`, { timeout: 60_000 }, async (t) => {
        const fx = makeFixture(t);
        fx.scenario(path.scenario);
        const outDir = fx.outDir("swapped");
        const run = await fx.run([], { outDir, env: path.env ? path.env(fx) : {} });
        expectOutcome(run, path.status, path.exit);
        assert.ok(existsSync(lockPath(outDir)), "the relay deleted a lock that another owner had taken over");
        assert.equal(readFileSync(lockPath(outDir), "utf8"), OTHER, "the other owner's lock is byte-identical");
        assert.deepEqual(readdirSync(outDir).filter((name) => name.includes("lock")), [".relay.lock"], "no stray lock files");
      });
    }

    it("the surviving foreign lock keeps blocking later claimants, with its owner named", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ steps: [swap, op.final("ok")] });
      const outDir = fx.outDir("swapped-then-claimed");
      expectOutcome(await fx.run([], { outDir }), "completed", 0);
      const claimant = await fx.run([], { outDir });
      assert.equal(claimant.code, 2, claimant.stderr);
      assert.ok(claimant.stderr.includes("4242425"), "the diagnostic names the foreign owner");
      assert.match(claimant.stderr, /this invocation has no result/i);
      assert.equal(readFileSync(lockPath(outDir), "utf8"), OTHER);
    });

    it("a lock that someone else removed is tolerated: the run still finishes and no lock is created", { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      fx.scenario({ steps: [{ op: "removeLock" }, op.final("ok")] });
      const outDir = fx.outDir("removed");
      const run = await fx.run([], { outDir });
      expectOutcome(run, "completed", 0);
      assert.ok(!existsSync(lockPath(outDir)));
    });
  });

  // Plan 4.8: cleanup is registered "immediately after acquiring ownership, before metadata
  // initialization" and released on "preparation error ... version failure".
  it("lock cleanup: a failed lock-metadata write releases ownership and leaves the previous run's artifacts untouched", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    const outDir = fx.outDir("metadata-fault");
    fx.scenario({ steps: [op.outLines(ev.thread("t-prior")), op.err("prior stderr\n"), op.final("PRIOR-FINAL")] });
    const prior = await fx.run([], { outDir, brief: "BRIEF-PRIOR" });
    expectOutcome(prior, "completed", 0);
    const snapshot = snapshotDir(outDir);
    const invocations = fx.invocations().length;

    const run = await fx.run([], { outDir, brief: "BRIEF-NEW", env: { RELAY_TEST_FS_FAULT: "lock-write" } });
    assert.ok(fx.trace().some((entry) => entry.event === "fault" && entry.fault === "lock-write"), "the metadata-write fault was injected");
    assert.notEqual(run.code, 0, `the relay must not carry on without lock metadata; stdout:\n${run.stdout}`);
    assert.match(run.stderr, /lock/i, "a diagnostic names the lock");
    assert.ok(!existsSync(lockPath(outDir)), "the lock survived a failed metadata write");
    assert.deepEqual(snapshotDir(outDir), snapshot, "nothing is overwritten before the lock metadata is initialised (plan 4.8 step 5)");
    assert.equal(fx.invocations().length, invocations, "Codex was neither probed nor launched");

    fx.scenario({ steps: [op.final("AFTER")] });
    const next = await fx.run([], { outDir });
    expectOutcome(next, "completed", 0);
    assert.equal(next.result.finalMessage, "AFTER", "the directory is usable again: nothing is left locked");
  });

  // writeSync may store fewer bytes than asked without throwing, or make no progress at all. A relay
  // that ignores the return value leaves a truncated lock that its own ownership check then refuses
  // to delete: a stale lock after an otherwise perfectly controllable exit. Either contract is
  // acceptable here (finish the write and run, or refuse to run); a stale lock and a hang are not.
  describe("lock-metadata short writes", () => {
    const fault = (name) => ({ RELAY_TEST_FS_FAULT: name });
    const injected = (fx, name) => fx.trace().filter((entry) => entry.event === "fault" && entry.fault === name);
    // A relay that spins on a zero-progress write is killed after this long and the test fails.
    const BOUND_MS = 20_000;

    /** A finished run in `outDir`, and the digest of everything it left there. */
    async function priorRun(fx, outDir) {
      fx.scenario({ steps: [op.outLines(ev.thread("t-prior")), op.final("PRIOR-FINAL")] });
      expectOutcome(await fx.run([], { outDir, brief: "BRIEF-PRIOR" }), "completed", 0);
      return snapshotDir(outDir);
    }

    it("a short write: no stale lock; the relay either completes the metadata and runs, or refuses and overwrites nothing", { timeout: 90_000 }, async (t) => {
      const fx = makeFixture(t);
      const outDir = fx.outDir("short-write");
      const snapshot = await priorRun(fx, outDir);
      const invocations = fx.invocations().length;

      fx.scenario({ steps: [op.final("NEW-FINAL")] });
      const run = await fx.run([], { outDir, brief: "BRIEF-NEW", env: fault("lock-short-write"), timeoutMs: BOUND_MS });
      const short = injected(fx, "lock-short-write");
      assert.equal(short.length, 1, "exactly one short write was injected");
      assert.ok(short[0].returned > 0 && short[0].returned < short[0].requested, JSON.stringify(short[0]));
      assert.ok(!existsSync(lockPath(outDir)), `a stale lock survived the short write (relay exit ${run.code}); stderr:\n${run.stderr}`);
      if (run.code === 0) {
        expectOutcome(run, "completed", 0);
        assert.equal(run.result.finalMessage, "NEW-FINAL", "the relay that completed the write really ran");
      } else {
        assert.match(run.stderr, /lock/i, "a refusal names the lock");
        assert.deepEqual(snapshotDir(outDir), snapshot, "a refusal overwrites nothing (plan 4.8 step 5)");
        assert.equal(fx.invocations().length, invocations, "a refusal never probes or launches Codex");
      }
      fx.scenario({ steps: [op.final("AFTER")] });
      const next = await fx.run([], { outDir });
      expectOutcome(next, "completed", 0);
      assert.equal(next.result.finalMessage, "AFTER", "the directory is usable again: nothing is left locked");
    });

    it("a short write: a relay that goes on to run has recorded the whole {pid, startedAt} while it runs", { timeout: 90_000 }, async (t) => {
      const fx = makeFixture(t);
      const outDir = fx.outDir("short-write-running");
      fx.scenario({ steps: [op.marker("started"), op.wait("release"), op.final("ok")] });
      const handle = fx.start([], { outDir, env: fault("lock-short-write"), timeoutMs: 30_000 });
      await waitFor(() => existsSync(fx.markerPath("started")) || handle.exited, { what: "the relay to reach Codex or exit" });
      if (existsSync(fx.markerPath("started"))) {
        const raw = readFileSync(lockPath(outDir), "utf8");
        let lock = null;
        try { lock = JSON.parse(raw); } catch { /* reported below */ }
        assert.ok(lock && typeof lock === "object", `the lock of a running relay must hold complete metadata, found ${raw.length} bytes of non-JSON`);
        assert.deepEqual(Object.keys(lock).sort(), ["pid", "startedAt"]);
        assert.equal(lock.pid, handle.pid);
        fx.release();
      }
      const run = await handle.done;
      assert.equal(injected(fx, "lock-short-write").length, 1, "the short write was injected");
      assert.ok(!existsSync(lockPath(outDir)), `a stale lock survived (relay exit ${run.code})`);
    });

    for (const name of ["lock-zero-write", "lock-short-then-zero"]) {
      it(`${name}: the relay neither hangs nor leaves a stale lock, and refuses to run on metadata it cannot write`, { timeout: 90_000 }, async (t) => {
        const fx = makeFixture(t);
        const outDir = fx.outDir(name);
        const snapshot = await priorRun(fx, outDir);
        const invocations = fx.invocations().length;

        const run = await fx.run([], { outDir, brief: "BRIEF-NEW", env: fault(name), timeoutMs: BOUND_MS });
        assert.ok(injected(fx, name).length >= 1, "the fault was injected");
        assert.notEqual(run.code, 0, `a relay that cannot record its owner must not carry on; stdout:\n${run.stdout}`);
        assert.match(run.stderr, /lock/i, "a diagnostic names the lock");
        assert.ok(!existsSync(lockPath(outDir)), "a stale lock survived the failed metadata write");
        assert.deepEqual(snapshotDir(outDir), snapshot, "nothing is overwritten before the lock metadata is initialised (plan 4.8 step 5)");
        assert.equal(fx.invocations().length, invocations, "Codex was neither probed nor launched");

        fx.scenario({ steps: [op.final("AFTER")] });
        const next = await fx.run([], { outDir });
        expectOutcome(next, "completed", 0);
        assert.equal(next.result.finalMessage, "AFTER", "nothing is left locked");
      });
    }
  });

  for (const obstruction of ["brief.txt", "events.jsonl", "stderr.txt"]) {
    it(`lock cleanup: an artifact-preparation failure after the lock was acquired (${obstruction} cannot be written) releases ownership`, { timeout: 60_000 }, async (t) => {
      const fx = makeFixture(t);
      const outDir = fx.outDir("prepare-fault");
      // A directory where the relay needs to write a file: the write fails, after the lock exists.
      mkdirSync(join(outDir, obstruction), { recursive: true });
      fx.scenario({ steps: [op.final("never")] });
      const run = await fx.run([], { outDir });
      assert.notEqual(run.code, 0, `preparation failure must not look like success; stdout:\n${run.stdout}`);
      assert.ok(run.stderr.trim().length > 0, "a diagnostic is printed");
      assert.ok(!existsSync(lockPath(outDir)), "the lock survived the preparation failure");
      assert.equal(fx.invocations().length, 0, "Codex was neither probed nor launched");

      rmSync(join(outDir, obstruction), { recursive: true, force: true });
      fx.scenario({ steps: [op.final("RECOVERED")] });
      const next = await fx.run([], { outDir });
      expectOutcome(next, "completed", 0);
      assert.equal(next.result.finalMessage, "RECOVERED", "nothing is left locked after the obstruction is gone");
    });
  }

  it("lock cleanup: a version-probe timeout releases ownership and keeps its timeout mapping", { timeout: 90_000 }, async (t) => {
    const fx = makeFixture(t);
    fx.scenario({ version: { sleepMs: 4000 }, steps: [op.final("never")] });
    const outDir = fx.outDir("probe-timeout");
    const run = await fx.run(["--timeout", "1s"], { outDir });
    expectOutcome(run, "timeout", 124);
    assert.match(run.result.error, /timed out/i);
    assert.equal(run.result.childExitCode, null, "no Codex run happened");
    assert.deepEqual(run.result.mcpCalls, { count: 0, names: [] });
    assert.equal(run.result.mcpViolation, false);
    assert.deepEqual(run.result.sandboxFailureReasons, []);
    assert.equal(fx.execInvocations().length, 0, "Codex was not dispatched after the probe timed out");
    assert.ok(!existsSync(lockPath(outDir)), "the lock survived a version-probe timeout");
  });

  it("usage errors never create or touch a lock", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const outDir = fx.outDir("usage");
    const run = await fx.run(["--timeout", "bogus"], { outDir });
    assert.equal(run.code, 2);
    assert.ok(!existsSync(outDir) || !existsSync(lockPath(outDir)));
  });
});

// =============================================================================================
// INTEGRATION: the printed resume hint (plan 4.1/4.3: a resume does not inherit the lane or isolation)
// =============================================================================================

describe("integration: resume hint", { concurrency: 4 }, () => {
  const LANES = {
    plan: { implementer: "codex", readOnly: true },
    build: { implementer: "codex", sandbox: "workspace-write" },
    bare: { implementer: "codex", model: "model-lane" },
  };
  const THREAD = "thread-hint-1";
  /** The hint line the relay prints for a run's thread id. */
  async function hintFor(t, args) {
    const fx = isolatedFixture(t);
    fx.lanes(LANES);
    fx.scenario({ steps: [op.outLines(ev.thread(THREAD)), op.final("ok")] });
    const run = await fx.run(args);
    expectOutcome(run, "completed", 0);
    assert.equal(run.result.threadId, THREAD);
    const line = run.stdout.split(/\r?\n/).find((entry) => /resume with:/i.test(entry));
    assert.ok(line, `no resume hint on stdout:\n${run.stdout}`);
    return line;
  }
  const flag = (name) => new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

  it("a --lane run's hint carries --session <threadId> and --lane <name>", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--lane", "plan", "--model", "m"]);
    assert.match(line, new RegExp(`--session ${THREAD}(?![\\w-])`), line);
    assert.match(line, /--lane plan(?![\w-])/, `a resume does not inherit the lane, so the hint must carry it: ${line}`);
  });

  it("the hint names the lane that was used, not a fixed one", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--lane", "build"]);
    assert.match(line, /--lane build(?![\w-])/, line);
    assert.doesNotMatch(line, /--lane plan/, line);
  });

  it("an explicit --read-only --isolated run (no lane) carries both flags in its hint", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--read-only", "--isolated", "--model", "m"]);
    assert.match(line, new RegExp(`--session ${THREAD}(?![\\w-])`), line);
    assert.match(line, flag("--read-only"), `a resume does not inherit the sandbox, so the hint must carry it: ${line}`);
    assert.match(line, flag("--isolated"), `a resume does not inherit isolation, so the hint must carry it: ${line}`);
    assert.doesNotMatch(line, /--lane/, "no lane was used");
  });

  it("an explicit --isolated run alone carries --isolated; an explicit --read-only run alone carries --read-only", { timeout: 60_000 }, async (t) => {
    const isolated = await hintFor(t, ["--isolated", "--model", "m"]);
    assert.match(isolated, flag("--isolated"), isolated);
    const readOnly = await hintFor(t, ["--read-only", "--model", "m"]);
    assert.match(readOnly, flag("--read-only"), readOnly);
    assert.doesNotMatch(readOnly, flag("--isolated"), "a standalone --read-only run was not isolated");
  });

  it("the hint repeats the subagent, web search and network flags, naming the default sandbox for --network-access", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--subagent-model", "sub-m", "--subagent-effort", "low", "--web-search", "live", "--network-access", "--model", "m"]);
    assert.match(line, /--subagent-model sub-m(?![\w-])/, `Codex does not carry subagent defaults into a resume: ${line}`);
    assert.match(line, /--subagent-effort low(?![\w-])/, line);
    assert.match(line, /--web-search live(?![\w-])/, `Codex does not carry the web search mode into a resume: ${line}`);
    assert.match(line, flag("--network-access"), `Codex does not carry network access into a resume: ${line}`);
    assert.match(line, /--sandbox workspace-write(?![\w-])/, `a resumed --network-access run needs the sandbox named: ${line}`);
  });

  it("a --network-access run on a lane with a sandbox dial lets the lane name the sandbox", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--lane", "build", "--network-access"]);
    assert.match(line, /--lane build(?![\w-])/, line);
    assert.match(line, flag("--network-access"), line);
    assert.doesNotMatch(line, /--sandbox/, `the lane names the sandbox on resume: ${line}`);
  });

  it("a --network-access run on a lane without a sandbox dial names the default sandbox", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--lane", "bare", "--network-access"]);
    assert.match(line, /--lane bare(?![\w-])/, line);
    assert.match(line, flag("--network-access"), line);
    assert.match(line, /--sandbox workspace-write(?![\w-])/, `the lane names no sandbox, so a resumed --network-access needs one: ${line}`);
  });

  it("a plain run's hint is just the session, with no lane or isolation flags", { timeout: 60_000 }, async (t) => {
    const line = await hintFor(t, ["--model", "m"]);
    assert.match(line, new RegExp(`--session ${THREAD}(?![\\w-])`), line);
    assert.doesNotMatch(line, /--lane|--isolated|--read-only/, line);
  });
});

// =============================================================================================
// INTEGRATION: import safety, entrypoint, help (plan 4.9)
// =============================================================================================

describe("integration: import safety and entrypoint", () => {
  it("importing relay.mjs has no side effects: exits cleanly, reads no stdin, creates no artifacts", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const child = spawn(process.execPath, [
      "--input-type=module", "-e",
      'import(process.argv[1]).then((m) => { console.log("IMPORT_OK " + JSON.stringify(Object.keys(m).sort())); }, (e) => { console.error(String((e && e.stack) || e)); process.exit(1); });',
      RELAY_URL,
    ], { cwd: fx.work, env: fx.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolveExit) => child.on("close", (code) => resolveExit(code)));
    // stdin stays open and empty: a relay that tried to read the brief at import time would hang here.
    const code = await Promise.race([exited, sleep(15_000).then(() => { child.kill("SIGKILL"); return "hung"; })]);
    child.stdin.destroy();
    assert.equal(code, 0, `import must exit cleanly (stdin read or main() at import?)\n${stderr}`);
    assert.match(stdout, /IMPORT_OK/);
    assert.match(stdout, /"main"/);
    assert.match(stdout, /"buildArgv"/);
    assert.ok(!existsSync(join(fx.tmp, "delegate-relay")), "no run directory created by import");
    assert.deepEqual(readdirSync(fx.work), [], "no artifacts in the working directory");
    assert.equal(fx.invocations().length, 0, "nothing was spawned");
    assert.deepEqual(fx.configTouches(), []);
  });

  it("--help works directly and documents the new flags", { timeout: 60_000 }, () => {
    const result = spawnSync(process.execPath, [RELAY, "--help"], { encoding: "utf8", timeout: 20_000, input: "" });
    assert.equal(result.status, 0, result.stderr);
    for (const flag of ["--isolated", "--no-isolated", "--disable"]) {
      assert.ok(result.stdout.includes(flag), `--help must document ${flag}`);
    }
  });

  it("--help output uses LF line breaks only, with no carriage returns", { timeout: 60_000 }, () => {
    const result = spawnSync(process.execPath, [RELAY, "--help"], { encoding: "utf8", timeout: 20_000, input: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("\r"), "--help must not contain any carriage return");
    assert.ok(result.stdout.split("\n").length > 10, "--help must span multiple LF-separated lines");
  });

  describe("helpTextFrom gives LF-only text whatever the source line endings", () => {
    const BLOCK = ["#!/usr/bin/env node", "/**", " * first line", " *   indented line", " *", " * last line", " */", "code();"];
    const EXPECTED = "first line\n  indented line\n\nlast line\n";
    for (const [name, eol] of [["CRLF", "\r\n"], ["LF", "\n"], ["lone CR", "\r"]]) {
      it(`${name} line endings give identical LF-only text`, () => {
        const out = fn("helpTextFrom")(BLOCK.join(eol) + eol);
        assert.equal(out, EXPECTED);
        assert.ok(!out.includes("\r"), "no carriage return may remain");
      });
    }
    it("falls back to a one-line LF-only text when there is no block comment", () => {
      const out = fn("helpTextFrom")("code();\r\n");
      assert.ok(out.endsWith("\n") && !out.includes("\r"), JSON.stringify(out));
    });
  });

  it("--help says a --disable value must start with a letter or digit", { timeout: 60_000 }, () => {
    const result = spawnSync(process.execPath, [RELAY, "--help"], { encoding: "utf8", timeout: 20_000, input: "" });
    assert.equal(result.status, 0, result.stderr);
    const start = result.stdout.indexOf("--disable <feature>");
    assert.notEqual(start, -1, "--help must document `--disable <feature>`");
    // The option's own entry: from its name to the next option line (options sit at a 2-space indent,
    // their wrapped continuation lines far deeper).
    const rest = result.stdout.slice(start);
    const nextOption = /\n {1,4}-/.exec(rest);
    const entry = nextOption ? rest.slice(0, nextOption.index) : rest;
    assert.ok(entry.includes("--disable"), entry);
    assert.match(entry, START_WITH_ALNUM, `the --disable entry must state the first-character rule:\n${entry}`);
  });

  for (const variant of [[], ["--preserve-symlinks-main"]]) {
    it(`--help works through a symlinked/junctioned entrypoint ${variant.join(" ")}`.trim(), { timeout: 60_000 }, (t) => {
      const root = mkdtempSync(join(tmpdir(), "relay-test-"));
      const token = randomBytes(8).toString("hex");
      writeFileSync(join(root, OWNED_MARKER), token);
      const link = join(root, "linked-scripts");
      t.after(() => {
        try { unlinkSync(link); } catch { try { rmSync(link, { recursive: false, force: true }); } catch { /* ignore */ } }
        removeOwned(root, token);
        assert.ok(existsSync(RELAY), "removing the link must never touch the repository");
      });
      try {
        symlinkSync(dirname(RELAY), link, IS_WIN ? "junction" : "dir");
      } catch (error) {
        t.skip(`cannot create a link here: ${error.code}`);
        return;
      }
      const result = spawnSync(process.execPath, [...variant, join(link, "relay.mjs"), "--help"], { encoding: "utf8", timeout: 20_000, input: "" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/, "main() ran through the link");
    });
  }

  it("a usage error still exits 2 and publishes no result", { timeout: 60_000 }, async (t) => {
    const fx = makeFixture(t);
    const outDir = fx.outDir("usage-error");
    const run = await fx.run(["--bogus-flag"], { outDir });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /unknown option/);
    assert.equal(run.result, null);
    assert.ok(!existsSync(outDir));
  });
});
