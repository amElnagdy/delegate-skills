#!/usr/bin/env node
/**
 * commandcode-delegate relay
 *
 * Sends one self-contained brief to Command Code headless mode, captures its
 * NDJSON stream, and writes a stable result.json for the orchestrator.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   Get-Content brief.txt -Raw | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>    Brief file. Omit to read stdin.
 *   --cd <dir>        Command Code working directory (default: current directory).
 *   --lane <name>     Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <id>      Optional override; fresh/resumed defaults stay with Command Code.
 *   --effort <level>  Optional reasoning effort.
 *   --max-turns <n>   Maximum agent turns.
 *   --read-only       Enforced plan mode; no repository edits.
 *   --resume-last     Continue latest headless session, or start fresh if none exists.
 *   --session <id>    Resume one explicit headless session id.
 *   --timeout <dur>   Relay watchdog (default: 30m; h/m/s syntax).
 *   --out-dir <dir>   External artifact directory (default: private system temp directory).
 *   -h, --help        Show this help.
 *
 * Write runs use --yolo because Command Code headless mode otherwise denies
 * edits and shell commands. Command Code's explicit deny/ask rules and its
 * root/home delete circuit breaker still apply. Read-only runs use --plan and
 * never combine it with --yolo.
 *
 * The relay never stages, commits, or pushes. The orchestrator reviews the
 * diff, reruns project gates, and owns the commit.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants as osConstants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const VERSION_TIMEOUT_MS = 10_000;
const IMPLEMENTER_KEY = "commandcode";

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
    model: null,
    effort: null,
    maxTurns: null,
    readOnly: false,
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
        process.stdout.write(helpText());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--max-turns": opts.maxTurns = next(); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  applyFleetLane(opts, flagged);
  opts.autonomy = opts.readOnly ? "read-only" : "bypass";

  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive");
  }

  // Keep ids within Command Code's documented token shape and reject values
  // that could be misread as another option. The brief always travels on stdin.
  const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  for (const name of ["model", "effort", "session"]) {
    if (opts[name] !== null && !safeToken.test(opts[name])) {
      fail(`--${name} contains unsupported characters`);
    }
  }
  if (opts.maxTurns !== null && !/^[1-9]\d*$/.test(opts.maxTurns)) {
    fail("--max-turns must be a positive integer");
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }

  return opts;
}

function helpText() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const block = source.match(/\/\*\*([\s\S]*?)\*\//);
  return block
    ? `${block[1].replace(/^\s*\* ?/gm, "").trim()}\n`
    : "commandcode-delegate relay\n";
}

function readBrief(opts) {
  let brief;
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    brief = readFileSync(opts.brief, "utf8");
  } else {
    if (process.stdin.isTTY) {
      fail("pass --brief <file> or pipe a brief on stdin");
    }
    try {
      brief = readFileSync(0, "utf8");
    } catch {
      brief = "";
    }
  }

  if (!brief.trim()) fail("brief is empty");
  return brief;
}

function resolveExecutable(name) {
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter((entry) => entry && isAbsolute(entry));

  if (process.platform === "win32") {
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean);
    for (const directory of pathEntries) {
      for (const extension of extensions) {
        const candidate = join(directory, `${name}${extension.toLowerCase()}`);
        try {
          if (statSync(candidate).isFile()) return resolve(candidate);
        } catch {
          // Try the next PATH candidate.
        }
      }
    }
    return null;
  }

  for (const directory of pathEntries) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return resolve(candidate);
    } catch {
      // Try the next PATH candidate.
    }
  }
  return null;
}

function resolveCommandCode() {
  const shimPath = resolveExecutable("command-code");
  if (!shimPath) return null;

  const packagePath = join(dirname(shimPath), "node_modules", "command-code");
  const packageJsonPath = join(packagePath, "package.json");
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const binPath = typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.["command-code"];
    if (packageJson.name === "command-code" && typeof binPath === "string") {
      const entrypointPath = realpathSync(resolve(packagePath, binPath));
      if (isInside(realpathSync(packagePath), entrypointPath)) {
        return { shimPath, entrypointPath };
      }
    }
  } catch {
    // POSIX npm shims are often symlinks directly to the package entrypoint.
  }

  try {
    const entrypointPath = realpathSync(shimPath);
    if (/\.(?:mjs|cjs|js)$/i.test(entrypointPath)) {
      return { shimPath, entrypointPath };
    }
  } catch {
    // Unsupported or broken installation.
  }
  return null;
}

function commandCodeVersion(entrypointPath, timeoutMs) {
  return execFileSync(
    process.execPath,
    [entrypointPath, "--no-auto-update", "--version"],
    {
      encoding: "utf8",
      timeout: Math.min(timeoutMs, VERSION_TIMEOUT_MS),
      killSignal: "SIGKILL",
    },
  ).trim();
}

function runGit(gitPath, cwd, args) {
  return execFileSync(
    gitPath,
    ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
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

function updateFileHash(hash, path) {
  const file = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(file, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(file);
  }
}

function pathHash(path) {
  const hash = createHash("sha256");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    hash.update(`type:symlink\0mode:${stat.mode}\0target:${readlinkSync(path)}`);
  } else if (stat.isFile()) {
    hash.update(`type:file\0mode:${stat.mode}\0size:${stat.size}\0`);
    updateFileHash(hash, path);
  } else {
    hash.update(`type:other\0mode:${stat.mode}\0size:${stat.size}`);
  }
  return hash.digest("hex");
}

function worktreeSnapshot(gitPath, cwd) {
  const tracked = runGit(gitPath, cwd, ["ls-files", "--cached", "-z"])
    .split("\0").filter(Boolean);
  const untracked = runGit(gitPath, cwd, [
    "ls-files", "--others", "--exclude-standard", "-z",
  ]).split("\0").filter(Boolean);
  const kinds = new Map([
    ...tracked.map((path) => [path, "tracked"]),
    ...untracked.map((path) => [path, "untracked"]),
  ]);
  const files = new Map();
  const aggregate = createHash("sha256");
  for (const relativePath of [...kinds.keys()].sort()) {
    if (relativePath.includes("\uFFFD")) throw new Error("git path is not valid UTF-8");
    const state = `${kinds.get(relativePath)}:${pathHash(join(cwd, relativePath))}`;
    files.set(relativePath, state);
    aggregate.update(relativePath).update("\0").update(state).update("\0");
  }
  return { hash: aggregate.digest("hex"), files };
}

function changedFiles(before, after) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changes = [];
  for (const path of [...paths].sort()) {
    if (before.files.get(path) === after.files.get(path)) continue;
    if (!before.files.has(path)) changes.push(`?? ${path}`);
    else if (!after.files.has(path)) changes.push(` D ${path}`);
    else changes.push(` M ${path}`);
  }
  return changes;
}

function gitState(gitPath, cwd, includeWorktreeHash = false) {
  if (!gitPath) return null;
  try {
    const inside = runGit(gitPath, cwd, ["rev-parse", "--is-inside-work-tree"]).trim();
    if (inside !== "true") return null;

    let head = null;
    try {
      head = runGit(gitPath, cwd, ["rev-parse", "HEAD"]).trim();
    } catch {
      // An unborn repository is valid and has no HEAD yet.
    }
    const indexEntries = runGit(gitPath, cwd, ["ls-files", "--stage", "-z"]);
    const hasSubmodules = indexEntries
      .split("\0")
      .some((entry) => entry.startsWith("160000 "));
    const indexHash = createHash("sha256").update(indexEntries).digest("hex");
    if (includeWorktreeHash && hasSubmodules) {
      return {
        head,
        indexHash,
        touchedFiles: null,
        worktreeHash: null,
        workspace: null,
        unsupportedReason: "read-only snapshot does not support repositories containing submodules",
      };
    }
    const workspace = includeWorktreeHash ? worktreeSnapshot(gitPath, cwd) : null;
    return {
      head,
      indexHash,
      touchedFiles: includeWorktreeHash ? null : gitTouchedFiles(cwd),
      worktreeHash: workspace?.hash ?? null,
      workspace,
      unsupportedReason: null,
    };
  } catch {
    return null;
  }
}

function isInside(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === ""
    || (!isAbsolute(pathFromParent)
      && pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`));
}

function canonicalForCreation(path) {
  let existingPath = resolve(path);
  const missingParts = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) throw new Error(`cannot resolve path: ${path}`);
    missingParts.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(realpathSync(existingPath), ...missingParts);
}

function prepareRun(opts, brief) {
  try {
    opts.cd = realpathSync(opts.cd);
  } catch {
    fail(`working directory not found: ${opts.cd}`);
  }
  let outDir = opts.outDir;
  if (outDir) {
    outDir = canonicalForCreation(outDir);
    if (isInside(opts.cd, outDir)) {
      fail("--out-dir must be outside the Command Code working directory");
    }
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } else {
    const tempRoot = realpathSync(tmpdir());
    if (isInside(opts.cd, tempRoot)) {
      fail("system temp directory is inside the Command Code working directory; pass external --out-dir");
    }
    outDir = mkdtempSync(join(tempRoot, "commandcode-delegate-"));
  }
  chmodSync(outDir, 0o700);

  const run = {
    outDir,
    startedAt: new Date().toISOString(),
    briefPath: join(outDir, "brief.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.log"),
    finalPath: join(outDir, "final.txt"),
    resultPath: join(outDir, "result.json"),
  };
  const privateText = { encoding: "utf8", mode: 0o600 };
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, privateText);
  writeFileSync(run.eventsPath, "", privateText);
  writeFileSync(run.stderrPath, "", privateText);
  return run;
}

function buildArgv(opts) {
  const argv = [
    "-p",
    "--output-format", "json",
    "--skip-onboarding",
    "--no-auto-update",
    "--trust",
  ];

  argv.push(opts.autonomy === "read-only" ? "--plan" : "--yolo");
  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push("--resume", opts.session);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.maxTurns) argv.push("--max-turns", opts.maxTurns);
  return argv;
}

function spawnCommandCode(entrypointPath, argv, options) {
  return spawn(process.execPath, [entrypointPath, ...argv], options);
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

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0);
}

function stderrTail(stderr) {
  return stderr.trim().split(/\r?\n/).slice(-20);
}

function validSuccessFrame(frame) {
  return frame?.subtype === "success"
    && typeof frame.finalText === "string"
    && frame.usage !== null
    && typeof frame.usage === "object"
    && !Array.isArray(frame.usage)
    && Number.isFinite(frame.durationMs);
}

function resultError(frame) {
  if (!frame) return "Command Code emitted no final result frame";
  if (frame.subtype === "success") return "Command Code emitted an invalid success result frame";
  if (typeof frame.error === "string" && frame.error) return frame.error;
  return `Command Code result subtype: ${frame.subtype ?? "unknown"}`;
}

function dispatchFailure(context) {
  if (context.abortSignal) {
    return `relay interrupted by ${context.abortSignal}; Command Code process tree terminated`;
  }
  if (context.watchdogFired) {
    return `Command Code did not finish within --timeout ${context.timeout}; killed by the relay watchdog`;
  }
  if (context.launchError) return context.launchError.message;
  if (context.runtimeError) return context.runtimeError.message;
  if (context.cliExitCode !== 0) return `Command Code exited with code ${context.cliExitCode}`;
  if (context.gitMutationViolation === true) {
    return "Command Code changed git HEAD or the staged index";
  }
  if (context.gitMutationViolation === null) {
    return "relay could not verify final git HEAD and index state";
  }
  if (context.readOnlyViolation === true) {
    return "Command Code changed the working tree during a read-only run";
  }
  if (context.readOnly && context.readOnlyViolation === null) {
    return "relay could not verify read-only working-tree state";
  }
  return resultError(context.resultFrame);
}

function writeResult(opts, version, run, extra) {
  const result = {
    schema: "delegate-relay.result.v1",
    lane: opts.lane,
    laneSource: opts.laneSource,
    tool: "commandcode",
    workdir: opts.cd,
    autonomy: opts.autonomy,
    model: opts.model,
    effort: opts.effort,
    maxTurns: opts.maxTurns ? Number(opts.maxTurns) : null,
    timeout: opts.timeout,
    resumeLast: opts.resumeLast,
    requestedSessionId: opts.session,
    commandCodeShimPath: opts.commandCodeShimPath ?? null,
    commandCodePath: opts.commandCodePath ?? null,
    nodePath: process.execPath,
    gitPath: opts.gitPath ?? null,
    commandCodeVersion: version,
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    briefPath: run.briefPath,
    eventsPath: run.eventsPath,
    stderrPath: run.stderrPath,
    finalPath: existsSync(run.finalPath) ? run.finalPath : null,
    ...extra,
  };
  const temporary = `${run.resultPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, run.resultPath);
  return result;
}

function printSummary(result, resultPath) {
  process.stdout.write([
    "=== Command Code delegate result ===",
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    `sessionId: ${result.sessionId ?? "none"}`,
    `result: ${resultPath}`,
  ].join("\n") + "\n");

  if (result.finalMessage) {
    process.stdout.write(
      `--- BEGIN IMPLEMENTER REPORT ---\n${result.finalMessage}\n--- END IMPLEMENTER REPORT ---\n`,
    );
  }
}

function unavailable(opts, run) {
  const result = writeResult(opts, null, run, {
    status: "commandcode_unavailable",
    exitCode: 127,
    signal: null,
    resultSubtype: null,
    sessionId: null,
    stopReason: null,
    finalMessage: "",
    usage: null,
    durationMs: null,
    touchedFiles: null,
    error: "supported `command-code` npm entrypoint not found on absolute PATH entries",
  });
  printSummary(result, run.resultPath);
  process.stderr.write(
    "relay: supported `command-code` npm entrypoint not found. Install with `npm i -g command-code` and run `command-code login`.\n",
  );
  process.exit(127);
}

function preflightFailure(opts, run, error) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const detail = stderr || error?.message || "unknown error";
  const message = timedOut
    ? `Command Code version preflight timed out after ${Math.min(parseDuration(opts.timeout), VERSION_TIMEOUT_MS)}ms; Command Code was not dispatched`
    : `Command Code version preflight failed; Command Code was not dispatched: ${detail}`;
  const result = writeResult(opts, null, run, {
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    resultSubtype: null,
    sessionId: null,
    stopReason: null,
    finalMessage: "",
    usage: null,
    durationMs: null,
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split(/\r?\n/).slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatch(opts, brief, version, run) {
  const maxNdjsonLineChars = 16 * 1024 * 1024;
  const readOnly = opts.autonomy === "read-only";
  const beforeGit = gitState(opts.gitPath, opts.cd, readOnly);
  const gitPreflightError = beforeGit?.unsupportedReason
    ?? (!beforeGit ? "target must be a readable git working tree" : null);
  if (gitPreflightError) {
    const result = writeResult(opts, version, run, {
      status: "failed",
      exitCode: 1,
      signal: null,
      resultSubtype: null,
      sessionId: null,
      stopReason: null,
      finalMessage: "",
      usage: null,
      durationMs: null,
      initialTouchedFiles: null,
      touchedFiles: null,
      gitHeadBefore: null,
      gitHeadAfter: null,
      gitHeadChanged: null,
      gitIndexChanged: null,
      gitMutationViolation: null,
      ...(readOnly ? { readOnlyViolation: null } : {}),
      error: gitPreflightError,
    });
    printSummary(result, run.resultPath);
    process.exitCode = 1;
    return;
  }
  const beforeTree = beforeGit?.touchedFiles ?? null;
  const argv = buildArgv(opts);
  const child = spawnCommandCode(opts.commandCodePath, argv, {
    cwd: opts.cd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let resultFrame = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let launchError = null;
  let runtimeError = null;
  let abortSignal = null;
  let watchdogFired = false;
  let forceKillTimer = null;
  const decoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const signalHandlers = new Map();

  const terminateForError = (error) => {
    if (runtimeError || abortSignal) return;
    runtimeError = error instanceof Error ? error : new Error(String(error));
    killChild(child);
    forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };

  for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (abortSignal) return;
      abortSignal = signalName;
      killChild(child);
      forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    };
    signalHandlers.set(signalName, handler);
    process.once(signalName, handler);
  }

  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    killChild(child);
    forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), 10_000);
  }, parseDuration(opts.timeout));

  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const frame = JSON.parse(line);
      if (frame?.type === "result") resultFrame = frame;
    } catch {
      // Preserve unknown output in events.jsonl; absence of a result frame
      // turns the run into a failure below.
    }
  };

  child.stdout.on("data", (chunk) => {
    if (runtimeError) return;
    try {
      const text = decoder.write(chunk);
      appendFileSync(run.eventsPath, chunk);
      stdoutBuffer += text;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        consumeLine(stdoutBuffer.slice(0, newline).replace(/\r$/, ""));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
      if (stdoutBuffer.length > maxNdjsonLineChars) {
        terminateForError(new Error("Command Code NDJSON line exceeded 16 MiB"));
      }
    } catch (error) {
      terminateForError(new Error(`failed to capture Command Code stdout: ${error.message}`));
    }
  });

  child.stderr.on("data", (chunk) => {
    if (runtimeError) return;
    try {
      appendFileSync(run.stderrPath, chunk);
      stderrBuffer = `${stderrBuffer}${stderrDecoder.write(chunk)}`.slice(-16_384);
    } catch (error) {
      terminateForError(new Error(`failed to capture Command Code stderr: ${error.message}`));
    }
  });

  child.stdout.on("error", (error) => {
    terminateForError(new Error(`Command Code stdout stream failed: ${error.message}`));
  });

  child.stderr.on("error", (error) => {
    terminateForError(new Error(`Command Code stderr stream failed: ${error.message}`));
  });

  child.on("error", (error) => {
    launchError = error;
  });

  child.stdin.on("error", (error) => {
    terminateForError(new Error(`stdin delivery failed: ${error.code ?? error.message}`));
  });
  try {
    child.stdin.end(brief);
  } catch (error) {
    terminateForError(new Error(`stdin delivery failed: ${error.code ?? error.message}`));
  }

  child.on("close", (code, signal) => {
    clearTimeout(watchdogTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (watchdogFired || abortSignal || runtimeError) killChild(child, "SIGKILL");
    for (const [signalName, handler] of signalHandlers) {
      process.removeListener(signalName, handler);
    }
    const tail = decoder.end();
    if (tail) {
      appendFileSync(run.eventsPath, tail, "utf8");
      stdoutBuffer += tail;
    }
    if (stdoutBuffer) consumeLine(stdoutBuffer.replace(/\r$/, ""));
    stderrBuffer = `${stderrBuffer}${stderrDecoder.end()}`.slice(-16_384);

    const finalMessage = typeof resultFrame?.finalText === "string"
      ? resultFrame.finalText
      : "";
    if (resultFrame) {
      writeFileSync(run.finalPath, finalMessage, { encoding: "utf8", mode: 0o600 });
    }

    const cliExitCode = abortSignal
      ? signalExitCode(abortSignal)
      : signal
        ? signalExitCode(signal)
        : (code ?? 1);
    const afterGit = gitState(opts.gitPath, opts.cd, readOnly);
    const touchedFiles = readOnly && beforeGit.workspace && afterGit?.workspace
      ? changedFiles(beforeGit.workspace, afterGit.workspace)
      : readOnly ? null : afterGit?.touchedFiles ?? null;
    const gitHeadChanged = beforeGit && afterGit
      ? beforeGit.head !== afterGit.head
      : null;
    const gitIndexChanged = beforeGit && afterGit
      ? beforeGit.indexHash !== afterGit.indexHash
      : null;
    const gitMutationViolation = gitHeadChanged === null || gitIndexChanged === null
      ? null
      : gitHeadChanged || gitIndexChanged;
    const readOnlyViolation = opts.autonomy === "read-only"
      ? beforeGit.worktreeHash === null
        || afterGit === null
        || afterGit.worktreeHash === null
        ? null
        : beforeGit.worktreeHash !== afterGit.worktreeHash
      : undefined;
    const completed = !abortSignal
      && !watchdogFired
      && !launchError
      && !runtimeError
      && cliExitCode === 0
      && validSuccessFrame(resultFrame)
      && gitMutationViolation === false
      && (!readOnly || readOnlyViolation === false);
    const exitCode = completed ? 0 : (cliExitCode || 1);

    const extra = {
      status: abortSignal ? "aborted" : watchdogFired ? "timeout" : completed ? "completed" : "failed",
      exitCode,
      signal: abortSignal ?? signal,
      resultSubtype: resultFrame?.subtype ?? null,
      sessionId: resultFrame?.sessionId ?? null,
      stopReason: resultFrame?.stopReason ?? null,
      finalMessage,
      usage: resultFrame?.usage ?? null,
      durationMs: resultFrame?.durationMs ?? null,
      initialTouchedFiles: beforeTree,
      touchedFiles,
      gitHeadBefore: beforeGit?.head ?? null,
      gitHeadAfter: afterGit?.head ?? null,
      gitHeadChanged,
      gitIndexChanged,
      gitMutationViolation,
      gitWorktreeHashBefore: beforeGit.worktreeHash,
      gitWorktreeHashAfter: afterGit?.worktreeHash ?? null,
      ...(opts.autonomy === "read-only" ? { readOnlyViolation } : {}),
      ...(!completed && stderrBuffer.trim() ? { stderrTail: stderrTail(stderrBuffer) } : {}),
      ...(!completed ? {
        error: dispatchFailure({
          abortSignal,
          watchdogFired,
          timeout: opts.timeout,
          cliExitCode,
          launchError,
          runtimeError,
          gitMutationViolation,
          readOnly,
          readOnlyViolation,
          resultFrame,
        }),
      } : {}),
    };

    const result = writeResult(opts, version, run, extra);
    printSummary(result, run.resultPath);
    process.exitCode = exitCode;
  });
}

const opts = parseArgs(process.argv.slice(2));
const brief = readBrief(opts);
const run = prepareRun(opts, brief);
const commandCode = resolveCommandCode();
if (!commandCode) unavailable(opts, run);
opts.commandCodeShimPath = commandCode.shimPath;
opts.commandCodePath = commandCode.entrypointPath;
if (isInside(opts.cd, opts.commandCodePath)) {
  preflightFailure(opts, run, new Error("resolved Command Code entrypoint is inside target workspace"));
}
opts.gitPath = resolveExecutable("git");
if (!opts.gitPath || isInside(opts.cd, opts.gitPath)) {
  opts.gitPath = null;
  preflightFailure(opts, run, new Error("trusted git executable not found outside target workspace"));
}
let version;
try {
  version = commandCodeVersion(opts.commandCodePath, parseDuration(opts.timeout));
  if (!version) throw new Error("Command Code version probe returned empty output");
} catch (error) {
  preflightFailure(opts, run, error);
}
dispatch(opts, brief, version, run);
