#!/usr/bin/env node
/**
 * delegate-skills · gemini-delegate · relay.mjs
 *
 * Dispatch a brief to Google's Gemini CLI in documented headless mode, capture
 * bounded stream-json events, and write delegate-relay.result.v1 artifacts.
 * This file uses Node built-ins only, never commits, and makes no network or
 * credential calls of its own. Gemini performs its normal provider traffic.
 */

import { execFileSync, spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";

const IMPLEMENTER_KEY = "gemini";
const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_BRIEF_BYTES = process.platform === "win32" ? 12 * 1024 * 1024 : 120 * 1024 * 1024;
const MAX_EVENT_LINE = 2 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const MAX_STDERR = 128 * 1024;
const MAX_FINAL = 2 * 1024 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+,=\[\]-]*$/;
const APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseDuration(value) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const ms = (BigInt(m[1] || 0) * 3600n + BigInt(m[2] || 0) * 60n + BigInt(m[3] || 0)) * 1000n;
  return ms > 0n && ms <= BigInt(MAX_TIMER_MS) ? Number(ms) : null;
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    brief: null,
    cd: process.cwd(),
    lane: null,
    model: null,
    approvalMode: "auto_edit",
    sandbox: false,
    readOnly: false,
    skipTrust: false,
    resume: null,
    resumeLast: false,
    includeDirectories: [],
    timeout: DEFAULT_TIMEOUT,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) fail(`${arg} requires a value`);
      return argv[++i];
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = resolve(next()); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--approval-mode": opts.approvalMode = next(); flagged.add("approvalMode"); break;
      case "--sandbox": opts.sandbox = true; flagged.add("sandbox"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--skip-trust": opts.skipTrust = true; flagged.add("skipTrust"); break;
      case "--resume": opts.resume = next(); flagged.add("resume"); break;
      case "--resume-last": opts.resumeLast = true; flagged.add("resume"); break;
      case "--include-directory":
      case "--include-directories":
        opts.includeDirectories.push(next()); flagged.add("includeDirectories"); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (opts.resume && opts.resumeLast) fail("--resume and --resume-last are mutually exclusive");
  if (opts.model !== null && (!opts.model || !SAFE_TOKEN.test(opts.model))) {
    fail("--model must be a non-empty shell-safe token (letters, digits, . _ : / @ + , = [ ] -)");
  }
  if (opts.approvalMode !== undefined && !APPROVAL_MODES.has(opts.approvalMode)) {
    fail(`--approval-mode must be one of: ${[...APPROVAL_MODES].join(", ")}`);
  }
  if (opts.readOnly) opts.approvalMode = "plan";
  if (opts.resume && !/^(?:latest|[1-9]\d*)$/.test(opts.resume)) {
    fail("--resume must be latest or a positive session index");
  }
  for (const dir of opts.includeDirectories) {
    if (!dir || /[\u0000\r\n\"]/.test(dir)) fail("--include-directory contains an unsafe path");
    const full = resolve(opts.cd, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) fail(`include directory not found: ${dir}`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) fail(`working directory not found: ${opts.cd}`);
  return { opts, flagged };
}

function headerComment() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  return `${(match ? match[1] : "relay.mjs - dispatch a brief to gemini").replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  let text;
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    text = readFileSync(opts.brief, "utf8");
  } else {
    if (process.stdin.isTTY) fail("no --brief given and stdin is a TTY; pass --brief or pipe stdin");
    text = readFileSync(0, "utf8");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (!text.trim()) fail("brief is empty");
  if (bytes > MAX_BRIEF_BYTES) fail(`brief is too large (max ${MAX_BRIEF_BYTES} bytes)`);
  return text;
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function prepareRun(opts, brief) {
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    outDir,
    briefPath: join(outDir, "brief.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    finalPath: join(outDir, "final.txt"),
    resultPath: join(outDir, "result.json"),
    startedAt: new Date().toISOString(),
    events: 0,
    finalMessage: null,
    sessionId: null,
    model: null,
    usage: null,
    stopReason: null,
    eventError: null,
    sawResult: false,
    sawError: false,
    stdoutTail: "",
    stderrTail: "",
    child: null,
    killed: null,
    beforeTouched: gitTouchedFiles(opts.cd),
    beforeSnapshot: gitSnapshot(opts.cd),
  };
  rmSync(run.resultPath, { force: true });
  rmSync(run.finalPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function quoteWin(value) {
  return process.platform === "win32" ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) fail("--lane requires delegate-setup beside this skill");
  const r = spawnSync(process.execPath, [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY], { encoding: "utf8" });
  if (r.error || r.status !== 0) fail((r.stderr || r.error?.message || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    const resolved = JSON.parse(lines.at(-1));
    opts.laneSource = resolved.source ?? null;
    for (const [field, value] of Object.entries(resolved.dials || {})) {
      if (!flagged.has(field)) opts[field] = value;
    }
  } catch { fail("lane resolve returned invalid JSON"); }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch { return null; }
}

function gitSnapshot(cwd) {
  try {
    const status = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const unstaged = execFileSync("git", ["diff", "--no-ext-diff", "--binary"], {
      cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const staged = execFileSync("git", ["diff", "--cached", "--no-ext-diff", "--binary"], {
      cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hash = createHash("sha256").update(status).update("\0").update(unstaged).update("\0").update(staged);
    // `git diff` omits untracked files. Include bounded contents of status paths
    // so a pre-existing dirty path changed by a run is not silently reported clean.
    for (const line of status.split("\n").filter(Boolean)) {
      const raw = line.slice(3).replace(/^\"|\"$/g, "");
      const path = raw.includes(" -> ") ? raw.split(" -> ").at(-1) : raw;
      const full = join(cwd, path);
      try {
        const stat = statSync(full);
        hash.update(`\0${path}\0${stat.size}\0${stat.mtimeMs}`);
        if (stat.isFile() && stat.size <= 8 * 1024 * 1024) hash.update(readFileSync(full));
      } catch { hash.update(`\0${path}\0missing`); }
    }
    return hash.digest("hex");
  } catch { return null; }
}

function writeBounded(path, text, max) {
  const value = String(text || "");
  writeFileSync(path, value.length > max ? `${value.slice(-max)}\n[truncated]` : value, "utf8");
}

function writeResult(run, result) {
  const temp = `${run.resultPath}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(result, null, 2) + "\n", "utf8");
  renameSync(temp, run.resultPath);
}

function killTree(child, force = false) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    return;
  }
  try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
  catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
}

function makeObjectScanner(onObject) {
  let buffer = "";
  let start = -1;
  let depth = 0;
  let string = false;
  let escaped = false;
  return (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_EVENT_LINE * 2) buffer = buffer.slice(-MAX_EVENT_LINE);
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (string) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') string = false;
      } else if (ch === '"' && depth > 0) string = true;
      else if (ch === "{") { if (depth === 0) start = i; depth += 1; }
      else if (ch === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const raw = buffer.slice(start, i + 1);
          buffer = buffer.slice(i + 1);
          i = -1;
          start = -1;
          if (raw.length <= MAX_EVENT_LINE) {
            try { onObject(JSON.parse(raw)); } catch {}
          }
        }
      }
    }
    if (buffer.length > MAX_EVENT_LINE) buffer = buffer.slice(-MAX_EVENT_LINE);
  };
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  if (typeof value.text === "string") return value.text;
  if (typeof value.response === "string") return value.response;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((part) => textFrom(part)).filter(Boolean).join("") || null;
  }
  if (typeof value.message === "string") return value.message;
  return null;
}

function extractError(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["errorMessage", "message", "detail", "error"]) {
    const text = textFrom(value[key]);
    if (text) return text;
  }
  return null;
}

function recordEvent(run, event) {
  if (run.events >= MAX_EVENTS) return;
  run.events += 1;
  const raw = JSON.stringify(event);
  appendFileSync(run.eventsPath, `${raw.length > MAX_EVENT_LINE ? raw.slice(0, MAX_EVENT_LINE) : raw}\n`, "utf8");
  const type = String(event.type || event.event || "").toLowerCase();
  const id = event.session_id ?? event.sessionId ?? event.session?.id;
  if (id && typeof id === "string") run.sessionId = id;
  if (event.model && typeof event.model === "string") run.model = event.model;
  if (["error", "fatal"].includes(type)) {
    if (event.severity !== "warning") run.sawError = true;
    if (event.severity !== "warning") run.eventError = extractError(event);
  }
  if (type === "result" || type === "response" || type === "final") {
    run.sawResult = true;
    run.stopReason = event.stop_reason ?? event.stopReason ?? event.reason ?? event.status ?? run.stopReason;
    const text = textFrom(event.response ?? event.result ?? event.message ?? event);
    if (text) run.finalMessage = text;
    run.usage = event.stats ?? event.usage ?? run.usage;
    if (event.error) { run.sawError = true; run.eventError = extractError(event.error); }
  } else if (type === "message" || type === "assistant" || type === "text") {
    const text = textFrom(event.message ?? event.content ?? event);
    if (text && (!run.finalMessage || type === "assistant")) run.finalMessage = (run.finalMessage || "") + text;
  }
}

function buildArgv(opts) {
  const argv = ["--output-format", "stream-json", "--approval-mode", opts.approvalMode];
  if (opts.sandbox) argv.push("--sandbox");
  if (opts.skipTrust) argv.push("--skip-trust");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.resume) argv.push("--resume", opts.resume);
  else if (opts.resumeLast) argv.push("--resume", "latest");
  for (const dir of opts.includeDirectories) argv.push("--include-directories", quoteWin(resolve(opts.cd, dir)));
  // A non-TTY stdin stream triggers Gemini's documented headless mode. Do not
  // pass an empty -p value: Windows cmd shims drop empty argv entries, and the
  // brief stays out of the process list when it is delivered on stdin.
  return argv;
}

function versionProbe(timeoutMs, onChild) {
  return new Promise((resolveProbe) => {
    const child = spawn("gemini", ["--version"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32", detached: process.platform !== "win32",
    });
    onChild(child);
    let stdout = ""; let stderr = ""; let settled = false; let timedOut = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolveProbe({ stdout, stderr, timedOut, ...value }); } };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => done({ code: null, error }));
    child.once("close", (code, signal) => done({ code, signal, error: null }));
    const timer = setTimeout(() => { timedOut = true; killTree(child, true); }, Math.min(timeoutMs, VERSION_TIMEOUT_MS));
  });
}

function resultObject(opts, run, status, exitCode, signal, error = null) {
  const touchedFiles = gitTouchedFiles(opts.cd);
  const afterSnapshot = gitSnapshot(opts.cd);
  const readOnlyViolation = opts.readOnly
    ? (run.beforeSnapshot === null || afterSnapshot === null ? null : run.beforeSnapshot !== afterSnapshot)
    : null;
  return {
    contract: "delegate-relay.result.v1",
    tool: IMPLEMENTER_KEY,
    workdir: opts.cd,
    lane: opts.lane,
    laneSource: opts.laneSource ?? null,
    status,
    exitCode,
    signal: signal ?? null,
    geminiVersion: run.geminiVersion ?? null,
    requestedModel: opts.model,
    actualModel: run.model,
    sessionId: run.sessionId,
    finalMessage: run.finalMessage,
    usage: run.usage,
    stopReason: run.stopReason,
    error: error || run.eventError || null,
    stderrTail: run.stderrTail || null,
    stdoutTail: run.stdoutTail || null,
    touchedFiles,
    readOnly: opts.readOnly,
    readOnlyViolation,
    resumed: Boolean(opts.resume || opts.resumeLast),
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    paths: {
      brief: run.briefPath,
      events: run.eventsPath,
      stderr: run.stderrPath,
      final: run.finalPath,
    },
  };
}

function printSummary(result) {
  process.stdout.write(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ""})\n`);
  if (result.paths?.result) process.stdout.write(`result: ${result.paths.result}\n`);
}

async function main() {
  const { opts, flagged } = parseArgs(process.argv.slice(2));
  applyFleetLane(opts, flagged);
  const brief = readBrief(opts);
  const run = prepareRun(opts, brief);
  let preflightChild = null;
  let activeChild = null;
  let shuttingDown = false;
  let forceTimer = null;
  let watchdogFired = false;
  const write = (status, code, signal, error) => {
    const result = resultObject(opts, run, status, code, signal, error);
    result.paths.result = run.resultPath;
    writeBounded(run.finalPath, run.finalMessage || "", MAX_FINAL);
    writeResult(run, result);
    printSummary(result);
  };
  const abort = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    run.killed = "aborted";
    if (preflightChild) killTree(preflightChild);
    if (activeChild) {
      killTree(activeChild);
      forceTimer = setTimeout(() => killTree(activeChild, true), 2_000);
    }
    // Write the aborted result immediately. A delayed write in an unref'd timer
    // can be lost: once the implementer's close drains the event loop, the
    // process exits before the timer fires, leaving no result.json.
    write("aborted", 130, signal, `relay received ${signal}`);
    // Keep the process alive through the grace window so files the implementer
    // flushes during shutdown appear in the refreshed touchedFiles snapshot.
    setTimeout(() => {
      if (activeChild) killTree(activeChild, true);
      write("aborted", 130, signal, `relay received ${signal}`);
      process.exit(130);
    }, 2_100);
  };
  process.once("SIGTERM", () => abort("SIGTERM"));
  process.once("SIGINT", () => abort("SIGINT"));

  const timeoutMs = parseDuration(opts.timeout);
  const probe = await versionProbe(timeoutMs, (child) => { preflightChild = child; });
  preflightChild = null;
  if (shuttingDown) return;
  if (probe.timedOut) {
    run.geminiVersion = null;
    write("timeout", 124, null, "gemini version preflight timed out; run was not dispatched");
    process.exit(124);
  }
  const unavailable = probe.error?.code === "ENOENT" ||
    (!probe.error && probe.code !== 0 && /not recognized|not found|cannot find|no such file/i.test(probe.stderr || ""));
  if (unavailable) {
    write("gemini_unavailable", 127, null, "gemini is not installed; run was not dispatched");
    process.exit(127);
  }
  if (probe.error || probe.code !== 0) {
    write("failed", probe.code ?? 1, probe.signal ?? null, `gemini version preflight failed; run was not dispatched${probe.stderr ? `: ${probe.stderr.trim().slice(-400)}` : ""}`);
    process.exit(probe.code ?? 1);
  }
  run.geminiVersion = probe.stdout.trim() || "unknown";

  const argv = buildArgv(opts);
  activeChild = spawn("gemini", argv, {
    cwd: opts.cd,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  run.child = activeChild;
  const decoder = new StringDecoder("utf8");
  const scan = makeObjectScanner((event) => recordEvent(run, event));
  let stdoutChars = 0;
  let stderrChars = 0;
  activeChild.stdout.on("data", (chunk) => {
    const text = decoder.write(chunk);
    stdoutChars += text.length;
    run.stdoutTail = `${run.stdoutTail}${text}`.slice(-MAX_FINAL);
    scan(text);
  });
  activeChild.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrChars += text.length;
    run.stderrTail = `${run.stderrTail}${text}`.slice(-MAX_STDERR);
    appendFileSync(run.stderrPath, text.slice(-MAX_STDERR), "utf8");
  });
  activeChild.once("error", (error) => { run.eventError = error.message; });
  activeChild.stdin.end(brief);
  const timer = setTimeout(() => {
    if (shuttingDown) return;
    run.killed = "timeout";
    watchdogFired = true;
    killTree(activeChild);
    forceTimer = setTimeout(() => killTree(activeChild, true), 2_000);
  }, timeoutMs);
  const [code, signal] = await new Promise((resolveExit) => activeChild.once("close", (c, s) => resolveExit([c, s])));
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  // A descendant that ignored SIGTERM must not outlive the timeout report: once the
  // parent is down, sweep the group (no-op where taskkill already felled the tree).
  if (watchdogFired) killTree(activeChild, true);
  activeChild = null;
  if (shuttingDown) return;
  const status = run.killed === "timeout" ? "timeout" : (code === 0 && !run.sawError && (run.sawResult || run.finalMessage) ? "completed" : "failed");
  const exitCode = run.killed === "timeout" ? 124 : (status === "failed" && (code ?? 0) === 0 ? 1 : (code ?? 1));
  write(status, exitCode, signal, status === "failed" && !run.eventError && !run.finalMessage ? "Gemini produced no final result" : null);
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`relay: ${error?.stack || error}\n`);
  process.exit(1);
});
