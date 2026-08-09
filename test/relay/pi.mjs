import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runPi(h) {
  const outDir = join(h.scratch, "out-success-pi");
  const workDir = h.freshRepo("work-success-pi");
  const argsFile = join(h.scratch, "args-success-pi");
  const run = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--provider", "google",
    "--model", "google/fake-model",
    "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
  h.check("pi success: relay exits zero", run.status === 0);
  h.check("pi success: documented argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--mode", "json",
      "--provider", "google",
      "--model", "google/fake-model",
      "--no-approve",
      "--tools", "read,grep,find,ls",
    ]));
  h.check("pi success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
  h.check("pi success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("pi success: session header and message_end parsed",
      value.status === "completed" &&
      value.sessionId === "pi-session-1" &&
      value.finalMessage === "fake pi completed" &&
      value.readOnly === true &&
      value.projectTrusted === false &&
      value.provider === "google" &&
      value.model === "google/fake-model" &&
      value.actualProvider === "google" &&
      value.actualModel === "fake-model" &&
      value.usage?.input === 7 &&
      value.usage?.output === 2 &&
      value.stopReason === "stop" &&
      value.resumed === false);
  }

  const approveOutDir = join(h.scratch, "out-approve-pi");
  const approveArgsFile = join(h.scratch, "args-approve-pi");
  const approveRun = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", approveOutDir,
    "--approve",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: approveArgsFile },
    encoding: "utf8",
  });
  const approveCapture = existsSync(approveArgsFile) ? JSON.parse(readFileSync(approveArgsFile, "utf8")) : {};
  h.check("pi project trust: --approve is explicit and recorded",
    approveRun.status === 0 &&
    JSON.stringify(approveCapture.args) === JSON.stringify(["--mode", "json", "--approve"]) &&
    existsSync(join(approveOutDir, "result.json")) &&
    h.result(approveOutDir).projectTrusted === true);

  const unsafeProvider = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--provider", "google & whoami",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("pi provider: shell-unsafe value is rejected", unsafeProvider.status === 2);

  const errorOutDir = join(h.scratch, "out-error-pi");
  const errorArgsFile = join(h.scratch, "args-error-pi");
  const errorRun = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", errorOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "pi-error", SMOKE_ARGS_FILE: errorArgsFile },
    encoding: "utf8",
  });
  const errorResult = existsSync(join(errorOutDir, "result.json")) ? h.result(errorOutDir) : {};
  h.check("pi assistant error: exit-zero event is reported as failed",
    errorRun.status === 1 &&
    errorResult.status === "failed" &&
    errorResult.exitCode === 1 &&
    errorResult.stopReason === "error" &&
    errorResult.error === "fake provider failure");

  const resumeOutDir = join(h.scratch, "out-resume-last-pi");
  const resumeArgsFile = join(h.scratch, "args-resume-last-pi");
  const resume = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "pi-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeCapture = existsSync(resumeArgsFile) ? JSON.parse(readFileSync(resumeArgsFile, "utf8")) : {};
  h.check("pi resume-last: uses documented --continue",
    resume.status === 0 &&
    Array.isArray(resumeCapture.args) &&
    resumeCapture.args.includes("--continue") &&
    !resumeCapture.args.includes("--session") &&
    existsSync(join(resumeOutDir, "result.json")) &&
    h.result(resumeOutDir).resumed === true);

  const missingOutDir = join(h.scratch, "out-unavailable-pi");
  const missing = spawnSync(process.execPath, [
    h.relayPath("pi"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("pi unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "pi_unavailable");

  for (const [mode, expectedStatus, expectedExit] of [
    ["pi-version-fail", "failed", 7],
    ["pi-version-hang", "timeout", 124],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("pi"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`pi preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      preflightResult.status === expectedStatus &&
      preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("was not dispatched"));
  }

  if (!h.WIN) {
    const preflightOutDir = join(h.scratch, "out-abort-preflight-pi");
    const preflight = h.runRelay("pi", workDir, preflightOutDir, ["--timeout", "1s"], {
      SMOKE_MODE: "pi-version-hang",
    });
    h.check("pi preflight abort: run artifacts are prepared",
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
    h.check("pi preflight abort: result is aborted and dispatch never starts",
      exited &&
      value.status === "aborted" &&
      value.signal === "SIGTERM" &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
