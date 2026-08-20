import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runOmp(h) {
  const outDir = join(h.scratch, "out-success-omp");
  const workDir = h.freshRepo("work-success-omp");
  const argsFile = join(h.scratch, "args-success-omp");
  const run = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--provider", "google",
    "--model", "google/fake-model",
    "--thinking", "high",
    "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
  h.check("omp success: relay exits zero", run.status === 0);
  h.check("omp success: documented argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--mode", "json",
      "--provider", "google",
      "--model", "google/fake-model",
      "--thinking", "high",
      "--tools", "read,grep,glob",
      "--no-extensions", "--no-skills", "--no-rules",
    ]));
  h.check("omp success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
  h.check("omp success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("omp success: session header and message_end parsed",
      value.status === "completed" &&
      value.sessionId === "omp-session-1" &&
      value.finalMessage === "fake omp completed" &&
      value.readOnly === true &&
      value.yolo === false &&
      value.projectTrusted === false &&
      value.provider === "google" &&
      value.model === "google/fake-model" &&
      value.thinking === "high" &&
      value.actualProvider === "google" &&
      value.actualModel === "fake-model" &&
      value.usage?.input === 7 &&
      value.usage?.output === 2 &&
      value.stopReason === "stop" &&
      value.resumed === false);
  }

  const writeOutDir = join(h.scratch, "out-write-omp");
  const writeArgsFile = join(h.scratch, "args-write-omp");
  const writeRun = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", writeOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: writeArgsFile },
    encoding: "utf8",
  });
  const writeCapture = existsSync(writeArgsFile) ? JSON.parse(readFileSync(writeArgsFile, "utf8")) : {};
  h.check("omp write: --yolo and untrusted project resources",
    writeRun.status === 0 &&
    JSON.stringify(writeCapture.args) === JSON.stringify([
      "--mode", "json",
      "--yolo",
      "--no-extensions", "--no-skills", "--no-rules",
    ]) &&
    existsSync(join(writeOutDir, "result.json")) &&
    h.result(writeOutDir).yolo === true &&
    h.result(writeOutDir).projectTrusted === false);

  const approveOutDir = join(h.scratch, "out-approve-omp");
  const approveArgsFile = join(h.scratch, "args-approve-omp");
  const approveRun = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", approveOutDir,
    "--approve",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: approveArgsFile },
    encoding: "utf8",
  });
  const approveCapture = existsSync(approveArgsFile) ? JSON.parse(readFileSync(approveArgsFile, "utf8")) : {};
  h.check("omp project trust: --approve omits --no-extensions/--no-skills/--no-rules",
    approveRun.status === 0 &&
    JSON.stringify(approveCapture.args) === JSON.stringify(["--mode", "json", "--yolo"]) &&
    existsSync(join(approveOutDir, "result.json")) &&
    h.result(approveOutDir).projectTrusted === true &&
    h.result(approveOutDir).yolo === true);

  const unsafeProvider = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--provider", "google & whoami",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("omp provider: flag-unsafe value is rejected", unsafeProvider.status === 2);

  const badThinking = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--thinking", "inherit",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("omp thinking: inherit is rejected before dispatch",
    badThinking.status === 2 && /invalid --thinking/.test(badThinking.stderr));

  const listModels = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--list-models",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("omp: --list-models is not a relay flag",
    listModels.status === 2 && /unknown option: --list-models/.test(listModels.stderr));

  const errorOutDir = join(h.scratch, "out-error-omp");
  const errorArgsFile = join(h.scratch, "args-error-omp");
  const errorRun = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", errorOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-error", SMOKE_ARGS_FILE: errorArgsFile },
    encoding: "utf8",
  });
  const errorResult = existsSync(join(errorOutDir, "result.json")) ? h.result(errorOutDir) : {};
  h.check("omp assistant error: exit-zero event is reported as failed",
    errorRun.status === 1 &&
    errorResult.status === "failed" &&
    errorResult.exitCode === 1 &&
    errorResult.stopReason === "error" &&
    errorResult.error === "fake provider failure");

  const resumeOutDir = join(h.scratch, "out-resume-last-omp");
  const resumeArgsFile = join(h.scratch, "args-resume-last-omp");
  const resume = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeCapture = existsSync(resumeArgsFile) ? JSON.parse(readFileSync(resumeArgsFile, "utf8")) : {};
  h.check("omp resume-last: uses documented --continue",
    resume.status === 0 &&
    Array.isArray(resumeCapture.args) &&
    resumeCapture.args.includes("--continue") &&
    !resumeCapture.args.includes("--session") &&
    existsSync(join(resumeOutDir, "result.json")) &&
    h.result(resumeOutDir).resumed === true);

  const sessionOutDir = join(h.scratch, "out-session-omp");
  const sessionArgsFile = join(h.scratch, "args-session-omp");
  const session = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", sessionOutDir,
    "--session", "omp-session-1",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: sessionArgsFile },
    encoding: "utf8",
  });
  const sessionCapture = existsSync(sessionArgsFile) ? JSON.parse(readFileSync(sessionArgsFile, "utf8")) : {};
  h.check("omp session: uses documented --session <id>",
    session.status === 0 &&
    JSON.stringify(sessionCapture.args) === JSON.stringify([
      "--mode", "json",
      "--session", "omp-session-1",
      "--yolo",
      "--no-extensions", "--no-skills", "--no-rules",
    ]) &&
    existsSync(join(sessionOutDir, "result.json")) &&
    h.result(sessionOutDir).resumed === true);

  const bothResume = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--resume-last",
    "--session", "omp-session-1",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("omp resume: --resume-last and --session are mutually exclusive",
    bothResume.status === 2 && /mutually exclusive/.test(bothResume.stderr));

  {
    const setupDir = join(h.testDir, "..", "skills", "delegate-setup", "scripts");
    const cfgHome = join(h.scratch, "home-lane-omp");
    mkdirSync(cfgHome, { recursive: true });
    const laneFile = join(workDir, "omp-lane.json");
    writeFileSync(laneFile, `${JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: {
        feature: {
          implementer: "omp",
          provider: "google",
          model: "google/fake-model",
          effort: "high",
        },
      },
    })}\n`);
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome, USERPROFILE: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;
    const writeCfg = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", laneFile], {
      encoding: "utf8",
      env: fleetEnv,
    });
    h.check("omp lane: global model/thinking lane is written", writeCfg.status === 0);
    const laneOutDir = join(h.scratch, "out-lane-omp");
    const laneArgsFile = join(h.scratch, "args-lane-omp");
    const laneRun = spawnSync(process.execPath, [
      h.relayPath("omp"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", laneOutDir,
      "--lane", "feature",
    ], {
      env: { ...fleetEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: laneArgsFile },
      encoding: "utf8",
    });
    const laneCapture = existsSync(laneArgsFile) ? JSON.parse(readFileSync(laneArgsFile, "utf8")) : {};
    h.check("omp lane: provider/model/effort become --provider/--model/--thinking",
      writeCfg.status === 0 &&
      laneRun.status === 0 &&
      JSON.stringify(laneCapture.args) === JSON.stringify([
        "--mode", "json",
        "--provider", "google",
        "--model", "google/fake-model",
        "--thinking", "high",
        "--yolo",
        "--no-extensions", "--no-skills", "--no-rules",
      ]) &&
      h.result(laneOutDir).thinking === "high" &&
      h.result(laneOutDir).model === "google/fake-model");
    const overrideOutDir = join(h.scratch, "out-lane-override-omp");
    const overrideArgsFile = join(h.scratch, "args-lane-override-omp");
    const overrideRun = spawnSync(process.execPath, [
      h.relayPath("omp"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", overrideOutDir,
      "--lane", "feature",
      "--thinking", "low",
    ], {
      env: { ...fleetEnv, SMOKE_MODE: "omp-success", SMOKE_ARGS_FILE: overrideArgsFile },
      encoding: "utf8",
    });
    const overrideCapture = existsSync(overrideArgsFile) ? JSON.parse(readFileSync(overrideArgsFile, "utf8")) : {};
    h.check("omp lane: explicit --thinking wins over lane effort",
      overrideRun.status === 0 &&
      overrideCapture.args?.includes("--thinking") &&
      overrideCapture.args[overrideCapture.args.indexOf("--thinking") + 1] === "low" &&
      h.result(overrideOutDir).thinking === "low");
  }

  const missingOutDir = join(h.scratch, "out-unavailable-omp");
  const missing = spawnSync(process.execPath, [
    h.relayPath("omp"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("omp unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "omp_unavailable");

  for (const [mode, expectedStatus, expectedExit] of [
    ["omp-version-fail", "failed", 7],
    ["omp-version-hang", "timeout", 124],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("omp"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`omp preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }

  if (!h.WIN) {
    const preflightOutDir = join(h.scratch, "out-abort-preflight-omp");
    const preflight = h.runRelay("omp", workDir, preflightOutDir, ["--timeout", "1s"], {
      SMOKE_MODE: "omp-version-hang",
    });
    h.check("omp preflight abort: run artifacts are prepared",
      await h.until(() => existsSync(join(preflightOutDir, "events.jsonl")), 2000));
    preflight.kill("SIGTERM");
    const exited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        preflight.kill("SIGKILL");
        resolveExit(false);
      }, 5000);
      preflight.on("close", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
    const value = existsSync(join(preflightOutDir, "result.json")) ? h.result(preflightOutDir) : {};
    h.check("omp preflight abort: result is aborted and dispatch never starts",
      exited &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
