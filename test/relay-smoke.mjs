#!/usr/bin/env node
/**
 * delegate-skills · relay smoke.
 *
 * Drives the relays, unmodified and end to end, against a fake implementer CLI
 * planted on PATH, and asserts the two guarantees they make about runs that do
 * not complete:
 *
 *   1. timeout  — the watchdog kills the implementer's WHOLE process tree and
 *                 result.json reports status "timeout". Driven for all ten
 *                 relays on both platforms. On Windows, claude and cursor
 *                 launch a .cmd shim through a serialized cmd.exe invocation,
 *                 while codex/opencode/grok/pi use shell:true. These are exactly the
 *                 cases a plain child.kill would miss; agy, kimi, qoder, and vibe spawn a
 *                 native binary directly — a .cmd stand-in cannot represent them,
 *                 so the smoke compiles a real fake .exe with the C# compiler
 *                 that ships in-box with Windows (no install, no network) and
 *                 puts it on PATH under their names. A POSIX variant repeats
 *                 each run with a parent that complies with
 *                 SIGTERM while its grandchild ignores it — the sweep at close
 *                 must fell the survivor even though the parent's exit
 *                 cancelled the pending escalation timer.
 *   2. aborted  — killing the relay itself still produces result.json with
 *                 status "aborted", and files the implementer flushes during
 *                 the shutdown grace window appear in the refreshed
 *                 touchedFiles. Driven for all ten relays on POSIX; Windows
 *                 delivers no catchable SIGTERM, so the scenario cannot be
 *                 driven there (the skill docs carry the same caveat).
 *
 * Every fake answers each relay's version preflight (--version, `version`,
 * `changelog`), and can be told to hang or fail that probe by mode name, so a
 * relay whose preflight is unbounded — wedging before any result.json exists —
 * or which reports a broken CLI as a missing one is caught here.
 * A shared matrix also drives all ten through the --timeout values no
 * watchdog can honour — malformed, zero, and past Node's timer ceiling — each of
 * which would otherwise fire on the next tick as a silent instant "timeout".
 * Quick Claude, Cursor, Qoder, Vibe, and Pi success cases verify brief
 * delivery, launch arguments, environment handling, and result-event parsing. The
 * timeout/abort cases otherwise run until killed and spawn a subprocess of
 * their own; both assert that this grandchild dies with the implementer.
 * Node built-ins only.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "wordpress"];
// wordpress-delegate launches no CLI of its own — it dispatches through a sibling relay, so the
// binary at the end of its chain is whichever implementer it routed to. EXTRA_ARGS pins it to
// codex for the shared matrix, which is why it answers to codex's fake here.
const binaryName = (skill) => skill === "qoder" ? "qodercli" : skill === "cursor" ? "cursor-agent" : skill === "wordpress" ? "codex" : skill;
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

// ---- package shape and registration ----
// Read from disk rather than from SKILLS, so a skill cannot ship without entering the matrix below:
// the one thing a hard-coded list cannot catch is its own omission.
{
  const skillsDir = join(here, "..", "skills");
  const onDisk = readdirSync(skillsDir).filter((d) => d.endsWith("-delegate")).sort();
  const registered = new Set(
    JSON.parse(readFileSync(join(here, "..", "skills.sh.json"), "utf8"))
      .groupings.flatMap((g) => g.skills),
  );
  const REFERENCES = ["writing-the-brief", "dispatch-and-poll", "review-and-land", "multi-task-queues"];

  check("skills/ is not empty", onDisk.length > 0);
  for (const dir of onDisk) {
    const name = dir.replace(/-delegate$/, "");
    check(`${name}: in the smoke matrix`, SKILLS.includes(name));
    check(`${name}: SKILL.md`, existsSync(join(skillsDir, dir, "SKILL.md")));
    check(`${name}: scripts/relay.mjs`, existsSync(join(skillsDir, dir, "scripts", "relay.mjs")));
    check(
      `${name}: exactly the four references`,
      REFERENCES.every((r) => existsSync(join(skillsDir, dir, "references", `${r}.md`))) &&
        readdirSync(join(skillsDir, dir, "references")).filter((f) => f.endsWith(".md")).length === REFERENCES.length,
    );
    check(`${name}: listed in skills.sh.json`, registered.has(dir));
  }
  check("smoke matrix has no entry without a directory", SKILLS.every((s) => onDisk.includes(`${s}-delegate`)));
  check("skills.sh.json has no entry without a directory", [...registered].every((s) => onDisk.includes(s)));
}

// ---- every relay must at least parse ----
for (const skill of SKILLS) {
  const r = relayPath(skill);
  const c = spawnSync(process.execPath, ["--check", r], { encoding: "utf8" });
  check(`syntax: ${r.split(/[\\/]/).slice(-3).join("/")}`, c.status === 0);
}

// ---- one fake CLI, planted on PATH under every relay's binary name ----
const FAKE = `const fs = require("node:fs");
const args = process.argv.slice(2);
// Every probe form one relay or another uses: --version, grok's \`version\` subcommand, and
// agy's \`changelog\`. Treating them alike lets any relay's hang/fail mode be driven by name.
const versionProbe = args.includes("--version") || args[0] === "version" || args[0] === "changelog";
if (versionProbe && process.env.SMOKE_MODE === "grok-version-fallback-budget") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  if (args[0] === "version") {
    console.error("fake documented version failure");
    process.exit(7);
  }
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
} else if (versionProbe && /-version-hang$/.test(process.env.SMOKE_MODE || "")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (versionProbe && /-version-fail-silent$/.test(process.env.SMOKE_MODE || "")) {
  process.exit(7);
} else if (versionProbe && /-version-fail$/.test(process.env.SMOKE_MODE || "")) {
  console.error("fake version failure");
  process.exit(7);
} else if (versionProbe) {
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "capture") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
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
if (process.env.SMOKE_MODE === "vibe-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({ role: "assistant", content: "working" }));
  console.log(JSON.stringify({ role: "assistant", content: "fake vibe completed" }));
  process.exit(0);
}
if (["pi-success", "pi-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "pi-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    console.log(JSON.stringify({ type: "session", version: 3, id: "pi-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: failed ? "fake pi failed" : "fake pi completed" }],
        provider: "google",
        model: "fake-model",
        usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } },
        stopReason: failed ? "error" : "stop",
        ...(failed ? { errorMessage: "fake provider failure" } : {}),
      },
    }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    process.exit(0);
  });
} else if (["cursor-success", "claude-success", "claude-read-only-write", "claude-read-only-clean", "claude-chunked"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", async () => {
    const mode = process.env.SMOKE_MODE;
    if (mode === "cursor-success") {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({ args, brief }));
      console.log(JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-1",
        model: "claude-opus-4-8[context=1m,effort=high,fast=false]",
        permissionMode: args.includes("plan") ? "plan" : "default",
      }));
      console.log(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "cursor-session-1",
        result: "fake cursor completed",
        usage: { input_tokens: 11, output_tokens: 4 },
      }));
      return;
    }
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

// agy, kimi, qoder, and vibe spawn a native binary without a shell, so on Windows their stand-in must be a
// real .exe. The C# compiler ships in-box with the .NET Framework on every supported Windows,
// which lets the smoke build one locally — no install, no network, still dependency-free.
const FAKE_EXE_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class FakeCli {
  static int Main(string[] args) {
    // Mirrors the .cjs fake: any probe form, and hang/fail selected by the mode's suffix,
    // so a native-binary relay (agy, kimi, qoder, vibe) enters the same preflight matrix.
    var mode = Environment.GetEnvironmentVariable("SMOKE_MODE") ?? "";
    bool versionProbe = Array.IndexOf(args, "--version") >= 0
      || (args.Length > 0 && (args[0] == "version" || args[0] == "changelog"));
    if (versionProbe && mode.EndsWith("-version-hang")) {
      Thread.Sleep(Timeout.Infinite);
      return 1;
    }
    if (versionProbe && mode.EndsWith("-version-fail-silent")) {
      return 7;
    }
    if (versionProbe && mode.EndsWith("-version-fail")) {
      Console.Error.WriteLine("fake version failure");
      return 7;
    }
    if (versionProbe) {
      Console.WriteLine("fake-cli 0.0.0-smoke");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "capture") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "qoder-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"qoder-session-1\\",\\"model\\":\\"performance\\",\\"permissionMode\\":\\"auto\\"}");
      Console.WriteLine("{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"qoder-session-1\\",\\"result\\":\\"fake qoder completed\\",\\"usage\\":{\\"input_tokens\\":7,\\"output_tokens\\":2}}");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "vibe-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("{\\"role\\":\\"assistant\\",\\"content\\":\\"working\\"}");
      Console.WriteLine("{\\"role\\":\\"assistant\\",\\"content\\":\\"fake vibe completed\\"}");
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
  for (const skill of ["claude", "codex", "opencode", "grok", "cursor", "pi"]) {
    writeFileSync(join(shimDir, `${binaryName(skill)}.cmd`), `@node "%~dp0fake-cli.cjs" %*\r\n`);
  }
  const windir = process.env.WINDIR || "C:\\Windows";
  const csc = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((p) => existsSync(p));
  check("windows: the in-box C# compiler exists (builds the native fake for agy/kimi/qoder/vibe)", Boolean(csc));
  if (csc) {
    const csFile = join(shimDir, "fake-cli.cs");
    writeFileSync(csFile, FAKE_EXE_SOURCE);
    const compiled = spawnSync(csc, ["/nologo", `/out:${join(shimDir, "kimi.exe")}`, csFile], { encoding: "utf8" });
    check("windows: the native fake compiled", compiled.status === 0);
    if (compiled.status === 0) {
      copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "agy.exe"));
      copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "qodercli.exe"));
      copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "vibe.exe"));
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
const slowWriteHook = join(scratch, "slow-result-write.cjs");
writeFileSync(slowWriteHook, `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function (path, data, options) {
  if (!String(path).includes("result.json")) return writeFileSync.apply(this, arguments);
  const encoding = typeof options === "string" ? options : options?.encoding;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
  const split = Math.max(1, Math.floor(bytes.length / 2));
  writeFileSync(path, bytes.subarray(0, split));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  writeFileSync(path, bytes.subarray(split), { flag: "a" });
};
syncBuiltinESMExports();
`);
const slowWriteNodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(slowWriteHook.replaceAll("\\", "/"))}`]
  .filter(Boolean)
  .join(" ");

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
// ---- codex --session resumes one exact thread ----
const sessionOutDir = join(scratch, "out-session-codex");
const sessionArgsFile = join(scratch, "args-session-codex");
const sessionWorkDir = freshRepo("work-session-codex");
const sessionRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--cd", sessionWorkDir, "--out-dir", sessionOutDir, "--session", "thread-abc"],
  { env: { ...baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: sessionArgsFile }, encoding: "utf8" });
const sessionArgs = existsSync(sessionArgsFile) ? JSON.parse(readFileSync(sessionArgsFile, "utf8")) : [];
check("codex session: resumes the named thread",
  sessionRun.status === 0 && sessionArgs[0] === "exec" && sessionArgs[1] === "resume" && sessionArgs[2] === "thread-abc");
check("codex session: no -s on a resume (exec resume rejects it)", !sessionArgs.includes("-s"));
check("codex session: recorded in result.json",
  existsSync(join(sessionOutDir, "result.json")) && result(sessionOutDir).session === "thread-abc");
const bothResumeRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--session", "thread-abc", "--resume-last"],
  { env: baseEnv, encoding: "utf8" });
check("codex session: --session with --resume-last is rejected", bothResumeRun.status === 2);
for (const [name, value] of [
  ["an empty id", ""],
  ["an option-like id", "--resume-last"],
  ["a shell-unsafe id", "thread & whoami"],
]) {
  const invalidSessionRun = spawnSync(process.execPath,
    [relayPath("codex"), "--brief", briefPath, "--session", value],
    { env: baseEnv, encoding: "utf8" });
  check(`codex session: ${name} is rejected`, invalidSessionRun.status === 2);
}

const emptyEffortRun = spawnSync(process.execPath,
  [relayPath("codex"), "--brief", briefPath, "--effort", ""],
  { env: baseEnv, encoding: "utf8" });
check("codex effort: an empty value is rejected", emptyEffortRun.status === 2);

// opencode refuses a fresh run without an explicit model
// wordpress-delegate routes by brief content; the shared smoke brief carries no WordPress signal,
// so pin the implementer rather than letting the matrix depend on the router's default.
const EXTRA_ARGS = { claude: [], codex: [], opencode: ["--model", "fake/model"], agy: [], grok: [], kimi: [], qoder: [], vibe: [], cursor: [], pi: [], wordpress: ["--implementer", "codex"] };

// ---- Cursor's session/model controls and structured result ----
{
  const outDir = join(scratch, "out-success-cursor");
  const workDir = freshRepo("work success cursor");
  const addDir = freshRepo("extra success cursor");
  const captureFile = join(scratch, "capture-success-cursor.json");
  const run = spawnSync(process.execPath, [
    relayPath("cursor"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--session", "cursor-session-0",
    "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
    "--add-dir", addDir,
    "--no-force",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [], brief: "" };
  check("cursor success: relay exits zero", run.status === 0);
  check("cursor success: session, model, add-dir, and no-force argv are exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
      "--resume", "cursor-session-0",
      "--add-dir", addDir,
    ]));
  check("cursor success: brief travels on stdin", capture.brief === "smoke brief: run until killed.");
  check("cursor success: result preserves session, model, permission, usage, and final report",
    existsSync(join(outDir, "result.json")) &&
    result(outDir).status === "completed" &&
    result(outDir).force === false &&
    result(outDir).sessionId === "cursor-session-1" &&
    result(outDir).resolvedModel === "claude-opus-4-8[context=1m,effort=high,fast=false]" &&
    result(outDir).permissionMode === "default" &&
    result(outDir).usage?.input_tokens === 11 &&
    result(outDir).usage?.output_tokens === 4 &&
    result(outDir).finalMessage === "fake cursor completed");
}
{
  const outDir = join(scratch, "out-read-only-cursor");
  const workDir = freshRepo("work-read-only-cursor");
  const captureFile = join(scratch, "capture-read-only-cursor.json");
  const run = spawnSync(process.execPath, [
    relayPath("cursor"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--read-only",
    "--resume-last",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [] };
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check("cursor read-only: plan mode resumes latest without force",
    run.status === 0 &&
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--mode", "plan",
      "--continue",
    ]) &&
    value.readOnly === true &&
    value.force === false &&
    value.permissionMode === "plan");
  check("cursor read-only: no unreliable porcelain tripwire is published",
    !Object.prototype.hasOwnProperty.call(value, "readOnlyViolation"));
}
const cursorNegativeWorkDir = freshRepo("work-negative-cursor");
for (const [flag, bad] of [
  ["--session", ""],
  ["--session", "--continue"],
  ["--session", "session & whoami"],
  ["--model", ""],
  ["--model", "--help"],
  ["--model", "model & whoami"],
]) {
  const rejected = spawnSync(process.execPath, [
    relayPath("cursor"),
    "--brief", briefPath,
    "--cd", cursorNegativeWorkDir,
    flag, bad,
  ], { env: baseEnv, encoding: "utf8", timeout: 5000 });
  check(`cursor validation: unsafe ${flag} value is rejected`, rejected.status === 2);
}
for (const [mode, expectedStatus, expectedExit] of [
  ["cursor-version-hang", "timeout", 124],
  ["cursor-version-fail", "failed", 7],
]) {
  const outDir = join(scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    relayPath("cursor"),
    "--brief", briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check(`cursor preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
if (!WIN) {
  const outDir = join(scratch, "out-abort-preflight-cursor");
  const preflight = runRelay("cursor", freshRepo("work-abort-preflight-cursor"), outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "cursor-version-hang",
  });
  check("cursor preflight abort: run artifacts are prepared",
    await until(() => existsSync(join(outDir, "events.jsonl")), 2000));
  preflight.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    preflight.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check("cursor preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const outDir = join(scratch, "out-unavailable-cursor");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    relayPath("cursor"),
    "--brief", briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  check("cursor unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    result(outDir).status === "cursor_agent_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}

// ---- Vibe's documented streaming argv and safer permission default ----
for (const scenario of [
  { name: "default", relayArgs: [], agent: "accept-edits", forwarded: [], resumed: false },
  { name: "plan only", relayArgs: ["--plan-only"], agent: "plan", forwarded: [], resumed: false },
  {
    name: "full access",
    relayArgs: ["--full-access", "--max-turns", "3", "--max-price", "0.5", "--max-tokens", "1000"],
    agent: "auto-approve",
    forwarded: ["--max-turns", "3", "--max-price", "0.5", "--max-tokens", "1000"],
    resumed: false,
  },
  {
    name: "session and tools",
    relayArgs: ["--session", "vibe-session-1", "--enabled-tools", "read_file", "--disabled-tools", "bash"],
    agent: "accept-edits",
    forwarded: ["--resume", "vibe-session-1", "--enabled-tools", "read_file", "--disabled-tools", "bash"],
    resumed: true,
  },
  {
    name: "resume last",
    relayArgs: ["--resume-last"],
    agent: "accept-edits",
    forwarded: ["--continue"],
    resumed: true,
  },
]) {
  const outDir = join(scratch, `out-${scenario.name}-vibe`);
  const workDir = freshRepo(`work-${scenario.name}-vibe`);
  const argsFile = join(scratch, `args-${scenario.name}-vibe`);
  const run = spawnSync(process.execPath, [
    relayPath("vibe"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...scenario.relayArgs,
  ], {
    env: { ...baseEnv, SMOKE_MODE: "vibe-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? WIN
      ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(argsFile, "utf8"))
    : [];
  check(`vibe ${scenario.name}: relay exits zero`, run.status === 0);
  check(`vibe ${scenario.name}: documented argv is exact`,
    JSON.stringify(args) === JSON.stringify([
      "--output", "streaming",
      "--agent", scenario.agent,
      "--trust",
      ...scenario.forwarded,
      "--prompt=smoke brief: run until killed.",
    ]));
  check(`vibe ${scenario.name}: result and assistant output are captured`,
    existsSync(join(outDir, "result.json")) &&
    result(outDir).status === "completed" &&
    result(outDir).finalMessage === "fake vibe completed" &&
    result(outDir).resumed === scenario.resumed &&
    result(outDir).sessionId === null);
}
for (const [mode, expectedStatus, expectedExit] of [
  ["vibe-version-hang", "timeout", 124],
  ["vibe-version-fail", "failed", 7],
]) {
  const workDir = freshRepo(`work-${mode}`);
  const outDir = join(scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    relayPath("vibe"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check(`vibe preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = freshRepo("work-unavailable-vibe");
  const outDir = join(scratch, "out-unavailable-vibe");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    relayPath("vibe"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  check("vibe unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    result(outDir).status === "vibe_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
if (!WIN) {
  const workDir = freshRepo("work-abort-preflight-vibe");
  const outDir = join(scratch, "out-abort-preflight-vibe");
  const preflight = runRelay("vibe", workDir, outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "vibe-version-hang",
  });
  check("vibe preflight abort: run artifacts are prepared",
    await until(() => existsSync(join(outDir, "events.jsonl")), 2000));
  preflight.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    preflight.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check("vibe preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = freshRepo("work-nul-brief-vibe");
  const nulBrief = join(scratch, "nul-vibe-brief.txt");
  const outDir = join(scratch, "out-nul-brief-vibe");
  writeFileSync(nulBrief, Buffer.from("brief\0tail"));
  const rejected = spawnSync(process.execPath, [
    relayPath("vibe"),
    "--brief", nulBrief,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: baseEnv, encoding: "utf8" });
  check("vibe validation: NUL brief is rejected before artifacts",
    rejected.status === 2 && !existsSync(outDir));
}
if (WIN) {
  const workDir = freshRepo("work-long-brief-vibe");
  const longBrief = join(scratch, "long-vibe-brief.txt");
  const outDir = join(scratch, "out-long-brief-vibe");
  writeFileSync(longBrief, "x".repeat(13 * 1024));
  const rejected = spawnSync(process.execPath, [
    relayPath("vibe"),
    "--brief", longBrief,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: baseEnv, encoding: "utf8" });
  check("vibe Windows: oversized argv brief is rejected before artifacts",
    rejected.status === 2 && !existsSync(outDir));
}

// ---- every relay publishes result.json atomically ----
// Slow the filesystem write inside each relay and parse any visible result while it is still
// running. A direct result.json write exposes half-written JSON; temp + rename never does.
for (const skill of SKILLS) {
  const atomicOutDir = join(scratch, `out-atomic-${skill}`);
  const atomicWorkDir = freshRepo(`work-atomic-${skill}`);
  const resultPath = join(atomicOutDir, "result.json");
  const child = runRelay(skill, atomicWorkDir, atomicOutDir, EXTRA_ARGS[skill], {
    NODE_OPTIONS: slowWriteNodeOptions,
    SMOKE_MODE: "capture",
    SMOKE_ARGS_FILE: join(scratch, `args-atomic-${skill}`),
  });
  let exitCode;
  let parseFailed = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => { exitCode = code; });
  const deadline = Date.now() + 15_000;
  while (exitCode === undefined && Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try { result(atomicOutDir); } catch { parseFailed = true; }
    }
    await sleep(5);
  }
  const timedOut = exitCode === undefined;
  if (timedOut) child.kill();
  await until(() => exitCode !== undefined, 5_000);
  let finalResultValid = false;
  try { finalResultValid = Boolean(result(atomicOutDir)); } catch {}
  const leftovers = existsSync(atomicOutDir) ? readdirSync(atomicOutDir).filter((f) => f.includes(".tmp")) : [];
  check(`${skill} atomic: relay exits`, !timedOut);
  check(`${skill} atomic: result.json is never partially published`, !parseFailed && finalResultValid);
  check(`${skill} atomic: no temporary result file survives the run`, leftovers.length === 0);
  if (timedOut) console.error(`${skill} atomic relay stderr:\n${stderr}`);
}

// ---- the version preflight is bounded and classified, not open-ended ----
// The probe runs before the watchdog is armed, so an implementer that never answers its
// version query would wedge the relay with no result.json and no --timeout able to reach it.
// A probe that *fails* is a distinct outcome from a missing binary: reporting exit 127
// "not installed" for a CLI that is installed but broken sends the caller to reinstall it.
for (const skill of ["codex", "opencode", "grok", "kimi"]) {
  const workDir = freshRepo(`work-preflight-${skill}`);
  for (const [suffix, expectedStatus, expectedExit] of [
    ["version-hang", "timeout", 124],
    ["version-fail", "failed", 7],
    ["version-fail-silent", "failed", 7],
  ]) {
    const outDir = join(scratch, `out-${skill}-${suffix}`);
    const preflight = spawnSync(process.execPath, [
      relayPath(skill),
      "--brief", briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--timeout", "1s",
      ...EXTRA_ARGS[skill],
    ], { env: { ...baseEnv, SMOKE_MODE: `${skill}-${suffix}` }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
    check(`${skill} preflight: ${skill}-${suffix} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      Array.isArray(value.stderrTail) &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
  // A missing binary must stay distinguishable from a broken one, so the classification
  // added above cannot quietly turn "not installed" into a generic failure.
  const missingOutDir = join(scratch, `out-unavailable-${skill}`);
  const missing = spawnSync(process.execPath, [
    relayPath(skill),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
    ...EXTRA_ARGS[skill],
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15_000 });
  check(`${skill} unavailable: missing binary still reports ${skill}_unavailable`,
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    result(missingOutDir).status === `${skill}_unavailable`);
}

if (!WIN) {
  const workDir = freshRepo("work-preflight-grok-fallback-budget");
  const outDir = join(scratch, "out-grok-version-fallback-budget");
  const preflight = spawnSync(process.execPath, [
    relayPath("grok"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...baseEnv, SMOKE_MODE: "grok-version-fallback-budget" }, encoding: "utf8", timeout: 15_000 });
  check("grok preflight: fallback shares one timeout budget",
    preflight.status === 124 && result(outDir).status === "timeout");
}

// ---- no relay accepts a --timeout its watchdog cannot honour ----
// Driven for all ten, because an unhonourable delay turns a typo into an instant, silent
// "timeout" — the one failure mode a watchdog must never have. Two ways in: parseDuration
// returns null for a malformed value and setTimeout(fn, null) fires on the next tick; and a
// delay past 2^31-1 ms overflows and fires immediately too, so "600h" would fell the
// implementer half a second in and report a 25-day budget as already spent. Both are usage
// errors, so both must exit 2 before any artifact exists.
const badTimeoutWorkDir = freshRepo("work-bad-timeout");
for (const skill of SKILLS) {
  for (const bad of ["NONSENSE", "", "10", "10s-junk", "1.5s", "1h30", "0s", "596h31m24s", "600h", "10000h"]) {
    const outDir = join(scratch, `out-bad-timeout-${skill}`);
    const rejected = spawnSync(process.execPath, [
      relayPath(skill),
      "--brief", briefPath,
      "--cd", badTimeoutWorkDir,
      "--out-dir", outDir,
      "--timeout", bad,
      ...EXTRA_ARGS[skill],
    ], { env: baseEnv, encoding: "utf8", timeout: 10_000 });
    check(`${skill} timeout: "${bad}" is rejected before artifacts`,
      rejected.status === 2 && !existsSync(outDir));
  }
  // Positive control for the bound above: the largest duration the h/m/s grammar can express
  // under the ceiling is still a legitimate budget, so validation must not over-reject the edge.
  const accepted = spawnSync(process.execPath, [
    relayPath(skill),
    "--brief", briefPath,
    "--cd", badTimeoutWorkDir,
    "--out-dir", join(scratch, `out-max-timeout-${skill}`),
    "--timeout", "596h31m23s",
    ...EXTRA_ARGS[skill],
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 10_000 });
  check(`${skill} timeout: the largest schedulable duration is accepted`, accepted.status !== 2);
}
// agy's own --print-timeout carries a 60s grace into the same watchdog, so its ceiling sits
// one grace window lower and it needs its own row.
for (const bad of ["NONSENSE", "0s", "", "10", "10s-junk", "1.5s", "1h30", "596h30m24s", "600h"]) {
  const badRun = spawnSync(process.execPath,
    [relayPath("agy"), "--brief", briefPath, "--print-timeout", bad],
    { env: baseEnv, encoding: "utf8" });
  check(`agy print timeout: "${bad}" is rejected`, badRun.status === 2);
}
{
  const outDir = join(scratch, "out-agy-version-hang");
  const preflight = spawnSync(process.execPath, [
    relayPath("agy"),
    "--brief", briefPath,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...baseEnv, SMOKE_MODE: "agy-version-hang" }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
  check("agy preflight: explicit watchdog bounds a hung version probe",
    preflight.status === 124 &&
    value.status === "timeout" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}

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

// ---- pi's stdin brief, JSON event stream, and bounded preflight ----
{
  const outDir = join(scratch, "out-success-pi");
  const workDir = freshRepo("work-success-pi");
  const argsFile = join(scratch, "args-success-pi");
  const run = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--provider", "google",
    "--model", "google/fake-model",
    "--read-only",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
  check("pi success: relay exits zero", run.status === 0);
  check("pi success: documented argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--mode", "json",
      "--provider", "google",
      "--model", "google/fake-model",
      "--no-approve",
      "--tools", "read,grep,find,ls",
    ]));
  check("pi success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
  check("pi success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = result(outDir);
    check("pi success: session header and message_end parsed",
      value.status === "completed" &&
      value.sessionId === "pi-session-1" &&
      value.finalMessage === "fake pi completed" &&
      value.readOnly === true &&
      value.projectTrusted === false &&
      value.provider === "google" &&
      value.model === "google/fake-model" &&
      value.actualProvider === "google" &&
      value.actualModel === "fake-model" &&
      value.usage?.input === 7 &&
      value.usage?.output === 2 &&
      value.stopReason === "stop" &&
      value.resumed === false);
  }

  const approveOutDir = join(scratch, "out-approve-pi");
  const approveArgsFile = join(scratch, "args-approve-pi");
  const approveRun = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", approveOutDir,
    "--approve",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: approveArgsFile },
    encoding: "utf8",
  });
  const approveCapture = existsSync(approveArgsFile) ? JSON.parse(readFileSync(approveArgsFile, "utf8")) : {};
  check("pi project trust: --approve is explicit and recorded",
    approveRun.status === 0 &&
    JSON.stringify(approveCapture.args) === JSON.stringify(["--mode", "json", "--approve"]) &&
    result(approveOutDir).projectTrusted === true);

  const unsafeProvider = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--provider", "google & whoami",
  ], { env: baseEnv, encoding: "utf8" });
  check("pi provider: shell-unsafe value is rejected", unsafeProvider.status === 2);

  const errorOutDir = join(scratch, "out-error-pi");
  const errorArgsFile = join(scratch, "args-error-pi");
  const errorRun = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", errorOutDir,
  ], {
    env: { ...baseEnv, SMOKE_MODE: "pi-error", SMOKE_ARGS_FILE: errorArgsFile },
    encoding: "utf8",
  });
  const errorResult = existsSync(join(errorOutDir, "result.json")) ? result(errorOutDir) : {};
  check("pi assistant error: exit-zero event is reported as failed",
    errorRun.status === 1 &&
    errorResult.status === "failed" &&
    errorResult.exitCode === 1 &&
    errorResult.stopReason === "error" &&
    errorResult.error === "fake provider failure");

  const resumeOutDir = join(scratch, "out-resume-last-pi");
  const resumeArgsFile = join(scratch, "args-resume-last-pi");
  const resume = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--resume-last",
  ], {
    env: { ...baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeCapture = existsSync(resumeArgsFile) ? JSON.parse(readFileSync(resumeArgsFile, "utf8")) : {};
  check("pi resume-last: uses documented --continue",
    resume.status === 0 &&
    resumeCapture.args.includes("--continue") &&
    !resumeCapture.args.includes("--session") &&
    existsSync(join(resumeOutDir, "result.json")) &&
    result(resumeOutDir).resumed === true);

  const missingOutDir = join(scratch, "out-unavailable-pi");
  const missing = spawnSync(process.execPath, [
    relayPath("pi"),
    "--brief", briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  check("pi unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    result(missingOutDir).status === "pi_unavailable");

  for (const [mode, expectedStatus, expectedExit] of [
    ["pi-version-fail", "failed", 7],
    ["pi-version-hang", "timeout", 124],
  ]) {
    const preflightOutDir = join(scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      relayPath("pi"),
      "--brief", briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? result(preflightOutDir)
      : {};
    check(`pi preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }

  if (!WIN) {
    const preflightOutDir = join(scratch, "out-abort-preflight-pi");
    const preflight = runRelay("pi", workDir, preflightOutDir, ["--timeout", "1s"], {
      SMOKE_MODE: "pi-version-hang",
    });
    check("pi preflight abort: run artifacts are prepared",
      await until(() => existsSync(join(preflightOutDir, "events.jsonl")), 2000));
    preflight.kill("SIGTERM");
    const exited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 5000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
    const value = existsSync(join(preflightOutDir, "result.json")) ? result(preflightOutDir) : {};
    check("pi preflight abort: result is aborted and dispatch never starts",
      exited &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
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

// ---- wordpress routing: the lane table, the flag translation, and the sibling boundary ----
// This relay's own job is the routing decision, so the decision is what gets asserted. --dry-run
// makes that testable without launching anything; the dispatch path below then proves the decision
// survives the hand-off to a sibling.
{
  const routed = (args, briefText, extraEnv) => {
    const file = join(scratch, `wp-brief-${Buffer.from(briefText).toString("hex").slice(0, 24)}.txt`);
    writeFileSync(file, briefText);
    const run = spawnSync(process.execPath, [relayPath("wordpress"), "--brief", file, ...args], {
      env: { ...baseEnv, ...extraEnv }, encoding: "utf8", timeout: 15_000,
    });
    let decision = null;
    try { decision = JSON.parse(run.stdout); } catch { /* left null: the check below reports it */ }
    return { run, decision };
  };

  // One row per lane the table ships, phrased the way a WordPress task actually arrives.
  const ROUTING_CASES = [
    ["security audit of the checkout AJAX handlers: no nonce check, and I suspect SQL injection",
      "security-audit", "grok", true],
    ["research which payment gateway to use for subscriptions; compare the options with pros and cons",
      "research", "grok", true],
    ["write the documentation: update readme.txt, add a changelog entry and PHPDoc docblocks",
      "documentation", "kimi", false],
    ["large refactor: rename the legacy prefix across all files and migrate all helpers into a class",
      "refactor-sweep", "opencode", false],
    ["build a new custom plugin with PSR-4 autoloading, a service container, and an activation hook",
      "plugin-architecture", "codex", false],
    ["build a complex Elementor widget with custom controls and a dynamic tag for the loop builder",
      "elementor-widget", "codex", false],
    ["add a dynamic block: registerBlockType with a block.json, InnerBlocks, and a render_callback",
      "block-editor", "codex", false],
    ["performance pass: slow queries on the archive, 4MB of autoloaded options, object cache with redis",
      "performance", "codex", false],
  ];
  for (const [text, lane, implementer, readOnly] of ROUTING_CASES) {
    const { run, decision } = routed(["--dry-run", "--model", "fake/model"], text);
    check(`wordpress routing: "${lane}" → ${implementer}`,
      run.status === 0 &&
      decision?.lane === lane &&
      decision?.implementer === implementer &&
      decision?.readOnly === readOnly &&
      decision?.confidence === "high" &&
      Array.isArray(decision?.matchedSignals) && decision.matchedSignals.length >= 2);
  }

  // Signals are matched case-insensitively, so a table row written in the casing its ecosystem uses
  // still fires. Without this a capital letter produces a signal that can never match, which is
  // invisible: the lane just quietly scores lower than it should.
  const cased = routed(["--dry-run"], "Register the GUTENBERG block with registerBlockType and theme.json");
  check("wordpress routing: signals match regardless of the brief's casing",
    cased.decision?.lane === "block-editor" &&
    cased.decision.matchedSignals.some((s) => /GUTENBERG/.test(s)) &&
    cased.decision.matchedSignals.some((s) => /registerBlockType/.test(s)));

  // A signal that can never fire is invisible — the lane just scores lower than it should. `\b@` is
  // the trap: the boundary would have to sit between a non-word character and `@`, which is not a
  // boundary, so a leading \b there matches only when glued to a word. Pin the package mention.
  const pkg = routed(["--dry-run"], "Import the block from @wordpress/blocks and register it");
  check("wordpress routing: an @wordpress package mention is a block-editor signal",
    pkg.decision?.lane === "block-editor" &&
    pkg.decision.matchedSignals.some((s) => s.startsWith("@wordpress/")));

  // A read-only lane winning on one weak signal would return findings and an empty diff to someone
  // who asked for a fix, and read as the implementer doing nothing. One mention of "nonce" in a
  // bugfix brief demotes to implementation rather than silently withholding writes.
  const weakAudit = routed(["--dry-run"], "fix the cart hook: the wc_get_order lookup is missing a nonce check");
  check("wordpress routing: a read-only lane on one signal demotes to implementation, keeping writes",
    weakAudit.run.status === 0 &&
    weakAudit.decision?.lane === "implementation" &&
    weakAudit.decision?.readOnly === false &&
    weakAudit.decision?.confidence === "low" &&
    weakAudit.decision?.alternates?.[0]?.lane === "security-audit" &&
    /too weak to withhold writes/.test(weakAudit.decision?.reason ?? ""));

  // Two signals is enough for the same lane to keep its read-only default.
  const realAudit = routed(["--dry-run"], "security audit of the cart hook: no nonce check anywhere");
  check("wordpress routing: two signals let the read-only lane stand",
    realAudit.decision?.lane === "security-audit" && realAudit.decision?.readOnly === true);

  // A brief with no lane signal must not silently pick a lane and pretend to be sure about it.
  const vague = routed(["--dry-run"], "please make the thing better");
  check("wordpress routing: an unroutable brief falls back with confidence \"none\" and a question",
    vague.run.status === 0 &&
    vague.decision?.lane === "implementation" &&
    vague.decision?.confidence === "none" &&
    typeof vague.decision?.clarification === "string" && vague.decision.clarification.length > 0);

  // ... and --strict-routing turns that question into a refusal, before any artifact exists.
  const strictOutDir = join(scratch, "out-wordpress-strict");
  const strictBrief = join(scratch, "wp-strict-brief.txt");
  writeFileSync(strictBrief, "please make the thing better");
  const strict = spawnSync(process.execPath, [
    relayPath("wordpress"), "--brief", strictBrief, "--out-dir", strictOutDir, "--strict-routing",
  ], { env: baseEnv, encoding: "utf8", timeout: 15_000 });
  check("wordpress routing: --strict-routing refuses with exit 3 and writes no artifacts",
    strict.status === 3 && !existsSync(strictOutDir) && /strict-routing refused/.test(strict.stderr));

  // An explicit --implementer bypasses the table entirely, and says so rather than inventing a lane.
  const forced = routed(["--dry-run", "--implementer", "pi"],
    "security audit of the checkout AJAX handlers: no nonce check, and I suspect SQL injection");
  check("wordpress routing: --implementer overrides the table and is marked forced",
    forced.run.status === 0 && forced.decision?.implementer === "pi" && forced.decision?.confidence === "forced");

  // The portable --read-only must be spelled in each CLI's own terms, since three of them spell it
  // differently and two cannot do it at all. A wrong translation surfaces as an unknown option from
  // the sibling, which reads like a bug here rather than a property of that CLI.
  const READ_ONLY_TRANSLATION = [
    ["codex", ["--read-only"]],
    ["claude", ["--read-only"]],
    ["cursor", ["--read-only"]],
    ["grok", ["--read-only"]],
    ["opencode", ["--read-only"]],
    ["pi", ["--read-only"]],
    ["qoder", ["--permission-mode", "plan"]],
    ["vibe", ["--plan-only"]],
  ];
  for (const [implementer, expected] of READ_ONLY_TRANSLATION) {
    const { run, decision } = routed(["--dry-run", "--read-only", "--model", "fake/model", "--implementer", implementer],
      "review the plugin bootstrap");
    check(`wordpress routing: --read-only becomes "${expected.join(" ")}" for ${implementer}`,
      run.status === 0 && JSON.stringify(decision?.implementerFlags) === JSON.stringify(expected));
  }
  for (const implementer of ["kimi", "agy"]) {
    const { run } = routed(["--read-only", "--implementer", implementer], "review the plugin bootstrap");
    check(`wordpress routing: --read-only is refused for ${implementer}, which has no such mode`,
      run.status === 2 && /has no read-only mode/.test(run.stderr));
  }
  // Resume is the same problem: qoder spells it --resume, agy --conversation, everyone else --session.
  const qoderResume = routed(["--dry-run", "--implementer", "qoder", "--session", "abc123"], "fix the shortcode");
  const agyResume = routed(["--dry-run", "--implementer", "agy", "--session", "abc123"], "fix the shortcode");
  check("wordpress routing: --session is spelled in the chosen CLI's own terms",
    JSON.stringify(qoderResume.decision?.implementerFlags) === JSON.stringify(["--resume", "abc123"]) &&
    JSON.stringify(agyResume.decision?.implementerFlags) === JSON.stringify(["--conversation", "abc123"]));

  // opencode is the one sibling that rejects a run with no --model. Catch it here, where the message
  // can name the lane that routed there, rather than letting the sibling exit 2 on its own.
  const noModel = routed(["--dry-run"],
    "large refactor: rename the legacy prefix across all files and migrate all helpers into a class");
  check("wordpress routing: a missing --model for opencode is reported as a blocker, not a crash",
    noModel.run.status === 0 && /requires an explicit model/.test(noModel.decision?.blocker ?? ""));

  // The preamble is the other half of this skill: every brief carries the WordPress standards, and
  // the domain notes are selected by what the router detected.
  const preamble = spawnSync(process.execPath, [relayPath("wordpress"), "--print-preamble"], { encoding: "utf8" });
  check("wordpress preamble: --print-preamble emits the standards block",
    preamble.status === 0 &&
    /wordpress_engineering_standards/.test(preamble.stdout) &&
    /nonce AND a capability/.test(preamble.stdout) &&
    /\$wpdb->prepare\(\)/.test(preamble.stdout) &&
    /Do NOT run git add or git commit/.test(preamble.stdout));

  // End to end through a real sibling: the decision must survive the hand-off, the composed brief
  // must carry the preamble and the domain notes, and the sibling's result must be lifted intact.
  {
    const outDir = join(scratch, "out-wordpress-dispatch");
    const workDir = freshRepo("work-wordpress-dispatch");
    const wpBrief = join(scratch, "wp-dispatch-brief.txt");
    writeFileSync(wpBrief, "Fix the WooCommerce checkout: the wc_get_order lookup in the cart hook is missing a nonce check.");
    const run = spawnSync(process.execPath, [
      relayPath("wordpress"), "--brief", wpBrief, "--cd", workDir, "--out-dir", outDir, "--implementer", "codex",
    ], {
      env: { ...baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(scratch, "args-wordpress-dispatch") },
      encoding: "utf8", timeout: 20_000,
    });
    const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
    const dispatched = existsSync(join(outDir, "dispatched-brief.txt"))
      ? readFileSync(join(outDir, "dispatched-brief.txt"), "utf8") : "";
    check("wordpress dispatch: the run completes through the sibling relay",
      run.status === 0 && value.status === "completed" && value.implementer === "codex");
    check("wordpress dispatch: the routing decision is recorded in result.json",
      value.routing?.implementer === "codex" &&
      value.routing?.forced === true &&
      Array.isArray(value.routing?.domains) &&
      value.routing.domains.includes("woocommerce") &&
      value.routing.domains.includes("security"));
    check("wordpress dispatch: the sibling's own result is embedded verbatim, not paraphrased",
      value.implementerResult?.schema === "delegate-relay.result.v1" &&
      value.implementerResult?.status === "completed" &&
      value.implementerResultPath === join(outDir, "implementer", "result.json"));
    check("wordpress dispatch: the composed brief carries the preamble, the detected domains, and the original text",
      /wordpress_engineering_standards/.test(dispatched) &&
      /<domain_notes>/.test(dispatched) &&
      /HPOS makes post-table assumptions wrong/.test(dispatched) &&
      /wc_get_order lookup in the cart hook/.test(dispatched));
    if (run.status !== 0) console.error(`wordpress dispatch stderr:\n${run.stderr}`);
  }

  // A resumed session already holds the preamble; re-sending it would restate standards the
  // implementer was given on the first pass.
  {
    const outDir = join(scratch, "out-wordpress-resume");
    const workDir = freshRepo("work-wordpress-resume");
    const wpBrief = join(scratch, "wp-resume-brief.txt");
    writeFileSync(wpBrief, "Also escape the order id in the admin column.");
    spawnSync(process.execPath, [
      relayPath("wordpress"), "--brief", wpBrief, "--cd", workDir, "--out-dir", outDir,
      "--implementer", "codex", "--session", "thread-1",
    ], {
      env: { ...baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(scratch, "args-wordpress-resume") },
      encoding: "utf8", timeout: 20_000,
    });
    const dispatched = existsSync(join(outDir, "dispatched-brief.txt"))
      ? readFileSync(join(outDir, "dispatched-brief.txt"), "utf8") : "";
    check("wordpress dispatch: a resumed run sends the delta brief without the preamble",
      dispatched.trim() === "Also escape the order id in the admin column." &&
      existsSync(join(outDir, "result.json")) && result(outDir).preamble === false);
  }

  // The sibling boundary is this skill's one hard dependency, so its absence must be a named
  // outcome with a result file — not an unhandled spawn error.
  {
    const outDir = join(scratch, "out-wordpress-missing-sibling");
    const workDir = freshRepo("work-wordpress-missing-sibling");
    const wpBrief = join(scratch, "wp-missing-brief.txt");
    writeFileSync(wpBrief, "fix the shortcode output escaping");
    const run = spawnSync(process.execPath, [
      relayPath("wordpress"), "--brief", wpBrief, "--cd", workDir, "--out-dir", outDir,
      "--implementer", "codex", "--implementer-relay", join(scratch, "no-such-relay.mjs"),
    ], { env: baseEnv, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(outDir, "result.json")) ? result(outDir) : {};
    check("wordpress: a missing sibling relay is implementer_unavailable at exit 127, with a result file",
      run.status === 127 &&
      value.status === "implementer_unavailable" &&
      value.exitCode === 127 &&
      /dispatches through its siblings/.test(value.error ?? ""));
  }
}

// ---- 1. the watchdog fells the whole tree ----
// Use agy's explicit watchdog here: this is the path that bounds a server-side hang
// beyond agy's own --print-timeout, and it keeps the shared smoke fast.
const TIMEOUT_CASES = [
  { skill: "claude", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "codex", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "opencode", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "grok", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "kimi", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "qoder", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "pi", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "cursor", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "vibe", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "agy", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  // wordpress forwards --timeout to the sibling, which owns the kill, and arms a backstop a grace
  // window later. The sibling must fire first: if the backstop is what fells the tree, the reported
  // status is still "timeout" but the run overshot by a minute, which the deadline below catches.
  { skill: "wordpress", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
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
    if (skill === "agy") {
      const timeoutIndex = flags.indexOf("--timeout");
      const expectedLimit = timeoutIndex === -1
        ? `--print-timeout ${flags[flags.indexOf("--print-timeout") + 1]} plus 60s grace`
        : `--timeout ${flags[timeoutIndex + 1]}`;
      check(`agy ${tag}: selected limit is named in the result`, r.error?.includes(expectedLimit));
    }
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
await driveTimeout(
  { skill: "agy", flags: ["--print-timeout", "1s", "--timeout", "4s"], exitDeadline: 45_000 },
  "timeout",
  {},
  "timeout-precedence",
);

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

  const outDir = join(scratch, "out-abort-defiant-vibe");
  const pidFile = join(scratch, "pid-abort-defiant-vibe");
  const grandPidFile = join(scratch, "grandpid-abort-defiant-vibe");
  const workDir = freshRepo("work-abort-defiant-vibe");
  const child = runRelay("vibe", workDir, outDir, [], {
    SMOKE_PID_FILE: pidFile,
    SMOKE_GRAND_PID_FILE: grandPidFile,
    SMOKE_GRAND_IGNORES_SIGTERM: "1",
    SMOKE_MODE: "abort-defiant",
  });
  check("vibe defiant abort: the fake implementer came up",
    await until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  check("vibe defiant abort: relay exits after forced termination", exited);
  check("vibe defiant abort: result is aborted",
    existsSync(join(outDir, "result.json")) && result(outDir).status === "aborted");
  check("vibe defiant abort: the implementer process is dead",
    implementerPid !== null && await until(() => !alive(implementerPid), 5000));
  check("vibe defiant abort: the implementer's own subprocess is dead",
    grandPid !== null && await until(() => !alive(grandPid), 5000));
}

rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nrelay smoke: all green");
process.exit(failed ? 1 : 0);
