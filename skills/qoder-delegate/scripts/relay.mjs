#!/usr/bin/env node
/**
 * delegate-skills · qoder-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Qoder CLI (`qodercli -p`), capture the
 * structured event stream, and write a result the orchestrator can review.
 * The relay uses Node built-ins only and shells out only to `qodercli`, `git`,
 * and the platform process-termination utility when needed. It makes no
 * network calls, reads no credentials, sends no telemetry, and never commits.
 *
 * The brief is passed as a command-line argument. Keep secrets out of the
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
 *   --route <name>          Named delegate-config task route.
 *   --model <name>          Model from `qodercli --list-models`.
 *   --context-window <n>    Positive integer; supported models only.
 *   --resume <id>           Resume one Qoder session; send a delta brief.
 *   --resume-last           Continue the latest session; send a delta brief.
 *   --add-dir <dir>         Add a workspace directory. Repeatable.
 *   --permission-mode <m>   default | accept_edits | auto |
 *                           bypass_permissions | dont_ask | plan
 *                           (default: auto).
 *   --timeout <dur>         Relay watchdog (default: 30m; h/m/s syntax).
 *   --out-dir <dir>         Artifact directory (default: system temp).
 *   -h, --help              Show this help.
 *
 * Result: <out-dir>/result.json plus brief.txt, events.jsonl, stderr.txt, and
 * final.txt when Qoder emits a final message. Pre-run usage errors exit 2 and
 * write no result. Missing `qodercli` exits 127 with qoder_unavailable. Once
 * dispatched, every outcome writes a result: completed, failed, timeout,
 * aborted, or qoder_unavailable.
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
import { constants, tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const VERSION_TIMEOUT_MS = 10_000;
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;
const PERMISSION_MODES = new Set([
  "default",
  "accept_edits",
  "bypass_permissions",
  "dont_ask",
  "auto",
  "plan",
]);
const SAFE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONFIG_FIELDS = new Set(["model", "timeout", "readOnly", "permissionMode"]);
const BOOLEAN_CONFIG_FIELDS = new Set(["readOnly"]);

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
    route: null,
    model: null,
    contextWindow: null,
    resume: null,
    resumeLast: false,
    addDirs: [],
    permissionMode: null,
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
      case "--context-window": opts.contextWindow = next(); break;
      case "--resume": opts.resume = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--permission-mode": opts.permissionMode = next(); break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  if (opts.resumeLast && opts.resume) {
    fail("--resume-last and --resume are mutually exclusive; pass only one");
  }
  if (opts.resume !== null && !opts.resume.trim()) fail("--resume must not be empty");
  if (opts.model !== null && (typeof opts.model !== "string" || !opts.model.trim())) {
    fail("--model must be a non-empty string");
  }
  const modelFromFlag = opts.model !== null;
  const delegateConfig = loadDelegateConfig(opts.cd, opts.route);
  const config = delegateConfig.values;
  if (opts.model === null && config.model !== undefined) opts.model = config.model;
  if (opts.timeout === null && config.timeout !== undefined) opts.timeout = config.timeout;
  if (opts.permissionMode === null) {
    if (config.readOnly === true) opts.permissionMode = "plan";
    else if (config.permissionMode !== undefined) opts.permissionMode = config.permissionMode;
    else if (config.sandbox !== undefined) opts.permissionMode = config.sandbox;
    else opts.permissionMode = "auto";
  }
  if (opts.timeout === null) opts.timeout = DEFAULT_TIMEOUT;
  opts.modelSource = modelFromFlag ? "flag" : delegateConfig.modelSource;
  if (config.readOnly !== undefined && typeof config.readOnly !== "boolean") {
    fail("delegate config qodercli.readOnly must be a boolean");
  }
  if (opts.contextWindow !== null && !/^[1-9]\d*$/.test(opts.contextWindow)) {
    fail("--context-window must be a positive integer");
  }
  if (opts.permissionMode !== null && !PERMISSION_MODES.has(opts.permissionMode)) {
    fail(`unsupported --permission-mode: ${opts.permissionMode}`);
  }
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  if (opts.timeout !== null && parseDuration(opts.timeout) === 0) fail("--timeout must be greater than zero");
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

function killChild(child, signal = "SIGTERM") {
  // A timeout/abort must stop Qoder's tools too, or a descendant could keep
  // editing after the relay reports that the run ended.
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return; // taskkill /f already felled the tree
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch { /* The tree already exited. */ }
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* The tree already exited. */ }
    }
  }
}

function qoderVersion(timeoutMs) {
  try {
    return {
      version: execFileSync("qodercli", ["--version"], {
        encoding: "utf8",
        shell: false,
        timeout: Math.min(timeoutMs, VERSION_TIMEOUT_MS),
        killSignal: "SIGKILL",
      }).trim() || "unknown",
      error: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    return { version: null, error };
  }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
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

function buildArgv(opts, brief) {
  const argv = ["--output-format", "stream-json", "--permission-mode", opts.permissionMode];
  if (opts.resume) argv.push("--resume", opts.resume);
  else if (opts.resumeLast) argv.push("-c");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.contextWindow) argv.push("--context-window", opts.contextWindow);
  for (const dir of opts.addDirs) argv.push("--add-dir", dir);
  argv.push("-p", brief);
  return argv;
}

function makeEventScanner(onObject) {
  // Qoder documents stream-json as newline-delimited JSON. This brace-aware
  // scanner also tolerates chunk-split and concatenated objects plus non-JSON
  // progress text without depending on undocumented event boundaries.
  let buffer = "";
  let cursor = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  return (chunk) => {
    buffer += chunk;
    for (; cursor < buffer.length; cursor += 1) {
      const char = buffer[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        if (depth > 0) inString = true;
      } else if (char === "{") {
        if (depth === 0) start = cursor;
        depth += 1;
      } else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const slice = buffer.slice(start, cursor + 1);
          try { onObject(JSON.parse(slice)); } catch { /* Ignore non-event text. */ }
          buffer = buffer.slice(cursor + 1);
          cursor = -1;
          start = -1;
        }
      }
    }
    if (depth === 0) {
      buffer = "";
      cursor = 0;
      start = -1;
      inString = false;
      escaped = false;
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
      tool: "qoder",
      workdir: opts.cd,
      model: opts.model,
      modelSource: opts.modelSource,
      route: opts.route,
      timeout: opts.timeout,
      contextWindow: opts.contextWindow,
      permissionMode: opts.permissionMode,
      resumed: Boolean(opts.resumeLast || opts.resume),
      qoderVersion: version,
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

function reportVersionFailure(writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `qodercli --version preflight timed out after ${Math.min(timeoutMs, VERSION_TIMEOUT_MS)}ms; Qoder was not dispatched`
    : `qodercli --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Qoder was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    actualModel: null,
    actualPermissionMode: null,
    usage: null,
    resultSubtype: null,
    qoderErrors: [],
    permissionDenials: [],
    finalMessage: "",
    touchedFiles: null,
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatch(opts, brief, run, writeResult) {
  // Target Qoder's currently documented native Windows executable, keeping
  // argv structured and avoiding a command shell on every platform.
  const child = spawn("qodercli", buildArgv(opts, brief), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
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
  const deltaChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    const eventSessionId = event.session_id ?? event.sessionId ?? event.session?.id;
    if (typeof eventSessionId === "string") sessionId = eventSessionId;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") actualModel = event.model;
      const mode = event.permissionMode ?? event.permission_mode;
      if (typeof mode === "string") actualPermissionMode = mode;
    }
    if (event.type === "assistant" || event.role === "assistant") {
      const content = event.message?.content ?? event.content;
      if (typeof content === "string") textChunks.push(content);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") textChunks.push(block.text);
        }
      }
    }
    if (event.type === "content_block_delta" && typeof event.delta?.text === "string") {
      deltaChunks.push(event.delta.text);
    }
    if (event.type === "result" || event.type === "final") {
      resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
      resultIsError = event.is_error === true || event.status === "error";
      const resultText = event.result ?? event.final_message ?? event.finalMessage;
      if (typeof resultText === "string") finalResult = resultText;
      if (!finalResult && typeof event.message === "string") finalResult = event.message;
      if (!finalResult && Array.isArray(event.message?.content)) {
        const blocks = event.message.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text);
        if (blocks.length) finalResult = blocks.join("\n\n");
      }
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
    const message = finalResult || textChunks.join("\n\n") || deltaChunks.join("");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
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
  }, parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT));

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = () => ({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        actualModel,
        actualPermissionMode,
        usage,
        resultSubtype,
        qoderErrors,
        permissionDenials,
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; qodercli was terminated with it — inspect the working tree before re-dispatching`,
      });
      const result = writeResult(abortedFields());
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        writeResult(abortedFields());
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
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
    clearWatchdog();
    if (watchdogFired) killChild(child, "SIGKILL");
    scan(stdoutDecoder.end());
    const stderrEnd = stderrDecoder.end();
    if (stderrEnd.trim()) stderrTail.push(stderrEnd.trimEnd());
    const succeeded = code === 0 && !watchdogFired && !resultIsError;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
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
      ...(watchdogFired ? { error: `qodercli did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
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
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed qodercli (commonly an OOM killer or supervisor timeout); check host memory and inspect the working tree before re-dispatching.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated qodercli; relay watchdogs and relay signals report timeout or aborted instead.");
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.actualModel) lines.push(`model: ${result.actualModel}`);
  if (result.contextWindow) lines.push(`context window requested: ${result.contextWindow}`);
  if (result.sessionId) lines.push(`session id (resume with: --resume ${result.sessionId}): ${result.sessionId}`);
  if (result.touchedFiles === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${result.touchedFiles.length}`);
    for (const file of result.touchedFiles.slice(0, 40)) lines.push(`  ${file}`);
    if (result.touchedFiles.length > 40) lines.push(`  ... and ${result.touchedFiles.length - 40} more`);
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
  const entry = document?.implementers?.qodercli;
  if (entry === undefined) return [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`invalid delegate config ${configPath}: implementers.qodercli must be an object`);
  }
  if (document.version === "delegate-config.v1") {
    const values = { ...entry };
    if (values.sandbox !== undefined && values.permissionMode === undefined) {
      values.permissionMode = values.sandbox;
    }
    delete values.sandbox;
    return [{ values, label: "defaults" }];
  }
  for (const field of Object.keys(entry)) {
    if (!["defaults", "routes"].includes(field)) {
      fail(`invalid delegate config ${configPath}: unsupported qodercli section "${field}"`);
    }
  }
  if (entry.routes !== undefined && (!entry.routes || typeof entry.routes !== "object" || Array.isArray(entry.routes))) {
    fail(`invalid delegate config ${configPath}: qodercli.routes must be an object`);
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
          fail(`invalid delegate config ${candidate.path}: unsupported qodercli field "${field}"`);
        }
        const fieldValue = field === "timeout" && Number.isSafeInteger(rawValue) && rawValue > 0
          ? `${rawValue}s`
          : rawValue;
        const expectedType = BOOLEAN_CONFIG_FIELDS.has(field) ? "boolean" : "string";
        if (typeof fieldValue !== expectedType) {
          fail(`invalid delegate config ${candidate.path}: qodercli field "${field}" must be a ${expectedType}`);
        }
        resolved[field] = fieldValue;
        if (field === "model") modelSource = `${candidate.scope}:${layer.label}`;
      }
    }
  }
  if (!routeFound) fail(`delegate config route not found: ${route}`);
  return { values: resolved, modelSource };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe stdin)");
  const briefBytes = Buffer.byteLength(brief, "utf8");
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; keep large context in workspace files instead of argv`);
  }

  const run = prepareRunDir(opts, brief);
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const probe = qoderVersion(timeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) return reportUnavailable(writeResult, run.resultPath);
  if (probe.error) return reportVersionFailure(writeResult, run, probe.error, timeoutMs);
  dispatch(opts, brief, run, writeResult);
}

main();
