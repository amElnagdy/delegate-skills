import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export async function runKiro(h) {
  const workDir = h.committedRepo("work-success-kiro");
  const outDir = join(h.scratch, "out-success-kiro");
  const argsFile = join(workDir, "smoke-args.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
    "--agent", "default", "--model", "fake-model", "--effort", "high", "--mode", "spec",
    "--trust-tools", "fs_read,fs_write,code",
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "kiro-success", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8", timeout: 30_000 });
  const rawArgs = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
  const args = rawArgs.trimStart().startsWith("[") ? JSON.parse(rawArgs) : rawArgs.split(/\r?\n/).filter(Boolean);
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("kiro success: relay exits zero", run.status === 0);
  h.check("kiro success: documented argv is exact", JSON.stringify(args) === JSON.stringify([
    "chat", "--no-interactive", "--wrap", "never", "--v3", "--agent", "default", "--model", "fake-model",
    "--effort", "high", "--mode", "spec", "--trust-tools=fs_read,fs_write,code", "--resume-id", "11111111-1111-4111-8111-111111111111",
    "smoke brief: run until killed.",
  ]));
  h.check("kiro success: upstream result and session report are captured",
    value.schema === "delegate-relay.result.v1" && value.status === "completed" &&
    value.finalMessage?.startsWith("fake kiro completed") &&
    value.sessionId === "11111111-1111-4111-8111-111111111111" &&
    value.trustTools?.join(",") === "fs_read,fs_write,code" &&
    value.effort === "high" && value.mode === "spec" && value.agentEngine === "v3" &&
    value.preflight?.ok === true);

  const basicWork = h.committedRepo("work-success-kiro-basic");
  const basicOut = join(h.scratch, "out-success-kiro-basic");
  const basicArgsFile = join(basicWork, "smoke-args.json");
  const basicRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", basicWork, "--out-dir", basicOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "kiro-success", SMOKE_ARGS_FILE: basicArgsFile }, encoding: "utf8", timeout: 30_000 });
  const basicRawArgs = existsSync(basicArgsFile) ? readFileSync(basicArgsFile, "utf8") : "";
  const basicArgs = basicRawArgs.trimStart().startsWith("[") ? JSON.parse(basicRawArgs) : basicRawArgs.split(/\r?\n/).filter(Boolean);
  const basicValue = existsSync(join(basicOut, "result.json")) ? h.result(basicOut) : {};
  h.check("kiro V3 basic setup: effort and mode stay omitted unless requested",
    basicRun.status === 0 && basicArgs.includes("--v3") && !basicArgs.includes("--effort") &&
    !basicArgs.includes("--mode") && basicValue.agentEngine === "v3" &&
    basicValue.effort === null && basicValue.mode === null);

  if (h.WIN) {
    const wslWork = h.committedRepo("work-success-kiro-wsl");
    const wslOut = join(h.scratch, "out-success-kiro-wsl");
    const wslArgsFile = join(wslWork, "smoke-args.json");
    const wslRun = spawnSync(process.execPath, [
      h.relayPath("kiro"), "--brief", h.briefPath, "--cd", wslWork, "--out-dir", wslOut,
      "--wsl", "--wsl-distro", "Ubuntu", "--effort", "xhigh", "--mode", "default",
      "--resume-id", "11111111-1111-4111-8111-111111111111",
    ], {
      env: {
        ...h.baseEnv,
        WSL_EXE_BIN: "kiro-cli",
        KIRO_WSL_WRAPPER_TEST: "1",
        SMOKE_MODE: "kiro-success",
        SMOKE_ARGS_FILE: wslArgsFile,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const wslRawArgs = existsSync(wslArgsFile) ? readFileSync(wslArgsFile, "utf8") : "";
    const wslArgs = wslRawArgs.trimStart().startsWith("[") ? JSON.parse(wslRawArgs) : wslRawArgs.split(/\r?\n/).filter(Boolean);
    const wslValue = existsSync(join(wslOut, "result.json")) ? h.result(wslOut) : {};
    h.check("kiro WSL: wrapper passes inner Kiro args and records launch metadata",
      wslRun.status === 0 && h.pair(wslArgs, "--effort", "xhigh") && h.pair(wslArgs, "--mode", "default") &&
      wslArgs.includes("--v3") && wslValue.agentEngine === "v3" &&
      wslValue.wsl === true && wslValue.wslDistro === "Ubuntu");
  }

  const laneHome = join(h.scratch, "kiro-lane-home");
  mkdirSync(join(laneHome, ".config", "delegate-skills"), { recursive: true });
  writeFileSync(join(laneHome, ".config", "delegate-skills", "config.json"), JSON.stringify({
    version: "delegate-fleet.v1",
    lanes: { feature: { implementer: "kiro", model: "lane-model", effort: "medium", mode: "default" } },
  }));
  const laneWork = h.committedRepo("work-success-kiro-lane");
  const laneOut = join(h.scratch, "out-success-kiro-lane");
  const laneRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", laneWork, "--out-dir", laneOut,
    "--lane", "feature", "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], {
    env: { ...h.baseEnv, HOME: laneHome, USERPROFILE: laneHome, SMOKE_MODE: "kiro-success" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const laneValue = existsSync(join(laneOut, "result.json")) ? h.result(laneOut) : {};
  h.check("kiro lane: applies model, effort, and mode with provenance",
    laneRun.status === 0 && laneValue.lane === "feature" && laneValue.laneSource === "global" &&
    laneValue.model === "lane-model" && laneValue.effort === "medium" && laneValue.mode === "default");

  const gitStatusWork = h.committedRepo("work-kiro-git-status-unavailable");
  writeFileSync(join(gitStatusWork, ".git", "index"), "CORRUPT");
  const gitStatusOut = join(h.scratch, "out-kiro-git-status-unavailable");
  const gitStatusRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", gitStatusWork, "--out-dir", gitStatusOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "kiro-success" }, encoding: "utf8", timeout: 30_000 });
  const gitStatusValue = existsSync(join(gitStatusOut, "result.json")) ? h.result(gitStatusOut) : {};
  h.check("kiro git status unavailable fails closed",
    gitStatusRun.status === 1 && gitStatusValue.status === "failed" && gitStatusValue.errorCode === "git_status_unavailable");

  const splitWork = h.committedRepo("work-kiro-stderr-split");
  const splitOut = join(h.scratch, "out-kiro-stderr-split");
  const splitRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", splitWork, "--out-dir", splitOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, KIRO_FAKE_MODE: "split", KIRO_API_KEY: "api-secret-value" }, encoding: "utf8", timeout: 30_000 });
  const stderrText = existsSync(join(splitOut, "stderr.txt")) ? readFileSync(join(splitOut, "stderr.txt"), "utf8") : "";
  const splitValue = existsSync(join(splitOut, "result.json")) ? h.result(splitOut) : {};
  h.check("kiro stderr split secret is redacted across chunks",
    splitRun.status === 0 && !stderrText.includes("api-secret-value") && stderrText.includes("[REDACTED]") && !JSON.stringify(splitValue).includes("api-secret-value"));

  const largeWork = h.committedRepo("work-kiro-large-stdout");
  const largeOut = join(h.scratch, "out-kiro-large-stdout");
  const largeRun = spawnSync(process.execPath, [
    h.relayPath("kiro"), "--brief", h.briefPath, "--cd", largeWork, "--out-dir", largeOut,
    "--resume-id", "11111111-1111-4111-8111-111111111111",
  ], { env: { ...h.baseEnv, KIRO_FAKE_MODE: "large-stdout" }, encoding: "utf8", timeout: 30_000 });
  const largeValue = existsSync(join(largeOut, "result.json")) ? h.result(largeOut) : {};
  const fullFinal = existsSync(join(largeOut, "final.txt")) ? readFileSync(join(largeOut, "final.txt"), "utf8") : "";
  h.check("kiro large stdout: full redacted artifact is streamed while result stays bounded",
    largeRun.status === 0 && largeValue.finalMessageTruncated === true &&
    largeValue.finalMessage?.length <= 65_536 && fullFinal.startsWith("START\n") && fullFinal.length > 65_536 &&
    largeValue.sessionId === "11111111-1111-4111-8111-111111111111");
}
