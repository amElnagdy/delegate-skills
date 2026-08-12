import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export async function runKiroConsoleAbort(h) {
  if (!h.WIN) {
    console.log("  skip  kiro console abort: Windows-only console control event");
    return;
  }
  const workDir = h.committedRepo("work-kiro-console-abort");
  const outDir = join(h.scratch, "out-kiro-console-abort");
  const pidFile = join(workDir, "smoke.pid");
  const grandPidFile = join(workDir, "smoke-grand.pid");
  const lateFile = join(workDir, "late-file.txt");
  const kiroBin = join(h.scratch, "shim", "kiro-cli.exe");
  h.check("kiro console abort: helper compiled", Boolean(h.consoleSignalHelper));
  if (!h.consoleSignalHelper) return;
  const run = spawnSync(h.consoleSignalHelper, [
    process.execPath,
    h.relayPath("kiro"),
    h.briefPath,
    workDir,
    outDir,
    kiroBin,
    pidFile,
  ], {
    cwd: h.testDir,
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "abort",
      SMOKE_PID_FILE: pidFile,
      SMOKE_GRAND_PID_FILE: grandPidFile,
      SMOKE_LATE_FILE: lateFile,
    },
    encoding: "utf8",
    timeout: 45_000,
  });
  const resultPath = join(outDir, "result.json");
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
  h.check(`kiro console abort: helper exits with relay abort code (got ${run.status})`, run.status === 130);
  h.check("kiro console abort: result exists", existsSync(resultPath));
  h.check("kiro console abort: result records aborted status", result.status === "aborted" && result.errorCode === "aborted");
  h.check("kiro console abort: signal is a console abort signal", result.signal === "SIGINT" || result.signal === "SIGBREAK");
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  h.check("kiro console abort: implementer is dead", implementerPid !== null && await h.until(() => !h.alive(implementerPid), 10_000));
  h.check("kiro console abort: implementer's child is dead", grandPid !== null && await h.until(() => !h.alive(grandPid), 10_000));
  if (run.stderr) console.error(`kiro console abort stderr:\n${run.stderr}`);
}
