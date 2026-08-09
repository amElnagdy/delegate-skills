import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runAtomic(h) {
for (const skill of h.SKILLS) {
  const atomicOutDir = join(h.scratch, `out-atomic-${skill}`);
  const atomicWorkDir = h.freshRepo(`work-atomic-${skill}`);
  const resultPath = join(atomicOutDir, "result.json");
  const child = h.runRelay(skill, atomicWorkDir, atomicOutDir, h.EXTRA_ARGS[skill], {
    NODE_OPTIONS: h.slowWriteNodeOptions,
    SMOKE_MODE: "capture",
    SMOKE_ARGS_FILE: join(h.scratch, `args-atomic-${skill}`),
  });
  let exitCode;
  let parseFailed = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => { exitCode = code; });
  const deadline = Date.now() + 15_000;
  while (exitCode === undefined && Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try { h.result(atomicOutDir); } catch { parseFailed = true; }
    }
    await h.sleep(5);
  }
  const timedOut = exitCode === undefined;
  if (timedOut) child.kill();
  await h.until(() => exitCode !== undefined, 5_000);
  if (exitCode === undefined) child.kill("SIGKILL"); // a relay that ignored SIGTERM would keep its tree alive
  let finalResultValid = false;
  try { finalResultValid = Boolean(h.result(atomicOutDir)); } catch {}
  const leftovers = existsSync(atomicOutDir) ? readdirSync(atomicOutDir).filter((f) => f.includes(".tmp")) : [];
  h.check(`${skill} atomic: relay exits`, !timedOut);
  h.check(`${skill} atomic: result.json is never partially published`, !parseFailed && finalResultValid);
  h.check(`${skill} atomic: no temporary result file survives the run`, leftovers.length === 0);
  if (timedOut) console.error(`${skill} atomic relay stderr:\n${stderr}`);
}
}
