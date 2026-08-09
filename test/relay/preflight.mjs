import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runPreflight(h) {
for (const skill of ["codex", "opencode", "grok", "kimi"]) {
  const workDir = h.freshRepo(`work-preflight-${skill}`);
  for (const [suffix, expectedStatus, expectedExit] of [
    ["version-hang", "timeout", 124],
    ["version-fail", "failed", 7],
    ["version-fail-silent", "failed", 7],
  ]) {
    const outDir = join(h.scratch, `out-${skill}-${suffix}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath(skill),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--timeout", "1s",
      ...h.EXTRA_ARGS[skill],
    ], { env: { ...h.baseEnv, SMOKE_MODE: `${skill}-${suffix}` }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`${skill} preflight: ${skill}-${suffix} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      Array.isArray(value.stderrTail) &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
  // A missing binary must stay distinguishable from a broken one, so the classification
  // added above cannot quietly turn "not installed" into a generic failure.
  const missingOutDir = join(h.scratch, `out-unavailable-${skill}`);
  const missing = spawnSync(process.execPath, [
    h.relayPath(skill),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
    ...h.EXTRA_ARGS[skill],
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15_000 });
  h.check(`${skill} unavailable: missing binary still reports ${skill}_unavailable`,
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === `${skill}_unavailable`);
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
