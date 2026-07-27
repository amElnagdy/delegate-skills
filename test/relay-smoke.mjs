#!/usr/bin/env node
/**
 * delegate-skills · relay smoke.
 *
 * Drives the relays, unmodified and end to end, against a fake implementer CLI
 * planted on PATH, and asserts the two guarantees they make about runs that do
 * not complete:
 *
 *   1. timeout  — the watchdog kills the implementer's WHOLE process tree and
 *                 result.json reports status "timeout". Driven for all seven
 *                 relays on both platforms. On Windows, claude launches a .cmd
 *                 shim through a serialized cmd.exe invocation, while
 *                 codex/opencode/grok use shell:true. These are exactly the
 *                 cases a plain child.kill would miss; agy, kimi, and qoder spawn a
 *                 native binary directly — a .cmd stand-in cannot represent them,
 *                 so the smoke compiles a real fake .exe with the C# compiler
 *                 that ships in-box with Windows (no install, no network) and
 *                 puts it on PATH under their names. agy's watchdog is
 *                 --print-timeout plus a fixed 60s grace, so its scenario is
 *                 the slow one (about a minute) on every platform. A POSIX
 *                 variant repeats each run with a parent that complies with
 *                 SIGTERM while its grandchild ignores it — the sweep at close
 *                 must fell the survivor even though the parent's exit
 *                 cancelled the pending escalation timer.
 *   2. aborted  — killing the relay itself still produces result.json with
 *                 status "aborted", and files the implementer flushes during
 *                 the shutdown grace window appear in the refreshed
 *                 touchedFiles. Driven for all seven relays on POSIX; Windows
 *                 delivers no catchable SIGTERM, so the scenario cannot be
 *                 driven there (the skill docs carry the same caveat).
 *
 * Every fake answers each relay's version preflight (--version, `version`,
 * `changelog`). Quick Claude and Qoder success cases verify brief delivery,
 * launch arguments, environment handling, and result-event parsing. The
 * timeout/abort cases otherwise run until killed and spawn a subprocess of
 * their own; both assert that this grandchild dies with the implementer.
 * Node built-ins only.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder"];
const binaryName = (skill) => skill === "qoder" ? "qodercli" : skill;
const relayPath = (skill) => join(here, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
const WIN = process.platform === "win32";
let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "  ok " : "  FAIL"}  ${name}`);
  if (!cond) failed++;
};
const pair = (args, flag, value) => args[args.indexOf(flag) + 1] === value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(250);
  }
  return fn();
};
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  // a dead-but-unreaped zombie still accepts signal 0. That happens whenever nothing reaps the
  // orphan — e.g. a container whose PID 1 is not an init — and would make a properly felled tree
  // look alive forever. Where /proc exists, read the real state; a zombie is dead.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = /\)\s+(\S)/.exec(stat.slice(stat.lastIndexOf(")")));
    return state ? state[1] !== "Z" : true;
  } catch {
    return true; // no /proc (macOS, Windows): the signal-0 verdict stands
  }
};

// ---- every relay must at least parse ----
for (const skill of SKILLS) {
  const r = relayPath(skill);
  const c = spawnSync(process.execPath, ["--check", r], { encoding: "utf8" });
  check(`syntax: ${r.split(/[\\/]/).slice(-3).join("/")}`, c.status === 0);
}

// ---- one fake CLI, planted on PATH under every relay's binary name ----
const FAKE = `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version") && process.env.SMOKE_MODE === "qoder-version-hang") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (args.includes("--version") && process.env.SMOKE_MODE === "qoder-version-fail") {
  console.error("fake qoder version failure");
  process.exit(7);
} else if (args.includes("--version") || args[0] === "version" || args[0] === "changelog") {
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
}
// A relay may deliberately strip the environment (codex --clean-env), which would also strip
// the SMOKE_* control variables. Fall back to a config file planted next to this fake so the
// harness can still drive it — and so stripping itself stays observable.
if (!process.env.SMOKE_MODE) {
  try {
    const fallback = JSON.parse(fs.readFileSync(require("path").join(__dirname, "smoke-fallback.json"), "utf8"));
    for (const key of Object.keys(fallback)) if (!process.env[key]) process.env[key] = fallback[key];
  } catch { /* no fallback planted */ }
}
if (process.env.SMOKE_MODE === "capture") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  if (process.env.SMOKE_ENV_FILE) fs.writeFileSync(process.env.SMOKE_ENV_FILE, JSON.stringify(process.env));
  process.exit(0);
}
if (process.env.SMOKE_MODE === "qoder-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "qoder-session-1",
    model: "performance",
    permissionMode: "auto",
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    session_id: "qoder-session-1",
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "qoder-session-1",
    result: "fake qoder completed",
    usage: { input_tokens: 7, output_tokens: 2 },
  }));
  process.exit(0);
}
if (["claude-success", "claude-read-only-write", "claude-read-only-clean", "claude-chunked"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", async () => {
    const mode = process.env.SMOKE_MODE;
    if (mode === "claude-read-only-write") {
      fs.writeFileSync("read-only-violation.txt", "written by fake claude\\n");
    }
    if (process.env.SMOKE_CAPTURE_FILE) {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({
        args,
        brief,
        claudeCode: process.env.CLAUDECODE ?? null,
        childSession: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
      }));
    }
    const permissionMode = mode.startsWith("claude-read-only") ? "plan" : "acceptEdits";
    console.log(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
      permissionMode,
    }));
    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "11111111-1111-4111-8111-111111111111",
      result: mode === "claude-chunked" ? "café — done ✅" : "fake claude completed",
      num_turns: 3,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (mode === "claude-chunked") {
      const output = Buffer.from(JSON.stringify(resultEvent));
      for (let i = 0; i < output.length; i += 1) {
        process.stdout.write(output.subarray(i, i + 1));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write("\\n");
    } else {
      console.log(JSON.stringify(resultEvent));
    }
  });
} else {
  process.stdin.resume();
  const grandProgram = process.env.SMOKE_GRAND_IGNORES_SIGTERM
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  const grand = require("node:child_process").spawn(process.execPath, ["-e", grandProgram], { stdio: "ignore" });
  fs.writeFileSync(process.env.SMOKE_GRAND_PID_FILE, String(grand.pid));
  fs.writeFileSync(process.env.SMOKE_PID_FILE, String(process.pid)); // written last: its existence means both pid files are readable
  if (process.env.SMOKE_MODE === "abort") {
    process.on("SIGTERM", () => { fs.writeFileSync(process.env.SMOKE_LATE_FILE, "flushed during shutdown"); process.exit(0); });
  } else if (process.env.SMOKE_MODE === "timeout-yield") {
    process.on("SIGTERM", () => process.exit(0)); // the parent complies while the grandchild ignores
  } else {
    process.on("SIGTERM", () => {}); // ignore, so the relay's SIGKILL escalation is what ends it
  }
  setInterval(() => {}, 1000);
}
`;

// agy, kimi, and qoder spawn a native binary without a shell, so on Windows their stand-in must be a
// real .exe. The C# compiler ships in-box with the .NET Framework on every supported Windows,
// which lets the smoke build one locally — no install, no network, still dependency-free.
const FAKE_EXE_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class FakeCli {
  static int Main(string[] args) {
    if (Array.IndexOf(args, "--version") >= 0 && Environment.GetEnvironmentVariable("SMOKE_MODE") == "qoder-version-hang") {
      Thread.Sleep(Timeout.Infinite);
      return 1;
    }
    if (Array.IndexOf(args, "--version") >= 0 && Environment.GetEnvironmentVariable("SMOKE_MODE") == "qoder-version-fail") {
      Console.Error.WriteLine("fake qoder version failure");
      return 7;
    }
    if (Array.IndexOf(args, "--version") >= 0 || (args.Length > 0 && (args[0] == "version" || args[0] == "changelog"))) {
      Console.WriteLine("fake-cli 0.0.0-smoke");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "qoder-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"qoder-session-1\\",\\"model\\":\\"performance\\",\\"permissionMode\\":\\"auto\\"}");
      Console.WriteLine("{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"qoder-session-1\\",\\"result\\":\\"fake qoder completed\\",\\"usage\\":{\\"input_tokens\\":7,\\"output_tokens\\":2}}");
      return 0;
    }
    var psi = new ProcessStartInfo {
      FileName = Environment.GetEnvironmentVariable("SMOKE_NODE"),
      Arguments = "-e setInterval(()=>{},1000)",
      UseShellExecute = false,
    };
    var grand = Process.Start(psi);
    File.WriteAllText(Environment.GetEnvironmentVariable("SMOKE_GRAND_PID_FILE"), grand.Id.ToString());
    File.WriteAllText(Environment.GetEnvironmentVariable("SMOKE_PID_FILE"), Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }
}
`;

const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-"));
const shimDir = join(scratch, "shim");
mkdirSync(shimDir);
writeFileSync(join(shimDir, "fake-cli.cjs"), FAKE);
if (WIN) {
  for (const skill of ["claude", "codex", "opencode", "grok"]) {
    writeFileSync(join(shimDir, `${skill}.cmd`), `@node "%~dp0fake-cli.cjs" %*\r\n`);
  }
  const windir = process.env.WINDIR || "C:\\Windows";
  const csc = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((p) => existsSync(p));
  check("windows: the in-box C# compiler exists (builds the native fake for agy/kimi/qoder)", Boolean(csc));
  if (csc) {
    const csFile = join(shimDir, "fake-cli.cs");
    writeFileSync(csFile, FAKE_EXE_SOURCE);
    const compiled = spawnSync(csc, ["/nologo", `/out:${join(shimDir, "kimi.exe")}`, csFile], { encoding: "utf8" });
    check("windows: the native fake compiled", compiled.status === 0);
    if (compiled.status === 0) {
      copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "agy.exe"));
      copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "qodercli.exe"));
    }
    else console.error(`${compiled.stdout ?? ""}${compiled.stderr ?? ""}`);
  }
} else {
  for (const skill of SKILLS) {
    const shim = join(shimDir, binaryName(skill));
    writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-cli.cjs" "$@"\n`);
    chmodSync(shim, 0o755);
  }
}
const briefPath = join(scratch, "brief.txt");
writeFileSync(briefPath, "smoke brief: run until killed.");
const baseEnv = { ...process.env, PATH: shimDir + delimiter + process.env.PATH, SMOKE_NODE: process.execPath };

const freshRepo = (name) => {
  const dir = join(scratch, name);
  mkdirSync(dir);
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  return dir;
};

const runRelay = (skill, workDir, outDir, extraArgs, extraEnv) =>
  spawn(process.execPath, [relayPath(skill), "--brief", briefPath, "--cd", workDir, "--out-dir", outDir, ...extraArgs], {
    env: { ...baseEnv, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });

const result = (outDir) => JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));

// ---- codex effort is validated, forwarded, and recorded ----
const effortOutDir = join(scratch, "out-effort-codex");
const effortArgsFile = join(scratch, "args-effort-codex");
const effortWorkDir = freshRepo("work-effort-codex");
const effortRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--cd", effortWorkDir, "--out-dir", effortOutDir, "--effort", "low"],
  { env: { ...baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: effortArgsFile }, encoding: "utf8" });
const effortArgs = existsSync(effortArgsFile) ? JSON.parse(readFileSync(effortArgsFile, "utf8")) : [];
check("codex effort: forwarded as a config override",
  effortRun.status === 0 && effortArgs.includes("-c") && effortArgs[effortArgs.indexOf("-c") + 1] === "model_reasoning_effort=low");
check("codex effort: recorded in result.json",
  existsSync(join(effortOutDir, "result.json")) && result(effortOutDir).effort === "low");
const emptyEffortRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--effort", ""],
  { env: baseEnv, encoding: "utf8" });
check("codex effort: an empty value is rejected", emptyEffortRun.status === 2);

// opencode refuses a fresh run without an explicit model
const EXTRA_ARGS = { claude: [], codex: [], opencode: ["--model", "fake/model"], agy: [], grok: [], kimi: [], qoder: [] };

// ---- codex --clean-env keeps unrelated credentials out of the child ----
const cleanEnvOutDir = join(scratch, "out-cleanenv-codex");
const cleanEnvArgsFile = join(scratch, "args-cleanenv-codex");
const cleanEnvWorkDir = freshRepo("work-cleanenv-codex");
const cleanEnvEnvFile = join(scratch, "env-cleanenv-codex");
const fallbackPath = join(shimDir, "smoke-fallback.json");
writeFileSync(fallbackPath, JSON.stringify({ SMOKE_MODE: "capture", SMOKE_ARGS_FILE: cleanEnvArgsFile, SMOKE_ENV_FILE: cleanEnvEnvFile }));
const cleanEnvRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--cd", cleanEnvWorkDir, "--out-dir", cleanEnvOutDir, "--clean-env"],
  { env: { ...baseEnv, SMOKE_SECRET_TOKEN: "must-not-leak" }, encoding: "utf8" });
rmSync(fallbackPath, { force: true });
const cleanEnvCapture = existsSync(cleanEnvEnvFile) ? JSON.parse(readFileSync(cleanEnvEnvFile, "utf8")) : null;
check("codex clean-env: the run completes", cleanEnvRun.status === 0);
check("codex clean-env: an unrelated variable does not reach the child",
  cleanEnvCapture !== null && cleanEnvCapture.SMOKE_SECRET_TOKEN === undefined);
check("codex clean-env: PATH and HOME still reach the child",
  cleanEnvCapture !== null && typeof cleanEnvCapture.PATH === "string" && cleanEnvCapture.PATH.length > 0);
check("codex clean-env: disables MCP servers for the run", (() => {
  const a = existsSync(cleanEnvArgsFile) ? JSON.parse(readFileSync(cleanEnvArgsFile, "utf8")) : [];
  return a.some((v, i) => v === "-c" && a[i + 1] === "mcp_servers={}");
})());
check("codex clean-env: recorded in result.json",
  existsSync(join(cleanEnvOutDir, "result.json")) && result(cleanEnvOutDir).cleanEnv === true);
const inheritEnvFile = join(scratch, "env-inherit-codex");
spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--cd", freshRepo("work-inherit-codex"), "--out-dir", join(scratch, "out-inherit-codex")],
  { env: { ...baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(scratch, "args-inherit-codex"), SMOKE_ENV_FILE: inheritEnvFile, SMOKE_SECRET_TOKEN: "inherited" }, encoding: "utf8" });
const inheritCapture = existsSync(inheritEnvFile) ? JSON.parse(readFileSync(inheritEnvFile, "utf8")) : null;
check("codex clean-env: control - without the flag the variable is inherited",
  inheritCapture !== null && inheritCapture.SMOKE_SECRET_TOKEN === "inherited");

// ---- Qoder's documented print-mode argv and structured result ----
{
  const outDir = join(scratch, "out-success-qoder");
  const workDir = freshRepo("work-success-qoder");
  const argsFile = join(scratch, "args-success-qoder");
  const run = spawnSync(process.execPath, [
    relayPath("qoder"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--resume", "qoder-session-0",
    "--model", "Performance",
    "--context-window", "32768",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "qoder-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? WIN
      ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(argsFile, "utf8"))
    : [];
  check("qoder success: relay exits zero", run.status === 0);
  check("qoder success: documented argv is exact",
    JSON.stringify(args) === JSON.stringify([
      "--output-format", "stream-json",
      "--permission-mode", "auto",
      "--resume", "qoder-session-0",
      "--model", "Performance",
      "--context-window", "32768",
      "-p", "smoke brief: run until killed.",
    ]));
  check("qoder success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = result(outDir);
    check("qoder success: init and result events parsed",
      value.status === "completed" &&
      value.sessionId === "qoder-session-1" &&
      value.actualModel === "performance" &&
      value.actualPermissionMode === "auto" &&
      value.resumed === true &&
      value.resultSubtype === "success");
    check("qoder success: usage and final message parsed",
      value.usage?.input_tokens === 7 &&
      value.usage?.output_tokens === 2 &&
      value.finalMessage === "fake qoder completed");
  }

  const invalidOutDir = join(scratch, "out-invalid-context-qoder");
  const invalid = spawnSync(process.execPath, [
    relayPath("qoder"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", invalidOutDir,
    "--context-window", "0",
  ], { env: baseEnv, encoding: "utf8" });
  check("qoder validation: non-positive context is rejected before artifacts",
    invalid.status === 2 && !existsSync(invalidOutDir));

  const zeroTimeoutOutDir = join(scratch, "out-zero-timeout-qoder");
  const zeroTimeout = spawnSync(process.execPath, [
    relayPath("qoder"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", zeroTimeoutOutDir,
    "--timeout", "0s",
  ], { env: baseEnv, encoding: "utf8" });
  check("qoder validation: zero timeout is rejected before preflight",
    zeroTimeout.status === 2 && !existsSync(zeroTimeoutOutDir));

  const latestOutDir = join(scratch, "out-resume-last-qoder");
  const latestArgsFile = join(scratch, "args-resume-last-qoder");
  const latest = spawnSync(process.execPath, [
    relayPath("qoder"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", latestOutDir,
    "--resume-last",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "qoder-success", SMOKE_ARGS_FILE: latestArgsFile },
    encoding: "utf8",
  });
  const latestArgs = existsSync(latestArgsFile)
    ? WIN
      ? readFileSync(latestArgsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(latestArgsFile, "utf8"))
    : [];
  check("qoder resume-last: uses documented -c",
    latest.status === 0 &&
    latestArgs.includes("-c") &&
    !latestArgs.includes("--resume") &&
    existsSync(join(latestOutDir, "result.json")) &&
    result(latestOutDir).resumed === true);

  const missingOutDir = join(scratch, "out-unavailable-qoder");
  mkdirSync(missingOutDir);
  writeFileSync(join(missingOutDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(missingOutDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    relayPath("qoder"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  check("qoder unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    result(missingOutDir).status === "qoder_unavailable" &&
    !existsSync(join(missingOutDir, "final.txt")));

  if (WIN) {
    const longBrief = join(scratch, "long-qoder-brief.txt");
    const longOutDir = join(scratch, "out-long-brief-qoder");
    writeFileSync(longBrief, "x".repeat(13 * 1024));
    const rejected = spawnSync(process.execPath, [
      relayPath("qoder"),
      "--brief", longBrief,
      "--cd", workDir,
      "--out-dir", longOutDir,
    ], { env: baseEnv, encoding: "utf8" });
    check("qoder Windows: oversized argv brief is rejected before artifacts",
      rejected.status === 2 && !existsSync(longOutDir));
  }

  for (const [mode, expectedStatus, expectedExit] of [
    ["qoder-version-hang", "timeout", 124],
    ["qoder-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      relayPath("qoder"),
      "--brief", briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? result(preflightOutDir)
      : {};
    check(`qoder preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }
}

// ---- Claude's completed stream contract and nested launch environment ----
{
  const outDir = join(scratch, "out success claude");
  const workDir = freshRepo("work success claude");
  const captureFile = join(scratch, "capture-success-claude.json");
  const child = runRelay("claude", workDir, outDir, [], {
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    SMOKE_CAPTURE_FILE: captureFile,
    SMOKE_MODE: "claude-success",
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  check("claude success: relay exits zero", exitCode === 0);
  check("claude success: relay close wait did not time out", exited);
  check("claude success: result.json exists", existsSync(join(outDir, "result.json")));
  check("claude success: fake captured the launch", existsSync(captureFile));
  if (existsSync(join(outDir, "result.json"))) {
    const value = result(outDir);
    check(`claude success: status is completed (got ${value.status})`, value.status === "completed");
    check("claude success: session id parsed", value.sessionId === "11111111-1111-4111-8111-111111111111");
    check("claude success: final message parsed", value.finalMessage === "fake claude completed");
    check("claude success: result subtype parsed", value.resultSubtype === "success");
    check("claude success: turns and cost parsed", value.numTurns === 3 && value.totalCostUsd === 0.0123);
    check("claude success: token usage parsed", value.usage?.input_tokens === 10 && value.usage?.output_tokens === 5);
  }
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    check("claude success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
    check("claude success: inherited CLAUDECODE removed", capture.claudeCode === null);
    check("claude success: child-session marker preserved", capture.childSession === "1");
    check("claude success: print stream-json launch selected",
      capture.args.includes("-p") &&
      pair(capture.args, "--output-format", "stream-json") &&
      capture.args.includes("--verbose"));
    check("claude success: normal permission profile selected",
      pair(capture.args, "--permission-mode", "acceptEdits"));
    check("claude success: forbidden modes omitted",
      !capture.args.includes("--bg") &&
      !capture.args.includes("--bare"));
    check("claude success: normal tool surface selected",
      pair(capture.args, "--tools", `Read,Glob,Grep,Edit,Write,${WIN ? "PowerShell" : "Bash"}`));
    check("claude success: all MCP tools disallowed",
      pair(capture.args, "--disallowedTools", "mcp__*"));
    check("claude success: generated profile selected",
      pair(capture.args, "--settings", join(outDir, "profile.json")));
    check("claude success: restriction flags selected",
      capture.args.includes("--strict-mcp-config") &&
      capture.args.includes("--disable-slash-commands"));

    const settingsPath = capture.args[capture.args.indexOf("--settings") + 1];
    check("claude success: generated profile exists", Boolean(settingsPath) && existsSync(settingsPath));
    if (settingsPath && existsSync(settingsPath)) {
      const profile = JSON.parse(readFileSync(settingsPath, "utf8"));
      const shell = WIN ? "PowerShell" : "Bash";
      const expectedDeny = [
        `${shell}(git commit *)`,
        `${shell}(git * commit *)`,
        `${shell}(git * commit)`,
        `${shell}(git push *)`,
        `${shell}(git * push *)`,
        `${shell}(git * push)`,
        `${shell}(claude *)`,
        `${shell}(*claude-delegate*)`,
      ];
      check("claude success: Claude.ai connectors disabled",
        profile.disableClaudeAiConnectors === true);
      check("claude success: deny rules match the write profile",
        JSON.stringify(profile.permissions?.deny) === JSON.stringify(expectedDeny));
      if (WIN) {
        check("claude success: native Windows profile omits the sandbox",
          !Object.prototype.hasOwnProperty.call(profile, "sandbox"));
        check("claude success: native Windows profile enables PowerShell",
          profile.env?.CLAUDE_CODE_USE_POWERSHELL_TOOL === "1");
      } else {
        check("claude success: POSIX sandbox is strict",
          profile.sandbox?.enabled === true &&
          profile.sandbox?.failIfUnavailable === true &&
          profile.sandbox?.autoAllowBashIfSandboxed === true &&
          profile.sandbox?.allowUnsandboxedCommands === false);
      }
    }
  }
  if (exitCode !== 0) console.error(`claude success relay stderr:\n${stderr}`);
}

// ---- Claude's read-only profile and git-porcelain tripwire ----
for (const scenario of [
  { name: "violation", mode: "claude-read-only-write", expectedViolation: true },
  { name: "clean", mode: "claude-read-only-clean", expectedViolation: false },
]) {
  const outDir = join(scratch, `out read-only ${scenario.name} claude`);
  const workDir = freshRepo(`work read-only ${scenario.name} claude`);
  const captureFile = join(scratch, `capture-read-only-${scenario.name}-claude.json`);
  const child = runRelay("claude", workDir, outDir, ["--read-only"], {
    SMOKE_CAPTURE_FILE: captureFile,
    SMOKE_MODE: scenario.mode,
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  check(`claude read-only ${scenario.name}: relay close wait did not time out`, exited);
  check(`claude read-only ${scenario.name}: relay exits zero`, exitCode === 0);
  check(`claude read-only ${scenario.name}: result.json exists`, existsSync(join(outDir, "result.json")));
  check(`claude read-only ${scenario.name}: fake captured the launch`, existsSync(captureFile));
  if (existsSync(join(outDir, "result.json"))) {
    const value = result(outDir);
    check(`claude read-only ${scenario.name}: violation result is ${scenario.expectedViolation}`,
      value.readOnlyViolation === scenario.expectedViolation);
    check(`claude read-only ${scenario.name}: tool surface is read-only`,
      JSON.stringify(value.toolSurface) === JSON.stringify(["Read", "Glob", "Grep"]));
    check(`claude read-only ${scenario.name}: permission mode is plan`,
      value.permissionMode === "plan");
  }
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    const tools = capture.args[capture.args.indexOf("--tools") + 1] ?? "";
    check(`claude read-only ${scenario.name}: plan mode selected`,
      pair(capture.args, "--permission-mode", "plan"));
    check(`claude read-only ${scenario.name}: read-only tools selected`,
      pair(capture.args, "--tools", "Read,Glob,Grep"));
    check(`claude read-only ${scenario.name}: write and shell tools omitted`,
      !["Edit", "Write", "Bash", "PowerShell"].some((tool) => tools.split(",").includes(tool)));
  }
  if (exitCode !== 0) console.error(`claude read-only ${scenario.name} relay stderr:\n${stderr}`);
}

// ---- Claude's stream parser preserves chunked multi-byte output ----
{
  const outDir = join(scratch, "out chunked claude");
  const workDir = freshRepo("work chunked claude");
  const child = runRelay("claude", workDir, outDir, [], { SMOKE_MODE: "claude-chunked" });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  check("claude chunked: relay close wait did not time out", exited);
  check("claude chunked: relay exits zero", exitCode === 0);
  check("claude chunked: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    check("claude chunked: multi-byte final message round-trips",
      result(outDir).finalMessage === "café — done ✅");
  }
  if (exitCode !== 0) console.error(`claude chunked relay stderr:\n${stderr}`);
}

// ---- 1. the watchdog fells the whole tree ----
// agy's watchdog flag is --print-timeout, and it always adds a fixed 60s grace on top,
// so its run needs about a minute wherever it executes.
const TIMEOUT_CASES = [
  { skill: "claude", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "codex", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "opencode", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "grok", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "kimi", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "qoder", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "agy", flags: ["--print-timeout", "1s"], exitDeadline: 120_000 },
];
async function driveTimeout({ skill, flags, exitDeadline }, mode, extraEnv, tag) {
  const outDir = join(scratch, `out-${tag}-${skill}`);
  const pidFile = join(scratch, `pid-${tag}-${skill}`);
  const grandPidFile = join(scratch, `grandpid-${tag}-${skill}`);
  const workDir = freshRepo(`work-${tag}-${skill}`);
  const child = runRelay(skill, workDir, outDir, [...flags, ...EXTRA_ARGS[skill]], { SMOKE_PID_FILE: pidFile, SMOKE_GRAND_PID_FILE: grandPidFile, SMOKE_MODE: mode, ...extraEnv });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  check(`${skill} ${tag}: the fake implementer came up`, await until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), exitDeadline);
    child.on("close", () => { clearTimeout(t); res(true); });
  });
  check(`${skill} ${tag}: the relay exited on its own`, exited);
  check(`${skill} ${tag}: result.json exists`, existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const r = result(outDir);
    check(`${skill} ${tag}: status is "timeout" (got ${r.status})`, r.status === "timeout");
    check(`${skill} ${tag}: relay exit code is non-zero`, r.exitCode !== 0);
  }
  check(`${skill} ${tag}: the implementer process is dead`,
    implementerPid !== null && await until(() => !alive(implementerPid), 20_000));
  check(`${skill} ${tag}: the implementer's own subprocess is dead (whole tree felled)`,
    grandPid !== null && await until(() => !alive(grandPid), 20_000));
  if (failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
}

for (const tc of TIMEOUT_CASES) {
  await driveTimeout(tc, "timeout", {}, "timeout");
}

// A compliant parent must not shield a defiant descendant: the parent exits on the group
// SIGTERM, its grandchild ignores it, and the sweep at close must still fell the grandchild
// before the relay reports. POSIX only — the Windows kill is a single unconditional
// taskkill /t /f with no SIGTERM/escalation phase to defeat.
if (!WIN) {
  for (const tc of TIMEOUT_CASES) {
    await driveTimeout(tc, "timeout-yield", { SMOKE_GRAND_IGNORES_SIGTERM: "1" }, "timeout-yield");
  }
}

// ---- 2. killing the relay still writes the artifact, with a refreshed snapshot ----
if (WIN) {
  console.log("  skip  aborted-path scenarios: Windows delivers no catchable SIGTERM to drive them");
} else {
  for (const skill of SKILLS) {
    const outDir = join(scratch, `out-abort-${skill}`);
    const pidFile = join(scratch, `pid-abort-${skill}`);
    const grandPidFile = join(scratch, `grandpid-abort-${skill}`);
    const workDir = freshRepo(`work-abort-${skill}`);
    const lateFile = join(workDir, "late-file.txt");
    const child = runRelay(skill, workDir, outDir, EXTRA_ARGS[skill], { SMOKE_PID_FILE: pidFile, SMOKE_GRAND_PID_FILE: grandPidFile, SMOKE_MODE: "abort", SMOKE_LATE_FILE: lateFile });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    check(`${skill} aborted: the fake implementer came up`, await until(() => existsSync(pidFile), 10_000));
    const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
    child.kill("SIGTERM");
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), 20_000);
      child.on("close", () => { clearTimeout(t); res(true); });
    });
    check(`${skill} aborted: the relay exited after the grace window`, exited);
    check(`${skill} aborted: result.json exists`, existsSync(join(outDir, "result.json")));
    if (existsSync(join(outDir, "result.json"))) {
      const r = result(outDir);
      check(`${skill} aborted: status is "aborted" (got ${r.status})`, r.status === "aborted");
      check(`${skill} aborted: the file flushed during shutdown is in touchedFiles`,
        Array.isArray(r.touchedFiles) && r.touchedFiles.some((f) => f.includes("late-file.txt")));
    }
    check(`${skill} aborted: the implementer's own subprocess is dead (whole tree felled)`,
      grandPid !== null && await until(() => !alive(grandPid), 20_000));
    if (failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nrelay smoke: all green");
process.exit(failed ? 1 : 0);
