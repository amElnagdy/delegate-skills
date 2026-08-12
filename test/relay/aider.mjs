import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_PINS = [
  "--yes-always",
  "--no-suggest-shell-commands",
  "--no-auto-commits",
  "--no-dirty-commits",
  "--no-gitignore",
  "--no-analytics",
  "--no-check-update",
  "--no-detect-urls",
  "--no-pretty",
  "--no-stream",
];

function readArgs(argsFile, win) {
  if (!existsSync(argsFile)) return [];
  return win
    ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
    : JSON.parse(readFileSync(argsFile, "utf8"));
}

function pinsPresent(args) {
  return REQUIRED_PINS.every((flag) => args.includes(flag))
    && !args.includes("--auto-commits")
    && !args.includes("--dirty-commits")
    && !args.includes("--suggest-shell-commands")
    && !args.includes("--detect-urls");
}

export async function runAider(h) {
  const workDir = h.freshRepo("work-success-aider");

  const outDir = join(h.scratch, "out-success-aider");
  const argsFile = join(h.scratch, "args-success-aider");
  const run = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--model", "openai/fake-model",
    "--api-base", "http://127.0.0.1:9/v1",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "aider-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = readArgs(argsFile, h.WIN);
  const messageAt = args.indexOf("--message-file");
  const briefViaFile = messageAt !== -1
    && typeof args[messageAt + 1] === "string"
    && existsSync(args[messageAt + 1])
    && readFileSync(args[messageAt + 1], "utf8") === "smoke brief: run until killed.";
  h.check("aider success: relay exits zero", run.status === 0);
  h.check("aider success: commit-suppression and headless pins are present", pinsPresent(args));
  h.check("aider success: brief is delivered through --message-file", briefViaFile);
  h.check("aider success: model and api-base are forwarded",
    h.pair(args, "--model", "openai/fake-model")
    && h.pair(args, "--openai-api-base", "http://127.0.0.1:9/v1"));
  h.check("aider success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("aider success: OPENAI_API_KEY prose does not false-fail",
      value.status === "completed"
      && value.exitCode === 0
      && value.finalMessage.includes("OPENAI_API_KEY")
      && value.error == null
      && value.readOnly === false
      && value.resumed === false
      && value.model === "openai/fake-model");
  }

  const dryOutDir = join(h.scratch, "out-readonly-aider");
  const dryArgsFile = join(h.scratch, "args-readonly-aider");
  const dryRun = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", dryOutDir,
    "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "aider-success", SMOKE_ARGS_FILE: dryArgsFile },
    encoding: "utf8",
  });
  const dryArgs = readArgs(dryArgsFile, h.WIN);
  h.check("aider read-only: maps to --dry-run with pins intact",
    dryRun.status === 0
    && pinsPresent(dryArgs)
    && dryArgs.includes("--dry-run")
    && existsSync(join(dryOutDir, "result.json"))
    && h.result(dryOutDir).readOnly === true);

  const resumeOutDir = join(h.scratch, "out-resume-aider");
  const resumeArgsFile = join(h.scratch, "args-resume-aider");
  const resumeRun = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", resumeOutDir,
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "aider-success", SMOKE_ARGS_FILE: resumeArgsFile },
    encoding: "utf8",
  });
  const resumeArgs = readArgs(resumeArgsFile, h.WIN);
  h.check("aider resume-last: maps to --restore-chat-history",
    resumeRun.status === 0
    && pinsPresent(resumeArgs)
    && resumeArgs.includes("--restore-chat-history")
    && existsSync(join(resumeOutDir, "result.json"))
    && h.result(resumeOutDir).resumed === true);

  const authOutDir = join(h.scratch, "out-auth-fail-aider");
  const authRun = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", authOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "aider-auth-fail" },
    encoding: "utf8",
  });
  const authResult = existsSync(join(authOutDir, "result.json")) ? h.result(authOutDir) : {};
  h.check("aider auth failure: exit-zero diagnostic is reported as failed",
    authRun.status === 1
    && authResult.status === "failed"
    && authResult.exitCode === 1
    && authResult.error?.includes("litellm.AuthenticationError"));

  const exitOutDir = join(h.scratch, "out-exit-nonzero-aider");
  const exitRun = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", exitOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "aider-exit-nonzero" },
    encoding: "utf8",
  });
  const exitResult = existsSync(join(exitOutDir, "result.json")) ? h.result(exitOutDir) : {};
  h.check("aider nonzero exit: failed result carries an error",
    exitRun.status === 7
    && exitResult.status === "failed"
    && exitResult.exitCode === 7
    && typeof exitResult.error === "string"
    && exitResult.error.length > 0);

  const missingOutDir = join(h.scratch, "out-unavailable-aider");
  const missing = spawnSync(process.execPath, [
    h.relayPath("aider"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("aider unavailable: missing binary writes the structured result",
    missing.status === 127
    && existsSync(join(missingOutDir, "result.json"))
    && h.result(missingOutDir).status === "aider_unavailable"
    && h.result(missingOutDir).error?.includes("not found on PATH"));

  for (const [mode, expectedStatus, expectedExit] of [
    ["aider-version-fail", "failed", 7],
    ["aider-version-hang", "timeout", 124],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("aider"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", preflightOutDir,
      "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOutDir, "result.json"))
      ? h.result(preflightOutDir)
      : {};
    h.check(`aider preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit
      && preflightResult.status === expectedStatus
      && preflightResult.error?.includes("version preflight")
      && preflightResult.error?.includes("was not dispatched"));
  }
}
