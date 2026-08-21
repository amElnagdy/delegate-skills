import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The win32 launch sends paths through cmd.exe, because a .cmd shim cannot be
 * spawned without a shell. Quoting is not a boundary there — cmd expands % inside
 * double quotes and ! under delayed expansion, and still reads & | ^ < > — so the
 * relay rejects those characters instead of escaping them. These cases pin that
 * rejection so a later change cannot quietly drop it.
 */
const METACHARACTERS = ["%", "!", "&", "|", "^", "<", ">", '"'];

export function runDsh(h) {
  const workDir = h.freshRepo("work-metachar-dsh");

  // A rejected path must never reach a run, so no result file may appear either.
  for (const character of METACHARACTERS) {
    const outDir = join(h.scratch, `out-patch-metachar-${METACHARACTERS.indexOf(character)}-dsh`);
    const patch = join(h.scratch, `overlay${character}.yml`);
    // The relay also exits 2 for a --patch file that does not exist, so on POSIX the
    // file has to be real or that check, not the guard, would decide the exit. These
    // names are legal on POSIX and illegal on Windows, where the guard fires first.
    if (!h.WIN) writeFileSync(patch, "- id: agent-default-model\n", "utf8");
    const run = spawnSync(process.execPath, [
      h.relayPath("dsh"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--patch", patch,
    ], { env: h.baseEnv, encoding: "utf8" });
    if (h.WIN) {
      h.check(`dsh win32 --patch ${JSON.stringify(character)}: exits 2`, run.status === 2);
      h.check(`dsh win32 --patch ${JSON.stringify(character)}: diagnostic names the character`,
        run.stderr.includes("--patch") && run.stderr.includes(JSON.stringify(character)));
      h.check(`dsh win32 --patch ${JSON.stringify(character)}: writes no result file`,
        !existsSync(join(outDir, "result.json")));
    } else {
      // POSIX spawns argv directly, so the guard must not fire at all: any usage exit
      // here is a failure, whatever the diagnostic says.
      h.check(`dsh posix --patch ${JSON.stringify(character)}: no usage exit`, run.status !== 2);
    }
  }

  for (const character of METACHARACTERS) {
    const outDir = join(h.scratch, `out-dir-metachar${character}-dsh`);
    const run = spawnSync(process.execPath, [
      h.relayPath("dsh"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], { env: h.baseEnv, encoding: "utf8" });
    if (h.WIN) {
      h.check(`dsh win32 --out-dir ${JSON.stringify(character)}: exits 2`, run.status === 2);
      h.check(`dsh win32 --out-dir ${JSON.stringify(character)}: diagnostic names the character`,
        run.stderr.includes("--out-dir") && run.stderr.includes(JSON.stringify(character)));
      h.check(`dsh win32 --out-dir ${JSON.stringify(character)}: writes no result file`,
        !existsSync(join(outDir, "result.json")));
    } else {
      h.check(`dsh posix --out-dir ${JSON.stringify(character)}: no usage exit`, run.status !== 2);
    }
  }

  // A path with none of those characters must still be accepted, so the guard
  // cannot be "fixed" by rejecting everything.
  const cleanOut = join(h.scratch, "out-clean-dsh");
  const clean = spawnSync(process.execPath, [
    h.relayPath("dsh"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", cleanOut,
    "--permission-mode", "read-only",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("dsh clean path: guard does not reject an ordinary out-dir", clean.status !== 2);
  h.check("dsh clean path: the run publishes a result file", existsSync(join(cleanOut, "result.json")));
}
