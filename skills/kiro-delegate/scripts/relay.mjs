#!/usr/bin/env node
/** Dispatch one bounded brief to Kiro CLI without committing or leaking credentials. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const DEFAULT_TRUST_TOOLS = "fs_read,grep,glob,code";
const KIRO_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const KIRO_MODE = new Set(["default", "spec"]);
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_BRIEF_BYTES = 24 * 1024;
const MAX_FINAL_MESSAGE_CHARS = 64 * 1024;
const GRACE_MS = 2_000;
const SCHEMA = "delegate-relay.result.v1";
const IMPLEMENTER_KEY = "kiro";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SEARCH = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const REQUIRED_FLAGS = ["--no-interactive", "--trust-tools", "--resume-id", "--wrap", "--effort", "--v3", "--mode"];
const MANAGED = ["brief.txt", "final.txt", "stderr.txt", "result.json"];

function fail(message, code = 2) { process.stderr.write(`relay: ${message}\n`); process.exit(code); }

function help() { return `kiro-delegate relay\n\nUsage:\n  node relay.mjs --brief <file> [options]\n  type brief.txt | node relay.mjs [options]\n\nOptions:\n  --brief <file>                  Read brief from file instead of stdin\n  --cd <dir>                      Kiro working directory (default: current directory)\n  --lane <name>                   Fleet lane from delegate-setup config\n  --kiro-bin <path>               Kiro executable (default: kiro-cli)\n  --wsl                           Run Kiro through wsl.exe (Windows only)\n  --wsl-distro <name>             WSL distribution (requires --wsl; default: WSL default)\n  --agent <name>                  Kiro custom agent\n  --model <name>                  Kiro model\n  --effort <level>                Kiro effort: low, medium, high, xhigh, or max\n  --mode <mode>                   V3 agent mode: default or spec (V3 is always enabled)\n  --trust-tools <tools>           Comma-separated tools; default: ${DEFAULT_TRUST_TOOLS}\n  --trust-all-tools               Explicitly trust every Kiro tool\n  --inherit-env                   Pass the complete parent environment (unsafe)\n  --require-mcp-startup           Fail if an MCP server cannot start\n  --resume                        Resume the most recent session in --cd\n  --resume-id <uuid>              Resume a specific Kiro session\n  --timeout <h/m/s>               Relay watchdog (default: ${DEFAULT_TIMEOUT})\n  --out-dir <dir>                 Artifact directory (default: system temp)\n  -h, --help                      Show this help\n\nBriefs are limited to ${MAX_BRIEF_BYTES} UTF-8 bytes. The relay never runs git commit, git push, or creates a pull request.\n`; }

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds = BigInt(match[1] || 0) * 3600n + BigInt(match[2] || 0) * 60n + BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch { return null; }
}

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) fail("--lane requires the delegate-setup skill installed beside this relay");
  const r = spawnSync(process.execPath, [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY], { encoding: "utf8", env: process.env });
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  let resolved;
  try { const lines = (r.stdout || "").trim().split("\n").filter(Boolean); resolved = JSON.parse(lines[lines.length - 1]); } catch { fail("lane resolve returned invalid JSON"); }
  opts.laneSource = resolved.source;
  for (const [field, value] of Object.entries(resolved.dials || {})) if (!flagged.has(field)) opts[field] = value;
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = { lane: null, laneSource: null, brief: null, cd: process.cwd(), kiroBin: process.env.KIRO_CLI_BIN || "kiro-cli", wslBin: process.env.WSL_EXE_BIN || "wsl.exe", wsl: false, wslDistro: null, agent: null, model: null, effort: null, mode: null, trustTools: DEFAULT_TRUST_TOOLS, trustToolsExplicit: false, trustAllTools: false, inheritEnv: false, requireMcpStartup: false, resume: false, resumeId: null, timeout: DEFAULT_TIMEOUT, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const next = () => { if (argv[i + 1] === undefined) fail(`${arg} requires a value`); return argv[++i]; };
    if (arg === "-h" || arg === "--help") { process.stdout.write(help()); process.exit(0); }
    else if (arg === "--brief") opts.brief = next(); else if (arg === "--cd") opts.cd = resolve(next()); else if (arg === "--lane") opts.lane = next(); else if (arg === "--kiro-bin") opts.kiroBin = next();
    else if (arg === "--wsl") opts.wsl = true; else if (arg === "--wsl-distro") opts.wslDistro = next();
    else if (arg === "--agent") { opts.agent = next(); flagged.add("agent"); } else if (arg === "--model") { opts.model = next(); flagged.add("model"); }
    else if (arg === "--effort") { opts.effort = next(); flagged.add("effort"); } else if (arg === "--mode") { opts.mode = next(); flagged.add("mode"); }
    else if (arg === "--trust-tools") { opts.trustTools = next(); opts.trustToolsExplicit = true; flagged.add("trustTools"); } else if (arg.startsWith("--trust-tools=")) { opts.trustTools = arg.slice(14); opts.trustToolsExplicit = true; flagged.add("trustTools"); }
    else if (arg === "--trust-all-tools") { opts.trustAllTools = true; flagged.add("trustAllTools"); } else if (arg === "--inherit-env") opts.inheritEnv = true;
    else if (arg === "--require-mcp-startup") opts.requireMcpStartup = true; else if (arg === "--resume") opts.resume = true; else if (arg === "--resume-id") opts.resumeId = next(); else if (arg === "--timeout") { opts.timeout = next(); flagged.add("timeout"); } else if (arg === "--out-dir") opts.outDir = resolve(next()); else fail(`unknown option: ${arg}`);
  }
  applyFleetLane(opts, flagged);
  if (opts.resume && opts.resumeId) fail("--resume and --resume-id are mutually exclusive");
  if (parseDuration(opts.timeout) === null) fail(`--timeout "${opts.timeout}" is invalid or too long`);
  if (!existsSync(opts.cd)) fail(`working directory does not exist: ${opts.cd}`);
  if (opts.wsl && process.platform !== "win32") fail("--wsl is available only when the relay runs on Windows");
  if (opts.wslDistro && !opts.wsl) fail("--wsl-distro requires --wsl");
  if (opts.trustAllTools && opts.trustToolsExplicit) fail("--trust-all-tools cannot be combined with explicitly supplied --trust-tools");
  if (opts.effort && !KIRO_EFFORT.has(opts.effort)) fail(`--effort must be one of: ${[...KIRO_EFFORT].join(", ")}`);
  if (opts.mode && !KIRO_MODE.has(opts.mode)) fail(`--mode must be one of: ${[...KIRO_MODE].join(", ")}`);
  if (opts.resumeId && !UUID.test(opts.resumeId)) fail("--resume-id must be a complete Kiro session UUID");
  return opts;
}

function readBrief(opts) { if (opts.brief) { if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`); return readFileSync(opts.brief, "utf8"); } if (process.stdin.isTTY) fail("no --brief given and stdin is a TTY; pass --brief or pipe stdin"); return readFileSync(0, "utf8"); }

function killChild(child, force = false) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    // Windows child.kill can remove the root before the later escalation can
    // address its descendants. taskkill must fell the tree while the root PID exists.
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); } catch { /* The process tree already exited. */ }
    return;
  }
  try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* The process group already exited. */ } }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch { return null; }
}

function gitHead(cwd) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 10_000 }).trim() || null; } catch { return null; } }
function gitWorktree(cwd) { try { return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 10_000 }).trim() === "true"; } catch { return false; } }
function secretValues(env) { return Object.entries(env).filter(([key, value]) => value && (key === "KIRO_API_KEY" || /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|PRIVATE)/i.test(key))).map(([, value]) => value).filter((value) => value.length >= 4).sort((a, b) => b.length - a.length); }
function makeRedactor(env) { const values = [...new Set(secretValues(env))]; const maxSecretLength = values.reduce((max, value) => Math.max(max, value.length), 0); let replacements = 0; const redact = (input) => { let text = String(input ?? ""); for (const value of values) text = text.replaceAll(value, () => { replacements += 1; return "[REDACTED]"; }); return text; }; return { redact, maxSecretLength, metadata: () => ({ applied: values.length > 0, replacementCount: replacements }) }; }
function makeStderrStream(redactor) {
  // A secret split across two stderr chunks must still be redacted. Redact the
  // whole pending buffer (carryover + incoming decoded text) first, then emit
  // everything except the last maxSecretLength chars, keeping that redacted
  // tail as carryover so a partial secret that continues in the next chunk is
  // re-scanned as part of the full string.
  const hold = redactor.maxSecretLength;
  let carry = "";
  return {
    write(text) {
      const redactedPending = redactor.redact(carry + text);
      const splitAt = Math.max(0, redactedPending.length - hold);
      const safe = redactedPending.slice(0, splitAt);
      carry = redactedPending.slice(splitAt);
      return safe;
    },
    flush() {
      const out = carry;
      carry = "";
      return out;
    },
  };
}
function childEnvironment(opts) {
  const env = opts.inheritEnv ? { ...process.env } : {};
  if (!opts.inheritEnv) {
    const allow = /^(PATH|Path|PATHEXT|SystemRoot|TEMP|TMP|HOME|USERPROFILE|LANG|LC_[A-Z_]+|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|AWS_CA_BUNDLE|WSLENV|KIRO_API_KEY|KIRO_[A-Z0-9_]+)$/;
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && allow.test(key) && !(key !== "KIRO_API_KEY" && /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|PRIVATE)/i.test(key))) env[key] = value;
    }
  }
  env.PWD = opts.cd;
  env.KIRO_LOG_NO_COLOR = "1";
  if (opts.wsl) {
    const entries = (env.WSLENV || "").split(":").filter(Boolean);
    const forwarded = new Set(entries.map((entry) => entry.split("/")[0]));
    const pathVariables = new Set(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE"]);
    for (const key of Object.keys(env)) {
      const forward = key === "KIRO_API_KEY" || /^KIRO_[A-Z0-9_]+$/.test(key) || pathVariables.has(key);
      if (forward && !forwarded.has(key)) entries.push(pathVariables.has(key) ? `${key}/p` : key);
    }
    env.WSLENV = entries.join(":");
  }
  return env;
}
function prepareRun(opts, brief, redactor) { const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${new Date().toISOString().replace(/[:.]/g, "-")}`); mkdirSync(outDir, { recursive: true }); for (const name of MANAGED) rmSync(join(outDir, name), { force: true }); for (const name of readdirSync(outDir)) if (name.startsWith("result.json.")) rmSync(join(outDir, name), { force: true }); const run = { startedAt: new Date().toISOString(), outDir, briefPath: join(outDir, "brief.txt"), finalPath: join(outDir, "final.txt"), stderrPath: join(outDir, "stderr.txt"), resultPath: join(outDir, "result.json") }; writeFileSync(run.briefPath, redactor.redact(brief), "utf8"); writeFileSync(run.stderrPath, "", "utf8"); return run; }
function executable(binary, args) { return binary.toLowerCase().endsWith(".mjs") ? { file: process.execPath, args: [binary, ...args] } : { file: binary, args }; }
function command(opts, args) {
  if (!opts.wsl) return executable(opts.kiroBin, args);
  const wslArgs = [];
  if (opts.wslDistro) wslArgs.push("--distribution", opts.wslDistro);
  wslArgs.push("--cd", opts.cd, "--exec", opts.kiroBin, ...args);
  return executable(opts.wslBin, wslArgs);
}

function probe(opts, args, redactor, onChild = () => {}) {
  return new Promise((resolveProbe) => {
    const c = command(opts, args);
    let child;
    try {
      child = spawn(c.file, c.args, { cwd: opts.cd, env: childEnvironment(opts), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      onChild(child);
    } catch (error) {
      resolveProbe({ ok: false, missing: error?.code === "ENOENT", output: "", status: null, error: `exit_${error?.status ?? "unknown"}` });
      return;
    }
    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    let graceExpired = false;
    let pendingClose = null;
    let stdout = "";
    let stderr = "";
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const finishProbe = (closeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      onChild(null);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      const output = redactor.redact(stdout || stderr).trim().slice(0, 20_000);
      resolveProbe({ ...closeResult, output });
    };
    const finishAfterClose = (closeResult) => {
      if (timedOut && !graceExpired) pendingClose = closeResult;
      else finishProbe(closeResult);
    };
    const forceStop = () => {
      killChild(child, true);
      graceExpired = true;
      if (pendingClose) {
        const closeResult = pendingClose;
        pendingClose = null;
        finishProbe(closeResult);
      } else if (timedOut) {
        finishProbe({ ok: false, missing: false, status: null, error: "timeout" });
      }
    };
    const probeTimeout = Math.min(parseDuration(opts.timeout), VERSION_PROBE_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killChild(child);
      graceTimer = setTimeout(forceStop, GRACE_MS);
    }, probeTimeout);
    child.stdout.on("data", (chunk) => { stdout += outDecoder.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += errDecoder.write(chunk); });
    child.on("error", (error) => finishAfterClose({ ok: false, missing: error?.code === "ENOENT", status: null, error: `exit_${error?.status ?? "unknown"}` }));
    child.on("close", (code) => finishAfterClose(timedOut
      ? { ok: false, missing: false, status: null, error: "timeout" }
      : { ok: code === 0 && Boolean((stdout || stderr).trim()), missing: opts.wsl && code === 127, status: code, error: code === 0 ? null : `exit_${code ?? "unknown"}` }));
  });
}

async function preflight(opts, redactor, onChild) {
  const version = await probe(opts, ["--version"], redactor, onChild);
  if (version.missing) return { ok: false, missing: true, version, help: null };
  if (!version.ok) return { ok: false, missing: false, version, help: null };
  const helpResult = await probe(opts, ["chat", "--help"], redactor, onChild);
  const missingFlags = REQUIRED_FLAGS.filter((flag) => !helpResult.output.includes(flag));
  return { ok: helpResult.ok && missingFlags.length === 0, missing: false, version, help: { ...helpResult, missingFlags } };
}

function buildArgs(opts, brief) { const args = ["chat", "--no-interactive", "--wrap", "never", "--v3"]; if (opts.agent) args.push("--agent", opts.agent); if (opts.model) args.push("--model", opts.model); if (opts.effort) args.push("--effort", opts.effort); if (opts.mode) args.push("--mode", opts.mode); if (opts.trustAllTools) args.push("--trust-all-tools"); else args.push(`--trust-tools=${opts.trustTools}`); if (opts.requireMcpStartup) args.push("--require-mcp-startup"); if (opts.resume) args.push("--resume"); if (opts.resumeId) args.push("--resume-id", opts.resumeId); args.push(brief); return args; }
function extractSessionId(text) { const match = String(text).match(UUID_SEARCH); return match ? match[0] : null; }

function writeResult(run, opts, extra) { const result = { schema: SCHEMA, lane: opts.lane, laneSource: opts.laneSource, tool: IMPLEMENTER_KEY, workdir: opts.cd, kiroBin: opts.kiroBin, wsl: opts.wsl, wslDistro: opts.wslDistro, agentEngine: "v3", agent: opts.agent, model: opts.model, effort: opts.effort, mode: opts.mode, trustTools: opts.trustAllTools ? null : opts.trustTools.split(",").map((x) => x.trim()).filter(Boolean), trustAllTools: opts.trustAllTools, inheritEnv: opts.inheritEnv, requireMcpStartup: opts.requireMcpStartup, resumed: Boolean(opts.resume || opts.resumeId), resumeId: opts.resumeId, startedAt: run.startedAt, finishedAt: new Date().toISOString(), briefPath: run.briefPath, finalPath: existsSync(run.finalPath) ? run.finalPath : null, stderrPath: run.stderrPath, resultPath: run.resultPath, ...extra }; const temporary = `${run.resultPath}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8"); renameSync(temporary, run.resultPath); return result; }
function printSummary(result) { process.stdout.write(`relay: ${result.status} (exit ${result.exitCode})\nresult: ${result.resultPath}\n`); }

function installPreflightSignalHandlers(opts, run, base, redactor, getChild) {
  let active = true;
  const handlers = new Map();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  for (const signal of signals) {
    const handler = () => {
      if (!active) return;
      active = false;
      const child = getChild();
      if (child) killChild(child, true);
      const finalStatus = gitTouchedFiles(opts.cd);
      const finalHead = gitHead(opts.cd);
      const result = writeResult(run, opts, {
        ...base,
        status: "aborted",
        exitCode: 128 + (constants.signals[signal] || 15),
        signal,
        kiroVersion: null,
        preflight: null,
        touchedFiles: finalStatus,
        finalStatus,
        finalHead,
        headCheck: finalHead ? "known" : "unavailable",
        headChanged: base.baselineHead && finalHead ? base.baselineHead !== finalHead : null,
        errorCode: "aborted",
        error: `relay received ${signal} during Kiro CLI preflight; Kiro was not dispatched`,
        redaction: redactor.metadata(),
      });
      printSummary(result);
      process.exit(result.exitCode);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    active = false;
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

function dispatch(opts, brief, run, baseline, checks, redactor) {
  const c = command(opts, buildArgs(opts, brief));
  const child = spawn(c.file, c.args, { cwd: opts.cd, env: childEnvironment(opts), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdoutTail = "";
  let stdoutTruncated = false;
  let sessionSearchTail = "";
  let observedSessionId = null;
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let abortSignal = null;
  let graceTimer = null;
  let graceExpired = false;
  let pendingClose = null;
  const stderrTail = [];
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  const stdoutStream = makeStderrStream(redactor);
  const stderrStream = makeStderrStream(redactor);
  const recordStdout = (text) => {
    if (!text) return;
    const sessionText = `${sessionSearchTail}${text}`;
    observedSessionId ||= extractSessionId(sessionText);
    sessionSearchTail = sessionText.slice(-256);
    const redactedText = stdoutStream.write(text);
    if (!redactedText) return;
    appendFileSync(run.finalPath, redactedText, "utf8");
    const combined = stdoutTail + redactedText;
    if (combined.length > MAX_FINAL_MESSAGE_CHARS) stdoutTruncated = true;
    stdoutTail = combined.slice(-MAX_FINAL_MESSAGE_CHARS);
  };
  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    killChild(child);
    graceTimer = setTimeout(forceStop, GRACE_MS);
  }, parseDuration(opts.timeout));
  const finish = (status, exitCode, signal, error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    recordStdout(outDecoder.end());
    const stdoutRemainder = stdoutStream.flush();
    if (stdoutRemainder) {
      appendFileSync(run.finalPath, stdoutRemainder, "utf8");
      const combined = stdoutTail + stdoutRemainder;
      if (combined.length > MAX_FINAL_MESSAGE_CHARS) stdoutTruncated = true;
      stdoutTail = combined.slice(-MAX_FINAL_MESSAGE_CHARS);
    }
    const stderrRemainder = errDecoder.end();
    stderr += stderrRemainder;
    const redactedRemainder = stderrStream.write(stderrRemainder) + stderrStream.flush();
    if (redactedRemainder) {
      appendFileSync(run.stderrPath, redactedRemainder, "utf8");
      for (const line of redactedRemainder.split("\n")) if (line.trim()) {
        stderrTail.push(line.trimEnd());
        while (stderrTail.length > 20) stderrTail.shift();
      }
    }
    const final = stdoutTail.trim();
    const finalStatus = gitTouchedFiles(opts.cd);
    const head = gitHead(opts.cd);
    const headChanged = baseline.head && head ? baseline.head !== head : null;
    let effectiveStatus = status;
    let errorCode = error ? (status === "timeout" ? "timeout" : status === "aborted" ? "aborted" : "kiro_failed") : null;
    let errorMessage = error ? String(error) : null;
    if (!gitWorktree(opts.cd)) { effectiveStatus = "failed"; errorCode = "git_worktree_unavailable"; errorMessage = "Git worktree is unavailable"; }
    else if (!head) { effectiveStatus = "failed"; errorCode = "git_head_unavailable"; errorMessage = "Git HEAD could not be verified"; }
    else if (headChanged) { effectiveStatus = "failed"; errorCode = "head_changed"; errorMessage = "Git HEAD changed during the run; inspect the working tree"; }
    else if (finalStatus === null) { effectiveStatus = "failed"; errorCode = "git_status_unavailable"; errorMessage = "git status could not be reported"; }
    const result = writeResult(run, opts, {
      status: effectiveStatus,
      exitCode: effectiveStatus === "completed" ? 0 : (exitCode || 1),
      signal: signal || null,
      kiroVersion: checks.version.output,
      preflight: checks,
      sessionId: observedSessionId || extractSessionId(stderr) || opts.resumeId,
      finalMessage: final,
      finalMessageTruncated: stdoutTruncated,
      touchedFiles: finalStatus,
      baselineStatus: baseline.status,
      finalStatus,
      baselineHead: baseline.head,
      finalHead: head,
      headCheck: head ? "known" : "unavailable",
      headChanged,
      errorCode,
      stderrTail: redactor.redact(stderrTail.slice(-20).join("\n")),
      error: errorMessage ? redactor.redact(errorMessage) : null,
      redaction: redactor.metadata(),
    });
    printSummary(result);
    process.exit(result.exitCode);
  };
  const finishAfterClose = (closeResult) => {
    if ((timedOut || abortSignal) && !graceExpired) pendingClose = closeResult;
    else finish(...closeResult);
  };
  function forceStop() {
    killChild(child, true);
    graceExpired = true;
    if (pendingClose) {
      const closeResult = pendingClose;
      pendingClose = null;
      finish(...closeResult);
    } else if (timedOut) {
      finish("timeout", 124, null, `kiro-cli did not finish within --timeout ${opts.timeout}`);
    } else if (abortSignal) {
      finish("aborted", 128 + (constants.signals[abortSignal] || 15), abortSignal, `relay received ${abortSignal}`);
    }
  }
  child.stdout.on("data", (chunk) => { recordStdout(outDecoder.write(chunk)); });
  child.stderr.on("data", (chunk) => {
    const text = errDecoder.write(chunk);
    stderr += text;
    const redactedText = stderrStream.write(text);
    if (!redactedText) return;
    appendFileSync(run.stderrPath, redactedText, "utf8");
    for (const line of redactedText.split("\n")) if (line.trim()) {
      stderrTail.push(line.trimEnd());
      while (stderrTail.length > 20) stderrTail.shift();
    }
  });
  child.on("error", (error) => finishAfterClose([error?.code === "ENOENT" ? "kiro_unavailable" : "failed", error?.code === "ENOENT" ? 127 : 1, null, error?.message || error]));
  child.on("close", (code, signal) => {
    if (timedOut) finishAfterClose(["timeout", 124, signal, `kiro-cli did not finish within --timeout ${opts.timeout}`]);
    else if (abortSignal) finishAfterClose(["aborted", 128 + (constants.signals[abortSignal] || 15), abortSignal, `relay received ${abortSignal}`]);
    else finishAfterClose([code === 0 ? "completed" : "failed", code ?? 1, signal, code === 0 ? null : `kiro-cli exited with code ${code ?? "unknown"}`]);
  });
  const abortSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
  if (process.platform === "win32") abortSignals.push("SIGBREAK");
  for (const signal of abortSignals) process.on(signal, () => {
    if (!settled && !timedOut && !abortSignal) {
      abortSignal = signal;
      killChild(child);
      graceTimer = setTimeout(forceStop, GRACE_MS);
    }
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief");
  if (Buffer.byteLength(brief, "utf8") > MAX_BRIEF_BYTES) fail(`brief exceeds ${MAX_BRIEF_BYTES} bytes`);
  const redactor = makeRedactor(process.env);
  const run = prepareRun(opts, brief, redactor);
  const baseline = { status: gitTouchedFiles(opts.cd), head: gitHead(opts.cd), worktreeAvailable: gitWorktree(opts.cd) };
  const base = { baselineStatus: baseline.status, finalStatus: baseline.status, baselineHead: baseline.head, finalHead: baseline.head, headCheck: baseline.head ? "known" : "unavailable", headChanged: null, finalMessage: "", touchedFiles: baseline.status, sessionId: null, redaction: redactor.metadata() };
  if (!baseline.worktreeAvailable) { const result = writeResult(run, opts, { ...base, status: "failed", exitCode: 1, signal: null, kiroVersion: null, errorCode: "git_worktree_unavailable", error: "--cd must be a Git worktree" }); printSummary(result); process.exit(1); }
  if (!baseline.head) { const result = writeResult(run, opts, { ...base, status: "failed", exitCode: 1, signal: null, kiroVersion: null, errorCode: "git_head_unavailable", error: "Git HEAD could not be verified" }); printSummary(result); process.exit(1); }
  if (baseline.status === null) { const result = writeResult(run, opts, { ...base, status: "failed", exitCode: 1, signal: null, kiroVersion: null, errorCode: "git_status_unavailable", error: "Git status could not be verified" }); printSummary(result); process.exit(1); }
  let preflightChild = null;
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, base, redactor, () => preflightChild);
  const checks = await preflight(opts, redactor, (child) => { preflightChild = child; });
  clearPreflightSignals();
  if (checks.missing) { const result = writeResult(run, opts, { ...base, status: "kiro_unavailable", exitCode: 127, signal: null, kiroVersion: null, errorCode: "kiro_unavailable", preflight: checks, error: `${opts.kiroBin} was not found` }); printSummary(result); process.exit(127); }
  if (!checks.ok) {
    const probeTimedOut = checks.version.error === "timeout" || checks.help?.error === "timeout";
    const probeOutput = checks.help?.output || checks.version.output || "";
    const result = writeResult(run, opts, {
      ...base,
      status: probeTimedOut ? "timeout" : "failed",
      exitCode: probeTimedOut ? 124 : 1,
      signal: null,
      kiroVersion: checks.version.output || null,
      errorCode: "kiro_preflight_failed",
      preflight: checks,
      stderrTail: probeOutput.split("\n").slice(-20).join("\n"),
      error: "Kiro CLI preflight failed; Kiro was not dispatched",
    });
    printSummary(result);
    process.exit(probeTimedOut ? 124 : 1);
  }
  dispatch(opts, brief, run, baseline, checks, redactor);
}

main().catch((error) => fail(error?.message || String(error), 1));
