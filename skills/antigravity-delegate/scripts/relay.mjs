#!/usr/bin/env node
/**
 * delegate-skills · antigravity-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Antigravity CLI (`agy --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Antigravity-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against agy 1.1.1.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `agy` and `git`, and reads one local agy cache
 * file (last_conversations.json) to report the conversation id for resume.
 * The `agy` process it launches does authenticate — exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Two verified agy behaviors shape this relay:
 *   1. The working root must be added to agy's workspace with --add-dir, or agy
 *      does its work in its own scratch directory instead of the repo. The relay
 *      always passes --add-dir for the working root.
 *   2. There is NO enforced read-only mode: `--mode plan` can still write the
 *      working tree (verified). This relay therefore has no --read-only flag and
 *      treats every run as write-capable — work on a branch or snapshot first if
 *      you need isolation.
 *
 * Permissions auto-approve by default: the relay passes agy's
 * `--dangerously-skip-permissions` so a headless run never blocks on a prompt no
 * one can answer; the orchestrator's diff review is the safety net. Pass
 * --no-skip-permissions to withhold it and rely on agy's own defaults (which
 * already allow workspace file edits and safe commands headlessly, but may
 * refuse riskier commands).
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *                           (Read by the relay; agy itself receives it as the --print value.)
 *   --cd <dir>              Working root for agy (default: current directory). Passed as
 *                           --add-dir and used as the working directory.
 *   --model <name>          Antigravity model (default: agy's own configured default;
 *                           `agy models` lists the choices).
 *   --no-skip-permissions   Don't pass `--dangerously-skip-permissions`; rely on agy's
 *                           own permission defaults instead.
 *   --timeout <duration>    agy --print-timeout value, Go duration format (default: 60m —
 *                           agy's own 5m default is too short for real delegated tasks).
 *   --resume-last           Continue the working root's most recent agy conversation;
 *                           send only the delta brief.
 *   --conversation <id>     Continue a specific conversation id; send only the delta brief.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, agyVersion, conversationId (for a later resume, best-effort),
 *   finalMessage (agy's printed response — plain text; agy has no JSON output mode),
 *   touchedFiles (git porcelain, null if git can't report), and the path to final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `agy` binary exits 127;
 * otherwise the exit code mirrors agy's own (0 success, non-zero failure; a
 * --print-timeout expiry exits 1 with "Error: timeout waiting for response").
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or agy_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir, homedir } from "node:os";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    skipPermissions: true,
    timeout: "60m",
    resumeLast: false,
    conversation: null,
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
      case "--no-skip-permissions": opts.skipPermissions = false; break;
      case "--timeout": opts.timeout = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--conversation": opts.conversation = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      case "--read-only":
        // Refused on purpose, not unimplemented: agy has no enforced read-only —
        // `--mode plan` was verified to still write the working tree, so offering
        // a --read-only flag here would be a false promise.
        fail("agy has no enforced read-only mode (a plan-mode run can still write the tree); treat every dispatch as write-capable — work on a branch or stash first if you need isolation");
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to agy --print\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
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
    // agy ships as a real native binary on every platform (curl/PowerShell
    // installer, never an npm .cmd shim), so no shell:true is needed anywhere —
    // and it must stay off: the brief travels in argv (agy --print takes the
    // prompt as a value, it does not read stdin), and a shell would mangle a
    // multi-line XML brief.
    return execFileSync("agy", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report — git missing, or a non-repo run — so the
  // caller can tell "git unavailable" apart from "agy changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  // Local script (not a workflow): Date is available and fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts, brief) {
  // --add-dir is not optional: without the working root in agy's workspace, agy
  // does the work in its own scratch directory (~/.gemini/antigravity-cli/scratch)
  // and the repo never changes (verified).
  const argv = ["--add-dir", opts.cd, "--print-timeout", opts.timeout];
  if (opts.conversation) {
    argv.push("--conversation", opts.conversation);
  } else if (opts.resumeLast) {
    argv.push("--continue");
  }
  if (opts.model) argv.push("--model", opts.model);
  if (opts.skipPermissions) argv.push("--dangerously-skip-permissions");
  // The brief is the value of --print — agy's non-interactive mode takes the
  // prompt as an argument and does not read stdin. spawn() passes it as a single
  // argv entry with no shell involved, so multi-line XML briefs need no quoting.
  argv.push("--print", brief);
  return argv;
}

function conversationIdFor(cd) {
  // Best-effort: agy records each directory's most recent conversation id in a
  // local cache. Reading it lets result.json carry the id for a later
  // --conversation resume. Absent or reshaped cache → null, never an error.
  try {
    const cachePath = join(homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
    const map = JSON.parse(readFileSync(cachePath, "utf8"));
    if (map[cd]) return map[cd];
    // agy stores the fully-resolved path (e.g. /private/tmp on macOS, not /tmp).
    const real = realpathSync(cd);
    return map[real] || null;
  } catch {
    return null;
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only agy's edits, not relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "agy",
      workdir: opts.cd,
      model: opts.model,
      skipPermissions: opts.skipPermissions,
      timeout: opts.timeout,
      resumeLast: opts.resumeLast,
      agyVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({ status: "agy_unavailable", exitCode: 127, conversationId: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `agy` not found on PATH. Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash) and sign in on first run.\n");
  process.exit(127);
}

function dispatchToAgy(opts, brief, run, writeResult) {
  const argv = buildArgv(opts, brief);
  // Pin the working root two ways: `cwd` sets the child's real directory (agy
  // keys its per-directory conversation history on it, which is what makes
  // --resume-last pick up this repo's conversation), and PWD is set explicitly
  // because spawn does NOT rewrite the inherited PWD env.
  // No shell anywhere: the brief travels as one argv entry (see agyVersion).
  const child = spawn("agy", argv, {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  const stderrTail = [];

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface agy progress live for the orchestrator
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = stdoutBuf.trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  child.on("error", (err) => {
    const result = writeResult({ status: "failed", exitCode: 1, conversationId: conversationIdFor(opts.cd), finalMessage: assembleFinal(), touchedFiles: gitTouchedFiles(opts.cd), error: String(err && err.message ? err.message : err) });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code) => {
    const finalMessage = assembleFinal();
    const result = writeResult({
      status: code === 0 ? "completed" : "failed",
      exitCode: code === null ? 1 : code,
      conversationId: conversationIdFor(opts.cd),
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(code === 0 ? {} : { stderrTail: stderrTail.slice(-20) }),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  // --conversation pins a specific conversation and --resume-last picks the working root's most
  // recent; passing both is a contradiction, and buildArgv would silently prefer --conversation.
  if (opts.conversation && opts.resumeLast) {
    fail("--conversation and --resume-last are mutually exclusive; pass only one");
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
  lines.push(`relay: ${result.status} (exit ${result.exitCode})  ·  agy ${result.agyVersion ?? "?"}`);
  if (result.resumeLast) lines.push("mode: resumed the working root's most recent conversation");
  if (result.conversationId) lines.push(`conversation id (resume with: --conversation ${result.conversationId}): ${result.conversationId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
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
