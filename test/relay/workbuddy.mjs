import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function argsContain(args, ...values) {
  return values.every((value) => args.includes(value));
}

export async function runWorkbuddy(h) {
  const workDir = h.freshRepo("work-workbuddy");
  const argsPath = join(h.scratch, "args-workbuddy");
  const outDir = join(h.scratch, "out-workbuddy");
  const run = spawnSync(process.execPath, [
    h.relayPath("workbuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--model", "fake-model", "--effort", "high",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "workbuddy-success", SMOKE_ARGS_FILE: argsPath }, encoding: "utf8" });
  const captured = existsSync(argsPath) ? JSON.parse(readFileSync(argsPath, "utf8")) : null;
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  h.check("workbuddy success: relay exits zero", run.status === 0);
  h.check("workbuddy success: brief is delivered on stdin", captured?.brief === "smoke brief: run until killed.");
  h.check("workbuddy success: uses JSON print mode and write approval", captured && argsContain(captured.args, "-p", "--output-format", "json", "-y"));
  h.check("workbuddy success: forwards model and effort", captured && argsContain(captured.args, "--model", "fake-model", "--effort", "high"));
  h.check("workbuddy success: structured result is parsed", result?.status === "completed" && result.sessionId === "workbuddy-session-1" && result.finalMessage === "fake workbuddy completed");
  h.check("workbuddy success: read-only verdict is not applicable", result?.readOnlyViolation === null);

  const readOnlyArgsPath = join(h.scratch, "args-workbuddy-read-only");
  const readOnlyOut = join(h.scratch, "out-workbuddy-read-only");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("workbuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOut, "--model", "fake-model", "--read-only",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "workbuddy-success", SMOKE_ARGS_FILE: readOnlyArgsPath }, encoding: "utf8" });
  const readOnlyArgs = existsSync(readOnlyArgsPath) ? JSON.parse(readFileSync(readOnlyArgsPath, "utf8")) : null;
  const readOnlyResult = existsSync(join(readOnlyOut, "result.json")) ? h.result(readOnlyOut) : null;
  h.check("workbuddy read-only: relay exits zero", readOnly.status === 0);
  h.check("workbuddy read-only: maps to CodeBuddy plan mode without -y", readOnlyArgs && argsContain(readOnlyArgs.args, "--permission-mode", "plan") && !readOnlyArgs.args.includes("-y"));
  h.check("workbuddy read-only: reports clean verdict", readOnlyResult?.readOnlyViolation === false || readOnlyResult?.readOnlyViolation === null);

  const errorOut = join(h.scratch, "out-workbuddy-error");
  const error = spawnSync(process.execPath, [
    h.relayPath("workbuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", errorOut, "--model", "fake-model",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "workbuddy-error" }, encoding: "utf8" });
  h.check("workbuddy failure: non-zero implementer is preserved", error.status === 1 && h.result(errorOut).status === "failed");
}
