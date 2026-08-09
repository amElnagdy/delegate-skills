import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runTimeoutBounds(h) {
const badTimeoutWorkDir = h.freshRepo("work-bad-timeout");
for (const skill of h.SKILLS) {
  // One directory per value: a single leak would otherwise fail every later value too.
  for (const [i, bad] of ["NONSENSE", "", "10", "10s-junk", "1.5s", "1h30", "0s", "596h31m24s", "600h", "10000h"].entries()) {
    const outDir = join(h.scratch, `out-bad-timeout-${skill}-${i}`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath(skill),
      "--brief", h.briefPath,
      "--cd", badTimeoutWorkDir,
      "--out-dir", outDir,
      "--timeout", bad,
      ...h.EXTRA_ARGS[skill],
    ], { env: h.baseEnv, encoding: "utf8", timeout: 10_000 });
    h.check(`${skill} timeout: "${bad}" is rejected before artifacts`,
      rejected.status === 2 && !existsSync(outDir));
  }
  // Positive control for the bound above: the largest duration the h/m/s grammar can express
  // under the ceiling is still a legitimate budget, so validation must not over-reject the edge.
  const accepted = spawnSync(process.execPath, [
    h.relayPath(skill),
    "--brief", h.briefPath,
    "--cd", badTimeoutWorkDir,
    "--out-dir", join(h.scratch, `out-max-timeout-${skill}`),
    "--timeout", "596h31m23s",
    ...h.EXTRA_ARGS[skill],
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 10_000 });
  h.check(`${skill} timeout: the largest schedulable duration is accepted`, accepted.status !== 2);
}
// agy's own --print-timeout carries a 60s grace into the same watchdog, so its ceiling sits
// one grace window lower and it needs its own row.
for (const bad of ["NONSENSE", "0s", "", "10", "10s-junk", "1.5s", "1h30", "596h30m24s", "600h"]) {
  const badRun = spawnSync(process.execPath,
    [h.relayPath("agy"), "--brief", h.briefPath, "--print-timeout", bad],
    { env: h.baseEnv, encoding: "utf8" });
  h.check(`agy print timeout: "${bad}" is rejected`, badRun.status === 2);
}
{
  const outDir = join(h.scratch, "out-agy-version-hang");
  const preflight = spawnSync(process.execPath, [
    h.relayPath("agy"),
    "--brief", h.briefPath,
    "--cd", h.freshRepo("work-agy-version-hang"),
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "agy-version-hang" }, encoding: "utf8", timeout: 15_000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("agy preflight: explicit watchdog bounds a hung version probe",
    preflight.status === 124 &&
    value.status === "timeout" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
}
