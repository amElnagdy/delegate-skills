import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function runSyntax(h) {
for (const skill of h.SKILLS) {
  const r = h.relayPath(skill);
  const c = spawnSync(process.execPath, ["--check", r], { encoding: "utf8" });
  h.check(`syntax: ${r.split(/[\\/]/).slice(-3).join("/")}`, c.status === 0);
}
}
