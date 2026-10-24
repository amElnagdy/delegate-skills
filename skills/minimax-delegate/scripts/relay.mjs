#!/usr/bin/env node
/**
 * delegate-skills · minimax-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the MiniMax Code CLI (`mcode exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON -
 * every MiniMax-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against mcode 0.6.13 on Windows 11.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `mcode` and `git`. The `mcode` process it
 * launches does authenticate - exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * The brief goes to `mcode exec --input -` on stdin, so it never rides argv
 * and never shows in the host process list.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * - after it reviews the diff and re-runs the project gates.
 *
 * Headless mcode has no read-only mode: `--permission` takes smart (mcode's
 * default), full, or off, and all three can write. The diff reported in
 * `touchedFiles`, not a flag, is the guarantee of what changed.
 *
 * On Windows npm installs `mcode` as a `.cmd` shim, which Node's CreateProcess
 * cannot launch, so the relay uses shell:true there. The brief rides stdin and
 * the workspace is the child cwd, so the shell only ever sees flag names and
 * token-validated values.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for mcode (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <provider/model>  Model for this run, e.g. minimax/MiniMax-M3
 *                           (default: mcode's configured model).
 *   --effort <level>        Reasoning effort for this run. Levels depend on the
 *                           model; mcode lists them when given a bad one.
 *   --permission <policy>   smart (mcode default), full, or off.
 *   --max-steps <n>         Cap on assistant steps.
 *   --session <id>          Continue a specific mcode session; send only the delta brief.
 *   --resume-last           Continue the latest session in --cd; send only the delta brief.
 *   --timeout <dur>         Relay-side watchdog (default: 30m); h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, mcodeVersion, sessionId, finalMessage (mcode's
 *   own report), resolvedModel, usage, touchedFiles (git porcelain, null if git
 *   cannot report), and paths to brief.txt, final.txt, events.jsonl, and
 *   stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `mcode` exits 127;
 * otherwise the exit code mirrors mcode's own (0 success, non-zero failure). A
 * run mcode reports as failed is failed even if mcode exits 0. If the child
 * dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome - completed, failed, timeout (the --timeout watchdog
 * fired), aborted (the relay itself was killed and forwarded the kill to
 * mcode), or mcode_unavailable.
 */

import { spawn, execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const PERMISSIONS = ["smart", "full", "off"];
// These values reach cmd.exe on win32, so no shell metacharacter may pass. Keep in
// lockstep with delegate-setup MODEL_TOKEN.shellSafe.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;

const IMPLEMENTER_KEY = "minimax";

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
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
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
    permissionMode: null,
    maxSteps: null,
    session: null,
    resumeLast: false,
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
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--permission": opts.permissionMode = next(); flagged.add("permissionMode"); break;
      case "--max-steps": opts.maxSteps = next(); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  for (const [flag, value] of [["--model", opts.model], ["--effort", opts.effort], ["--session", opts.session]]) {
    if (value !== null && !SAFE_TOKEN.test(value)) fail(`${flag} "${value}" has unsupported characters`);
  }
  if (opts.permissionMode !== null && !PERMISSIONS.includes(opts.permissionMode)) {
    fail(`--permission must be one of: ${PERMISSIONS.join(", ")} (ask needs a human, so headless runs reject it)`);
  }
  if (opts.maxSteps !== null && !/^[1-9]\d*$/.test(opts.maxSteps)) {
    fail(`--max-steps "${opts.maxSteps}" must be a positive integer`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to mcode exec\n";
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
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
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

function mcodeVersion(probeTimeoutMs) {
  try {
    const options = {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
    };
    const version = (process.platform === "win32"
      ? execSync("mcode --version", options)
      : execFileSync("mcode", ["--version"], options)).trim();
    return { version: version || "unknown", error: null };
  } catch (err) {
    // Only a missing binary means "unavailable"; a hung or failing probe means
    // mcode is installed but broken, and dispatching would waste the brief.
    if (err && err.code === "ENOENT") return { version: null, error: null };
    // shell:true routes a missing binary through cmd.exe, which reports it as a
    // non-zero exit rather than ENOENT.
    if (process.platform === "win32" &&
        /not recognized as an internal or external command/i.test(String(err?.stderr || ""))) {
      return { version: null, error: null };
    }
    return { version: null, error: err };
  }
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts) {
  const argv = ["exec", "--input", "-", "--output-format", "stream-json"];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.permissionMode) argv.push("--permission", opts.permissionMode);
  if (opts.maxSteps) argv.push("--max-steps", opts.maxSteps);
  if (opts.session) argv.push("--session", opts.session);
  else if (opts.resumeLast) argv.push("--continue");
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
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
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "minimax",
      workdir: opts.cd,
      model: opts.model,
      effort: opts.effort,
      permission: opts.permissionMode,
      resumed: Boolean(opts.resumeLast || opts.session),
      mcodeVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    // Publish atomically so a polling orchestrator never reads a half-written file.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "mcode_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `mcode` not found on PATH. Install it with `npm install -g @minimax-ai/code` and run `mcode login --region global`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `mcode --version preflight timed out after ${probeTimeoutMs}ms; mcode was not dispatched`
    : `mcode --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; mcode was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToMcode(opts, brief, run, writeResult) {
  const options = {
    cwd: opts.cd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  };
  // Node 24 warns when shell:true is paired with an args array; every arg is a flag
  // name or a token-validated value, so join them once.
  const child = process.platform === "win32"
    ? spawn(["mcode", ...buildArgv(opts)].join(" "), { ...options, shell: true })
    : spawn("mcode", buildArgv(opts), options);
  child.stdin.on("error", () => {
    // mcode exited before reading the whole brief; its exit status reports why.
  });
  child.stdin.end(brief);

  let sessionId = null;
  let execResult = null;
  const messages = [];
  const stderrTail = [];
  let pending = "";
  const onEvent = (event) => {
    if (typeof event.sessionId === "string") sessionId = event.sessionId;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.content === "string") {
      messages.push(event.item.content);
    }
    if (event.type === "exec.completed" && event.result) execResult = event.result;
  };

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    pending += stdoutDecoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch { /* not an event line */ }
    }
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

  // mcode's exec result carries the whole final answer; the last agent message
  // is the fallback when the run died before emitting it.
  const assembleFinal = () => {
    const message = typeof execResult?.output === "string" && execResult.output
      ? execResult.output
      : messages[messages.length - 1] || "";
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };
  const runDetails = () => ({
    resolvedModel: execResult?.model ? `${execResult.model.providerId}/${execResult.model.modelId}` : null,
    usage: execResult?.usage ?? null,
    ...(execResult?.error ? { mcodeError: execResult.error } : {}),
  });

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
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, 10_000);
  }, timeoutMs);

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side writes no result.json and leaves mcode running or dying
  // mid-edit with nothing recording why. SIGTERM/SIGHUP registration is a no-op on
  // Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        finalMessage: assembleFinal(),
        ...runDetails(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; mcode was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  // A grandchild that outlives mcode and inherited the pipes keeps stdout/stderr open,
  // so "close" never fires. Once mcode itself is gone, drop the pipes after a short
  // drain grace and let "close" run.
  child.once("exit", () => {
    if (!watchdogFired) {
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    }
    const drain = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
    if (typeof drain.unref === "function") drain.unref();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      ...runDetails(),
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
    if (pending.trim()) {
      try { onEvent(JSON.parse(pending)); } catch { /* truncated tail */ }
    }
    // a descendant that ignored SIGTERM must not outlive the timeout report
    if (watchdogFired) killChild(child, "SIGKILL");
    const mcodeFailed = execResult !== null && execResult.status !== "succeeded";
    const succeeded = code === 0 && !watchdogFired && !mcodeFailed;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      finalMessage: assembleFinal(),
      ...runDetails(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `mcode did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  const probeTimeoutMs = Math.min(parseDuration(opts.timeout), VERSION_PROBE_TIMEOUT_MS);
  const probe = mcodeVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }
  dispatchToMcode(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  mcode ${result.mcodeVersion ?? "?"}${result.resolvedModel ? `  ·  ${result.resolvedModel}` : ""}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not an mcode error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated mcode (a supervisor, the session ending, or a manual kill) — inspect the working tree before re-dispatching.");
  if (result.mcodeError?.message) lines.push(`mcode error: ${result.mcodeError.message}`);
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
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
  lines.push("--- mcode final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
