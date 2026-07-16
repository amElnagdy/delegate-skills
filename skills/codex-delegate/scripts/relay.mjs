#!/usr/bin/env node
/**
 * delegate-skills · codex-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenAI Codex CLI (`codex exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Codex-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codex` and `git`. The `codex` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Whether Codex's sandbox can write `.git`
 * varies by Codex version, OS, and execution path, so committing is always the
 * orchestrator's job — after it reviews the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Codex (default: current directory).
 *   --model <name>          Codex model (default: Codex's own configured default).
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           (Inherits the original session's sandbox and working root.)
 *   --skip-git-repo-check   Allow running outside a git repository.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain, null if git can't report), and the paths to
 *   events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127;
 * otherwise the exit code mirrors Codex's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or codex_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    sandbox: "workspace-write",
    resumeLast: false,
    skipGitRepoCheck: false,
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
      case "--sandbox": opts.sandbox = next(); break;
      case "--read-only": opts.sandbox = "read-only"; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--skip-git-repo-check": opts.skipGitRepoCheck = true; break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (!SANDBOX_MODES.has(opts.sandbox)) {
    fail(`invalid --sandbox "${opts.sandbox}" (expected: ${[...SANDBOX_MODES].join(", ")})`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to codex exec\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
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

function codexVersion() {
  try {
    // On Windows, npm installs `codex` as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
    // ENOENTs on a working install. POSIX is unaffected. (git installs a real
    // git.exe and must NOT get this flag — see gitTouchedFiles.)
    return execFileSync("codex", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report — git missing, or a non-repo run under
  // --skip-git-repo-check — so the caller can tell "git unavailable" apart from
  // "Codex changed nothing." [] means git ran and the working tree is clean.
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

function buildArgv(opts, finalPath) {
  const argv = ["exec"];
  if (opts.resumeLast) argv.push("resume", "--last");
  // ponytail: shell:true on win32 (needed for the codex.cmd shim) doesn't quote
  // args, so a temp path with spaces (C:\Users\First Last\...) splits and the
  // trailing "-" misparses (issue #3). Quote the only spaceable arg in argv.
  // Ceiling: if quoting proves too blunt, drop shell:true and resolve the shim.
  const outPath = process.platform === "win32" ? `"${finalPath}"` : finalPath;
  argv.push("--json", "-o", outPath);
  // `-s`/`-C` are not accepted by `exec resume`; resume inherits the original
  // session's sandbox and working root, and we set the child process cwd below.
  if (!opts.resumeLast) {
    argv.push("-s", opts.sandbox);
  }
  if (opts.model) argv.push("-m", opts.model);
  if (opts.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  argv.push("-"); // read the prompt from stdin
  return argv;
}

function extractThreadId(event) {
  return (
    event.thread_id ??
    event.threadId ??
    (event.thread && (event.thread.thread_id ?? event.thread.id)) ??
    null
  );
}

function recordEventLine(eventsPath, line) {
  // Append one stdout line to the event log and pull a thread id from it when the
  // line is a JSON event. Non-JSON progress lines (and a newline-less final line)
  // are preserved in events.jsonl regardless; they just carry no thread id.
  appendFileSync(eventsPath, `${line}\n`, "utf8");
  try {
    return extractThreadId(JSON.parse(line));
  } catch {
    return null;
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Codex's edits, not relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      workdir: opts.cd,
      sandbox: opts.resumeLast ? "(inherited from resumed session)" : opts.sandbox,
      model: opts.model,
      resumeLast: opts.resumeLast,
      codexVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({ status: "codex_unavailable", exitCode: 127, signal: null, threadId: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `codex` not found on PATH. Install it (npm i -g @openai/codex) and run `codex login`.\n");
  process.exit(127);
}

function dispatchToCodex(opts, brief, run, writeResult) {
  const argv = buildArgv(opts, run.finalPath);
  // shell:true on Windows so the codex.cmd shim resolves (see codexVersion). Safe:
  // the brief is fed via child.stdin below — never argv — and argv holds only
  // sandbox enums, model names, and file paths, with no shell metacharacters.
  const child = spawn("codex", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });

  let threadId = null;
  let stdoutBuf = "";
  const stderrTail = [];

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      const tid = recordEventLine(run.eventsPath, line);
      if (tid) threadId = tid;
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface Codex progress live for the orchestrator
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  let settled = false;
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    const result = writeResult({ status: "failed", exitCode: 1, signal: null, threadId, finalMessage: "", touchedFiles: gitTouchedFiles(opts.cd), error: String(err && err.message ? err.message : err) });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    if (stdoutBuf.trim()) {
      const tid = recordEventLine(run.eventsPath, stdoutBuf);
      if (tid) threadId = tid;
    }
    const finalMessage = existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8").trim() : "";
    const result = writeResult({
      status: code === 0 ? "completed" : "failed",
      exitCode: code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1),
      signal: signal ?? null,
      threadId,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(code === 0 ? {} : { stderrTail: stderrTail.slice(-20) }),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  // If the child failed to launch, writing to its stdin can emit a stray 'error'
  // on the pipe; the 'error' handler above owns that outcome, so swallow it here.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const version = codexVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToCodex(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  codex ${result.codexVersion ?? "?"}`);
  if (result.signal === "SIGKILL") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a codex error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.resumeLast) lines.push("mode: resumed most recent session");
  if (result.threadId) lines.push(`thread id (resume with: codex exec resume ${result.threadId}): ${result.threadId}`);
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
  lines.push("--- codex final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
