import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function argsContain(args, ...values) {
  return values.every((value) => args.includes(value));
}

export async function runCodebuddy(h) {
  const workDir = h.freshRepo("work-codebuddy");
  const argsPath = join(h.scratch, "args-codebuddy");
  const outDir = join(h.scratch, "out-codebuddy");
  const run = spawnSync(process.execPath, [
    h.relayPath("codebuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--model", "fake-model", "--effort", "high",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "codebuddy-success", SMOKE_ARGS_FILE: argsPath }, encoding: "utf8" });
  const captured = existsSync(argsPath) ? JSON.parse(readFileSync(argsPath, "utf8")) : null;
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  h.check("codebuddy success: relay exits zero", run.status === 0);
  h.check("codebuddy success: brief is delivered on stdin", captured?.brief === "smoke brief: run until killed.");
  h.check("codebuddy success: uses JSON print mode and write approval", captured && argsContain(captured.args, "-p", "--output-format", "json", "-y"));
  h.check("codebuddy success: forwards model and effort", captured && argsContain(captured.args, "--model", "fake-model", "--effort", "high"));
  h.check("codebuddy success: structured result is parsed", result?.status === "completed" && result.sessionId === "codebuddy-session-1" && result.finalMessage === "fake codebuddy completed");
  h.check("codebuddy success: read-only verdict is not applicable", result?.readOnlyViolation === null);

  const readOnlyArgsPath = join(h.scratch, "args-codebuddy-read-only");
  const readOnlyOut = join(h.scratch, "out-codebuddy-read-only");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("codebuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOut, "--model", "fake-model", "--read-only",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "codebuddy-success", SMOKE_ARGS_FILE: readOnlyArgsPath }, encoding: "utf8" });
  const readOnlyArgs = existsSync(readOnlyArgsPath) ? JSON.parse(readFileSync(readOnlyArgsPath, "utf8")) : null;
  const readOnlyResult = existsSync(join(readOnlyOut, "result.json")) ? h.result(readOnlyOut) : null;
  h.check("codebuddy read-only: relay exits zero", readOnly.status === 0);
  h.check("codebuddy read-only: maps to CodeBuddy plan mode without -y", readOnlyArgs && argsContain(readOnlyArgs.args, "--permission-mode", "plan") && !readOnlyArgs.args.includes("-y"));
  h.check("codebuddy read-only: reports clean verdict", readOnlyResult?.readOnlyViolation === false || readOnlyResult?.readOnlyViolation === null);

  const errorOut = join(h.scratch, "out-codebuddy-error");
  const error = spawnSync(process.execPath, [
    h.relayPath("codebuddy"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", errorOut, "--model", "fake-model",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "codebuddy-error" }, encoding: "utf8" });
  h.check("codebuddy failure: non-zero implementer is preserved", error.status === 1 && h.result(errorOut).status === "failed");
}
