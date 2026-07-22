#!/usr/bin/env node
/**
 * delegate-skills · relay smoke.
 *
 * Drives the relays, unmodified and end to end, against a fake implementer CLI
 * planted on PATH, and asserts the two guarantees they make about runs that do
 * not complete:
 *
 *   1. timeout  — the watchdog kills the implementer's WHOLE process tree and
 *                 result.json reports status "timeout". Driven for codex,
 *                 opencode and grok on every platform (on Windows they launch a
 *                 .cmd shim via shell:true — exactly the case a plain
 *                 child.kill would miss) and for kimi on POSIX. kimi and agy
 *                 spawn their binary directly, which never resolves a .cmd
 *                 shim, so a PATH stand-in cannot exist for them on Windows —
 *                 and neither has Windows-specific kill code to prove. agy's
 *                 watchdog is --print-timeout plus a fixed 60s grace, too slow
 *                 for a smoke; its changed code (signal handlers, snapshot
 *                 refresh) is exactly the aborted path below.
 *   2. aborted  — killing the relay itself still produces result.json with
 *                 status "aborted", and files the implementer flushes during
 *                 the shutdown grace window appear in the refreshed
 *                 touchedFiles. Driven for all five relays on POSIX; Windows
 *                 delivers no catchable SIGTERM, so the scenario cannot be
 *                 driven there (the skill docs carry the same caveat).
 *
 * The fake CLI answers each relay's version preflight (--version, `version`,
 * `changelog`) and otherwise runs until killed. Node built-ins only.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = ["codex", "opencode", "agy", "grok", "kimi"];
const relayPath = (skill) => join(here, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
const WIN = process.platform === "win32";
let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "  ok " : "  FAIL"}  ${name}`);
  if (!cond) failed++;
};
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
  try { process.kill(pid, 0); return true; } catch { return false; }
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
if (args.includes("--version") || args[0] === "version" || args[0] === "changelog") {
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
}
process.stdin.resume();
fs.writeFileSync(process.env.SMOKE_PID_FILE, String(process.pid));
if (process.env.SMOKE_MODE === "abort") {
  process.on("SIGTERM", () => { fs.writeFileSync(process.env.SMOKE_LATE_FILE, "flushed during shutdown"); process.exit(0); });
} else {
  process.on("SIGTERM", () => {}); // ignore, so the relay's SIGKILL escalation is what ends it
}
setInterval(() => {}, 1000);
`;

const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-"));
const shimDir = join(scratch, "shim");
mkdirSync(shimDir);
writeFileSync(join(shimDir, "fake-cli.cjs"), FAKE);
for (const skill of SKILLS) {
  if (WIN) {
    writeFileSync(join(shimDir, `${skill}.cmd`), `@node "%~dp0fake-cli.cjs" %*\r\n`);
  } else {
    const shim = join(shimDir, skill);
    writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-cli.cjs" "$@"\n`);
    chmodSync(shim, 0o755);
  }
}
const briefPath = join(scratch, "brief.txt");
writeFileSync(briefPath, "smoke brief: run until killed.");
const baseEnv = { ...process.env, PATH: shimDir + delimiter + process.env.PATH };

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

// opencode refuses a fresh run without an explicit model
const EXTRA_ARGS = { codex: [], opencode: ["--model", "fake/model"], agy: [], grok: [], kimi: [] };

// ---- 1. the --timeout watchdog fells the whole tree ----
const TIMEOUT_SKILLS = WIN ? ["codex", "opencode", "grok"] : ["codex", "opencode", "grok", "kimi"];
for (const skill of TIMEOUT_SKILLS) {
  const outDir = join(scratch, `out-timeout-${skill}`);
  const pidFile = join(scratch, `pid-timeout-${skill}`);
  const workDir = freshRepo(`work-timeout-${skill}`);
  const child = runRelay(skill, workDir, outDir, ["--timeout", "6s", ...EXTRA_ARGS[skill]], { SMOKE_PID_FILE: pidFile, SMOKE_MODE: "timeout" });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  check(`${skill} timeout: the fake implementer came up`, await until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), 45_000);
    child.on("close", () => { clearTimeout(t); res(true); });
  });
  check(`${skill} timeout: the relay exited on its own`, exited);
  check(`${skill} timeout: result.json exists`, existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const r = result(outDir);
    check(`${skill} timeout: status is "timeout" (got ${r.status})`, r.status === "timeout");
    check(`${skill} timeout: relay exit code is non-zero`, r.exitCode !== 0);
  }
  check(`${skill} timeout: the implementer process is dead (tree included)`,
    implementerPid !== null && await until(() => !alive(implementerPid), 20_000));
  if (failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
}

// ---- 2. killing the relay still writes the artifact, with a refreshed snapshot ----
if (WIN) {
  console.log("  skip  aborted-path scenarios: Windows delivers no catchable SIGTERM to drive them");
} else {
  for (const skill of SKILLS) {
    const outDir = join(scratch, `out-abort-${skill}`);
    const pidFile = join(scratch, `pid-abort-${skill}`);
    const workDir = freshRepo(`work-abort-${skill}`);
    const lateFile = join(workDir, "late-file.txt");
    const child = runRelay(skill, workDir, outDir, EXTRA_ARGS[skill], { SMOKE_PID_FILE: pidFile, SMOKE_MODE: "abort", SMOKE_LATE_FILE: lateFile });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    check(`${skill} aborted: the fake implementer came up`, await until(() => existsSync(pidFile), 10_000));
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
    if (failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nrelay smoke: all green");
process.exit(failed ? 1 : 0);
