import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function capturedArgs(h, argsFile) {
  if (!existsSync(argsFile)) return { args: [], brief: "" };
  return JSON.parse(readFileSync(argsFile, "utf8"));
}

function dispatch(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-${name}-kilo`);
  const workDir = h.freshRepo(`work-${name}-kilo`);
  const argsFile = join(h.scratch, `args-${name}-kilo`);
  const run = spawnSync(process.execPath, [
    h.relayPath("kilo"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "kilo-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
  });
  return { run, outDir, workDir, capture: capturedArgs(h, argsFile) };
}

export async function runKilo(h) {
for (const scenario of [
  {
    name: "default",
    relayArgs: [],
    forwarded: (workDir) => ["run", "--format", "json", "--dir", workDir, "--agent", "code", "--auto"],
    agent: "code",
    auto: true,
    resumed: false,
  },
  {
    name: "read-only",
    relayArgs: ["--read-only"],
    forwarded: (workDir) => ["run", "--format", "json", "--dir", workDir, "--agent", "plan"],
    agent: "plan",
    auto: true,
    resumed: false,
  },
  {
    name: "resume last",
    relayArgs: ["--resume-last"],
    forwarded: (workDir) => ["run", "--format", "json", "--dir", workDir, "--continue", "--agent", "code", "--auto"],
    agent: "code",
    auto: true,
    resumed: true,
  },
  {
    name: "session",
    relayArgs: ["--session", "ses_kilo-1"],
    forwarded: (workDir) => ["run", "--format", "json", "--dir", workDir, "--session", "ses_kilo-1", "--agent", "code", "--auto"],
    agent: "code",
    auto: true,
    resumed: true,
  },
  {
    name: "tilde model",
    relayArgs: ["--model", "kilo/~anthropic/claude-fable-latest", "--variant", "high"],
    forwarded: (workDir) => [
      "run", "--format", "json", "--dir", workDir, "--agent", "code",
      "--model", "kilo/~anthropic/claude-fable-latest", "--variant", "high", "--auto",
    ],
    agent: "code",
    auto: true,
    resumed: false,
  },
]) {
  const { run, outDir, workDir, capture } = dispatch(h, scenario.name, scenario.relayArgs);
  h.check(`kilo ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`kilo ${scenario.name}: documented argv is exact`,
    JSON.stringify(capture.args) === JSON.stringify(scenario.forwarded(workDir)));
  h.check(`kilo ${scenario.name}: brief delivered through stdin`,
    capture.brief === "smoke brief: run until killed.");
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`kilo ${scenario.name}: result and assistant output are captured`,
    value.status === "completed" &&
    value.finalMessage === "fake kilo completed" &&
    value.sessionId === "ses_kilo-1" &&
    value.agent === scenario.agent &&
    value.auto === scenario.auto &&
    value.resumed === scenario.resumed);
}

{
  const { run } = dispatch(h, "session-and-resume", ["--session", "ses_kilo-1", "--resume-last"]);
  h.check("kilo validation: --session and --resume-last are exclusive",
    run.status === 2 && !existsSync(join(h.scratch, "out-session-and-resume-kilo", "result.json")));
}

{
  const workDir = h.freshRepo("work-bare-model-kilo");
  const rejected = spawnSync(process.execPath, [
    h.relayPath("kilo"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--model", "grok",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("kilo validation: model must be provider/model", rejected.status === 2);
}

for (const [mode, expectedStatus, expectedExit] of [
  ["kilo-version-hang", "timeout", 124],
  ["kilo-version-fail", "failed", 7],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("kilo"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`kilo preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-kilo");
  const outDir = join(h.scratch, "out-unavailable-dedicated-kilo");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("kilo"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("kilo unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "kilo_unavailable");
}
}
