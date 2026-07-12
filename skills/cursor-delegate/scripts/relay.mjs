#!/usr/bin/env node
/**
 * delegate-skills · cursor-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cursor CLI (`cursor-agent --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Cursor-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against cursor-agent 2026.07.09.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cursor-agent` and `git`. The `cursor-agent`
 * process it launches does authenticate — exactly as you do at the terminal.
 * Read this file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Cursor's headless permissions (verified): file edits are applied without
 * prompting, but shell commands only auto-run under `--force`. A write run
 * passes `--force` by default so the brief's gate commands (tests, lint) don't
 * silently get skipped; the orchestrator's diff review is the safety net. Pass
 * --no-force to withhold it — cursor-agent then refuses approval-gated commands
 * rather than prompting (headless runs never prompt).
 * A plan (read-only) run never gets --force, and `--mode plan` is enforced by
 * cursor-agent itself (verified: a plan run cannot write the tree).
 * Every run gets `--trust`: headless dispatch into a workspace is itself the
 * trust decision, made by the human who opted into delegation.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for cursor-agent (default: current directory).
 *   --model <name>          Cursor model (default: the account's configured default;
 *                           `cursor-agent models` lists the choices).
 *   --read-only             Run with `--mode plan` (review/diagnosis, no edits — enforced
 *                           by cursor-agent).
 *   --no-force              Don't pass `--force`; approval-gated shell commands are then
 *                           refused instead of auto-run (a headless run never prompts).
 *   --resume-last           Continue the most recent cursor-agent session; send only the
 *                           delta brief.
 *   --session <id>          Continue a specific session id; send only the delta brief.
 *   --timeout <duration>    Run budget, Go duration format (e.g. 90s, 45m, 2h; default: 60m).
 *                           cursor-agent has no timeout flag of its own, so the relay
 *                           terminates a run that exceeds the budget and reports it failed.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, cursorAgentVersion, sessionId (for a later resume), finalMessage
 *   (cursor-agent's own report), touchedFiles (git porcelain, null if git can't report),
 *   usage (token counts), and the paths to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cursor-agent` binary exits 127;
 * otherwise the exit code mirrors cursor-agent's own (0 success, non-zero failure),
 * except that a run which exits 0 while reporting is_error in its result event
 * makes the relay exit 1 — either failure signal means failed.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or cursor_agent_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    readOnly: false,
    force: true,
    resumeLast: false,
    session: null,
    timeout: "60m",
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
      case "--read-only": opts.readOnly = true; break;
      case "--force": opts.force = true; break;
      case "--no-force": opts.force = false; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
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
  if (!match) return "relay.mjs — dispatch a brief to cursor-agent --print\n";
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

function cursorAgentVersion() {
  try {
    // cursor-agent installs as a real binary (curl installer, not an npm .cmd
    // shim), but shell:true on win32 is kept for parity with any shim-wrapped
    // install; argv here is a bare --version, so quoting is a non-issue. (git
    // installs a real git.exe and must NOT get this flag — see gitTouchedFiles.)
    return execFileSync("cursor-agent", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  } catch {
    return null;
  }
}

function parseDurationMs(text) {
  // Go duration format, same as the sibling agy relay's --timeout: "90s", "45m",
  // "2h", "1h30m". Returns milliseconds, or null when the text doesn't parse.
  if (!/^(\d+[hms])+$/.test(text)) return null;
  let ms = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)([hms])/g)) {
    ms += Number(count) * (unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
  }
  return ms;
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report — git missing, or a non-repo run — so the
  // caller can tell "git unavailable" apart from "cursor-agent changed nothing."
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

function buildArgv(opts) {
  const argv = ["--print", "--output-format", "stream-json"];
  // --trust is required for headless work in a not-yet-trusted workspace (without
  // it a fresh workspace prompts, which a headless run can't answer). Dispatching
  // into the workspace is itself the trust decision, so every run gets it.
  argv.push("--trust");
  // Resume continues an existing session; --session pins a specific id, otherwise
  // --continue picks up the most recent one.
  if (opts.session) {
    argv.push("--resume", opts.session);
  } else if (opts.resumeLast) {
    argv.push("--continue");
  }
  // --mode plan is passed on resumed runs too: cursor-agent applies the mode to
  // the new turn, and a read-only rework must stay read-only.
  if (opts.readOnly) argv.push("--mode", "plan");
  // --force (on by default) lets approval-gated shell commands auto-run so the
  // brief's gate commands actually execute; headless file edits are applied even
  // without it (verified). Never on a read-only run: plan mode should not get
  // command approval it cannot use for edits anyway.
  if (opts.force && !opts.readOnly) argv.push("--force");
  if (opts.model) argv.push("--model", opts.model);
  // No prompt argument: the brief is piped on stdin (see dispatchToCursorAgent),
  // which avoids all argv-quoting issues with multi-line, XML-tagged briefs.
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only cursor-agent's edits, not relay's artifacts.
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
      tool: "cursor-agent",
      workdir: opts.cd,
      mode: opts.readOnly ? "plan" : "default",
      force: opts.force && !opts.readOnly,
      model: opts.model,
      timeout: opts.timeout,
      resumeLast: opts.resumeLast,
      cursorAgentVersion: version,
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
  const result = writeResult({ status: "cursor_agent_unavailable", exitCode: 127, sessionId: null, finalMessage: "", touchedFiles: null, usage: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `cursor-agent` not found on PATH. Install it (curl https://cursor.com/install -fsS | bash) and run `cursor-agent login`.\n");
  process.exit(127);
}

function dispatchToCursorAgent(opts, brief, run, writeResult) {
  const argv = buildArgv(opts);
  // Pin the working root two ways: `cwd` sets the child's real directory (which
  // cursor-agent uses as the workspace), and PWD is set explicitly because spawn
  // does NOT rewrite the inherited PWD env — a tool that consults it could
  // otherwise resolve the orchestrator's directory instead of opts.cd.
  // shell:true on win32 for parity with a shim-wrapped install (see
  // cursorAgentVersion). Safe: the brief is fed via child.stdin below — never
  // argv — and argv holds only flag names, a mode enum, a model string, and a
  // session id; main() rejects whitespace in the user-provided values on win32,
  // where the shell would split them.
  const child = spawn("cursor-agent", argv, {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = opts.session || null;
  let resolvedModel = null;
  let resultEvent = null;
  const assistantParts = [];
  const stderrTail = [];
  let stdoutBuf = "";

  // cursor-agent has no run-budget flag of its own (agy has --print-timeout), so
  // the relay enforces one: past the budget the child is terminated and the run
  // reported failed. On win32 with shell:true this kills the wrapping shell;
  // ponytail: a detached grandchild could survive — acceptable for a budget
  // whose job is unblocking the orchestrator, not process hygiene.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, opts.timeoutMs);

  const handleEvent = (event) => {
    if (event.session_id) sessionId = event.session_id;
    // The init event carries the resolved model (useful when --model was omitted
    // and the account default ran).
    if (event.type === "system" && event.subtype === "init" && event.model) resolvedModel = event.model;
    // Assistant text is the fallback report if no result event arrives.
    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      for (const part of event.message.content) {
        if (part && part.type === "text" && part.text) assistantParts.push(part.text);
      }
    }
    // The final `result` event carries cursor-agent's own summary, error flag,
    // and token usage — the authoritative report for result.json.
    if (event.type === "result") resultEvent = event;
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      appendFileSync(run.eventsPath, `${line}\n`, "utf8"); // faithful raw record of the event stream
      try { handleEvent(JSON.parse(line)); } catch { /* non-JSON progress line; kept in events.jsonl */ }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface cursor-agent progress live for the orchestrator
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = (resultEvent && typeof resultEvent.result === "string" && resultEvent.result.trim())
      ? resultEvent.result.trim()
      : assistantParts.join("").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  child.on("error", (err) => {
    clearTimeout(timer);
    const result = writeResult({ status: "failed", exitCode: 1, sessionId, finalMessage: assembleFinal(), touchedFiles: gitTouchedFiles(opts.cd), usage: null, error: String(err && err.message ? err.message : err) });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (stdoutBuf.trim()) {
      appendFileSync(run.eventsPath, `${stdoutBuf}\n`, "utf8");
      try { handleEvent(JSON.parse(stdoutBuf)); } catch { /* non-JSON tail; kept in events.jsonl */ }
    }
    const finalMessage = assembleFinal();
    // A run can exit 0 yet report is_error in its result event; treat either
    // signal — or a relay-enforced timeout — as failure so the orchestrator
    // never mistakes it for success.
    const isError = Boolean(resultEvent && resultEvent.is_error);
    const failed = code !== 0 || isError || timedOut;
    const result = writeResult({
      status: failed ? "failed" : "completed",
      exitCode: code === null ? 1 : code,
      sessionId,
      resolvedModel,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      usage: resultEvent && resultEvent.usage ? resultEvent.usage : null,
      ...(timedOut ? { error: `timed out after ${opts.timeout}; the run was terminated (re-dispatch with a bigger --timeout, or split the brief)` } : {}),
      ...(failed ? { stderrTail: stderrTail.slice(-20) } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode !== 0 ? result.exitCode : (failed ? 1 : 0));
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
  // --session pins a specific session and --resume-last picks the most recent; passing both is a
  // contradiction, and buildArgv would silently prefer --session. Reject it rather than guess.
  if (opts.session && opts.resumeLast) {
    fail("--session and --resume-last are mutually exclusive; pass only one");
  }
  opts.timeoutMs = parseDurationMs(opts.timeout);
  if (opts.timeoutMs === null || opts.timeoutMs <= 0) {
    fail(`invalid --timeout "${opts.timeout}" (Go duration format, e.g. 90s, 45m, 2h)`);
  }
  // On win32 the launch goes through a shell (see dispatchToCursorAgent), which
  // would split a value containing whitespace. Cursor model ids and session ids
  // never legitimately contain it, so reject early instead of mangling silently.
  if (process.platform === "win32") {
    for (const [flag, value] of [["--model", opts.model], ["--session", opts.session]]) {
      if (value && /\s/.test(value)) {
        fail(`${flag} value contains whitespace, which the win32 shell launch would split: "${value}"`);
      }
    }
  }

  const version = cursorAgentVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToCursorAgent(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode})  ·  cursor-agent ${result.cursorAgentVersion ?? "?"}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}`);
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
  lines.push("--- cursor-agent final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
