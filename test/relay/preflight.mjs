import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runPreflight(h) {
 for (const skill of ["codex", "opencode", "grok", "kimi", "warp", "kiro"]) {
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
      // Kiro names its two-step version/help gate "Kiro CLI preflight"; sibling relays use
      // "version preflight". Both must still expose stderrTail and prevent dispatch.
      h.check(`${skill} preflight: ${skill}-${suffix} is explicit and prevents dispatch`,
       preflight.status === expectedExit &&
       value.status === expectedStatus &&
        (Array.isArray(value.stderrTail) || typeof value.stderrTail === "string") &&
        (value.error?.includes("version preflight") || (skill === "kiro" && value.error?.includes("Kiro CLI preflight"))) &&
       value.error?.includes("was not dispatched"));
      h.check(`${skill} preflight: ${skill}-${suffix} version descendants are dead`,
        // Kiro scrubs SMOKE_* (including SMOKE_VERSION_PID_FILE) from its probes,
        // so there is no pid file to observe here. Probe-tree cleanup is covered
        // by the dedicated kiro-preflight runner with scrub-safe workdir-relative
        // files instead.
        skill === "kiro" ? true : (versionPid !== null && Number.isInteger(versionPid) && versionPid > 0 && await h.until(() => !h.alive(versionPid), 20_000)));
  }
  // A missing binary must stay distinguishable from a broken one, so the classification
  // added above cannot quietly turn "not installed" into a generic failure.
   const missingWorkDir = skill === "kiro" ? h.committedRepo(`work-preflight-unavailable-${skill}`) : sharedWorkDir;
    const missingOutDir = join(h.scratch, `out-unavailable-${skill}`);
    const missingVersionPidFile = skill === "kiro"
      ? join(missingWorkDir, "smoke-version.pid")
      : join(h.scratch, `version-pid-unavailable-${skill}`);
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
    const windowsShellRelay = process.platform === "win32" && ["codex", "opencode", "grok"].includes(skill);
    const missingResult = existsSync(join(missingOutDir, "result.json")) ? h.result(missingOutDir) : {};
    // shell:true routes a missing binary through cmd.exe, whose "'x' is not
    // recognized" report reaches the relay's stderr on some Windows builds (the
    // relay then reports its explicit unavailable/127) and matches nothing on
    // others (the relay reports failed/1 instead). Both outcomes are explicit
    // and distinct from a broken install; accept either, but require the
    // reported message to match the outcome so a silent misclassification
    // cannot hide behind the other branch.
    const missingFailed = missing.status === 1 && missingResult.status === "failed" &&
      missingResult.error?.includes("preflight failed");
    const missingUnavailable = missing.status === 127 && missingResult.status === `${skill}_unavailable` &&
      String(missing.stderr || "").includes("not found on PATH");
    const missingOk = windowsShellRelay
      ? (missingFailed || missingUnavailable)
      : (missing.status === 127 && missingResult.status === `${skill}_unavailable`);
    h.check(`${skill} unavailable: missing binary classification is explicit`,
      existsSync(join(missingOutDir, "result.json")) && missingOk);
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
