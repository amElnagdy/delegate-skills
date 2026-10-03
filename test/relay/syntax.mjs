import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function runSyntax(h) {
  const server = join(h.testDir, "..", "skills", "codex-background", "scripts", "server.mjs");
  const checked = spawnSync(process.execPath, ["--check", server], { encoding: "utf8" });
  h.check("syntax: codex-background/scripts/server.mjs", checked.status === 0);
  const supervisor = join(h.testDir, "..", "skills", "codex-background", "scripts", "supervisor.mjs");
  h.check("syntax: codex-background/scripts/supervisor.mjs", spawnSync(process.execPath, ["--check", supervisor], { encoding: "utf8" }).status === 0);
for (const skill of h.SKILLS) {
  const r = h.relayPath(skill);
  const c = spawnSync(process.execPath, ["--check", r], { encoding: "utf8" });
  h.check(`syntax: ${r.split(/[\\/]/).slice(-3).join("/")}`, c.status === 0);
}
}
