#!/usr/bin/env node
/**
 * delegate-skills · copilot-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the GitHub Copilot CLI (`copilot -p`),
 * capture the JSONL event stream, and write a structured result the
 * orchestrating agent can review. The orchestrator runs this one command and
 * reads the result JSON — every copilot-specific mechanic lives in here, which
 * keeps the skill orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `copilot`, `git`, and Windows `taskkill` for
 * process-tree termination. The `copilot` process it launches does
 * authenticate — exactly as you do at the terminal. Read this file before you
 * run it.
 *
 * The brief is handed to copilot via `-p @<file>` (the CLI's @-prefixed file
 * prompt channel, verified on copilot 1.0.78), never argv: it stays out of
 * the host process list, isn't bounded by the OS arg-length cap, and a brief
 * that begins with "-" can't be misread as a flag.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Default mode runs without `--allow-all-tools`: headless tool calls are
 * auto-denied by copilot, and the relay detects denial events and reports
 * `status: "failed"` with the CLI's own error message plus a hint to pass
 * `--allow-all-tools`. `--allow-all-tools` explicitly opts in to full tool
 * autonomy. `--read-only` selects `--mode plan`, which disables edit tools so
 * project files can't be changed by direct edits (shell commands still run),
 * and works without `--allow-all-tools`. `--read-only` and `--allow-all-tools`
 * are mutually exclusive.
 *
 * On native Windows `copilot` is an npm-installed `.cmd` shim this relay
 * launches with shell:true. Model and effort values therefore accept only
 * shell-safe tokens; the working directory is the child process cwd; and the
 * brief path is quoted for the shell.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for copilot (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Copilot model (default: copilot's own default, `auto`).
 *                           Letters, digits, and . _ : / - only.
 *   --effort <level>        Reasoning effort for this run (low|medium|high|xhigh|max).
 *   --read-only             Read-only plan mode (`--mode plan`); works without
 *                           `--allow-all-tools`. Mutually exclusive with
 *                           `--allow-all-tools`.
 *   --allow-all-tools       Pass copilot's `--allow-all-tools` for full tool
 *                           autonomy in headless mode. Without this, headless
 *                           tool calls are auto-denied. Mutually exclusive with
 *                           `--read-only`.
 *   --resume-last           Continue the most recent copilot session for this
 *                           cwd (`--continue`); send only the delta brief.
 *   --session <id>          Continue a specific session id (`--resume=<id>`);
 *                           send only the delta brief. Mutually exclusive with
 *                           --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Copilot has no
 *                           timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, copilotVersion, model, effort, readOnly,
 *   allowAllTools, resumed, sessionId, finalMessage (the last non-ephemeral
 *   assistant message), touchedFiles (git porcelain, null if git cannot
 *   report), and paths to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `copilot` binary exits
 * 127; otherwise the exit code mirrors copilot's own (0 success, non-zero
 * failure), except a run whose event stream contains a tool denial exits 1
 * even if copilot exits 0. If the child dies on a signal, the exit code is 128
 * plus the signal number and `result.json` records the signal. Once the brief
 * validates, `result.json` is written on every outcome — completed, failed,
 * timeout (the --timeout watchdog fired), aborted (the relay itself was killed
 * and forwarded the kill to copilot), or copilot_unavailable.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const MAX_BUFFERED_CHARS = 1_048_576;

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const PROBE_TIMEOUT_MS = 10_000;

// --model and --effort values reach a shell on win32 (shell:true for the .cmd
// shim), so they are restricted to safe tokens. Effort is then checked against
// Copilot's documented enum (low|medium|high|xhigh|max).
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

const IMPLEMENTER_KEY = "copilot";

// On resume (--resume=<id> / --continue), a bare @file reference in the resumed
// session is echoed back instead of executed (verified on copilot 1.0.78); the
// relay wraps the reference in this fixed directive so the delta is acted on.
// The directive is relay-authored text, so the win32 value has no user content
// to mangle inside its shell quotes. Deliberately not appended on fresh runs,
// which execute a bare @file reference correctly.
const RESUME_DIRECTIVE =
  "Execute the instructions in the referenced file, then report what you did. Do not just summarize the file: ";

function makeLineScanner(onObject) {
  let buf = "";
  return (chunk) => {
    if (!chunk) return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      const line = buf + chunk.slice(start, end);
      buf = "";
      const trimmed = line.trim();
      if (trimmed) {
        try { onObject(JSON.parse(trimmed)); } catch { /* skip non-JSON lines */ }
      }
      start = end + 1;
    }
    buf += chunk.slice(start);
    if (buf.length > MAX_BUFFERED_CHARS) buf = "";
  };
}

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
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (field === "planOnly" && (flagged.has("planOnly") || flagged.has("readOnly"))) continue;
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("allowAllTools"))) continue;
    if (field === "force" && flagged.has("force")) continue;
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
    readOnly: false,
    allowAllTools: false,
    resumeLast: false,
    session: null,
    timeout: DEFAULT_TIMEOUT,
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
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--allow-all-tools": opts.allowAllTools = true; flagged.add("allowAllTools"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.readOnly && opts.allowAllTools) {
    fail("--read-only and --allow-all-tools are mutually exclusive; plan mode works without tool permissions");
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
  for (const flag of ["model", "effort", "session"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (opts.effort !== null && !EFFORT_LEVELS.has(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: ${[...EFFORT_LEVELS].join(", ")})`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a positive schedulable duration; use h/m/s strings like 30m, 90s, or 1h30m (maximum ~24.8 days)`);
  }
  try {
    if (!statSync(opts.cd).isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  } catch {
    fail(`--cd directory not found: ${opts.cd}`);
  }
  if (opts.outDir && existsSync(opts.outDir)) {
    try {
      if (!statSync(opts.outDir).isDirectory()) fail(`--out-dir is not a directory: ${opts.outDir}`);
    } catch {
      fail(`cannot inspect --out-dir: ${opts.outDir}`);
    }
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to copilot -p\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function copilotVersion(timeoutMs) {
  const limit = Math.min(timeoutMs, PROBE_TIMEOUT_MS);
  // On Windows, npm installs `copilot` as a .cmd shim; shell:true resolves it.
  // `copilot version` (subcommand) prints "GitHub Copilot CLI X.Y.Z" as the
  // first line, followed by an optional update notice — parse only the first line.
  try {
    const raw = execFileSync("copilot", ["version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: limit,
      killSignal: "SIGKILL",
    }).trim();
    const firstLine = raw.split("\n")[0].trim();
    // Extract version from "GitHub Copilot CLI 1.0.78"
    const versionMatch = firstLine.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)/);
    return { version: versionMatch ? versionMatch[1] : firstLine || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    // shell:true routes a missing binary through cmd.exe, which reports it as a
    // non-zero exit rather than ENOENT; that is still "not installed".
    if (process.platform === "win32" &&
        /not recognized as an internal or external command/i.test(String(error?.stderr || ""))) {
      return { version: null, error: null };
    }
    return { version: null, error };
  }
}

function buildArgv(opts, briefPath) {
  // shell:true on win32 (needed for the copilot.cmd shim) doesn't quote
  // args, so a path with spaces splits. Quote the spaceable path args;
  // --model/--effort/--session are already restricted to safe tokens at parse time.
  const quotePath = (p) => (process.platform === "win32" ? `"${p}"` : p);
  const argv = [
    "--output-format", "json",
    "--no-color",
    "--stream", "off",
  ];

  if (opts.readOnly) {
    argv.push("--mode", "plan");
  }

  if (opts.allowAllTools) {
    argv.push("--allow-all-tools");
  }

  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push(`--resume=${opts.session}`);

  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);

  // Deliver the brief via a file, not argv: keeps it out of the host process
  // list, isn't bounded by the OS arg-length cap, and a brief that begins with
  // "-" can't be misread as a flag. prepareRunDir already wrote run.briefPath.
  // On resume the reference gets the RESUME_DIRECTIVE wrapper (see above); its
  // value contains spaces, so on win32 the whole value is outer-quoted for cmd
  // (the path then needs no inner quotes of its own).
  let delivery;
  if (opts.resumeLast || opts.session) {
    delivery = process.platform === "win32"
      ? `"${RESUME_DIRECTIVE}@${briefPath}"`
      : `${RESUME_DIRECTIVE}@${briefPath}`;
  } else {
    delivery = `@${quotePath(briefPath)}`;
  }
  argv.push("-p", delivery);
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir =
    opts.outDir ||
    join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "copilot",
      workdir: opts.cd,
      model: opts.model,
      effort: opts.effort,
      readOnly: opts.readOnly,
      allowAllTools: opts.allowAllTools,
      resumed: Boolean(opts.resumeLast || opts.session),
      sessionId: null,
      copilotVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(opts, writeResult, resultPath) {
  const result = writeResult({
    status: "copilot_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `copilot` not found on PATH. Install with `npm install -g @github/copilot` and run `copilot login`.\n",
  );
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `copilot version preflight timed out after ${Math.min(timeoutMs, PROBE_TIMEOUT_MS)}ms; copilot was not dispatched`
    : `copilot version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; copilot was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function installPreflightSignalHandlers(opts, run, writeResult) {
  let active = true;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (!active) return;
      active = false;
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the copilot version preflight; copilot was not dispatched`,
      });
      printSummary(result, run.resultPath);
      process.exit(result.exitCode);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    active = false;
    for (const [sig, handler] of handlers) process.off(sig, handler);
  };
}

function dispatchToCopilot(opts, run, writeResult, onReady) {
  const child = spawn("copilot", buildArgv(opts, run.briefPath), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    // shell:true on win32 so the copilot.cmd shim resolves. Safe: the brief
    // rides `-p @<briefPath>` as a quoted file path, --model/--effort/--session
    // are restricted to safe tokens at parse time.
    shell: process.platform === "win32",
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let sessionId = null;
  let lastAssistantMessage = "";
  let denied = false;
  let denialMessage = "";
  const stderrTail = [];

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const scan = makeLineScanner((event) => {
    // Skip ephemeral events (mcp status, skills_loaded, tool.execution_start, etc.)
    if (event.ephemeral) return;

    // assistant.message — capture the last non-ephemeral one as finalMessage
    if (event.type === "assistant.message" && event.data && typeof event.data.content === "string") {
      lastAssistantMessage = event.data.content;
    }

    // result — carries sessionId and usage
    if (event.type === "result") {
      if (event.sessionId) sessionId = event.sessionId;
    }

    // tool.execution_complete with success:false and error.code:"denied" — the
    // headless auto-deny trap. copilot exits 0 but the run is a failure.
    // Copilot wraps the outcome in `data` (event.data.success, event.data.error).
    if (event.type === "tool.execution_complete" && event.data?.success === false) {
      if (event.data.error && event.data.error.code === "denied") {
        denied = true;
        denialMessage = event.data.error.message || "Permission denied";
      }
    }
  });

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = lastAssistantMessage;
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const watchdogTimer = setTimeout(() => {
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

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const exitCode = 128 + (constants.signals[sig] || 15);
      let finalized = false;
      const finishAbort = () => {
        if (finalized) return;
        finalized = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
        killChild(child, "SIGKILL");
        const result = writeResult({
          status: "aborted",
          exitCode,
          signal: sig,
          sessionId,
          finalMessage: assembleFinal(),
          touchedFiles: gitTouchedFiles(opts.cd),
          stderrTail: stderrTail.slice(-20),
          error: `the relay was killed by ${sig}; copilot was terminated with it — inspect the working tree before re-dispatching`,
        });
        printSummary(result, run.resultPath);
        process.exit(exitCode);
      };
      child.once("exit", finishAbort);
      killChild(child);
      sigkillTimer = setTimeout(finishAbort, 2000);
    });
  }
  onReady();

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    if (watchdogFired) killChild(child, "SIGKILL");
    // Force a delimiter so a final event without a trailing newline still parses.
    scan(`${stdoutDecoder.end()}\n`);
    const stderrEnd = stderrDecoder.end();
    if (stderrEnd.trim()) stderrTail.push(stderrEnd.trimEnd());
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    // Denial trap: copilot exits 0 even when tool calls are denied headlessly.
    // The relay catches the denial event and reports failed.
    const deniedRun = denied && !watchdogFired;
    const succeeded = code === 0 && !watchdogFired && !deniedRun;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const denialError = deniedRun
      ? `copilot auto-denied a tool call in headless mode: ${denialMessage}. Pass --allow-all-tools to grant full tool permissions`
      : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      finalMessage,
      touchedFiles,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired
        ? {
            error: `copilot did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`,
          }
        : {}),
      ...(denialError ? { error: denialError } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const run = prepareRunDir(opts, brief);
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = copilotVersion(timeoutMs);
  // execFileSync defers JS signal handlers; yield once so a signal received
  // during the bounded preflight becomes "aborted" before any dispatch.
  await new Promise((resolve) => setImmediate(resolve));
  writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    return reportUnavailable(opts, writeResult, run.resultPath);
  }
  if (probe.error) {
    clearPreflightSignals();
    return reportVersionFailure(opts, writeResult, run, probe.error, timeoutMs);
  }
  dispatchToCopilot(opts, run, writeResult, clearPreflightSignals);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  copilot ${result.copilotVersion ?? "?"}`,
  );
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a copilot error; check host memory and re-dispatch, or split the task into smaller briefs.",
    );
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(
      "hint: something outside the relay terminated copilot; relay watchdogs and relay signals report timeout or aborted instead.",
    );
  }
  if (result.readOnly) lines.push("mode: plan (read-only)");
  if (result.allowAllTools) lines.push("autonomy: --allow-all-tools");
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- copilot final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push(
    "relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
