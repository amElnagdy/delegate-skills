#!/usr/bin/env node
/**
 * delegate-skills · grok-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Grok Build CLI (`grok -p`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Grok-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Designed against the Grok Build headless docs; other
 * shell-capable agents (Claude Code, Cursor, …) are designed-for but not yet
 * verified end-to-end here.
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
 *   --read-only    — `--sandbox read-only --permission-mode plan` (no edits)
 *   --full-access  — `--always-approve --sandbox off` (unrestricted; opt-in)
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
 *   --read-only             Review/diagnosis with no edits (`--sandbox read-only`).
 *   --full-access           Unrestricted auto-approve (`--sandbox off`); opt-in.
 *   --resume-last           Continue the most recent Grok session for this cwd;
 *                           send only the delta brief.
 *   --session <id>          Continue a specific session id; send only the delta brief.
 *                           Mutually exclusive with --resume-last.
 *   --prompt-stdin          Experimental: pipe the brief on stdin and pass `-p -`
 *                           instead of putting the brief in argv. Unverified —
 *                           use while testing which delivery path Grok accepts.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, grokVersion, sessionId (for a later resume), finalMessage
 *   (Grok's own report), touchedFiles (git porcelain, null if git can't report), and the
 *   paths to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `grok` binary exits 127;
 * otherwise the exit code mirrors Grok's own (0 success, non-zero failure).
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or grok_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

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
    autonomy: "workspace-write",
    resumeLast: false,
    session: null,
    promptStdin: false,
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
      case "--read-only": opts.autonomy = "read-only"; break;
      case "--full-access": opts.autonomy = "full-access"; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--prompt-stdin": opts.promptStdin = true; break;
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
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to grok -p\n";
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
  // explicitly. Sandbox profiles (from the Enterprise docs):
  //   workspace  — write CWD /tmp ~/.grok/   (workspace-write analog)
  //   read-only  — no working-tree writes    (review/diagnosis)
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

function quoteForCmd(value) {
  // cmd.exe quoting when shell:true on win32: wrap in ", double internal ".
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildArgv(opts, brief) {
  // Always: automation hygiene + structured events + working root.
  const argv = [
    "--no-auto-update",
    "--no-alt-screen",
    "--output-format", "streaming-json",
    "--cwd", opts.cd,
  ];

  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push("--resume", opts.session);

  // Re-pass autonomy on resume too — headless permission mode may not inherit.
  argv.push(...autonomyFlags(opts.autonomy));

  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);

  // Prompt delivery: default puts the brief in `-p` argv; --prompt-stdin is the
  // experimental alternate (pipe + `-p -`). Isolated here so A/B testing is a
  // one-flag change. See deliverPrompt().
  if (opts.promptStdin) {
    argv.push("-p", "-");
  } else {
    // On win32 + shell:true the brief must be cmd-quoted or spaces/newlines split.
    const prompt = process.platform === "win32" ? quoteForCmd(brief) : brief;
    argv.push("-p", prompt);
  }
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
  return (
    event.sessionId ??
    event.session_id ??
    event.sessionID ??
    (event.session && (event.session.id ?? event.session.sessionId ?? event.session.session_id)) ??
    event.params?.sessionId ??
    event.params?.session_id ??
    null
  );
}

function extractTextChunk(event) {
  // Tolerant of several plausible streaming-json / ACP-like shapes until a real
  // event stream confirms the canonical field names (see plan §6.4).
  if (typeof event.text === "string") return event.text;
  if (typeof event.message === "string") return event.message;
  if (typeof event.content === "string") return event.content;
  if (event.content && typeof event.content.text === "string") return event.content.text;
  if (event.delta && typeof event.delta.text === "string") return event.delta.text;
  if (event.part && typeof event.part.text === "string") return event.part.text;
  const update = event.params?.update ?? event.update;
  if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
    return update.content.text;
  }
  if (update?.content?.text) return update.content.text;
  // type:"text" / type:"assistant" / type:"message" with nested text
  if ((event.type === "text" || event.type === "assistant" || event.type === "message" ||
       event.type === "agent_message" || event.type === "result") &&
      typeof (event.text ?? event.message ?? event.result) === "string") {
    return event.text ?? event.message ?? event.result;
  }
  if (event.type === "result" && typeof event.result?.text === "string") return event.result.text;
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
      promptStdin: opts.promptStdin,
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
  const result = writeResult({ status: "grok_unavailable", exitCode: 127, sessionId: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `grok` not found on PATH. Install it (curl -fsSL https://x.ai/cli/install.sh | bash, or npm i -g @xai-official/grok) and run `grok login`.\n");
  process.exit(127);
}

function deliverPrompt(child, brief, opts) {
  // Isolated seam for A/B testing prompt delivery (plan §2e / §6.1).
  // Default: brief already in `-p` argv — close stdin.
  // --prompt-stdin: write brief to stdin (paired with `-p -` in buildArgv).
  child.stdin.on("error", () => {});
  if (opts.promptStdin) {
    child.stdin.write(brief);
  }
  child.stdin.end();
}

function dispatchToGrok(opts, brief, run, writeResult) {
  const argv = buildArgv(opts, brief);
  // shell:true on Windows so the grok.cmd shim resolves (see grokVersion).
  // When the brief is in argv on win32 it is cmd-quoted in buildArgv; prefer
  // --prompt-stdin for pathological multi-line briefs if quoting misbehaves.
  const child = spawn("grok", argv, {
    cwd: opts.cd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = opts.session || null;
  const textChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    const sid = extractSessionId(event);
    if (sid) sessionId = sid;
    const chunk = extractTextChunk(event);
    if (chunk) textChunks.push(chunk);
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    appendFileSync(run.eventsPath, text, "utf8"); // faithful raw record
    scan(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface Grok progress live for the orchestrator
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

  child.on("error", (err) => {
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code) => {
    const finalMessage = assembleFinal();
    const result = writeResult({
      status: code === 0 ? "completed" : "failed",
      exitCode: code === null ? 1 : code,
      sessionId,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(code === 0 ? {} : { stderrTail: stderrTail.slice(-20) }),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  deliverPrompt(child, brief, opts);
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

  dispatchToGrok(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode})  ·  grok ${result.grokVersion ?? "?"}`);
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session (--continue)");
  else if (result.sessionId && result.status !== "grok_unavailable") {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  }
  if (result.promptStdin) lines.push("prompt delivery: stdin (-p -)  [experimental]");
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
