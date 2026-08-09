import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runQoder(h) {
  const outDir = join(h.scratch, "out-success-qoder");
  const workDir = h.freshRepo("work-success-qoder");
  const argsFile = join(h.scratch, "args-success-qoder");
  const run = spawnSync(process.execPath, [
    h.relayPath("qoder"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--resume", "qoder-session-0",
    "--model", "Performance",
    "--context-window", "32768",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "qoder-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? h.WIN
      ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(argsFile, "utf8"))
    : [];
  h.check("qoder success: relay exits zero", run.status === 0);
  h.check("qoder success: documented argv is exact",
    JSON.stringify(args) === JSON.stringify([
      "--output-format", "stream-json",
      "--permission-mode", "auto",
      "--resume", "qoder-session-0",
      "--model", "Performance",
      "--context-window", "32768",
      "-p", "smoke brief: run until killed.",
    ]));
  h.check("qoder success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("qoder success: init and result events parsed",
      value.status === "completed" &&
      value.sessionId === "qoder-session-1" &&
      value.actualModel === "performance" &&
      value.actualPermissionMode === "auto" &&
      value.resumed === true &&
      value.resultSubtype === "success");
    h.check("qoder success: usage and final message parsed",
      value.usage?.input_tokens === 7 &&
      value.usage?.output_tokens === 2 &&
      value.finalMessage === "fake qoder completed");
  }

  const invalidOutDir = join(h.scratch, "out-invalid-context-qoder");
  const invalid = spawnSync(process.execPath, [
    h.relayPath("qoder"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", invalidOutDir,
    "--context-window", "0",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("qoder validation: non-positive context is rejected before artifacts",
    invalid.status === 2 && !existsSync(invalidOutDir));

  const latestOutDir = join(h.scratch, "out-resume-last-qoder");
  const latestArgsFile = join(h.scratch, "args-resume-last-qoder");
  const latest = spawnSync(process.execPath, [
    h.relayPath("qoder"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", latestOutDir,
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "qoder-success", SMOKE_ARGS_FILE: latestArgsFile },
    encoding: "utf8",
  });
  const latestArgs = existsSync(latestArgsFile)
    ? h.WIN
      ? readFileSync(latestArgsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(latestArgsFile, "utf8"))
    : [];
  h.check("qoder resume-last: uses documented -c",
    latest.status === 0 &&
    latestArgs.includes("-c") &&
    !latestArgs.includes("--resume") &&
    existsSync(join(latestOutDir, "result.json")) &&
    h.result(latestOutDir).resumed === true);

  const missingOutDir = join(h.scratch, "out-unavailable-qoder");
  mkdirSync(missingOutDir);
  writeFileSync(join(missingOutDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(missingOutDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("qoder"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("qoder unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "qoder_unavailable" &&
    !existsSync(join(missingOutDir, "final.txt")));

  if (h.WIN) {
    const longBrief = join(h.scratch, "long-qoder-brief.txt");
    const longOutDir = join(h.scratch, "out-long-brief-qoder");
    writeFileSync(longBrief, "x".repeat(13 * 1024));
    const rejected = spawnSync(process.execPath, [
      h.relayPath("qoder"),
      "--brief", longBrief,
      "--cd", workDir,
      "--out-dir", longOutDir,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check("qoder Windows: oversized argv brief is rejected before artifacts",
      rejected.status === 2 && !existsSync(longOutDir));
  }

  for (const [mode, expectedStatus, expectedExit] of [
    ["qoder-version-hang", "timeout", 124],
    ["qoder-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("qoder"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`qoder preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }
}
