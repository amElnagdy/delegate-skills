import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SKILLS, WIN, binaryName } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(harnessDir, "..", "fixtures");

export function installShim(h) {
  const shimDir = join(h.scratch, "shim");
  mkdirSync(shimDir);
  copyFileSync(join(fixturesDir, "fake-cli.cjs"), join(shimDir, "fake-cli.cjs"));

  if (WIN) {
    for (const skill of ["claude", "codex", "opencode", "grok", "cursor", "pi"]) {
      writeFileSync(join(shimDir, `${binaryName(skill)}.cmd`), `@node "%~dp0fake-cli.cjs" %*\r\n`);
    }
    const windir = process.env.WINDIR || "C:\\Windows";
    const csc = [
      join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ].find((p) => existsSync(p));
    h.check("windows: the in-box C# compiler exists (builds the native fake for agy/kimi/qoder/vibe)", Boolean(csc));
    if (csc) {
      const csFile = join(shimDir, "fake-cli.cs");
      copyFileSync(join(fixturesDir, "fake-cli.cs"), csFile);
      const compiled = spawnSync(csc, ["/nologo", `/out:${join(shimDir, "kimi.exe")}`, csFile], { encoding: "utf8" });
      h.check("windows: the native fake compiled", compiled.status === 0);
      if (compiled.status === 0) {
        copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "agy.exe"));
        copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "qodercli.exe"));
        copyFileSync(join(shimDir, "kimi.exe"), join(shimDir, "vibe.exe"));
      } else {
        console.error(`${compiled.stdout ?? ""}${compiled.stderr ?? ""}`);
      }
    }
  } else {
    for (const skill of SKILLS) {
      const shim = join(shimDir, binaryName(skill));
      writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-cli.cjs" "$@"\n`);
      chmodSync(shim, 0o755);
    }
  }

  h.briefPath = join(h.scratch, "brief.txt");
  writeFileSync(h.briefPath, "smoke brief: run until killed.");
  h.baseEnv = { ...process.env, PATH: shimDir + delimiter + process.env.PATH, SMOKE_NODE: process.execPath };

  const slowWriteHook = join(h.scratch, "slow-result-write.cjs");
  copyFileSync(join(fixturesDir, "slow-result-write.cjs"), slowWriteHook);
  h.slowWriteNodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(slowWriteHook.replaceAll("\\", "/"))}`]
    .filter(Boolean)
    .join(" ");
}
