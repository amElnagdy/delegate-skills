#!/usr/bin/env node
/**
 * delegate-skills · cline-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cline coding agent CLI (`cline --json -v`),
 * capture the JSON event stream, and write a structured result the orchestrating
 * agent can review. The orchestrator runs this one command and reads the result
 * JSON — every cline-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cline` and `git` (plus `where.exe` / `taskkill`
 * on Windows) — and to `node` for the delegate-setup lane resolver when `--lane`
 * is used. The `cline` process it launches does authenticate — exactly as you do
 * at the terminal. Read this file before you run it.
 *
 * The brief is streamed to cline on stdin. Current Cline JSON mode checks for
 * a positional prompt before it reads piped input, so the relay passes a fixed
 * positional instruction and keeps the full brief out of argv.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: the relay explicitly sets Cline's `--auto-approve` (true in act
 * mode, false with `--plan`). Plan mode can request a switch to act mode, so
 * `--plan --auto-approve true` is rejected to preserve the read-only gate.
 * Cline also supports sandbox through `--data-dir` / `CLINE_SANDBOX`; this
 * relay does not configure it. The diff reported in `touchedFiles` records
 * what changed.
 *
 * On native Windows `cline` is an npm-installed `.cmd` shim this relay launches
 * with shell:true. Provider and model values therefore accept only shell-safe
 * tokens; the working directory is the child process cwd and the brief stays
 * on stdin.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for cline (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --provider <name>       cline provider id (default: cline's own default).
 *   --model <id>            cline model id (default: cline's own default).
 *                           Letters, digits, and . _ : / - only.
 *   --plan                  Read-only plan mode; forces --auto-approve false.
 *   --auto-approve <bool>   Cline tool auto-approval (default: true in act mode,
 *                           false with --plan). True conflicts with --plan.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, clineVersion, sessionId, finalMessage (cline's own
 *   report, from run_result.text), requested/actual provider and model, usage,
 *   finishReason, touchedFiles (git porcelain, null if git cannot report),
 *   planMode, autoApprove, briefPath, nullable finalPath, eventsPath, and
 *   stderrPath. sessionId is nullable because fresh JSON runs omit it.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cline` binary exits 127;
 * otherwise the exit code mirrors cline's own (0 success, non-zero failure),
 * except a run_result whose finishReason is not "completed" exits 1 even if
 * cline exits 0. If the child dies on a signal, the exit code is 128 plus the
 * signal number and `result.json` records the signal. Once the brief validates,
 * `result.json` is written on every outcome — completed, failed, timeout (the
 * --timeout watchdog fired, or the bounded --version preflight hung), aborted
 * (the relay itself was killed and forwarded the kill to cline), or
 * cline_unavailable.
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

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const MAX_BUFFERED_CHARS = 1_048_576;
const VERSION_TIMEOUT_MS = 10_000;
const STDIN_PROMPT = "Follow the task instructions provided on stdin.";
// --model and --provider values reach a shell on win32 (shell:true for the .cmd
// shim), so they are restricted to safe tokens.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const IMPLEMENTER_KEY = "cline";

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
    if (field === "readOnly" && flagged.has("readOnly")) continue;
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
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

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    provider: null,
    model: null,
    plan: false,
    autoApprove: null,
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
      case "--provider": opts.provider = next(); flagged.add("provider"); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--plan": opts.plan = true; break;
      case "--auto-approve": {
        const value = next();
        if (value !== "true" && value !== "false") fail("--auto-approve must be true or false");
        opts.autoApprove = value === "true";
        break;
      }
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.plan && opts.autoApprove === true) {
    fail("--plan conflicts with --auto-approve true; plan mode requires auto-approve false to prevent a switch to act mode");
  }
  if (opts.autoApprove === null) opts.autoApprove = !opts.plan;
  for (const flag of ["model", "provider"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a positive schedulable duration; use h/m/s strings like 30m, 90s, or 1h30m (maximum ~24.8 days)`);
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) {
    fail(`working directory not found: ${opts.cd}`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to cline --json -v\n";
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
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
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

async function clineVersion(timeoutMs, onChild) {
  const limit = Math.min(timeoutMs, VERSION_TIMEOUT_MS);
  const runProbe = (command, argv, options = {}) => new Promise((resolveProbe) => {
    const child = spawn(command, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...options,
    });
    onChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ stdout, stderr, ...result });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, error, timedOut: false }));
    child.on("close", (code) => finish({ code, error: null, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    }, limit);
  });

  // shell:true resolves cline.cmd, but a missing command is only an exit 1 from
  // cmd.exe. Ask the in-box where.exe first so absence stays cline_unavailable.
  if (process.platform === "win32") {
    const wherePath = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "where.exe");
    const found = await runProbe(wherePath, ["cline"]);
    if (found.timedOut) {
      return { version: null, error: Object.assign(new Error("where.exe cline timed out"), { code: "ETIMEDOUT", stderr: found.stderr }) };
    }
    if (found.error && found.error.code !== "ENOENT") return { version: null, error: found.error };
    if (!found.error && found.code !== 0) return { version: null, error: null };
  }

  const probe = process.platform === "win32"
    ? await runProbe("cline --version", [], { shell: true, detached: false })
    : await runProbe("cline", ["--version"]);
  if (probe.timedOut) {
    return { version: null, error: Object.assign(new Error("cline --version timed out"), { code: "ETIMEDOUT", stderr: probe.stderr }) };
  }
  if (probe.error && probe.error.code === "ENOENT") return { version: null, error: null };
  if (probe.error) return { version: null, error: probe.error };
  if (probe.code !== 0) {
    return { version: null, error: Object.assign(new Error("cline --version failed"), { status: probe.code, stderr: probe.stderr }) };
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts) {
  // Current Cline JSON mode checks for a positional prompt before reading
  // piped input. Keep that positional fixed and stream the user brief on stdin.
  const argv = ["--json", "-v", "--auto-approve", String(opts.autoApprove)];
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.plan) argv.push("--plan");
  argv.push(process.platform === "win32" ? `"${STDIN_PROMPT}"` : STDIN_PROMPT);
  return argv;
}

function makeEventScanner(onObject) {
  let buf = "";
  let index = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    for (;;) {
      while (index < buf.length) {
        const ch = buf[index];
        // Only track strings inside an object (depth > 0). At depth 0 we are
        // skipping a junk prefix, and an unmatched `"` there must not swallow the
        // real `{...}` that follows in the same chunk.
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          if (depth > 0) inString = true;
        } else if (ch === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (ch === "}") {
          if (depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
              const slice = buf.slice(start, index + 1);
              try { onObject(JSON.parse(slice)); } catch { /* skip malformed */ }
              start = -1;
            }
          }
        }
        index += 1;
      }
      if (depth === 0 || start === -1 || buf.length - start <= MAX_BUFFERED_CHARS) break;
      // A complete object may exceed the retained-input cap within this chunk.
      // Drop only an oversized partial, then rescan its suffix so a later
      // concatenated event is not lost.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      start = -1;
      depth = 0;
      inString = false;
      escaped = false;
    }
    if (depth > 0 && start !== -1) {
      if (start > 0) {
        buf = buf.slice(start);
        index -= start;
        start = 0;
      }
    } else {
      buf = "";
      index = 0;
      start = -1;
    }
  };
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not leak a previous run's artifacts into this one.
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
      tool: "cline",
      workdir: opts.cd,
      provider: opts.provider,
      model: opts.model,
      planMode: opts.plan,
      autoApprove: opts.autoApprove,
      clineVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    // Atomic write: a polling orchestrator never reads a half-written result.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "cline_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    actualProvider: null,
    actualModel: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `cline` not found on PATH. Install or add it to PATH, then re-dispatch.\n");
  process.exit(127);
}

function reportVersionFailure(writeResult, run, error, timeoutMs) {
  const timedOut = error && error.code === "ETIMEDOUT";
  const stderr = String((error && error.stderr) || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `cline --version preflight timed out after ${Math.min(timeoutMs, VERSION_TIMEOUT_MS)}ms; cline was not dispatched`
    : `cline --version preflight failed${Number.isInteger(error && error.status) ? ` with exit ${error.status}` : ""}; cline was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error && error.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    actualProvider: null,
    actualModel: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
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
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId: null,
        actualProvider: null,
        actualModel: null,
        usage: null,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the cline version preflight; cline was not dispatched`,
      });
      printSummary(result, run.resultPath);
      const child = getChild();
      if (child) killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
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

function dispatchToCline(opts, brief, run, writeResult) {
  const child = spawn("cline", buildArgv(opts), {
    cwd: opts.cd,
    stdio: ["pipe", "pipe", "pipe"],
    // shell:true on win32 so the cline.cmd shim resolves. Safe on both
    // platforms the same way codex-delegate's launch is: argv holds only fixed
    // values plus token-validated --provider/--model values. The brief is
    // stdin and cwd is a spawn option, so neither reaches cmd.exe.
    shell: process.platform === "win32",
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let sessionId = null;
  let actualProvider = null;
  let actualModel = null;
  let usage = null;
  let finishReason = null;
  let durationMs = null;
  let resultText = null;
  const stderrTail = [];
  const scan = makeEventScanner((event) => {
    // run_start (verbose-only): requested model/provider (a sessionId is set
    // when cline surfaces one; some builds only emit provider/model)
    if (event.type === "run_start") {
      if (event.sessionId) sessionId = event.sessionId;
      if (typeof event.modelId === "string" || typeof event.model === "string") actualModel = event.modelId || event.model;
      if (typeof event.providerId === "string" || typeof event.provider === "string") actualProvider = event.providerId || event.provider;
    }
    // run_result: the final event; finishReason "completed" is success
    if (event.type === "run_result") {
      if (typeof event.finishReason === "string") finishReason = event.finishReason;
      if (typeof event.text === "string") resultText = event.text;
      if (event.usage && typeof event.usage === "object") usage = event.usage;
      if (typeof event.model === "string") actualModel = event.model;
      if (event.model && typeof event.model === "object" && typeof event.model.id === "string") actualModel = event.model.id;
      if (typeof event.durationMs === "number") durationMs = event.durationMs;
    }
    // run_aborted / run_abort_requested: the run stopped early
    if (event.type === "run_aborted" || event.type === "run_abort_requested") {
      finishReason = "aborted";
    }
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

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

  // A fast-exiting cline (usage error, crashed startup) closes the pipe before
  // the write; swallow EPIPE here — the exit code reports the failure.
  child.stdin.on("error", () => {});
  child.stdin.end(brief);

  const assembleFinal = () => {
    const message = resultText ?? "";
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

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the cline child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        actualProvider,
        actualModel,
        usage,
        finishReason,
        durationMs,
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; cline was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      actualProvider,
      actualModel,
      usage,
      finishReason,
      durationMs,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
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
    // A timed-out run is failed even if cline handles SIGTERM by exiting 0 —
    // orchestrators key off status and the relay exit code.
    const assistantFailed = finishReason !== null && finishReason !== "completed";
    const succeeded = code === 0 && !watchdogFired && finishReason === "completed";
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      actualProvider,
      actualModel,
      usage,
      finishReason,
      durationMs,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `cline did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
      ...(!watchdogFired && assistantFailed ? { error: `cline ended with finishReason "${finishReason}"` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const run = prepareRunDir(opts, brief);
  let writeResult = makeResultWriter(opts, null, run);
  let preflightChild = null;
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult, () => preflightChild);
  const probe = await clineVersion(timeoutMs, (child) => { preflightChild = child; });
  writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (!probe.version) {
    clearPreflightSignals();
    reportVersionFailure(writeResult, run, probe.error, timeoutMs);
    return;
  }
  clearPreflightSignals();
  dispatchToCline(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  cline ${result.clineVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a cline error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated cline (a supervisor, the session ending, or a manual kill) — when the relay itself kills it, reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.planMode) lines.push("mode: plan-only (analysis, no edits)");
  if (result.actualModel) lines.push(`model: ${result.actualModel}${result.actualProvider ? ` (provider: ${result.actualProvider})` : ""}`);
  if (result.sessionId) lines.push(`session id: ${result.sessionId}`);
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
  lines.push("--- cline final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const detail = error && error.stack ? error.stack : String(error);
  process.stderr.write(`relay: unexpected internal error: ${detail}\n`);
  process.exit(2);
});
