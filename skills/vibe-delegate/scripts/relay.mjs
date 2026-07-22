#!/usr/bin/env node
/**
 * delegate-skills · vibe-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Mistral Vibe CLI (`vibe --prompt`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Vibe-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `vibe` and `git`. The `vibe` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `vibe --prompt` takes the prompt as a command-line argument, so the
 * brief is visible in the host process list (`ps`, /proc). On a shared machine
 * keep secrets out of the brief — reference them by a path or environment
 * variable the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Default mode uses Vibe's `auto-approve` agent profile, which auto-approves
 * all tool executions. `--plan-only` uses the `plan` agent (exploration and
 * planning, auto-approves only safe read tools); this is best-effort — check
 * `touchedFiles` and the diff after every run regardless of mode.
 *
 * Mistral Vibe works on Windows, but the upstream project officially targets
 * UNIX environments. The relay does not set `shell:true` on win32, so Windows
 * is untested; consult the Mistral Vibe documentation for Windows guidance.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>           Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>               Working root for Vibe (default: current directory).
 *   --max-turns <n>          Maximum number of Vibe agent turns (--max-turns).
 *   --session <id>           Resume a specific Vibe session (--resume SESSION_ID);
 *                            send only the delta brief.
 *   --resume-last            Resume the most recent Vibe session (--continue);
 *                            send only the delta brief.
 *   --plan-only              Use Vibe's plan agent (exploration/planning, best-
 *                            effort read-only — verify touchedFiles after run).
 *   --enabled-tools <tool>   Enable only this tool (--enabled-tools). Repeatable.
 *   --disabled-tools <tool>  Disable this tool (--disabled-tools). Repeatable.
 *   --timeout <dur>          Relay-side watchdog (default: 30m). Vibe has no
 *                            timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>          Where to write run artifacts (default: a fresh dir
 *                            under the system temp dir).
 *   -h, --help               Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, vibeVersion, sessionId, finalMessage (Vibe's own
 *   report), touchedFiles (git porcelain, null if git cannot report), and paths
 *   to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `vibe` binary exits 127;
 * otherwise the exit code mirrors Vibe's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, or vibe_unavailable.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    maxTurns: null,
    session: null,
    resumeLast: false,
    planOnly: false,
    enabledTools: [],
    disabledTools: [],
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
      case "--max-turns": {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) fail(`--max-turns must be a positive integer; got: ${v}`);
        opts.maxTurns = n;
        break;
      }
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--plan-only": opts.planOnly = true; break;
      case "--enabled-tools": opts.enabledTools.push(next()); break;
      case "--disabled-tools": opts.disabledTools.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  // The watchdog is relay-only (vibe has no timeout flag), so a malformed
  // --timeout must fail loudly here — a silent 30m fallback would be wrong.
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to vibe --prompt\n";
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

function vibeVersion() {
  try {
    const out = execFileSync("vibe", ["--version"], { encoding: "utf8" }).trim();
    return out || "unknown";
  } catch (err) {
    // Only a missing binary means "unavailable"; any other version-probe
    // failure must not masquerade as exit 127.
    if (err && err.code === "ENOENT") return null;
    return "unknown";
  }
}

function parseDuration(duration) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute.
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function gitTouchedFiles(cwd) {
  // null (not []) when git cannot report — git missing, or a non-repo run — so
  // the caller can tell "git unavailable" apart from "Vibe changed nothing."
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

function buildArgv(opts, brief) {
  const argv = [
    "--output", "streaming",
    "--agent", opts.planOnly ? "plan" : "auto-approve",
    "--trust",
  ];
  if (opts.maxTurns != null) argv.push("--max-turns", String(opts.maxTurns));
  if (opts.session) argv.push("--resume", opts.session);
  else if (opts.resumeLast) argv.push("--continue");
  for (const tool of opts.enabledTools) argv.push("--enabled-tools", tool);
  for (const tool of opts.disabledTools) argv.push("--disabled-tools", tool);
  // Use --prompt=<brief>, not a separate ["--prompt", brief] pair: the equals
  // form binds a brief that starts with "-" instead of letting it parse as a flag.
  argv.push(`--prompt=${brief}`);
  return argv;
}

function makeLineScanner(onObject) {
  // Vibe's --output streaming emits newline-delimited JSON: one JSON object per
  // line. Parse line by line; skip blank lines and non-JSON gracefully.
  let buf = "";
  return (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onObject(JSON.parse(trimmed)); } catch { /* skip non-JSON lines */ }
    }
  };
}

function extractFromEvent(obj, textChunks, sessionIdRef) {
  if (!obj || typeof obj !== "object") return;

  // Session ID extraction (best-effort; checked on every event type since the
  // session metadata can appear in any message).
  if (typeof obj.session_id === "string" && obj.session_id) {
    sessionIdRef.value = obj.session_id;
  } else if (obj.metadata && typeof obj.metadata.session_id === "string") {
    sessionIdRef.value = obj.metadata.session_id;
  }

  // Primary format: { role: "assistant", content: "..." }
  if (obj.role === "assistant") {
    const content =
      typeof obj.content === "string"
        ? obj.content
        : Array.isArray(obj.content)
          ? obj.content
              .filter((c) => c && c.type === "text")
              .map((c) => (typeof c.text === "string" ? c.text : ""))
              .join("")
          : "";
    if (content) textChunks.push(content);
    return;
  }

  // OpenAI-style streaming delta: { choices: [{ delta: { role: "assistant", content: "..." } }] }
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === "string" && delta.content) {
        textChunks.push(delta.content);
      }
    }
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir =
    opts.outDir ||
    join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
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
      tool: "vibe",
      workdir: opts.cd,
      agent: opts.planOnly ? "plan" : "auto-approve",
      maxTurns: opts.maxTurns,
      resumed: Boolean(opts.resumeLast || opts.session),
      vibeVersion: version,
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
    status: "vibe_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `vibe` not found on PATH. Install with `uv tool install mistral-vibe` and configure MISTRAL_API_KEY.\n",
  );
  process.exit(127);
}

function dispatchToVibe(opts, brief, run, writeResult) {
  const child = spawn("vibe", buildArgv(opts, brief), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const sessionIdRef = { value: null };
  const textChunks = [];
  const stderrTail = [];

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const scan = makeLineScanner((obj) => extractFromEvent(obj, textChunks, sessionIdRef));

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
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

  const assembleFinal = () => {
    const message = textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
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
  }, timeoutMs);

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId: sessionIdRef.value,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
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
    // A timed-out run is failed even if vibe handles SIGTERM by exiting 0 —
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId: sessionIdRef.value,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired
        ? {
            error: `vibe did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`,
          }
        : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // vibe --prompt takes the prompt as a CLI argument, so the brief rides argv.
  // The OS caps one argument (~128KB on Linux via MAX_ARG_STRLEN); reject a
  // huge brief early instead of allowing an opaque E2BIG spawn failure.
  const briefBytes = Buffer.byteLength(brief, "utf8");
  const MAX_BRIEF_BYTES = 120 * 1024;
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(
      `brief is ${Math.round(briefBytes / 1024)}KB; vibe passes the prompt as a CLI argument, which the OS caps (~128KB on Linux). Trim it, or have vibe read large context from the workspace instead of inlining it.`,
    );
  }

  const version = vibeVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);
  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  dispatchToVibe(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  vibe ${result.vibeVersion ?? "?"}`,
  );
  if (result.signal === "SIGKILL") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a vibe error; check host memory and re-dispatch, or split the task into smaller briefs.",
    );
  }
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  }
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
  lines.push("--- vibe final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push(
    "relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
