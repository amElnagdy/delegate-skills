import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    "--model", "fake/fake-model",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
  h.check("cline success: relay exits zero", run.status === 0);
  h.check("cline success: documented argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--json", "-v",
      "--provider", "fake",
      "--model", "fake/fake-model",
      "--cwd", workDir,
      "smoke brief: run until killed.",
    ]));
  h.check("cline success: brief rides argv as the [prompt] positional", capture.brief === "smoke brief: run until killed.");
  h.check("cline success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("cline success: run_start and run_result parsed",
      value.status === "completed" &&
      value.exitCode === 0 &&
      value.sessionId === "cline-session-1" &&
      value.finalMessage === "fake cline completed" &&
      value.provider === "fake" &&
      value.model === "fake/fake-model" &&
      value.actualProvider === "fake" &&
      value.actualModel === "fake/fake-model" &&
      value.finishReason === "completed" &&
      value.durationMs === 42 &&
      value.usage?.inputTokens === 7 &&
      value.usage?.outputTokens === 2 &&
      value.planMode === false &&
      value.resumed === false &&
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
  h.check("cline plan: --plan is passed and recorded",
    planRun.status === 0 &&
    Array.isArray(planCapture.args) &&
    planCapture.args.includes("--plan") &&
    existsSync(join(planOutDir, "result.json")) &&
    h.result(planOutDir).planMode === true);

  const resumeOutDir = join(h.scratch, "out-resume-cline");
  const resumeArgsFile = join(h.scratch, "args-resume-cline");
  const resumeRun = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--session", "cline-session-9",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cline-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeCapture = existsSync(resumeArgsFile) ? JSON.parse(readFileSync(resumeArgsFile, "utf8")) : {};
  h.check("cline resume: uses documented --id and records resumed",
    resumeRun.status === 0 &&
    Array.isArray(resumeCapture.args) &&
    resumeCapture.args.includes("--id") &&
    resumeCapture.args.includes("cline-session-9") &&
    !resumeCapture.args.includes("--session") &&
    existsSync(join(resumeOutDir, "result.json")) &&
    h.result(resumeOutDir).resumed === true);

  const unsafeProvider = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--provider", "fake & whoami",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline provider: shell-unsafe value is rejected", unsafeProvider.status === 2);

  const bareModel = spawnSync(process.execPath, [
    h.relayPath("cline"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--model", "deepseek-v4-flash",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("cline model: bare id is rejected before dispatch (cline expects provider/model)",
    bareModel.status === 2 &&
    /vendor-qualified/.test(bareModel.stderr));

  if (h.WIN) {
    const unsafeBriefPath = join(h.scratch, "brief-unsafe-cline.txt");
    writeFileSync(unsafeBriefPath, "use 100% of the quota; \"fix\" it", "utf8");
    const unsafeBrief = spawnSync(process.execPath, [
      h.relayPath("cline"),
      "--brief", unsafeBriefPath,
      "--cd", workDir,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check("cline win32 brief: %/quote/newline brief is rejected before dispatch", unsafeBrief.status === 2);

    const unsafeCdPath = join(h.scratch, "dir-with-!bang");
    mkdirSync(unsafeCdPath, { recursive: true });
    const unsafeCd = spawnSync(process.execPath, [
      h.relayPath("cline"),
      "--brief", h.briefPath,
      "--cd", unsafeCdPath,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check("cline win32 cd: path with % or ! is rejected before dispatch", unsafeCd.status === 2);
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
    h.result(missingOutDir).status === "cline_unavailable");

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