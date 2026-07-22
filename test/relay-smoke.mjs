#!/usr/bin/env node
/**
 * delegate-skills · relay smoke.
 *
 * Runs the codex relay against a fake implementer CLI and asserts the two
 * guarantees the relay makes about runs that do not complete:
 *
 *   1. timeout  — the --timeout watchdog kills the implementer's WHOLE process
 *                 tree (on Windows the relay launches a .cmd shim via shell:true,
 *                 so this is exactly the case a plain child.kill would miss), and
 *                 result.json reports status "timeout".
 *   2. aborted  — killing the relay itself still produces result.json with
 *                 status "aborted", and files the implementer flushes during the
 *                 shutdown grace window appear in the refreshed touchedFiles.
 *                 (POSIX only: Windows delivers no catchable SIGTERM, so the
 *                 aborted path cannot be driven from a test there.)
 *
 * The fake implementer is a stand-in on PATH named `codex` (`codex.cmd` on
 * Windows) — the relay is exercised unmodified, end to end. Node built-ins only.
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RELAYS = ["codex", "opencode", "agy", "grok", "kimi"].map(
  (s) => join(here, "..", "skills", `${s}-delegate`, "scripts", "relay.mjs"),
);
const CODEX_RELAY = RELAYS[0];
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
for (const r of RELAYS) {
  const c = spawnSync(process.execPath, ["--check", r], { encoding: "utf8" });
  check(`syntax: ${r.split(/[\\/]/).slice(-3).join("/")}`, c.status === 0);
}

// ---- a fake `codex` on PATH: --version answers the preflight; anything else runs forever ----
const FAKE = `const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0-smoke"); process.exit(0); }
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
writeFileSync(join(shimDir, "fake-codex.cjs"), FAKE);
if (WIN) {
  writeFileSync(join(shimDir, "codex.cmd"), `@node "%~dp0fake-codex.cjs" %*\r\n`);
} else {
  const shim = join(shimDir, "codex");
  writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.cjs" "$@"\n`);
  chmodSync(shim, 0o755);
}
const workDir = join(scratch, "repo");
mkdirSync(workDir);
spawnSync("git", ["-C", workDir, "init", "-q"], { encoding: "utf8" });
const briefPath = join(scratch, "brief.txt");
writeFileSync(briefPath, "smoke brief: run until killed.");
const baseEnv = { ...process.env, PATH: shimDir + delimiter + process.env.PATH };

const runRelay = (outDir, extraArgs, extraEnv) =>
  spawn(process.execPath, [CODEX_RELAY, "--brief", briefPath, "--cd", workDir, "--out-dir", outDir, ...extraArgs], {
    env: { ...baseEnv, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });

const result = (outDir) => JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));

// ---- 1. the --timeout watchdog fells the whole tree ----
{
  const outDir = join(scratch, "out-timeout");
  const pidFile = join(scratch, "pid-timeout");
  const child = runRelay(outDir, ["--timeout", "6s"], { SMOKE_PID_FILE: pidFile, SMOKE_MODE: "timeout" });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  check("timeout: the fake implementer came up", await until(() => existsSync(pidFile), 10_000));
  const implementerPid = Number(readFileSync(pidFile, "utf8"));
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), 45_000);
    child.on("close", () => { clearTimeout(t); res(true); });
  });
  check("timeout: the relay exited on its own", exited);
  check("timeout: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const r = result(outDir);
    check(`timeout: status is "timeout" (got ${r.status})`, r.status === "timeout");
    check("timeout: relay exit code is non-zero", r.exitCode !== 0);
  }
  check("timeout: the implementer process is dead (tree included)", await until(() => !alive(implementerPid), 20_000));
  if (failed) console.error(`relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
}

// ---- 2. killing the relay still writes the artifact, with a refreshed snapshot ----
if (WIN) {
  console.log("  skip  aborted-path scenario: Windows delivers no catchable SIGTERM to drive it");
} else {
  const outDir = join(scratch, "out-abort");
  const pidFile = join(scratch, "pid-abort");
  const lateFile = join(workDir, "late-file.txt");
  const child = runRelay(outDir, [], { SMOKE_PID_FILE: pidFile, SMOKE_MODE: "abort", SMOKE_LATE_FILE: lateFile });
  check("aborted: the fake implementer came up", await until(() => existsSync(pidFile), 10_000));
  child.kill("SIGTERM");
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), 20_000);
    child.on("close", () => { clearTimeout(t); res(true); });
  });
  check("aborted: the relay exited after the grace window", exited);
  check("aborted: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const r = result(outDir);
    check(`aborted: status is "aborted" (got ${r.status})`, r.status === "aborted");
    check("aborted: the file flushed during shutdown is in touchedFiles",
      Array.isArray(r.touchedFiles) && r.touchedFiles.some((f) => f.includes("late-file.txt")));
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nrelay smoke: all green");
process.exit(failed ? 1 : 0);
