import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readArgs(argsFile, win) {
  if (!existsSync(argsFile)) return [];
  return win
    ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
    : JSON.parse(readFileSync(argsFile, "utf8"));
}

export async function runDevin(h) {
  const workDir = h.freshRepo("work-success-devin");

  const outDir = join(h.scratch, "out-success-devin");
  const argsFile = join(h.scratch, "args-success-devin");
  const captureFile = join(h.scratch, "capture-success-devin.json");
  const preflightEnvFile = join(h.scratch, "preflight-env-success-devin.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--model", "opus",
  ], {
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "devin-success",
      SMOKE_ARGS_FILE: argsFile,
      SMOKE_CAPTURE_FILE: captureFile,
      SMOKE_DEVIN_PREFLIGHT_ENV_FILE: preflightEnvFile,
      WINDSURF_API_KEY: "bogus-windsurf-key",
      SMOKE_SECRET_TOKEN: "must-survive",
    },
    encoding: "utf8",
  });
  const args = readArgs(argsFile, h.WIN);
  const promptAt = args.indexOf("--prompt-file");
  const briefViaFile = promptAt !== -1
    && typeof args[promptAt + 1] === "string"
    && existsSync(args[promptAt + 1])
    && readFileSync(args[promptAt + 1], "utf8") === "smoke brief: run until killed.";
  h.check("devin success: relay exits zero", run.status === 0);
  h.check("devin success: print mode, prompt-file, and workspace-trust pins are present",
    args.includes("--print")
    && briefViaFile
    && h.pair(args, "--respect-workspace-trust", "false")
    && h.pair(args, "--permission-mode", "smart")
    && !args.includes("--sandbox"));
  h.check("devin success: model is forwarded and no positional prompt is used",
    h.pair(args, "--model", "opus")
    && args[args.length - 1] !== "smoke brief: run until killed.");
  h.check("devin success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("devin success: ATIF session id and print report are captured",
      value.status === "completed"
      && value.exitCode === 0
      && value.sessionId === "devin-session-1"
      && value.finalMessage === "fake devin completed"
      && value.permissionMode === "smart"
      && value.autonomy === "workspace-write"
      && Array.isArray(value.touchedFiles)
      && value.exportPath
      && existsSync(value.exportPath)
      && !existsSync(join(outDir, "events.jsonl")));
  }
  h.check("devin success: fake captured the child environment", existsSync(captureFile));
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    h.check("devin success: inherited WINDSURF_API_KEY removed", capture.windsurfApiKey === null);
    h.check("devin success: unrelated environment entries preserved", capture.smokeSecretToken === "must-survive");
  }
  h.check("devin success: fake captured the preflight environment", existsSync(preflightEnvFile));
  if (existsSync(preflightEnvFile)) {
    const preflight = JSON.parse(readFileSync(preflightEnvFile, "utf8"));
    h.check("devin success: preflight WINDSURF_API_KEY removed", preflight.windsurfApiKey === null);
    h.check("devin success: preflight sentinel preserved", preflight.smokeSecretToken === "must-survive");
  }

  const readOnlyOutDir = join(h.scratch, "out-readonly-devin");
  const readOnlyArgsFile = join(h.scratch, "args-readonly-devin");
  const readOnlyRun = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", readOnlyOutDir,
    "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: readOnlyArgsFile },
    encoding: "utf8",
  });
  const readOnlyArgs = readArgs(readOnlyArgsFile, h.WIN);
  h.check("devin read-only: maps to --permission-mode normal",
    readOnlyRun.status === 0
    && h.pair(readOnlyArgs, "--permission-mode", "normal")
    && existsSync(join(readOnlyOutDir, "result.json"))
    && h.result(readOnlyOutDir).autonomy === "read-only"
    && h.result(readOnlyOutDir).permissionMode === "normal"
    && h.result(readOnlyOutDir).readOnlyViolation === false);

  const fullOutDir = join(h.scratch, "out-full-access-devin");
  const fullArgsFile = join(h.scratch, "args-full-access-devin");
  const fullRun = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", fullOutDir,
    "--full-access",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: fullArgsFile },
    encoding: "utf8",
  });
  const fullArgs = readArgs(fullArgsFile, h.WIN);
  h.check("devin full-access: maps to --permission-mode dangerous",
    fullRun.status === 0
    && h.pair(fullArgs, "--permission-mode", "dangerous")
    && existsSync(join(fullOutDir, "result.json"))
    && h.result(fullOutDir).autonomy === "full-access"
    && h.result(fullOutDir).permissionMode === "dangerous");

  const acceptOutDir = join(h.scratch, "out-accept-edits-devin");
  const acceptArgsFile = join(h.scratch, "args-accept-edits-devin");
  const acceptRun = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", acceptOutDir,
    "--permission-mode", "accept-edits",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: acceptArgsFile },
    encoding: "utf8",
  });
  const acceptArgs = readArgs(acceptArgsFile, h.WIN);
  h.check("devin permission-mode: accept-edits is forwarded",
    acceptRun.status === 0
    && h.pair(acceptArgs, "--permission-mode", "accept-edits")
    && existsSync(join(acceptOutDir, "result.json"))
    && h.result(acceptOutDir).permissionMode === "accept-edits");

  const resumeOutDir = join(h.scratch, "out-resume-last-devin");
  const resumeArgsFile = join(h.scratch, "args-resume-last-devin");
  const resumeRun = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeArgs = readArgs(resumeArgsFile, h.WIN);
  h.check("devin resume-last: uses documented -c",
    resumeRun.status === 0
    && resumeArgs.includes("-c")
    && !resumeArgs.includes("-r")
    && existsSync(join(resumeOutDir, "result.json"))
    && h.result(resumeOutDir).resumeLast === true
    && h.result(resumeOutDir).sessionId === "devin-session-1");

  const sessionOutDir = join(h.scratch, "out-session-devin");
  const sessionArgsFile = join(h.scratch, "args-session-devin");
  const sessionRun = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", sessionOutDir,
    "--session", "indigo-entrance",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "devin-success", SMOKE_ARGS_FILE: sessionArgsFile },
    encoding: "utf8",
  });
  const sessionArgs = readArgs(sessionArgsFile, h.WIN);
  h.check("devin session: uses documented -r",
    sessionRun.status === 0
    && h.pair(sessionArgs, "-r", "indigo-entrance")
    && existsSync(join(sessionOutDir, "result.json"))
    && h.result(sessionOutDir).sessionId === "devin-session-1");

  const invalidOutDir = join(h.scratch, "out-invalid-permission-devin");
  for (const mode of ["autonomous", "auto", "yolo", "bypass", "banana"]) {
    const rejected = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", invalidOutDir,
      "--permission-mode", mode,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`devin validation: --permission-mode ${mode} is rejected before artifacts`,
      rejected.status === 2 && !existsSync(invalidOutDir));
  }

  const conflict = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", join(h.scratch, "out-conflict-devin"),
    "--read-only",
    "--permission-mode", "smart",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("devin validation: --read-only conflicts with a write permission mode",
    conflict.status === 2 && !existsSync(join(h.scratch, "out-conflict-devin")));

  const missingOutDir = join(h.scratch, "out-unavailable-devin");
  mkdirSync(missingOutDir);
  writeFileSync(join(missingOutDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(missingOutDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("devin"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("devin unavailable: missing binary writes the structured result",
    missing.status === 127
    && existsSync(join(missingOutDir, "result.json"))
    && h.result(missingOutDir).status === "devin_unavailable"
    && !existsSync(join(missingOutDir, "final.txt")));

  for (const [mode, expectedStatus, expectedExit] of [
    ["devin-version-hang", "timeout", 124],
    ["devin-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("devin"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`devin preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit
      && preflightResult.status === expectedStatus
      && preflightResult.error?.includes("version preflight")
      && preflightResult.error?.includes("was not dispatched"));
  }
}
