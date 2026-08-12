import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export async function runKiro(h) {
  const workDir = h.committedRepo("work-success-kiro");
  const outDir = join(h.scratch, "out-success-kiro");
  const argsFile = join(workDir, "smoke-args.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
    "--agent", "default", "--model", "fake-model", "--trust-tools", "fs_read,fs_write,code",
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "kiro-success", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
  const rawArgs = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
  const args = rawArgs.trimStart().startsWith("[") ? JSON.parse(rawArgs) : rawArgs.split(/\r?\n/).filter(Boolean);
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("kiro success: relay exits zero", run.status === 0);
  h.check("kiro success: documented argv is exact", JSON.stringify(args) === JSON.stringify([
    "chat", "--no-interactive", "--wrap", "never", "--agent", "default", "--model", "fake-model",
    "--trust-tools=fs_read,fs_write,code", "--resume-id", "11111111-1111-4111-8111-111111111111",
    "smoke brief: run until killed.",
  ]));
  h.check("kiro success: upstream result and session report are captured",
    value.schema === "delegate-relay.result.v1" && value.status === "completed" &&
    value.finalMessage.startsWith("fake kiro completed") &&
    value.sessionId === "11111111-1111-4111-8111-111111111111" &&
    value.trustTools.join(",") === "fs_read,fs_write,code" &&
    value.preflight?.ok === true);

  const laneHome = join(h.scratch, "kiro-lane-home");
  mkdirSync(join(laneHome, ".config", "delegate-skills"), { recursive: true });
  writeFileSync(join(laneHome, ".config", "delegate-skills", "config.json"), JSON.stringify({
    version: "delegate-fleet.v1",
    lanes: { feature: { implementer: "kiro", model: "lane-model" } },
  }));
  const laneWork = h.committedRepo("work-success-kiro-lane");
  const laneOut = join(h.scratch, "out-success-kiro-lane");
  const laneRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", laneWork, "--out-dir", laneOut,
    "--lane", "feature", "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], {
    env: { ...h.baseEnv, HOME: laneHome, USERPROFILE: laneHome, SMOKE_MODE: "kiro-success" },
    encoding: "utf8",
  });
  const laneValue = existsSync(join(laneOut, "result.json")) ? h.result(laneOut) : {};
  h.check("kiro lane: applies model and records provenance",
    laneRun.status === 0 && laneValue.lane === "feature" && laneValue.laneSource === "global" && laneValue.model === "lane-model");

  const gitStatusWork = h.committedRepo("work-kiro-git-status-unavailable");
  writeFileSync(join(gitStatusWork, ".git", "index"), "CORRUPT");
  const gitStatusOut = join(h.scratch, "out-kiro-git-status-unavailable");
  const gitStatusRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", gitStatusWork, "--out-dir", gitStatusOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "kiro-success" }, encoding: "utf8" });
  const gitStatusValue = existsSync(join(gitStatusOut, "result.json")) ? h.result(gitStatusOut) : {};
  h.check("kiro git status unavailable fails closed",
    gitStatusRun.status === 1 && gitStatusValue.status === "failed" && gitStatusValue.errorCode === "git_status_unavailable");

  const splitWork = h.committedRepo("work-kiro-stderr-split");
  const splitOut = join(h.scratch, "out-kiro-stderr-split");
  const splitRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", splitWork, "--out-dir", splitOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, KIRO_FAKE_MODE: "split", KIRO_API_KEY: "api-secret-value" }, encoding: "utf8" });
  const stderrText = existsSync(join(splitOut, "stderr.txt")) ? readFileSync(join(splitOut, "stderr.txt"), "utf8") : "";
  const splitValue = existsSync(join(splitOut, "result.json")) ? h.result(splitOut) : {};
  h.check("kiro stderr split secret is redacted across chunks",
    splitRun.status === 0 && !stderrText.includes("api-secret-value") && stderrText.includes("[REDACTED]") && !JSON.stringify(splitValue).includes("api-secret-value"));
}
