#!/usr/bin/env node
/**
 * delegate-skills · grok-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Grok Build in headless streaming-JSON mode,
 * preserve the raw event stream, and write a stable result.json for an
 * orchestrator to review. The helper never commits.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Read the brief from a file; otherwise read stdin.
 *   --cd <dir>              Grok working directory (default: current directory).
 *   --model <id>            Grok model id.
 *   --effort <level>        Reasoning effort.
 *   --max-turns <n>         Maximum agent turns.
 *   --session <id>          Resume a specific Grok session.
 *   --resume-last           Continue the latest session for --cd.
 *   --read-only             Remove write/edit tools, avoid auto-approval, and
 *                           fail if git status changes during the run.
 *   --no-auto-approve       Do not pass --always-approve on implementation runs.
 *   --no-subagents          Disable subagents.
 *   --no-memory             Disable cross-session memory.
 *   --no-web                Disable web search.
 *   --out-dir <dir>         Artifact directory (default: system temp directory).
 *   -h, --help              Show this help.
 */

import { spawn, execFileSync } from "node:child_process";
import { constants, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    maxTurns: null,
    session: null,
    resumeLast: false,
    readOnly: false,
    autoApprove: true,
    noSubagents: false,
    noMemory: false,
    noWeb: false,
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
      case "--help": process.stdout.write(readHelp()); process.exit(0); break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--max-turns": opts.maxTurns = next(); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--read-only": opts.readOnly = true; break;
      case "--no-auto-approve": opts.autoApprove = false; break;
      case "--no-subagents": opts.noSubagents = true; break;
      case "--no-memory": opts.noMemory = true; break;
      case "--no-web": opts.noWeb = true; break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (opts.session && opts.resumeLast) fail("use only one of --session or --resume-last");
  if (opts.maxTurns !== null && (!/^\d+$/.test(opts.maxTurns) || Number(opts.maxTurns) < 1)) {
    fail("--max-turns must be a positive integer");
  }
  return opts;
}

function readHelp() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  return match ? `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n` : "relay.mjs\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8").trim();
  }
  if (process.stdin.isTTY) fail("pass --brief <file> or pipe a brief on stdin");
  try { return readFileSync(0, "utf8").trim(); } catch { return ""; }
}

function grokVersion() {
  try {
    return execFileSync("grok", ["version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    }).trim();
  } catch {
    return null;
  }
}

function gitStatus(cwd) {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
      .split("\n").map(line => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function buildArgs(opts, brief) {
  const rules = [
    "Do not create commits, amend commits, push, or modify git history.",
    "Stay inside the requested scope and return a concise final report with changed files and gates run.",
  ];
  if (opts.readOnly) {
    rules.push("This is a read-only review. Do not modify, create, rename, or delete files and do not run mutating commands.");
  }
  const args = ["--no-auto-update", "--cwd", opts.cd, "--output-format", "streaming-json", "--rules", rules.join(" ")];
  if (opts.session) args.push("--resume", opts.session);
  else if (opts.resumeLast) args.push("--continue");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns);
  if (opts.noSubagents) args.push("--no-subagents");
  if (opts.noMemory) args.push("--no-memory");
  if (opts.noWeb) args.push("--disable-web-search");
  if (opts.readOnly) args.push("--disallowed-tools", "write,edit");
  else if (opts.autoApprove) args.push("--always-approve");
  args.push("-p", brief);
  return args;
}

function findString(object, keys) {
  if (!object || typeof object !== "object") return null;
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  for (const value of Object.values(object)) {
    const found = findString(value, keys);
    if (found) return found;
  }
  return null;
}

function extractText(event) {
  const direct = findString(event, ["finalMessage", "final_message", "output", "text", "message"]);
  return direct || null;
}

function makeLineScanner(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) onLine(line);
    },
    flush() { if (buffer.trim()) onLine(buffer); buffer = ""; },
  };
}

function writeResult(opts, run, version, extra) {
  const result = {
    schema: "delegate-relay.result.v1",
    tool: "grok",
    grokVersion: version,
    cd: opts.cd,
    readOnly: opts.readOnly,
    resumeLast: opts.resumeLast,
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    briefPath: run.briefPath,
    eventsPath: run.eventsPath,
    stderrPath: run.stderrPath,
    finalPath: run.finalPath,
    ...extra,
  };
  writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function printSummary(result, resultPath) {
  process.stdout.write(`\nrelay: ${result.status} (exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ""}) · grok ${result.grokVersion || "?"}\n`);
  if (result.sessionId) process.stdout.write(`session: ${result.sessionId}\n`);
  if (Array.isArray(result.touchedFiles)) process.stdout.write(`working tree entries: ${result.touchedFiles.length}\n`);
  process.stdout.write(`result: ${resultPath}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief) fail("brief is empty");
  if (!existsSync(opts.cd)) fail(`working directory not found: ${opts.cd}`);

  const run = prepareRun(opts, brief);
  const beforeStatus = gitStatus(opts.cd);
  const version = grokVersion();
  if (!version) {
    const result = writeResult(opts, run, null, {
      status: "grok_unavailable", exitCode: 127, signal: null, sessionId: null,
      finalMessage: "", touchedFiles: beforeStatus,
    });
    printSummary(result, run.resultPath);
    process.stderr.write("relay: `grok` not found on PATH. Install Grok Build and run `grok login`.\n");
    process.exit(127);
  }

  const child = spawn("grok", buildArgs(opts, brief), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = opts.session || null;
  let finalMessage = "";
  let settled = false;
  const scanner = makeLineScanner(line => {
    appendFileSync(run.eventsPath, `${line}\n`, "utf8");
    try {
      const event = JSON.parse(line);
      sessionId ||= findString(event, ["sessionId", "session_id"]);
      const text = extractText(event);
      if (text) finalMessage = text;
    } catch {
      // Preserve unknown/non-JSON output in events.jsonl; schema changes remain diagnosable.
    }
  });
  child.stdout.on("data", chunk => scanner.push(chunk.toString("utf8")));
  child.stderr.on("data", chunk => appendFileSync(run.stderrPath, chunk.toString("utf8"), "utf8"));

  child.on("error", error => {
    if (settled) return;
    settled = true;
    const result = writeResult(opts, run, version, {
      status: "failed", exitCode: 1, signal: null, sessionId, finalMessage,
      touchedFiles: gitStatus(opts.cd), error: error.message,
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    scanner.flush();
    const afterStatus = gitStatus(opts.cd);
    const readOnlyViolation = opts.readOnly && beforeStatus !== null && afterStatus !== null
      && JSON.stringify(beforeStatus) !== JSON.stringify(afterStatus);
    if (finalMessage) writeFileSync(run.finalPath, `${finalMessage}\n`, "utf8");
    else writeFileSync(run.finalPath, "", "utf8");
    const exitCode = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult(opts, run, version, {
      status: exitCode === 0 && !readOnlyViolation ? "completed" : "failed",
      exitCode: readOnlyViolation && exitCode === 0 ? 3 : exitCode,
      signal: signal || null,
      sessionId,
      finalMessage,
      touchedFiles: afterStatus,
      readOnlyViolation,
      error: readOnlyViolation ? "read-only run changed the git working-tree status" : undefined,
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

main();
