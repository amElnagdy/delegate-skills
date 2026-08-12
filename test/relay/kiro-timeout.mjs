import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runKiroTimeout(h) {
  const workDir = h.committedRepo("work-kiro-timeout");
  const outDir = join(h.scratch, "out-kiro-timeout");
  const pidFile = join(workDir, "smoke.pid");
  const grandPidFile = join(workDir, "smoke-grand.pid");
  const child = h.runRelay("kiro", workDir, outDir, ["--timeout", "1s"], {
    SMOKE_PID_FILE: pidFile,
    SMOKE_GRAND_PID_FILE: grandPidFile,
    SMOKE_MODE: "kiro-timeout",
  });
  h.check("kiro timeout: fake implementer came up", await h.until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    child.on("close", () => { clearTimeout(timer); resolve(true); });
  });
  h.check("kiro timeout: relay exits within bounded deadline", exited);
  const resultPath = join(outDir, "result.json");
  h.check("kiro timeout: result exists", existsSync(resultPath));
  if (existsSync(resultPath)) {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    h.check(`kiro timeout: status is timeout (got ${result.status})`, result.status === "timeout");
    h.check("kiro timeout: exit code is non-zero", result.exitCode !== 0);
  }
  h.check("kiro timeout: implementer is dead", implementerPid !== null && await h.until(() => !h.alive(implementerPid), 10_000));
  h.check("kiro timeout: grandchild is dead", grandPid !== null && await h.until(() => !h.alive(grandPid), 10_000));
}
