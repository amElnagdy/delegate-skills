import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runCline(h) {
  const outDir = join(h.scratch, "out-success-cline");
  const workDir = h.freshRepo("work-success-cline");
  const argsFile = join(h.scratch, "args-success-cline");
  const run = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--provider", "fake",
    "--model", "fake-model",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
  h.check("cline success: relay exits zero", run.status === 0);
  h.check("cline success: documented argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--json", "-v",
      "--auto-approve", "true",
      "--provider", "fake",
      "--model", "fake-model",
      "Follow the task instructions provided on stdin.",
    ]));
  h.check("cline success: brief is streamed on stdin and cwd stays out of argv",
    capture.brief === "smoke brief: run until killed." &&
    realpathSync(capture.cwd) === realpathSync(workDir) &&
    !capture.args.includes("--cwd") &&
    !capture.args.includes("--timeout"));
  h.check("cline success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("cline success: run_start and run_result parsed",
      value.status === "completed" &&
      value.exitCode === 0 &&
      value.sessionId === null &&
      value.finalMessage === "fake cline completed" &&
      value.provider === "fake" &&
      value.model === "fake-model" &&
      value.actualProvider === "fake" &&
      value.actualModel === "fake-model" &&
      value.finishReason === "completed" &&
      value.durationMs === 42 &&
      value.usage?.inputTokens === 7 &&
      value.usage?.outputTokens === 2 &&
      value.planMode === false &&
      value.autoApprove === true &&
      value.clineVersion === "fake-cli 0.0.0-smoke");
  }

  const planOutDir = join(h.scratch, "out-plan-cline");
  const planArgsFile = join(h.scratch, "args-plan-cline");
  const planRun = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", planOutDir,
    "--plan",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: planArgsFile },
    encoding: "utf8",
  });
  const planCapture = existsSync(planArgsFile) ? JSON.parse(readFileSync(planArgsFile, "utf8")) : {};
  h.check("cline plan: --plan forces auto-approve false in argv and result",
    planRun.status === 0 &&
    Array.isArray(planCapture.args) &&
    planCapture.args.includes("--plan") &&
    planCapture.args.includes("--auto-approve") &&
    planCapture.args[planCapture.args.indexOf("--auto-approve") + 1] === "false" &&
    existsSync(join(planOutDir, "result.json")) &&
    h.result(planOutDir).planMode === true &&
    h.result(planOutDir).autoApprove === false);

  const unsafePlanOutDir = join(h.scratch, "out-unsafe-plan-cline");
  const unsafePlan = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", unsafePlanOutDir,
    "--plan",
    "--auto-approve", "true",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline plan: auto-approve true is rejected before dispatch",
    unsafePlan.status === 2 &&
    /requires auto-approve false/.test(unsafePlan.stderr) &&
    !existsSync(join(unsafePlanOutDir, "result.json")));

  const invalidAutoApprove = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--auto-approve", "yes",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline auto-approve: non-boolean value is rejected before dispatch",
    invalidAutoApprove.status === 2 && /must be true or false/.test(invalidAutoApprove.stderr));

  const unsupportedResume = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--session", "cline-session-9",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline resume: unsupported relay flag is rejected before dispatch",
    unsupportedResume.status === 2 && /unknown option: --session/.test(unsupportedResume.stderr));

  const unsafeProvider = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--provider", "fake & whoami",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline provider: shell-unsafe value is rejected", unsafeProvider.status === 2);

  const bareModelOutDir = join(h.scratch, "out-bare-model-cline");
  const bareModelArgsFile = join(h.scratch, "args-bare-model-cline");
  const bareModel = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", bareModelOutDir,
    "--provider", "openrouter",
    "--model", "provider-local-model",
    "--auto-approve", "false",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: bareModelArgsFile },
    encoding: "utf8",
  });
  const bareModelCapture = existsSync(bareModelArgsFile)
    ? JSON.parse(readFileSync(bareModelArgsFile, "utf8"))
    : {};
  h.check("cline model: bare id is accepted with a separate provider flag",
    bareModel.status === 0 &&
    bareModelCapture.args?.includes("provider-local-model") &&
    bareModelCapture.args?.[bareModelCapture.args.indexOf("--auto-approve") + 1] === "false" &&
    h.result(bareModelOutDir).model === "provider-local-model" &&
    h.result(bareModelOutDir).autoApprove === false);

  if (h.WIN) {
    const unsafeBriefPath = join(h.scratch, "brief-unsafe-cline.txt");
    const unsafeBriefText = "use 100% now! \"fix\" it\r\nthen test & | ^ < >";
    writeFileSync(unsafeBriefPath, unsafeBriefText, "utf8");
    const unsafeBriefOutDir = join(h.scratch, "out-unsafe-brief-cline");
    const unsafeBriefArgsFile = join(h.scratch, "args-unsafe-brief-cline");
    const unsafeBrief = spawnSync(process.execPath, [
      h.relayPath("cline"),
      "--brief", unsafeBriefPath,
      "--cd", workDir,
      "--out-dir", unsafeBriefOutDir,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: unsafeBriefArgsFile },
      encoding: "utf8",
    });
    const unsafeBriefCapture = existsSync(unsafeBriefArgsFile)
      ? JSON.parse(readFileSync(unsafeBriefArgsFile, "utf8"))
      : {};
    h.check("cline win32 transport: shell metacharacters and newlines stay intact on stdin",
      unsafeBrief.status === 0 && unsafeBriefCapture.brief === unsafeBriefText);

    const unsafeCdPath = join(h.scratch, "dir-with-!bang");
    mkdirSync(unsafeCdPath, { recursive: true });
    const unsafeCdOutDir = join(h.scratch, "out-unsafe-cd-cline");
    const unsafeCdArgsFile = join(h.scratch, "args-unsafe-cd-cline");
    const unsafeCd = spawnSync(process.execPath, [
      h.relayPath("cline"),
      "--brief", h.briefPath,
      "--cd", unsafeCdPath,
      "--out-dir", unsafeCdOutDir,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: unsafeCdArgsFile },
      encoding: "utf8",
    });
    const unsafeCdCapture = existsSync(unsafeCdArgsFile)
      ? JSON.parse(readFileSync(unsafeCdArgsFile, "utf8"))
      : {};
    h.check("cline win32 cwd: shell metacharacters stay in the spawn cwd option",
      unsafeCd.status === 0 && realpathSync(unsafeCdCapture.cwd) === realpathSync(unsafeCdPath));
  }

  const errorOutDir = join(h.scratch, "out-error-cline");
  const errorArgsFile = join(h.scratch, "args-error-cline");
  const errorRun = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", errorOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-error", SMOKE_ARGS_FILE: errorArgsFile },
    encoding: "utf8",
  });
  const errorResult = existsSync(join(errorOutDir, "result.json")) ? h.result(errorOutDir) : {};
  h.check("cline assistant error: exit-one run is reported as failed",
    errorRun.status === 1 &&
    errorResult.status === "failed" &&
    errorResult.exitCode === 1 &&
    errorResult.finishReason === "error" &&
    errorResult.error === `cline ended with finishReason "error"`);

  const missingOutDir = join(h.scratch, "out-unavailable-cline");
  const missing = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("cline unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "cline_unavailable" &&
    h.result(missingOutDir).finalPath === null);

  for (const [mode, expectedStatus, expectedExit] of [
    ["cline-version-fail", "failed", 7],
    ["cline-version-hang", "timeout", 124],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("cline"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`cline preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }

  if (!h.WIN) {
    const preflightOutDir = join(h.scratch, "out-abort-preflight-cline");
    const preflight = h.runRelay("cline", workDir, preflightOutDir, ["--timeout", "1s"], {
      SMOKE_MODE: "cline-version-hang",
    });
    h.check("cline preflight abort: run artifacts are prepared",
      await h.until(() => existsSync(join(preflightOutDir, "events.jsonl")), 2000));
    preflight.kill("SIGTERM");
    const exited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        preflight.kill("SIGKILL"); // a survivor holds handles in preflightOutDir past cleanup
        resolveExit(false);
      }, 5000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
    const value = existsSync(join(preflightOutDir, "result.json")) ? h.result(preflightOutDir) : {};
    h.check("cline preflight abort: result is aborted and dispatch never starts",
      exited &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
