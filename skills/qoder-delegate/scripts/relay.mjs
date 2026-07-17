#!/usr/bin/env node
/**
 * delegate-skills · qoder-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Qoder CLI (`qodercli -p`), capture the
 * structured event stream, and write a result the orchestrator can review.
 * The relay uses Node built-ins only and shells out only to `qodercli` and
 * `git`. It makes no network calls, reads no credentials, sends no telemetry,
 * and never commits.
 *
 * The prompt is passed as a command-line argument. Keep secrets out of the
 * brief on shared hosts; point Qoder at workspace files or environment
 * variables instead.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Brief path. If omitted, read stdin.
 *   --cd <dir>              Qoder working root (default: current directory).
 *   --model <name>          Model from `qodercli --list-models`.
 *   --context-window <n>    Positive integer; supported models only.
 *   --session <id>          Resume one Qoder session; send a delta brief.
 *   --resume-last           Continue the latest session; send a delta brief.
 *   --add-dir <dir>         Add a workspace directory. Repeatable.
 *   --permission-mode <m>   default | accept_edits | bypass_permissions |
 *                           dont_ask | auto (default: accept_edits).
 *   --timeout <dur>         Relay watchdog (default: 30m; h/m/s syntax).
 *   --out-dir <dir>         Artifact directory (default: system temp).
 *   -h, --help              Show this help.
 *
 * Result: <out-dir>/result.json plus brief.txt, events.jsonl, stderr.txt, and
 * final.txt when Qoder emits a final message. Pre-run usage errors exit 2 and
 * write no result. Missing `qodercli` exits 127 with qoder_unavailable.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const MAX_BRIEF_BYTES = 120 * 1024;
const PERMISSION_MODES = new Set([
  "default",
  "accept_edits",
  "bypass_permissions",
  "dont_ask",
  "auto",
]);

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    contextWindow: null,
    session: null,
    resumeLast: false,
    addDirs: [],
    permissionMode: "accept_edits",
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
      case "--model": opts.model = next(); break;
      case "--context-window": opts.contextWindow = next(); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--permission-mode": opts.permissionMode = next(); break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.model !== null && !opts.model.trim()) fail("--model must not be empty");
  if (opts.contextWindow !== null && !/^[1-9]\d*$/.test(opts.contextWindow)) {
    fail("--context-window must be a positive integer");
  }
  if (!PERMISSION_MODES.has(opts.permissionMode)) {
    fail(`unsupported --permission-mode: ${opts.permissionMode}`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) {
    fail(`working directory not found: ${opts.cd}`);
  }

  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  return opts;
}

function headerComment() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to qodercli -p\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function qoderVersion() {
  try {
    return execFileSync("qodercli", ["--version"], { encoding: "utf8" }).trim() || "unknown";
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return "unknown";
  }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts, brief) {
  const argv = ["-p", "--output-format", "stream-json", "--permission-mode", opts.permissionMode];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.contextWindow) argv.push("--context-window", opts.contextWindow);
  if (opts.session) argv.push("--resume", opts.session);
  else if (opts.resumeLast) argv.push("--continue");
  for (const dir of opts.addDirs) argv.push("--add-dir", dir);
  argv.push("--", brief);
  return argv;
}

function makeEventScanner(onObject) {
  let buffer = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  return (chunk) => {
    buffer += chunk;
    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        if (depth > 0) inString = true;
      } else if (char === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const slice = buffer.slice(start, i + 1);
          try { onObject(JSON.parse(slice)); } catch { /* Ignore non-event text. */ }
          start = -1;
        }
      }
    }
    buffer = depth > 0 && start !== -1 ? buffer.slice(start) : "";
    depth = 0;
    start = -1;
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
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "qoder",
      workdir: opts.cd,
      model: opts.model,
      contextWindow: opts.contextWindow,
      permissionMode: opts.permissionMode,
      resumed: Boolean(opts.resumeLast || opts.session),
      qoderVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "qoder_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    actualModel: null,
    actualPermissionMode: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `qodercli` not found on PATH. Install from https://docs.qoder.com/en/cli/quick-start, then run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN for automation.\n");
  process.exit(127);
}

function dispatch(opts, brief, run, writeResult) {
  const child = spawn("qodercli", buildArgv(opts, brief), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let sessionId = null;
  let actualModel = null;
  let actualPermissionMode = null;
  let usage = null;
  let finalResult = "";
  let resultIsError = false;
  let resultSubtype = null;
  let qoderErrors = [];
  let permissionDenials = [];
  const textChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") actualModel = event.model;
      if (typeof event.permissionMode === "string") actualPermissionMode = event.permissionMode;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string") textChunks.push(block.text);
      }
    }
    if (event.type === "result") {
      resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
      resultIsError = event.is_error === true;
      if (typeof event.result === "string") finalResult = event.result;
      if (event.usage && typeof event.usage === "object") usage = event.usage;
      if (Array.isArray(event.errors)) qoderErrors = event.errors;
      if (Array.isArray(event.permission_denials)) permissionDenials = event.permission_denials;
    }
  });
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    for (const line of stderrDecoder.write(chunk).split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = finalResult || textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    const destroyStreams = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      destroyStreams();
    } else {
      child.once("exit", destroyStreams);
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 10_000);
    }
  }, parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT));

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      actualModel,
      actualPermissionMode,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(error?.message || error),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const succeeded = code === 0 && !watchdogFired && !resultIsError;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      actualModel,
      actualPermissionMode,
      usage,
      resultSubtype,
      qoderErrors,
      permissionDenials,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `qodercli run did not close within --timeout ${opts.timeout}; terminated by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(exitCode);
  });
}

function printSummary(result, resultPath) {
  const lines = [
    "",
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""}) · qodercli ${result.qoderVersion ?? "?"}`,
  ];
  if (result.actualModel) lines.push(`model: ${result.actualModel}`);
  if (result.contextWindow) lines.push(`context window requested: ${result.contextWindow}`);
  if (result.sessionId) lines.push(`session id (resume with --session ${result.sessionId}): ${result.sessionId}`);
  if (result.touchedFiles === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${result.touchedFiles.length}`);
    for (const file of result.touchedFiles.slice(0, 40)) lines.push(`  ${file}`);
  }
  if (result.stderrTail?.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("", "--- qoder final report ---", result.finalMessage || "(no final message captured)", "--- end report ---", "");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, rerun the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe stdin)");
  const briefBytes = Buffer.byteLength(brief, "utf8");
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; keep large context in workspace files instead of argv`);
  }

  const version = qoderVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);
  if (!version) return reportUnavailable(writeResult, run.resultPath);
  dispatch(opts, brief, run, writeResult);
}

main();
