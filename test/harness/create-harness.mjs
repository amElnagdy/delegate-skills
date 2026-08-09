import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { EXTRA_ARGS, SKILLS, WIN, relayPath } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
export const testDir = join(harnessDir, "..");

export function createHarness() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? "  ok " : "  FAIL"}  ${name}`);
    if (!cond) failed++;
  };
  // indexOf returns -1 for a flag that was never passed; without the guard the
  // assertion would compare args[0] and pass while the flag is missing.
  const pair = (args, flag, value) => {
    const at = args.indexOf(flag);
    return at !== -1 && args[at + 1] === value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(250);
    }
    return fn();
  };
  // kill(0) decides the answer; /proc only refines it, because a reaped-but-unwaited
  // child stays signalable on Linux while its state is "Z". Everywhere else /proc does
  // not exist, so the read throws and the catch must keep kill(0)'s verdict. Do NOT
  // "fix" that catch to return false: on macOS and Windows every process would read as
  // dead and the whole timeout/abort matrix would pass without felling anything.
  const alive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = /\)\s+(\S)/.exec(stat.slice(stat.lastIndexOf(")")));
      return state ? state[1] !== "Z" : true;
    } catch {
      return true;
    }
  };

  const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-"));

  const h = {
    check,
    get failed() { return failed; },
    pair,
    sleep,
    until,
    alive,
    SKILLS,
    EXTRA_ARGS,
    WIN,
    testDir,
    scratch,
    relayPath: (skill) => relayPath(testDir, skill),
    briefPath: null,
    baseEnv: null,
    slowWriteNodeOptions: null,
    freshRepo: null,
    runRelay: null,
    result: null,
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };

  h.freshRepo = (name) => {
    const dir = join(scratch, name);
    mkdirSync(dir);
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    return dir;
  };

  h.runRelay = (skill, workDir, outDir, extraArgs, extraEnv) =>
    spawn(process.execPath, [h.relayPath(skill), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, ...extraArgs], {
      env: { ...h.baseEnv, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });

  h.result = (outDir) => JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));

  return h;
}
