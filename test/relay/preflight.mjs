import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runPreflight(h) {
 for (const skill of ["codex", "opencode", "grok", "kimi", "kiro"]) {
   const sharedWorkDir = skill === "kiro" ? null : h.freshRepo(`work-preflight-${skill}`);
   for (const [suffix, expectedStatus, expectedExit] of [
    ["version-hang", "timeout", 124],
     ["version-fail", "failed", skill === "kiro" ? 1 : 7],
     ["version-fail-silent", "failed", skill === "kiro" ? 1 : 7],
   ]) {
      const workDir = skill === "kiro" ? h.committedRepo(`work-preflight-${skill}-${suffix}`) : sharedWorkDir;
      const outDir = join(h.scratch, `out-${skill}-${suffix}`);
      const versionPidFile = skill === "kiro"
        ? join(workDir, "smoke-version.pid")
        : join(h.scratch, `version-pid-${skill}-${suffix}`);
      const preflight = spawnSync(process.execPath, [
        h.relayPath(skill),
        "--brief", h.briefPath,
        "--cd", workDir,
        "--out-dir", outDir,
        "--timeout", suffix === "version-hang" ? "1s" : "30s",
        ...h.EXTRA_ARGS[skill],
      ], {
        env: {
          ...h.baseEnv,
          SMOKE_MODE: `${skill}-${suffix}`,
          SMOKE_VERSION_PID_FILE: versionPidFile,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
      const versionPid = existsSync(versionPidFile) ? Number(readFileSync(versionPidFile, "utf8")) : null;
      h.check(`${skill} preflight: ${skill}-${suffix} is explicit and prevents dispatch`,
       preflight.status === expectedExit &&
       value.status === expectedStatus &&
        (Array.isArray(value.stderrTail) || typeof value.stderrTail === "string" || (skill === "kiro" && value.stderrTail === undefined)) &&
        (value.error?.includes("version preflight") || (skill === "kiro" && value.error?.includes("Kiro CLI preflight"))) &&
       value.error?.includes("was not dispatched"));
      h.check(`${skill} preflight: ${skill}-${suffix} version descendants are dead`,
        versionPid !== null && Number.isInteger(versionPid) && versionPid > 0 && await h.until(() => !h.alive(versionPid), 20_000));
  }
  // A missing binary must stay distinguishable from a broken one, so the classification
  // added above cannot quietly turn "not installed" into a generic failure.
   const missingWorkDir = skill === "kiro" ? h.committedRepo(`work-preflight-unavailable-${skill}`) : sharedWorkDir;
    const missingOutDir = join(h.scratch, `out-unavailable-${skill}`);
    const missingVersionPidFile = join(h.scratch, `version-pid-unavailable-${skill}`);
   const missingArgs = skill === "kiro" ? ["--kiro-bin", join(h.scratch, "missing-kiro.exe")] : [];
   const missing = spawnSync(process.execPath, [
    h.relayPath(skill),
    "--brief", h.briefPath,
     "--cd", missingWorkDir,
    "--out-dir", missingOutDir,
     ...h.EXTRA_ARGS[skill],
     ...missingArgs,
    ], {
      env: { ...h.baseEnv, PATH: h.gitOnlyPath, SMOKE_VERSION_PID_FILE: missingVersionPidFile },
      encoding: "utf8",
      timeout: 60_000,
    });
   const windowsShellFailure = process.platform === "win32" && ["codex", "opencode", "grok"].includes(skill);
   const missingStatus = windowsShellFailure ? "failed" : `${skill}_unavailable`;
   const missingExit = windowsShellFailure ? 1 : 127;
    h.check(`${skill} unavailable: missing binary classification is explicit`,
      missing.status === missingExit &&
      existsSync(join(missingOutDir, "result.json")) &&
      h.result(missingOutDir).status === missingStatus);
    const missingVersionPid = existsSync(missingVersionPidFile) ? Number(readFileSync(missingVersionPidFile, "utf8")) : null;
    h.check(`${skill} unavailable: no version descendants leaked`,
      missingVersionPid === null || (Number.isInteger(missingVersionPid) && await h.until(() => !h.alive(missingVersionPid), 20_000)));
}

if (!h.WIN) {
  const workDir = h.freshRepo("work-preflight-grok-fallback-budget");
  const outDir = join(h.scratch, "out-grok-version-fallback-budget");
  const preflight = spawnSync(process.execPath, [
    h.relayPath("grok"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "grok-version-fallback-budget" }, encoding: "utf8", timeout: 15_000 });
  h.check("grok preflight: fallback shares one timeout budget",
    preflight.status === 124 &&
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "timeout");
}
}
