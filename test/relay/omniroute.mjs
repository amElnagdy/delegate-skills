import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function argsContain(args, ...values) {
  return values.every((value) => args.includes(value));
}

export async function runOmniroute(h) {
  const workDir = h.freshRepo("work-omniroute");
  const argsPath = join(h.scratch, "args-omniroute");
  const outDir = join(h.scratch, "out-omniroute");
  const run = spawnSync(process.execPath, [
    h.relayPath("omniroute"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--model", "fake-model",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "omniroute-success", SMOKE_ARGS_FILE: argsPath }, encoding: "utf8" });
  const captured = existsSync(argsPath) ? JSON.parse(readFileSync(argsPath, "utf8")) : null;
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  h.check("omniroute success: relay exits zero", run.status === 0);
  h.check("omniroute success: brief is delivered on stdin", captured?.brief === "smoke brief: run until killed.");
  h.check("omniroute success: uses run claude and Claude write mode", captured && argsContain(captured.args, "run", "claude", "--model", "fake-model", "--", "--permission-mode", "acceptEdits"));
  h.check("omniroute success: forwards the write tool surface", captured && argsContain(captured.args, "--tools", "Read,Glob,Grep,Edit,Write,Bash"));
  h.check("omniroute success: structured result is parsed", result?.status === "completed" && result.sessionId === "omniroute-session-1" && result.finalMessage === "fake omniroute completed");
  h.check("omniroute success: records the routed command", result?.omniroute?.command === "omniroute" && result.omniroute.args.includes("run"));

  const readOnlyArgsPath = join(h.scratch, "args-omniroute-read-only");
  const readOnlyOut = join(h.scratch, "out-omniroute-read-only");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("omniroute"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOut, "--model", "fake-model", "--read-only",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "omniroute-success", SMOKE_ARGS_FILE: readOnlyArgsPath }, encoding: "utf8" });
  const readOnlyArgs = existsSync(readOnlyArgsPath) ? JSON.parse(readOnlyArgsPath && readFileSync(readOnlyArgsPath, "utf8")) : null;
  const readOnlyResult = existsSync(join(readOnlyOut, "result.json")) ? h.result(readOnlyOut) : null;
  h.check("omniroute read-only: relay exits zero", readOnly.status === 0);
  h.check("omniroute read-only: maps to Claude plan mode and read tools", readOnlyArgs && argsContain(readOnlyArgs.args, "--permission-mode", "plan", "--tools", "Read,Glob,Grep") && !readOnlyArgs.args.includes("Edit"));
  h.check("omniroute read-only: reports completed", readOnlyResult?.status === "completed");

  const errorOut = join(h.scratch, "out-omniroute-error");
  const error = spawnSync(process.execPath, [
    h.relayPath("omniroute"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", errorOut, "--model", "fake-model",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "omniroute-error" }, encoding: "utf8" });
  h.check("omniroute failure: non-zero implementer is preserved", error.status === 1 && h.result(errorOut).status === "failed");
}
