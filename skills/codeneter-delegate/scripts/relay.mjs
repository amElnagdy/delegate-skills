#!/usr/bin/env node
/**
 * delegate-skills · codeneter-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the CodeNeter CLI (`codeneter run`), capture
 * the run, and write a structured result the orchestrating agent can review.
 * The orchestrator runs this one command and reads the result JSON — every
 * CodeNeter-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Shell-capable agents use the same file contract.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codeneter` and `git`. The one file it reads
 * outside the run is the `autoApprove` key of ~/.codeneter/config.json (no
 * credentials live there). The `codeneter` process it launches does
 * authenticate — exactly as you do at the terminal. Read this file before you
 * run it.
 *
 * Autonomy, in CodeNeter's own terms: `codeneter run` has no sandbox and no
 * read-only mode. File edits run in every `--mode` (`agent`, `plan`, `ask`); a
 * mode only guides the agent. Terminal commands, file deletions, and (with
 * `approvalPolicy.confirmMcp` on) MCP calls need an approval a headless run
 * cannot give, so the CLI refuses them and the agent carries on. `--auto`
 * approves all of them for the run. The config key `autoApprove: true` does the
 * same with no flag and nothing turns it off per run, so the relay refuses to
 * launch while it is on unless --auto was passed.
 *
 * Without --auto the implementer can read and edit files but cannot run the
 * project's gates. The orchestrator runs them in either case.
 *
 * It deliberately does NOT commit. Committing belongs to the reviewer, after it
 * reads the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>     Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>         Workspace for CodeNeter (default: current directory).
 *   --lane <name>      Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>       A Model ID from `codeneter models` (default: the CLI's configured
 *                      model, or the session's saved model when resuming).
 *   --effort <level>   A supported effort that `codeneter models` lists for --model.
 *                      Sent as <id>?effort=<level>; requires --model.
 *   --mode <mode>      agent | plan | ask. An instruction to the agent, not a restriction:
 *                      edits run in every mode.
 *   --auto             Approve terminal commands, file deletions, and MCP calls for this
 *                      run. Nothing sandboxes them. Not remembered by a resumed session.
 *   --session <id>     Continue a saved session (the sessionId from a prior result.json);
 *                      send only the delta brief. It must belong to the same --cd.
 *   --timeout <dur>    Relay-side watchdog (default: off). Durations use h/m/s
 *                      strings like 30m or 2h. On expiry the codeneter child is killed
 *                      and result.json gets status "timeout".
 *   --out-dir <dir>    Where to write run artifacts (default: a fresh dir under
 *                      the system temp dir, outside the target repository).
 *   -h, --help         Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codeneterVersion, sessionId (for a later --session),
 *   resolvedModel and resolvedMode from the CLI's init event, errorKind and
 *   limit from its result event, tools (started, failed, refused for lack of
 *   approval), finalMessage (its report), touchedFiles (git porcelain, null if
 *   git can't report), and the paths to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a brief
 * starting with "/", autoApprove on without --auto) exits 2 before any run and
 * writes no result file; a missing `codeneter` binary exits 127. A run whose
 * result event does not say ok, or that exits without one, is reported failed
 * and keeps the CLI's non-zero exit code (1 when it exited 0).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to codeneter), or
 * codeneter_unavailable. An orchestrator that polls for the file must therefore
 * also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const MAX_BUFFERED_CHARS = 1_048_576;
// Batch size for the event log; small enough to bound memory, large enough that the
// stdout pipe keeps draining while we write.
const EVENT_FLUSH_CHARS = 262_144;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Model IDs as `codeneter models` prints them (provider/model). Effort is a separate
// dial so `?` and `=` never come from free text. Keep in lockstep with
// delegate-setup MODEL_TOKEN.shellSafe (codeneter is a winShell implementer).
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const SAFE_EFFORT = /^[a-z][a-z0-9-]*$/i;
const MODES = ["agent", "plan", "ask"];
// The workspace path reaches cmd.exe on Windows, quoted; these characters would
// still be interpreted inside the quotes.
const WIN_SHELL_UNSAFE_PATH = /["%!^&|<>]/;
const PRIVATE_FILE_MODE = 0o600;
// What the CLI answers when an action needed an approval nobody could give.
const REFUSED = /^User rejected /;

const IMPLEMENTER_KEY = "codeneter";
const DEFAULT_BIN = "codeneter";

const AUTH_HINTS = {
  sign_in_required: "the CLI is not signed in, or its sign-in was rejected — run `codeneter login` at a terminal (or set CODENETER_AUTH_TOKEN), then re-dispatch",
  access_denied: "the account is signed in but not allowed to run this — signing in again will not help; check the account or plan",
  auth_unavailable: "the sign-in could not be renewed because the service did not answer — it may still be good; retry later",
};

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the delegate-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (flagged.has(field)) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    mode: null,
    auto: false,
    session: null,
    timeout: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--mode": opts.mode = next(); flagged.add("mode"); break;
      case "--auto": opts.auto = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model must be a Model ID from `codeneter models` (letters, digits, . _ : / -); pass effort with --effort");
  }
  if (opts.effort !== null && !SAFE_EFFORT.test(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected a bare token such as high)`);
  }
  if (opts.effort !== null && opts.model === null) {
    fail("--effort requires --model: effort is part of the model selection (<id>?effort=<level>)");
  }
  // The CLI runs an unknown mode as agent without saying so; refuse it here instead.
  if (opts.mode !== null && !MODES.includes(opts.mode)) {
    fail(`invalid --mode "${opts.mode}" (expected one of: ${MODES.join(", ")})`);
  }
  // A malformed --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session must be a session id (letters, digits, . _ : -)");
  }
  let workspace = null;
  try { workspace = statSync(opts.cd); } catch { /* reported below */ }
  if (!workspace?.isDirectory()) fail(`--cd ${opts.cd} is not a directory`);
  // On Windows the npm install is a .cmd shim, which needs cmd.exe to launch.
  opts.winShell = process.platform === "win32";
  if (opts.winShell && WIN_SHELL_UNSAFE_PATH.test(opts.cd)) {
    fail("the --cd path contains characters cmd.exe would interpret; use a path without them");
  }
  return opts;
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to codeneter run\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

/**
 * The CLI has no flag that turns approvals off: `autoApprove: true` in its config
 * approves terminal commands, deletions, and MCP calls even without --auto. Read
 * that one key (the file holds no credentials) so a run the orchestrator asked to
 * keep approvals off never silently gets them. A missing file means the CLI's
 * defaults; a file that cannot be read as a JSON object is refused, never guessed.
 * This is a snapshot: the CLI reads the file itself a moment later.
 */
function approvalConfig() {
  let raw;
  try {
    raw = readFileSync(join(homedir(), ".codeneter", "config.json"), "utf8");
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? { state: "missing", autoApprove: false }
      : { state: "unreadable", autoApprove: null };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* reported as invalid */ }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "invalid", autoApprove: null };
  }
  return { state: "read", autoApprove: parsed.autoApprove === true };
}

function checkApprovals(opts) {
  const config = approvalConfig();
  opts.configAutoApprove = config.autoApprove;
  if (opts.auto) return;
  if (config.state === "unreadable" || config.state === "invalid") {
    fail(`~/.codeneter/config.json is ${config.state === "invalid" ? "not a JSON object" : "unreadable"}, so the relay cannot tell whether it turns approvals on; fix it, or pass --auto to accept unattended approvals`);
  }
  if (config.autoApprove) {
    fail("~/.codeneter/config.json has autoApprove on, so this run would approve terminal commands, file deletions, and MCP calls without asking; pass --auto to accept that, or turn autoApprove off");
  }
}

function versionProbeTimeout(opts) {
  // The watchdog is only armed once codeneter is running, so the preflight needs a bound of
  // its own: a `codeneter --version` that never returns would wedge the relay here, before
  // any result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function spawnShellLaunch(binary, argv, options, useShell) {
  if (!useShell) return spawn(binary, argv, options);
  // Node 24 warns when shell:true is paired with an args array. The args here
  // are already token-validated or quoted for cmd.exe, so serialize them once.
  return spawn([binary, ...argv].join(" "), { ...options, shell: true });
}

async function codeneterVersion(opts, probeTimeoutMs, onChild) {
  const probe = await new Promise((resolveProbe) => {
    const child = spawnShellLaunch(DEFAULT_BIN, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }, opts.winShell);
    onChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe({ stdout, stderr, ...result });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, error, timedOut: false }));
    child.on("close", (code) => finish({ code, error: null, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    }, probeTimeoutMs);
  });
  if (probe.timedOut) {
    return { version: null, error: Object.assign(new Error("codeneter --version timed out"), { code: "ETIMEDOUT", stderr: probe.stderr }) };
  }
  if (probe.error?.code === "ENOENT") return { version: null, error: null };
  if (probe.error) return { version: null, error: probe.error };
  if (opts.winShell && /not recognized as an internal or external command/i.test(probe.stderr)) {
    return { version: null, error: null };
  }
  if (probe.code !== 0) {
    return { version: null, error: Object.assign(new Error("codeneter --version failed"), { status: probe.code, stderr: probe.stderr }) };
  }
  return { version: probe.stdout.trim() || "unknown", error: null };
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function buildArgv(opts) {
  // The brief goes in on stdin, never in argv, so the win32 cmd.exe launch only ever
  // sees fixed words, token-validated values, and one quoted path. --workspace is
  // passed even though it matches the child's cwd: on --resume it makes the CLI
  // refuse a session saved under another folder instead of quietly running there.
  const workspace = opts.winShell ? `"${opts.cd}"` : opts.cd;
  const argv = ["run", "--output-format", "stream-json", "--workspace", workspace];
  if (opts.session) argv.push("--resume", opts.session);
  if (opts.model) argv.push("--model", opts.effort ? `${opts.model}?effort=${opts.effort}` : opts.model);
  if (opts.mode) argv.push("--mode", opts.mode);
  if (opts.auto) argv.push("--auto");
  return argv;
}

/**
 * `codeneter run --output-format stream-json` writes one JSON object per line:
 * `init` (sessionId, resumed, workspaceRoot, model, mode), `assistant_delta`,
 * `retry_reset`, `assistant_message`, `tool_start`, `tool_result` (ok, error), and
 * one closing `result` (ok, response, error, errorKind, statusCode, limit,
 * sessionId). The result event is the only proof of success; invalid options
 * end the process with no result line at all.
 */
function scanEventLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return; // a partial or oversized line; events.jsonl keeps it either way
  }
  if (!event || typeof event !== "object") return;
  if (typeof event.sessionId === "string" && event.sessionId) state.sessionId = event.sessionId;
  switch (event.type) {
    case "init":
      state.resolvedModel = typeof event.model === "string" ? event.model : null;
      state.resolvedMode = typeof event.mode === "string" ? event.mode : null;
      break;
    case "assistant_message":
      if (typeof event.text === "string" && event.text.trim()) state.lastText = event.text.trim();
      break;
    case "tool_start":
      state.tools.started += 1;
      break;
    case "tool_result":
      if (event.ok === false) {
        state.tools.failed += 1;
        if (REFUSED.test(String(event.error ?? ""))) state.tools.refused += 1;
      }
      break;
    case "result":
      state.result = {
        ok: event.ok === true,
        response: typeof event.response === "string" ? event.response : "",
        error: typeof event.error === "string" ? event.error : null,
        errorKind: typeof event.errorKind === "string" ? event.errorKind : null,
        statusCode: Number.isInteger(event.statusCode) ? event.statusCode : null,
        limit: event.limit && typeof event.limit === "object" ? event.limit : null,
      };
      break;
    default:
      break;
  }
}

/**
 * Buffer the event log instead of appending per line: a relay that blocks on a
 * synchronous write for every line drains the stdout pipe slowly. Lines are parsed
 * in memory as they arrive and flushed in batches.
 */
function recordEventLine(run, line, state) {
  state.pending.push(line, "\n");
  state.pendingChars += line.length + 1;
  if (state.pendingChars >= EVENT_FLUSH_CHARS) flushEvents(run, state);
  scanEventLine(line, state);
}

function flushEvents(run, state) {
  if (state.pending.length === 0) return;
  const batch = state.pending.join("");
  state.pending = [];
  state.pendingChars = 0;
  try {
    appendFileSync(run.eventsPath, batch, "utf8");
  } catch {
    // The log is a diagnostic aid; losing it must not lose the run's result.
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Keep relay artifacts outside the target repository so touchedFiles reports
  // CodeNeter's Git-visible edits without the helper's own files.
  const outDir = opts.outDir || mkdtempSync(join(tmpdir(), "delegate-relay-"));
  if (opts.outDir) mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  const paths = [run.finalPath, run.resultPath, run.briefPath, run.eventsPath];
  let entries = [];
  try { entries = readdirSync(outDir); } catch { /* the writers report an unusable output directory */ }
  const collides = paths.some((path) => entries.includes(basename(path)));
  if (collides) {
    let priorRun = false;
    try {
      priorRun = lstatSync(run.resultPath).isFile() &&
        JSON.parse(readFileSync(run.resultPath, "utf8")).schema === "delegate-relay.result.v1";
    } catch { /* an absent, malformed, or linked marker is not reusable */ }
    if (!priorRun) fail("--out-dir contains relay artifacts without a prior delegate-relay.result.v1 result");
  }
  // Exact relay files may be reused, but no stale artifact endpoint may survive:
  // final.txt is written after dispatch and would otherwise follow its symlink.
  for (const path of paths) {
    if (!entries.includes(basename(path))) continue;
    try {
      const artifact = lstatSync(path);
      if (artifact.isFile() || artifact.isSymbolicLink()) {
        rmSync(path, { force: true });
      }
    } catch { /* the writer will report an unusable artifact path */ }
  }
  // Exclusive creation closes the cleanup-to-write race.
  writeFileSync(run.briefPath, brief, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  writeFileSync(run.eventsPath, "", { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  return run;
}

function makeResultWriter(opts, version, run) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json atomically, and returns the object it
  // just wrote so the caller can hand it straight to printSummary.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "codeneter",
      workdir: opts.cd,
      model: opts.model,
      effort: opts.effort,
      mode: opts.mode,
      auto: opts.auto,
      configAutoApprove: opts.configAutoApprove,
      autonomy: opts.auto
        ? "--auto: terminal commands, file deletions, and MCP calls approved for the run (no sandbox)"
        : "approvals off: file edits run; terminal commands and deletions are refused (no sandbox, no read-only)",
      session: opts.session,
      resumed: Boolean(opts.session),
      codeneterVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      resolvedModel: null,
      resolvedMode: null,
      errorKind: null,
      limit: null,
      tools: { started: 0, failed: 0, refused: 0 },
      ...extra,
    };
    const resultContents = `${JSON.stringify(result, null, 2)}\n`;
    let resultTemporary = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const resultCandidate = `${run.resultPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
      try {
        writeFileSync(resultCandidate, resultContents, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
        resultTemporary = resultCandidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (resultTemporary === null) throw new Error("could not reserve a result.json temporary file");
    try {
      renameSync(resultTemporary, run.resultPath);
    } catch (error) {
      rmSync(resultTemporary, { force: true });
      throw error;
    }
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "codeneter_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `codeneter` not found on PATH. Install the CodeNeter CLI (`npm install -g @codeneter/cli`) and run `codeneter login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `codeneter --version preflight timed out after ${probeTimeoutMs}ms; CodeNeter was not dispatched`
    : `codeneter --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; CodeNeter was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function installPreflightSignalHandlers(opts, run, writeResult, getChild) {
  let active = true;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (!active) return;
      active = false;
      const child = getChild();
      if (child) killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId: null,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the codeneter version preflight; CodeNeter was not dispatched`,
      });
      printSummary(result, run.resultPath);
      process.exit(result.exitCode);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    active = false;
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
  };
}

function runFields(state) {
  return {
    sessionId: state.sessionId,
    resolvedModel: state.resolvedModel,
    resolvedMode: state.resolvedMode,
    errorKind: state.result?.errorKind ?? null,
    limit: state.result?.limit ?? null,
    tools: { ...state.tools },
  };
}

function dispatchToCodeneter(opts, brief, run, writeResult) {
  const argv = buildArgv(opts);
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree.
  const child = spawnShellLaunch(DEFAULT_BIN, argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }, opts.winShell);

  const state = {
    sessionId: null,
    resolvedModel: null,
    resolvedMode: null,
    lastText: null,
    result: null,
    tools: { started: 0, failed: 0, refused: 0 },
    pending: [],
    pendingChars: 0,
  };
  let stdoutBuf = "";
  const stderrTail = [];

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuf += stdoutDecoder.write(chunk);
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      recordEventLine(run, line, state);
    }
    // Flush an oversized line as a fragment rather than growing the buffer without bound;
    // the fragment cannot be parsed, and events.jsonl still keeps it.
    if (stdoutBuf.length > MAX_BUFFERED_CHARS) {
      recordEventLine(run, stdoutBuf, state);
      stdoutBuf = "";
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface codeneter progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // The relay writes final.txt itself from the event stream, preferring the result
  // event's response and falling back to the last assistant message.
  const persistFinal = () => {
    const text = (state.result?.response || state.lastText || "").trim();
    if (!text) return { text: "", error: null };
    try {
      // final.txt is deliberately created only once. This refuses a symlink
      // introduced after prepareRunDir completed.
      writeFileSync(run.finalPath, `${text}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
      return { text, error: null };
    } catch (error) {
      return { text, error: `could not safely create final.txt: ${error.code || error.message}` };
    }
  };

  let settled = false;
  let watchdogFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  if (timeoutMs !== null) {
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      child.once("exit", () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      killChild(child);
      sigkillTimer = setTimeout(() => {
        if (!settled) killChild(child, "SIGKILL");
      }, 10_000);
    }, timeoutMs);
  }

  const clearWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the codeneter child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      killChild(child);
      try {
        const touched = gitTouchedFiles(opts.cd);
        flushEvents(run, state);
        const final = persistFinal();
        const abortedFields = {
          status: "aborted",
          exitCode: 128 + (constants.signals[sig] || 15),
          signal: sig,
          ...runFields(state),
          finalMessage: final.text,
          touchedFiles: touched,
          stderrTail: stderrTail.slice(-20),
          error: final.error || `the relay was killed by ${sig}; codeneter was terminated with it — inspect the working tree before re-dispatching`,
        };
        const result = writeResult(abortedFields);
        printSummary(result, run.resultPath);
        setTimeout(() => {
          killChild(child, "SIGKILL");
          // the child may flush files during the grace window; refresh the snapshot so the
          // artifact matches the tree the orchestrator will actually find
          const late = gitTouchedFiles(opts.cd);
          writeResult({ ...abortedFields, touchedFiles: late });
          process.exit(result.exitCode);
        }, 2000);
      } catch (error) {
        killChild(child, "SIGKILL");
        throw error;
      }
    });
  }

  // A grandchild that outlives codeneter and inherited the pipes keeps stdout/stderr open,
  // so "close" never fires and the relay waits forever, writing no result. Once codeneter
  // itself is gone the pipes hold nothing we still need, so drop them after a short drain
  // grace and let "close" run.
  child.once("exit", () => {
    // The implementer already exited. Leaving the watchdog armed lets a drain that
    // overlaps the remaining budget fire, set watchdogFired, and report timeout.
    if (!watchdogFired) clearWatchdog();
    const drain = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
    if (typeof drain.unref === "function") drain.unref();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      ...runFields(state),
      finalMessage: "",
      touchedFiles: touched,
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    if (stdoutBuf.trim()) recordEventLine(run, stdoutBuf, state);
    flushEvents(run, state);
    const final = persistFinal();
    // A result event that says ok is the only proof of a finished task: a missing
    // event means the stream was cut or the CLI rejected its arguments.
    const cliOk = code === 0 && state.result?.ok === true;
    const succeeded = cliOk && !watchdogFired && final.error === null;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const touched = gitTouchedFiles(opts.cd);
    const limitText = state.result?.limit
      ? [state.result.limit.title, state.result.limit.message].filter((part) => typeof part === "string" && part).join(": ")
      : "";
    const cliError = !state.result
      ? `codeneter exited ${code ?? signal} without a result event`
      : state.result.ok !== true
        ? state.result.error
          ? `codeneter reported a failure: ${state.result.error}`
          : state.result.limit
            ? `codeneter reached a usage limit${limitText ? `: ${limitText}` : ""}`
            : "codeneter reported a failure without a message"
        : code !== 0
          ? `codeneter reported success but exited ${code ?? signal}`
          : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      ...runFields(state),
      finalMessage: final.text,
      touchedFiles: touched,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(final.error
        ? { error: final.error }
        : watchdogFired
        ? { error: `codeneter did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
        : cliError
          ? { error: cliError }
          : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  // If the child failed to launch, writing to its stdin can emit a stray 'error'
  // on the pipe; the 'error' handler above owns that outcome, so swallow it here.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  // The CLI replaces a prompt that starts with /name with a saved command of that name.
  if (brief.trimStart().startsWith("/")) {
    fail("the brief starts with \"/\", which CodeNeter may replace with a saved command; start it with plain text");
  }
  checkApprovals(opts);

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  let resultWriter = makeResultWriter(opts, null, run);
  const writeResult = (extra) => resultWriter(extra);
  let preflightChild = null;
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult, () => preflightChild);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const probe = await codeneterVersion(opts, probeTimeoutMs, (child) => { preflightChild = child; });
  resultWriter = makeResultWriter(opts, probe.version, run);

  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    clearPreflightSignals();
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  clearPreflightSignals();
  dispatchToCodeneter(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  codeneter ${result.codeneterVersion ?? "?"}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.errorKind && AUTH_HINTS[result.errorKind]) lines.push(`hint: ${AUTH_HINTS[result.errorKind]}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a CodeNeter error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated codeneter (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.session) lines.push(`mode: resumed session ${result.session}`);
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId})`);
  if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}${result.resolvedMode ? `  ·  mode: ${result.resolvedMode}` : ""}`);
  const tools = result.tools ?? { started: 0, failed: 0, refused: 0 };
  if (tools.started > 0) lines.push(`tools: ${tools.started} started, ${tools.failed} failed`);
  if (tools.refused > 0 && !result.auto) {
    lines.push(`approvals: ${tools.refused} action${tools.refused === 1 ? " was" : "s were"} refused because approvals are off — the implementer could not run them; run the gates yourself, or re-dispatch with --auto only if the user accepts unattended commands`);
  }
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- CodeNeter final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
