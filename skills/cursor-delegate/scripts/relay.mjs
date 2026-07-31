#!/usr/bin/env node
/**
 * delegate-skills · cursor-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cursor Agent CLI (`cursor-agent -p`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Cursor-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against cursor-agent 2026.07.23 on Windows.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cursor-agent` and `git` (plus taskkill on
 * Windows for process-tree termination). The `cursor-agent` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * The brief is fed on the child's stdin, never argv, so it is not visible in
 * the host process list and has no OS argument-size cap.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: a fresh run defaults to write-capable with `--force` (Cursor runs
 * commands without approval unless your Cursor config denies them). Pass
 * `--read-only` to run in Cursor's plan mode (read-only/planning, no edits)
 * instead. The relay always passes `--trust` so a headless run never stalls
 * on the workspace-trust prompt — point --cd only at repositories you trust.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Cursor (default: current directory).
 *   --route <name>          Named delegate-config task route.
 *   --model <name>          Cursor model (default: your Cursor default, usually
 *                           auto). List names with `cursor-agent models`.
 *   --read-only             Run in Cursor's plan mode: read-only analysis, no
 *                           edits, no --force.
 *   --sandbox <mode>        Cursor sandbox: enabled | disabled.
 *   --no-force              Withhold --force on a write-capable run; commands
 *                           that require approval are refused instead of run.
 *   --session <id>          Resume a specific Cursor chat (`--resume <id>`);
 *                           send only the delta brief.
 *   --resume-last           Resume the most recent Cursor chat (`--continue`);
 *                           send only the delta brief.
 *   --add-dir <dir>         Add an extra workspace root. Repeatable; requires
 *                           cursor-agent 2026.07.23 or newer.
 *   --timeout <dur>         Relay-side watchdog (default: 30m; h/m/s strings
 *                           like 90s, 45m, 2h). cursor-agent has no timeout flag.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, cursorAgentVersion, sessionId, resolvedModel,
 *   permissionMode, force, usage, finalMessage (Cursor's own report),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cursor-agent` binary
 * exits 127 and writes status `cursor_agent_unavailable`; otherwise the exit
 * code mirrors cursor-agent's own (0 success, non-zero failure). If the child
 * dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout
 * watchdog fired), aborted (the relay itself was killed and forwarded the kill
 * to cursor-agent), or cursor_agent_unavailable.
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { constants, tmpdir, homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\],=-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SANDBOX_MODES = new Set(["enabled", "disabled"]);
const CONFIG_FIELDS = new Set(["model", "sandbox", "force", "timeout", "readOnly"]);
const BOOLEAN_CONFIG_FIELDS = new Set(["force", "readOnly"]);

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    route: null,
    model: null,
    readOnly: null,
    force: null,
    sandbox: null,
    session: null,
    resumeLast: false,
    addDirs: [],
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
      case "--route": opts.route = next(); break;
      case "--model": opts.model = next(); break;
      case "--read-only": opts.readOnly = true; break;
      case "--sandbox": opts.sandbox = next(); break;
      case "--no-force": opts.force = false; break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  const modelFromFlag = opts.model !== null;
  const delegateConfig = loadDelegateConfig(opts.cd, opts.route);
  const config = delegateConfig.values;
  if (opts.model === null && config.model !== undefined) opts.model = config.model;
  if (opts.timeout === null && config.timeout !== undefined) opts.timeout = config.timeout;
  if (opts.sandbox === null && config.sandbox !== undefined) opts.sandbox = config.sandbox;
  if (opts.force === null && config.force !== undefined) opts.force = config.force;
  if (opts.readOnly === null && config.readOnly !== undefined) opts.readOnly = config.readOnly;
  if (opts.force === null) opts.force = true;
  if (opts.readOnly === null) opts.readOnly = false;
  if (opts.timeout === null) opts.timeout = DEFAULT_TIMEOUT;
  opts.modelSource = modelFromFlag ? "flag" : delegateConfig.modelSource;
  if (typeof opts.force !== "boolean") {
    fail("delegate config cursor-agent.force must be a boolean");
  }
  if (typeof opts.readOnly !== "boolean") {
    fail("delegate config cursor-agent.readOnly must be a boolean");
  }
  if (opts.sandbox !== null && !SANDBOX_MODES.has(opts.sandbox)) {
    fail(`invalid sandbox "${opts.sandbox}" (expected: enabled, disabled)`);
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.model !== null && (typeof opts.model !== "string" || !SAFE_MODEL.test(opts.model))) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ / [ ] , = -)");
  }
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session contains unsupported characters (allowed: letters, digits, . _ : -)");
  }
  // cursor-agent resolves a relative --add-dir against ITS cwd, so resolve
  // against --cd (not the relay's own cwd) — and only after the loop, since
  // --add-dir may appear before --cd on the command line. resolve() passes
  // absolutes through.
  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  if (process.platform === "win32" && opts.addDirs.some((dir) => /[\0\r\n"%!]/.test(dir))) {
    fail("--add-dir cannot contain %, !, a quote, or a newline when cursor-agent launches through cmd.exe");
  }
  // The watchdog is relay-only (cursor-agent has no timeout flag), so a
  // malformed --timeout must fail loudly here — a silent 30m fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to cursor-agent -p\n";
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

function killChild(child, signal = "SIGTERM") {
  // The kill must reach the whole process family, not just the immediate child — a tool
  // subprocess left running would keep editing after the relay reports timeout/aborted.
  // On Windows the child is the cursor-agent.cmd shim (the shell:true launch below), Windows
  // has no process-group signals, and Node can't kill a process family without a Job Object,
  // so kill the tree by pid with the OS tool (/t includes descendants, /f forces it — the
  // tree-kill/npm idiom).
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return; // the first taskkill /f already felled the whole tree
    // stderr is inherited so a real taskkill failure (e.g. access denied) is visible to the operator;
    // its non-zero exit when the tree is already gone is the expected race and carries nothing to do.
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch { /* already gone — nothing left to kill */ }
  } else {
    // On POSIX the child leads its own process group (the detached launch), so the negative-pid
    // signal reaches every descendant; fall back to the lone pid if the group is already gone.
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  }
}

function cursorAgentVersion(timeoutMs) {
  try {
    // On Windows, cursor-agent installs as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs a shell there or it
    // ENOENTs on a working install. A pre-joined string (not shell:true + args)
    // avoids Node's DEP0190 warning. POSIX is unaffected. (git installs a real
    // git.exe and must NOT go through a shell — see gitTouchedFiles.)
    const options = {
      encoding: "utf8",
      timeout: Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS),
      killSignal: "SIGKILL",
    };
    const out = process.platform === "win32"
      ? execSync("cursor-agent --version", options).trim()
      : execFileSync("cursor-agent", ["--version"], options).trim();
    return { version: out || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    if (process.platform === "win32" &&
        /not recognized as an internal or external command/i.test(String(error?.stderr || ""))) {
      return { version: null, error: null };
    }
    return { version: null, error };
  }
}

function parseDuration(duration) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute.
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

function gitTouchedFiles(cwd) {
  // null (not []) when git cannot report — git missing, or a non-repo run — so
  // the caller can tell "git unavailable" apart from "Cursor changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function winq(value) {
  // shell:true on win32 (needed for the cursor-agent.cmd shim) doesn't quote
  // args, so a path with spaces (C:\Users\First Last\...) would split, and a
  // parameterized model ("opus[context=1m,effort=high]") would be re-tokenized
  // by the shim's PowerShell hop. Quote the spaceable/parameterized values on
  // Windows only — on POSIX the quotes would become literal characters.
  return process.platform === "win32" ? `"${value}"` : value;
}

function buildArgv(opts) {
  const argv = ["--print", "--output-format", "stream-json", "--trust"];
  if (opts.readOnly) argv.push("--mode", "plan");
  else if (opts.force) argv.push("--force");
  if (opts.sandbox) argv.push("--sandbox", opts.sandbox);
  if (opts.model) argv.push("--model", winq(opts.model));
  if (opts.session) argv.push("--resume", winq(opts.session));
  else if (opts.resumeLast) argv.push("--continue");
  for (const dir of opts.addDirs) argv.push("--add-dir", winq(dir));
  return argv;
}

function makeEventScanner(onObject) {
  // stream-json is newline-delimited JSON, but this brace-aware scan also
  // tolerates junk prefixes and concatenated objects if the format drifts.
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    buf += chunk;
    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { if (depth > 0) inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            const slice = buf.slice(start, i + 1);
            try { onObject(JSON.parse(slice)); } catch { /* ignore non-objects */ }
            start = -1;
          }
        }
      }
    }
    buf = depth > 0 && start !== -1 ? buf.slice(start) : "";
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
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
      tool: "cursor-agent",
      workdir: opts.cd,
      model: opts.model,
      modelSource: opts.modelSource,
      route: opts.route,
      timeout: opts.timeout,
      readOnly: opts.readOnly,
      force: opts.force && !opts.readOnly,
      sandbox: opts.sandbox,
      resumed: Boolean(opts.resumeLast || opts.session),
      cursorAgentVersion: version,
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

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "cursor_agent_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    resolvedModel: null,
    permissionMode: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `cursor-agent` not found on PATH. Install the Cursor CLI (https://cursor.com/cli) and run `cursor-agent login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `cursor-agent --version preflight timed out after ${Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS)}ms; Cursor was not dispatched`
    : `cursor-agent --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Cursor was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    resolvedModel: null,
    permissionMode: null,
    usage: null,
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
        sessionId: null,
        resolvedModel: null,
        permissionMode: null,
        usage: null,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the cursor-agent version preflight; Cursor was not dispatched`,
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

function dispatchToCursor(opts, brief, run, writeResult) {
  // A shell launch on Windows so the cursor-agent.cmd shim resolves (see
  // cursorAgentVersion) — as a pre-joined string, which sidesteps Node's
  // DEP0190 warning about shell:true with an args array. Safe: the brief is
  // fed via child.stdin below — never argv — and argv holds only fixed flags
  // plus the win32-quoted model and directory values. detached on POSIX: the
  // child leads a new process group so killChild can fell the whole tree.
  const argv = buildArgv(opts);
  const child = process.platform === "win32"
    ? spawn(["cursor-agent", ...argv].join(" "), { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], shell: true })
    : spawn("cursor-agent", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], detached: true });

  let sessionId = null;
  let resolvedModel = null;
  let permissionMode = null;
  let usage = null;
  let resultMessage = null;
  let resultIsError = false;
  const textChunks = [];
  const stderrTail = [];
  const scan = makeEventScanner((event) => {
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") resolvedModel = event.model;
      if (typeof event.permissionMode === "string") permissionMode = event.permissionMode;
    }
    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      for (const part of event.message.content) {
        if (part && part.type === "text" && typeof part.text === "string") textChunks.push(part.text);
      }
    }
    if (event.type === "result") {
      if (typeof event.result === "string") resultMessage = event.result;
      if (event.is_error === true) resultIsError = true;
      if (event.usage && typeof event.usage === "object") usage = event.usage;
    }
  });

  // The brief rides stdin: no process-list exposure, no OS argv-size cap.
  child.stdin.on("error", () => { /* child exited before reading the brief; its exit code tells the story */ });
  child.stdin.write(brief);
  child.stdin.end();

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

  const assembleFinal = () => {
    // Prefer the result event's own report; fall back to the assistant text
    // stream when the run died before emitting one.
    const message = resultMessage && resultMessage.trim() ? resultMessage : textChunks.join("\n\n");
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

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the cursor-agent child running or dying mid-edit with
  // nothing recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const touched = gitTouchedFiles(opts.cd);
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        resolvedModel,
        permissionMode,
        usage,
        finalMessage: assembleFinal(),
        touchedFiles: touched,
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; cursor-agent was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        const late = gitTouchedFiles(opts.cd);
        writeResult({ ...abortedFields, touchedFiles: late });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      resolvedModel,
      permissionMode,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: touched,
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    // A timed-out run is failed even if cursor-agent handles SIGTERM by exiting 0 —
    // orchestrators key off status and the relay exit code. A result event with
    // is_error true is failed even on exit 0.
    const succeeded = code === 0 && !watchdogFired && !resultIsError;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      resolvedModel,
      permissionMode,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: touched,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `cursor-agent did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
      ...(resultIsError && !watchdogFired ? { error: "cursor-agent reported an error result (is_error: true in its result event)" } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

/** Find the nearest Git repository root, or retain cwd outside a repository. */
function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function readDelegateConfig(configPath) {
  if (!existsSync(configPath)) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`invalid delegate config ${configPath}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(`invalid delegate config ${configPath}: expected a JSON object`);
  }
  if (!["delegate-config.v1", "delegate-config.v2"].includes(document.version)) {
    fail(`invalid delegate config ${configPath}: unsupported version "${document.version}"`);
  }
  return document;
}

function configLayers(document, route, configPath) {
  const entry = document?.implementers?.["cursor-agent"];
  if (entry === undefined) return [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`invalid delegate config ${configPath}: implementers.cursor-agent must be an object`);
  }
  if (document.version === "delegate-config.v1") return [{ values: entry, label: "defaults" }];
  for (const field of Object.keys(entry)) {
    if (!["defaults", "routes"].includes(field)) {
      fail(`invalid delegate config ${configPath}: unsupported cursor-agent section "${field}"`);
    }
  }
  if (entry.routes !== undefined && (!entry.routes || typeof entry.routes !== "object" || Array.isArray(entry.routes))) {
    fail(`invalid delegate config ${configPath}: cursor-agent.routes must be an object`);
  }
  const layers = [];
  if (entry.defaults !== undefined) layers.push({ values: entry.defaults, label: "defaults" });
  if (route && entry.routes?.[route] !== undefined) {
    layers.push({ values: entry.routes[route], label: `route:${route}` });
  }
  return layers;
}

function loadDelegateConfig(cwd, route) {
  if (route !== null && !SAFE_ROUTE.test(route)) {
    fail("--route contains unsupported characters (allowed: letters, digits, . _ -)");
  }
  const candidates = [
    { scope: "global", path: join(homedir(), ".config", "delegate-skills", "config.json") },
    { scope: "project", path: join(findProjectRoot(cwd), ".delegate", "config.json") },
  ];
  const resolved = {};
  let modelSource = "default";
  let routeFound = route === null;
  for (const candidate of candidates) {
    const document = readDelegateConfig(candidate.path);
    if (!document) continue;
    for (const layer of configLayers(document, route, candidate.path)) {
      if (!layer.values || typeof layer.values !== "object" || Array.isArray(layer.values)) {
        fail(`invalid delegate config ${candidate.path}: ${layer.label} must be an object`);
      }
      if (layer.label.startsWith("route:")) routeFound = true;
      for (const [field, rawValue] of Object.entries(layer.values)) {
        if (!CONFIG_FIELDS.has(field)) {
          fail(`invalid delegate config ${candidate.path}: unsupported cursor-agent field "${field}"`);
        }
        const fieldValue = field === "timeout" && Number.isSafeInteger(rawValue) && rawValue > 0
          ? `${rawValue}s`
          : rawValue;
        const expectedType = BOOLEAN_CONFIG_FIELDS.has(field) ? "boolean" : "string";
        if (typeof fieldValue !== expectedType) {
          fail(`invalid delegate config ${candidate.path}: cursor-agent field "${field}" must be a ${expectedType}`);
        }
        resolved[field] = fieldValue;
        if (field === "model") modelSource = `${candidate.scope}:${layer.label}`;
      }
    }
  }
  if (!routeFound) fail(`delegate config route not found: ${route}`);
  return { values: resolved, modelSource };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const timeoutMs = parseDuration(opts.timeout);
  const run = prepareRunDir(opts, brief);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = cursorAgentVersion(timeoutMs);
  // Synchronous child-process calls defer JavaScript signal handlers. Yield once
  // so a signal received during the bounded probe becomes "aborted" before dispatch.
  await new Promise((resolve) => setImmediate(resolve));
  writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    clearPreflightSignals();
    reportVersionFailure(opts, writeResult, run, probe.error, timeoutMs);
    return;
  }
  clearPreflightSignals();
  dispatchToCursor(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  cursor-agent ${result.cursorAgentVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a cursor-agent error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated cursor-agent (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.readOnly) lines.push("mode: read-only (plan)");
  if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}${result.permissionMode ? `  ·  permission mode: ${result.permissionMode}` : ""}`);
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
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
  lines.push("--- cursor-agent final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
