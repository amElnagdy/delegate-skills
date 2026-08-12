import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export async function runKiroPreflight(h) {
  for (const [suffix, expectedStatus, expectedExit] of [
    ["version-hang", "timeout", 124],
    ["version-hang-tree", "timeout", 124],
    ["version-fail", "failed", 1],
    ["version-fail-silent", "failed", 1],
    ["help-missing", "failed", 1],
  ]) {
    const workDir = h.committedRepo(`work-kiro-preflight-${suffix}`);
    const outDir = join(h.scratch, `out-kiro-preflight-${suffix}`);
    const versionGrandPidFile = join(workDir, "smoke-version-grand.pid");
    const run = spawnSync(process.execPath, [
      h.relayPath("kiro"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--timeout", suffix === "version-hang" ? "1s" : "30s",
    ], {
      env: {
        ...h.baseEnv,
        PATH: h.baseEnv.PATH,
        SMOKE_MODE: `kiro-${suffix}`,
        ...(suffix === "version-hang-tree" ? {
          SMOKE_VERSION_PID_FILE: join(workDir, "smoke-version.pid"),
          SMOKE_VERSION_GRAND_PID_FILE: versionGrandPidFile,
        } : {}),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const resultPath = join(outDir, "result.json");
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
    h.check(`kiro preflight: ${suffix} exits with ${expectedExit}`, run.status === expectedExit);
    h.check(`kiro preflight: ${suffix} fails before dispatch`,
      result.status === expectedStatus && result.errorCode === "kiro_preflight_failed");
    h.check(`kiro preflight: ${suffix} records structured probes`,
      result.preflight?.version && Object.prototype.hasOwnProperty.call(result.preflight, "help"));
    if (suffix === "version-hang-tree") {
      const grandPid = existsSync(versionGrandPidFile) ? Number(readFileSync(versionGrandPidFile, "utf8")) : null;
      h.check("kiro preflight: version timeout kills probe grandchild", grandPid !== null && await h.until(() => !h.alive(grandPid), 10_000));
    }
  }

  const workDir = h.committedRepo("work-kiro-preflight-missing");
  const outDir = join(h.scratch, "out-kiro-preflight-missing");
  const missing = spawnSync(process.execPath, [
    h.relayPath("kiro"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--kiro-bin", join(h.scratch, "missing-kiro.exe"),
  ], { env: { ...h.baseEnv, PATH: h.gitOnlyPath }, encoding: "utf8", timeout: 30_000 });
  const resultPath = join(outDir, "result.json");
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
  h.check("kiro unavailable: missing binary exits 127", missing.status === 127);
  h.check("kiro unavailable: result is distinguishable", result.status === "kiro_unavailable" && result.errorCode === "kiro_unavailable");
}
