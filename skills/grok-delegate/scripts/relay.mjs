#!/usr/bin/env node
/**
 * delegate-skills · grok-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Grok Build CLI (`grok --prompt-file`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Grok-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified end-to-end on macOS against grok 0.2.101;
 * other shell-capable agents (Claude Code, Cursor, …) are designed-for but not
 * yet verified there.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `grok` and `git`. The `grok` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Grok's default permission mode is `ask`, which blocks on approval prompts in
 * a non-interactive pipe. The relay therefore sets autonomy explicitly:
 *   default        — `--always-approve --sandbox workspace` (write in CWD)
 *   --read-only    — `--sandbox read-only --permission-mode plan` (review intent)
 *   --full-access  — `--always-approve --sandbox off` (unrestricted; opt-in)
 *
 * `--read-only` is best-effort, NOT a hard guarantee: on grok 0.2.101 the
 * read-only sandbox governs out-of-workspace filesystem/network access, not the
 * agent's own edit tool, and headless `plan` mode is advisory — a determined run
 * can still write the working tree. Always confirm `touchedFiles` after a
 * read-only run; don't rely on the flag alone.
 *
 * The brief is handed to grok via `--prompt-file`, never argv: it stays out of
 * the host process list, isn't bounded by the OS arg-length cap, and a brief
 * that starts with "-" can't be misread as a flag.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Grok (default: current directory).
 *   --model <name>          Grok model (default: Grok's own configured default).
 *   --effort <level>        Reasoning effort for this run (passed as `--effort`).
 *   --max-turns <n>         Maximum number of agent turns for this run.
 *   --read-only             Review/diagnosis with no edits (`--sandbox read-only`).
 *   --full-access           Unrestricted auto-approve (`--sandbox off`); opt-in.
 *   --resume-last           Continue the most recent Grok session for this cwd;
 *                           send only the delta brief.
 *   --session <id>          Continue a specific session id; send only the delta brief.
 *                           Mutually exclusive with --resume-last.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, grokVersion, sessionId (for a later resume), finalMessage
 *   (Grok's own report), usage (token counts from the run's end event, null if
 *   none), touchedFiles (git porcelain, null if git can't report), and the paths
 *   to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `grok` binary exits 127;
 * otherwise the exit code mirrors Grok's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or grok_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const AUTONOMY_MODES = new Set(["workspace-write", "read-only", "full-access"]);

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
    autonomy: "workspace-write",
    resumeLast: false,
    session: null,
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
      case "--effort": opts.effort = next(); break;
      case "--max-turns": opts.maxTurns = next(); break;
      case "--read-only": opts.autonomy = "read-only"; break;
      case "--full-access": opts.autonomy = "full-access"; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (!AUTONOMY_MODES.has(opts.autonomy)) {
    fail(`invalid autonomy "${opts.autonomy}"`);
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive");
  }
  // These values reach a shell on win32 (shell:true for the .cmd shim), so restrict them to safe tokens.
  const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
  for (const flag of ["model", "effort", "session"]) {
    if (opts[flag] !== null && !safeToken.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  // Digits-only also keeps the value safe for the win32 shell launch.
  if (opts.maxTurns !== null && !/^[1-9]\d*$/.test(opts.maxTurns)) {
    fail("--max-turns must be a positive integer");
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to grok --prompt-file\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
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

function grokVersion() {
  try {
    // On Windows, npm installs `grok` as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
    // ENOENTs on a working install. POSIX is unaffected. (git installs a real
    // git.exe and must NOT get this flag — see gitTouchedFiles.)
    // Prefer `grok version` (documented subcommand); fall back to `--version`.
    try {
      return execFileSync("grok", ["version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
    } catch {
      return execFileSync("grok", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
    }
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report — git missing, or a non-repo run —
  // so the caller can tell "git unavailable" apart from "Grok changed nothing."
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

function autonomyFlags(autonomy) {
  // Maps the relay's three autonomy modes onto Grok's native --sandbox /
  // --always-approve / --permission-mode flags. Grok's default permission mode
  // is `ask`, which hangs a headless pipe — so every path sets autonomy
  // explicitly. Sandbox profiles (verified valid on grok 0.2.101):
  //   workspace  — write CWD /tmp ~/.grok/   (workspace-write analog)
  //   read-only  — review intent ONLY; the sandbox restricts out-of-workspace
  //                access, not grok's own edit tool, so a headless run can still
  //                write the tree. Best-effort — verify touchedFiles afterward.
  //   off        — unrestricted              (full-access opt-in)
  switch (autonomy) {
    case "read-only":
      return ["--sandbox", "read-only", "--permission-mode", "plan"];
    case "full-access":
      return ["--always-approve", "--sandbox", "off"];
    case "workspace-write":
    default:
      return ["--always-approve", "--sandbox", "workspace"];
  }
}

function buildArgv(opts, run) {
  // ponytail: shell:true on win32 (needed for the grok.cmd shim) doesn't quote
  // args, so a path with spaces (C:\Users\First Last\...) splits before grok
  // sees it. Quote the two spaceable path args; --model/--effort/--session are
  // already restricted to safe tokens at parse time.
  // Ceiling: if quoting proves too blunt, drop shell:true and resolve the shim.
  const quotePath = (p) => (process.platform === "win32" ? `"${p}"` : p);
  // Always: automation hygiene + structured events + working root.
  const argv = [
    "--no-auto-update",
    "--no-alt-screen",
    "--output-format", "streaming-json",
    "--cwd", quotePath(opts.cd),
  ];

  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push("--resume", opts.session);

  // Re-pass autonomy on resume too — headless permission mode may not inherit.
  argv.push(...autonomyFlags(opts.autonomy));

  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.maxTurns) argv.push("--max-turns", opts.maxTurns);

  // Deliver the brief via a file, not argv: keeps it out of the host process
  // list, isn't bounded by the OS arg-length cap, and a brief that begins with
  // "-" can't be misread as a flag. prepareRunDir already wrote run.briefPath.
  argv.push("--prompt-file", quotePath(run.briefPath));
  return argv;
}

function makeEventScanner(onObject) {
  // streaming-json is documented as newline-delimited JSON, but be defensive:
  // brace-aware scan (same approach as opencode-delegate) tolerates junk prefixes
  // and concatenated objects if the format drifts.
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    buf += chunk;
    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { if (depth > 0) inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            const slice = buf.slice(start, i + 1);
            try { onObject(JSON.parse(slice)); } catch { /* ignore non-objects */ }
            start = -1;
          }
        }
      }
    }
    buf = depth > 0 && start !== -1 ? buf.slice(start) : "";
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
  };
}

function extractSessionId(event) {
  // grok's streaming-json carries sessionId (camelCase) on the end event; the
  // extra fallbacks tolerate a shape drift across versions.
  return (
    event.sessionId ??
    event.session_id ??
    (event.session && (event.session.id ?? event.session.sessionId)) ??
    null
  );
}

function extractTextChunk(event) {
  // grok streams the assistant reply as {"type":"text","data":"…"}; reasoning
  // arrives as type:"thought" and is deliberately kept out of the report.
  // The type:"text"+event.text fallback covers a possible field rename.
  if (event.type !== "text") return null;
  if (typeof event.data === "string") return event.data;
  if (typeof event.text === "string") return event.text;
  return null;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Grok's edits, not relay's artifacts.
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
      tool: "grok",
      workdir: opts.cd,
      autonomy: opts.autonomy,
      model: opts.model,
      effort: opts.effort,
      resumeLast: opts.resumeLast,
      grokVersion: version,
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
  const result = writeResult({ status: "grok_unavailable", exitCode: 127, signal: null, sessionId: null, finalMessage: "", usage: null, touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `grok` not found on PATH. Install it with `npm i -g @xai-official/grok` and run `grok login`.\n");
  process.exit(127);
}

function dispatchToGrok(opts, run, writeResult) {
  // grok cannot be prevented from writing headlessly (the read-only sandbox and
  // plan mode are advisory), so a --read-only run snapshots the tree up front
  // and flags a violation in the result instead of pretending to enforce.
  const beforeTree = opts.autonomy === "read-only" ? gitTouchedFiles(opts.cd) : null;
  const argv = buildArgv(opts, run);
  // shell:true on Windows so the grok.cmd shim resolves (see grokVersion). Safe:
  // the brief is delivered via --prompt-file (never argv), --model/--effort/--session
  // are restricted to safe tokens at parse time, and the two path args are
  // quoted for win32 in buildArgv.
  const child = spawn("grok", argv, {
    cwd: opts.cd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = opts.session || null;
  let usage = null;
  const textChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    const sid = extractSessionId(event);
    if (sid) sessionId = sid;
    const chunk = extractTextChunk(event);
    if (chunk) textChunks.push(chunk);
    if (event.usage && typeof event.usage === "object") usage = event.usage;
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk); // faithful raw record
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Grok progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textChunks.join("").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      usage,
      touchedFiles: gitTouchedFiles(opts.cd),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: code === 0 ? "completed" : "failed",
      exitCode: code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1),
      signal: signal ?? null,
      sessionId,
      finalMessage,
      usage,
      touchedFiles,
      ...(opts.autonomy === "read-only"
        ? { readOnlyViolation: beforeTree !== null && touchedFiles !== null && JSON.stringify(beforeTree) !== JSON.stringify(touchedFiles) }
        : {}),
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

  const version = grokVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToGrok(opts, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  grok ${result.grokVersion ?? "?"}`);
  if (result.signal === "SIGKILL") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a grok error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.readOnlyViolation) lines.push("warning: this --read-only run modified the working tree — grok's read-only is best-effort; review the diff before trusting the run.");
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session (--continue)");
  else if (result.sessionId && result.status !== "grok_unavailable") {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  }
  if (result.usage) {
    const u = result.usage;
    lines.push(`tokens: ${u.total_tokens ?? "?"} total (in ${u.input_tokens ?? "?"}, out ${u.output_tokens ?? "?"})`);
  }
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
  lines.push("--- grok final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
