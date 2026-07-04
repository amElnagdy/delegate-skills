#!/usr/bin/env node
/**
 * delegate-skills · opencode-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenCode CLI (`opencode run`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every OpenCode-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against opencode CLI v1.17.13.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `opencode` and `git`. The `opencode` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * OpenCode autonomy is governed by the chosen agent, not a sandbox enum:
 *   build (default) — write-capable; edits files in the working dir headlessly.
 *   plan            — read-only; reviews/diagnoses without touching the tree.
 * A build run passes `--auto` by default so OpenCode never blocks on a permission
 * prompt no one can answer in headless mode; the orchestrator's diff review is the
 * safety net. Pass --no-auto to instead honor the agent's own permission config.
 * A plan (read-only) run never gets --auto, so it can't be auto-approved into edits.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for OpenCode (default: current directory).
 *   --model <name>          Model as provider/model. REQUIRED for a fresh run — OpenCode has no
 *                           safe default; a resumed run inherits its session's model.
 *   --agent <name>          OpenCode agent (default: build). Use plan for read-only review.
 *   --read-only             Shortcut for --agent plan (review/diagnosis, no edits).
 *   --variant <name>        Provider reasoning effort (e.g. high, max, minimal).
 *   --no-auto               Don't pass --auto; honor the agent's own permission config (a headless
 *                           run may then hang if the agent is set to ask for a permission).
 *   --resume-last           Continue the most recent OpenCode session; send only the delta brief.
 *   --session <id>          Continue a specific session id (ses_...); send only the delta brief.
 *   --pure                  Run OpenCode without external plugins (cleaner event stream).
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, opencodeVersion, sessionId (for a later resume), finalMessage
 *   (OpenCode's own report), touchedFiles (git porcelain, null if git can't report), and the
 *   paths to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `opencode` binary exits 127;
 * otherwise the exit code mirrors OpenCode's own (0 success, non-zero failure).
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or opencode_unavailable. An orchestrator that polls for the
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
    agent: "build",
    variant: null,
    auto: true,
    resumeLast: false,
    session: null,
    pure: false,
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
      case "--agent": opts.agent = next(); break;
      case "--read-only": opts.agent = "plan"; break;
      case "--variant": opts.variant = next(); break;
      case "--auto": opts.auto = true; break;
      case "--no-auto": opts.auto = false; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--pure": opts.pure = true; break;
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
  if (!match) return "relay.mjs — dispatch a brief to opencode run\n";
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

function opencodeVersion() {
  try {
    // On Windows, npm installs `opencode` as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
    // ENOENTs on a working install. POSIX is unaffected. (git installs a real
    // git.exe and must NOT get this flag — see gitTouchedFiles.)
    return execFileSync("opencode", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report — git missing, or a non-repo run — so the
  // caller can tell "git unavailable" apart from "OpenCode changed nothing."
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
  const argv = ["run", "--format", "json"];
  if (opts.pure) argv.push("--pure");
  // Resume continues an existing session; --session pins a specific id, otherwise
  // --continue picks up the most recent one. A resumed run inherits its original
  // agent, so we only set --agent on a fresh run.
  if (opts.session) {
    argv.push("--session", opts.session);
  } else if (opts.resumeLast) {
    argv.push("--continue");
  } else {
    argv.push("--agent", opts.agent);
  }
  if (opts.model) argv.push("--model", opts.model);
  if (opts.variant) argv.push("--variant", opts.variant);
  // --auto (on by default) auto-approves permissions so a headless build run doesn't
  // block on a prompt no one can answer; --no-auto honors the agent's own config.
  // Never on a plan (read-only) run: --auto would approve the plan agent's ask-gated
  // edit/bash permissions and let a "read-only" review modify the tree. A plan run
  // only reads, so it doesn't need auto-approval anyway.
  if (opts.auto && opts.agent !== "plan") argv.push("--auto");
  // No message argument: the brief is piped on stdin (see dispatchToOpenCode),
  // which avoids all argv-quoting issues with multi-line, XML-tagged briefs.
  return argv;
}

function makeEventScanner(onObject) {
  // OpenCode emits newline-delimited JSON events on stdout, but local plugins can
  // prepend terminal-notify escape sequences (e.g. `]777;notify;...{...}`) on the
  // same line. A plain line-splitter would choke on those. This brace-aware
  // scanner instead walks the byte stream, ignores anything at depth 0 that isn't
  // a top-level object, and emits each complete `{...}` it closes — robust to junk
  // prefixes and concatenated objects alike. String/escape state is tracked so
  // braces inside string values never throw off the depth count.
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
      // Only track strings inside an object (depth > 0). At depth 0 we're skipping a
      // junk prefix (e.g. a terminal-notify escape), and an unmatched `"` there must
      // not swallow the real `{...}` that follows in the same chunk.
      if (ch === '"') { if (depth > 0) inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            const slice = buf.slice(start, i + 1);
            try { onObject(JSON.parse(slice)); } catch { /* not a JSON object we care about */ }
            start = -1;
          }
        }
      }
    }
    // Retain only an in-progress object (if any) so the buffer can't grow without
    // bound; everything already emitted or skipped is dropped. Reset the scanner
    // state too: the next call re-derives depth/string state by scanning the
    // retained buffer (which always begins at an object's `{`) from scratch.
    // Without the reset, the carried-over depth double-counts the retained braces,
    // so an object split across chunks never closes and its event is lost.
    // ponytail: O(n^2) if a single object spans many chunks (each re-scans the
    // retained prefix); fine for OpenCode's event sizes — switch to a suffix-only
    // scan if it ever bites.
    buf = depth > 0 && start !== -1 ? buf.slice(start) : "";
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
  };
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only OpenCode's edits, not relay's artifacts.
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
    const resuming = Boolean(opts.session || opts.resumeLast);
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "opencode",
      workdir: opts.cd,
      agent: resuming ? "(inherited from resumed session)" : opts.agent,
      model: opts.model,
      auto: opts.auto,
      resumeLast: opts.resumeLast,
      opencodeVersion: version,
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
  const result = writeResult({ status: "opencode_unavailable", exitCode: 127, sessionId: null, finalMessage: "", touchedFiles: null, cost: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `opencode` not found on PATH. Install it (npm i -g opencode-ai) and run `opencode auth login`.\n");
  process.exit(127);
}

function dispatchToOpenCode(opts, brief, run, writeResult) {
  const argv = buildArgv(opts);
  // Pin the working root two ways: `cwd` sets the child's real directory, and PWD
  // is set explicitly because OpenCode can resolve its project root from the
  // inherited PWD env — which spawn does NOT rewrite — so without it a run could
  // operate on the orchestrator's directory instead of opts.cd (and, with --auto
  // on, edit it unattended). Passing the path via env, not argv, keeps it clear of
  // shell quoting.
  // shell:true on Windows so the opencode.cmd shim resolves (see opencodeVersion).
  // Safe: the brief is fed via child.stdin below — never argv — and argv holds only
  // flag names, an agent enum, a model string, and a session id, with no shell
  // metacharacters or spaceable paths.
  const child = spawn("opencode", argv, {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = opts.session || null;
  let totalCost = 0;
  let sawCost = false;
  const textParts = new Map(); // part.id -> latest text
  const textOrder = []; // part.ids in first-seen order
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    // Session id: real events carry `sessionID` (camelCase); plugin notify objects
    // carry `session_id` (snake_case). Accept either.
    const sid = event.sessionID || event.session_id;
    if (sid) sessionId = sid;
    // Assistant text lives in `type:"text"` events under part.text. Key by part.id
    // so streamed updates to the same part replace rather than duplicate; preserve
    // first-seen order so multi-segment messages assemble correctly.
    if (event.type === "text" && event.part && event.part.type === "text") {
      const id = event.part.id || `anon-${textOrder.length}`;
      if (!textParts.has(id)) textOrder.push(id);
      textParts.set(id, event.part.text ?? "");
    }
    if (event.type === "step_finish" && event.part && typeof event.part.cost === "number") {
      totalCost += event.part.cost;
      sawCost = true;
    }
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    appendFileSync(run.eventsPath, text, "utf8"); // faithful raw record of the event stream
    scan(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface OpenCode progress live for the orchestrator
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textOrder.map((id) => textParts.get(id)).join("").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  child.on("error", (err) => {
    const result = writeResult({ status: "failed", exitCode: 1, sessionId, finalMessage: assembleFinal(), touchedFiles: gitTouchedFiles(opts.cd), cost: sawCost ? totalCost : null, error: String(err && err.message ? err.message : err) });
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
      cost: sawCost ? Number(totalCost.toFixed(6)) : null,
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
  // --session pins a specific session and --resume-last picks the most recent; passing both is a
  // contradiction, and buildArgv would silently prefer --session. Reject it rather than guess.
  if (opts.session && opts.resumeLast) {
    fail("--session and --resume-last are mutually exclusive; pass only one");
  }
  // OpenCode has no safe default model (a bare `opencode run` errors), so a fresh run must name one.
  // A resumed run inherits its session's model, so --model is optional there.
  if (!opts.model && !opts.resumeLast && !opts.session) {
    fail("no model given: pass --model provider/model — opencode has no safe default (e.g. a plan you're subscribed to, like opencode-go/kimi-k2.7-code)");
  }

  const version = opencodeVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToOpenCode(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode})  ·  opencode ${result.opencodeVersion ?? "?"}`);
  if (result.resumeLast || result.agent === "(inherited from resumed session)") lines.push("mode: resumed existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  if (typeof result.cost === "number") lines.push(`cost: $${result.cost}`);
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
  lines.push("--- opencode final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
