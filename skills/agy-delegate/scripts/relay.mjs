#!/usr/bin/env node
/**
 * delegate-skills · agy-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Google Antigravity CLI (`agy --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON -
 * every Antigravity-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against agy CLI 1.0.16 on macOS.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `agy` and `git`. The `agy` process it launches
 * does authenticate - exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `agy --print` takes the prompt as a command-line argument, so the brief is
 * visible in the host process list (`ps`, /proc). On a shared machine keep secrets
 * out of the brief - reference them by a path or env var the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job -
 * after it reviews the diff and re-runs the project gates.
 *
 * Antigravity owns its own permission policy. This helper does not pass
 * --dangerously-skip-permissions by default; opt into that flag only when the
 * human explicitly accepts it. Pass --sandbox to enable Antigravity's terminal
 * sandbox for the run. Combining both flags must be treated as full access because
 * permission requests to act outside the sandbox may be auto-approved.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Antigravity (default: current directory).
 *   --model <name>          Antigravity model label (default: agy's configured default).
 *   --project <id>          Use an existing Antigravity project.
 *   --new-project           Force a fresh Antigravity project (default for fresh runs).
 *   --resume-last           Continue the most recent Antigravity conversation; send only the delta brief.
 *   --conversation <id>     Continue a specific Antigravity conversation; send only the delta brief.
 *   --sandbox               Enable Antigravity's terminal sandbox for this run.
 *   --dangerously-skip-permissions
 *                           Auto-approve Antigravity tool permission requests. Use only with human approval.
 *   --print-timeout <dur>   Timeout for print mode (default: 30m).
 *   --add-dir <dir>         Add an extra workspace directory. Repeatable.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, agyVersion, projectId, conversationId, finalMessage
 *   (Antigravity's own report), touchedFiles (git porcelain, null if git can't report), and the
 *   paths to brief.txt, final.txt, agy.log, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `agy` binary exits 127;
 * otherwise the exit code mirrors Antigravity's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome -
 * completed, failed, or agy_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_PRINT_TIMEOUT = "30m";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    project: null,
    newProject: false,
    resumeLast: false,
    conversation: null,
    sandbox: false,
    dangerouslySkipPermissions: false,
    printTimeout: DEFAULT_PRINT_TIMEOUT,
    addDirs: [],
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
      case "--project": opts.project = next(); break;
      case "--new-project": opts.newProject = true; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--conversation": opts.conversation = next(); break;
      case "--sandbox": opts.sandbox = true; break;
      case "--dangerously-skip-permissions": opts.dangerouslySkipPermissions = true; break;
      case "--print-timeout": opts.printTimeout = next(); break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.resumeLast && opts.conversation) {
    fail("--resume-last and --conversation are mutually exclusive; pass only one");
  }
  if (opts.project && (opts.resumeLast || opts.conversation)) {
    fail("--project cannot be combined with --resume-last or --conversation");
  }
  if (opts.project && opts.newProject) {
    fail("--project and --new-project are mutually exclusive");
  }
  if (opts.newProject && (opts.resumeLast || opts.conversation)) {
    fail("--new-project cannot be combined with --resume-last or --conversation");
  }
  // agy requires absolute --add-dir paths; resolve a relative one against --cd
  // (not the relay's own cwd) - and only after the loop, since --add-dir may
  // appear before --cd on the command line. resolve() passes absolutes through.
  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to agy --print\n";
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

function agyVersion() {
  try {
    const out = execFileSync("agy", ["changelog"], { encoding: "utf8" }).trim();
    const firstLine = out.split("\n").find(Boolean) || "";
    const match = firstLine.match(/^([^:\s]+):/);
    return match ? match[1] : firstLine || null;
  } catch (err) {
    // Only a missing binary means "unavailable"; any other changelog failure
    // (permissions, a broken subcommand) must not masquerade as exit 127.
    if (err && err.code === "ENOENT") return null;
    return "unknown";
  }
}

function parseDuration(duration) {
  let milliseconds = 0;
  let matched = false;
  for (const match of duration.matchAll(/(\d+)h|(\d+)m|(\d+)s/g)) {
    matched = true;
    if (match[1]) milliseconds += Number(match[1]) * 60 * 60 * 1000;
    if (match[2]) milliseconds += Number(match[2]) * 60 * 1000;
    if (match[3]) milliseconds += Number(match[3]) * 1000;
  }
  return matched ? milliseconds : null;
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report - git missing, or a non-repo run - so the
  // caller can tell "git unavailable" apart from "Antigravity changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    logPath: join(outDir, "agy.log"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function buildArgv(opts, brief, run) {
  const argv = [];
  if (opts.project) {
    argv.push("--project", opts.project);
  } else if (opts.conversation) {
    argv.push("--conversation", opts.conversation);
  } else if (opts.resumeLast) {
    argv.push("--continue");
  } else {
    argv.push("--new-project");
  }

  if (!opts.resumeLast && !opts.conversation) {
    // The disposable smoke showed that relying on cwd alone can produce a false
    // "I created the file" response, so pin the workspace explicitly. agy requires
    // an absolute path here (it rejects "." as non-absolute); opts.cd is already
    // resolve()d, and an argv-array element carries spaces fine without a shell.
    argv.push("--add-dir", opts.cd);
    for (const dir of opts.addDirs) argv.push("--add-dir", dir);
  }
  if (opts.model) argv.push("--model", opts.model);
  if (opts.sandbox) argv.push("--sandbox");
  if (opts.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (opts.printTimeout) argv.push("--print-timeout", opts.printTimeout);
  argv.push("--log-file", run.logPath);
  // Use the --print=<brief> form, not a separate ["--print", brief] pair: agy's flag
  // parser intercepts a value that is exactly a bare flag (a brief consisting only of
  // "--help" or "-h" prints usage instead of running). The = form always binds the value.
  argv.push(`--print=${brief}`);
  return argv;
}

function parseIdsFromLog(logPath) {
  if (!existsSync(logPath)) return { projectId: null, conversationId: null };
  const text = readFileSync(logPath, "utf8");
  const projectMatches = [
    /project: created project "[^"]*" \(id=([0-9a-f-]+)\)/i,
    /Conversation using project ID: ([0-9a-f-]+)/i,
    /Backend project ID updated dynamically to: ([0-9a-f-]+)/i,
  ];
  const conversationMatches = [
    /Print mode: conversation=([0-9a-f-]+)/i,
    /Created conversation ([0-9a-f-]+)/i,
  ];
  const firstMatch = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  };
  return {
    projectId: firstMatch(projectMatches),
    conversationId: firstMatch(conversationMatches),
  };
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const ids = parseIdsFromLog(run.logPath);
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "agy",
      workdir: opts.cd,
      model: opts.model,
      project: opts.project,
      sandbox: opts.sandbox,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      resumed: Boolean(opts.resumeLast || opts.conversation),
      agyVersion: version,
      projectId: ids.projectId,
      conversationId: ids.conversationId,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      logPath: existsSync(run.logPath) ? run.logPath : null,
      stderrPath: run.stderrPath,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({ status: "agy_unavailable", exitCode: 127, signal: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `agy` not found on PATH. Install the Antigravity CLI and complete first-launch setup.\n");
  process.exit(127);
}

function dispatchToAgy(opts, brief, run, writeResult) {
  const argv = buildArgv(opts, brief, run);
  const timeoutMs = parseDuration(opts.printTimeout) ?? parseDuration(DEFAULT_PRINT_TIMEOUT);
  // Antigravity's installer provides a native `agy` binary. Launch directly so
  // multi-line briefs and paths with spaces are passed as argv, not shell text.
  const child = spawn("agy", argv, {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  const stderrTail = [];
  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000);
  }, timeoutMs + 60_000);

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += stdoutDecoder.write(chunk);
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

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const finalMessage = stdout.trim();
    if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
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
    const finalMessage = stdout.trim();
    if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
    // A timed-out run is failed even if agy handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult({
      status: succeeded ? "completed" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `agy did not exit within --print-timeout ${opts.printTimeout} plus 60s grace; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // agy --print takes the prompt as a CLI argument, so the brief rides argv. The OS caps a
  // single argument (~128KB on Linux via MAX_ARG_STRLEN), so a huge brief would fail to spawn
  // with an opaque E2BIG. Reject it early with a clear message instead of a generic failure.
  const briefBytes = Buffer.byteLength(brief, "utf8");
  const MAX_BRIEF_BYTES = 120 * 1024;
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; agy passes the prompt as a CLI argument, which the OS caps (~128KB on Linux). Trim it, or have agy read large context from the workspace instead of inlining it.`);
  }

  const version = agyVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToAgy(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  agy ${result.agyVersion ?? "?"}`);
  if (result.signal === "SIGKILL") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not an agy error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.resumed) lines.push("mode: resumed an existing conversation");
  if (result.projectId) lines.push(`project id: ${result.projectId}`);
  if (result.conversationId) lines.push(`conversation id (resume with: --conversation ${result.conversationId}): ${result.conversationId}`);
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
  lines.push("--- agy final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
