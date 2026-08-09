import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runCursor(h) {
{
  const outDir = join(h.scratch, "out-success-cursor");
  const workDir = h.freshRepo("work success cursor");
  const addDir = h.freshRepo("extra success cursor");
  const captureFile = join(h.scratch, "capture-success-cursor.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--session", "cursor-session-0",
    "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
    "--add-dir", addDir,
    "--no-force",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [], brief: "" };
  h.check("cursor success: relay exits zero", run.status === 0);
  h.check("cursor success: session, model, add-dir, and no-force argv are exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
      "--resume", "cursor-session-0",
      "--add-dir", addDir,
    ]));
  h.check("cursor success: brief travels on stdin", capture.brief === "smoke brief: run until killed.");
  h.check("cursor success: result preserves session, model, permission, usage, and final report",
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "completed" &&
    h.result(outDir).force === false &&
    h.result(outDir).sessionId === "cursor-session-1" &&
    h.result(outDir).resolvedModel === "claude-opus-4-8[context=1m,effort=high,fast=false]" &&
    h.result(outDir).permissionMode === "default" &&
    h.result(outDir).usage?.input_tokens === 11 &&
    h.result(outDir).usage?.output_tokens === 4 &&
    h.result(outDir).finalMessage === "fake cursor completed");
}
{
  const outDir = join(h.scratch, "out-read-only-cursor");
  const workDir = h.freshRepo("work-read-only-cursor");
  const captureFile = join(h.scratch, "capture-read-only-cursor.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--read-only",
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [] };
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor read-only: plan mode resumes latest without force",
    run.status === 0 &&
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--mode", "plan",
      "--continue",
    ]) &&
    value.readOnly === true &&
    value.force === false &&
    value.permissionMode === "plan");
  h.check("cursor read-only: no unreliable porcelain tripwire is published",
    !Object.prototype.hasOwnProperty.call(value, "readOnlyViolation"));
}
const cursorNegativeWorkDir = h.freshRepo("work-negative-cursor");
for (const [flag, bad] of [
  ["--session", ""],
  ["--session", "--continue"],
  ["--session", "session & whoami"],
  ["--model", ""],
  ["--model", "--help"],
  ["--model", "model & whoami"],
]) {
  const rejected = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    flag, bad,
  ], { env: h.baseEnv, encoding: "utf8", timeout: 5000 });
  h.check(`cursor validation: unsafe ${flag} value is rejected`, rejected.status === 2);
}
for (const [mode, expectedStatus, expectedExit] of [
  ["cursor-version-hang", "timeout", 124],
  ["cursor-version-fail", "failed", 7],
]) {
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`cursor preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
if (!h.WIN) {
  const outDir = join(h.scratch, "out-abort-preflight-cursor");
  const preflight = h.runRelay("cursor", h.freshRepo("work-abort-preflight-cursor"), outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "cursor-version-hang",
  });
  h.check("cursor preflight abort: run artifacts are prepared",
    await h.until(() => existsSync(join(outDir, "events.jsonl")), 2000));
  preflight.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    preflight.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const outDir = join(h.scratch, "out-unavailable-cursor");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("cursor unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "cursor_agent_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
}
