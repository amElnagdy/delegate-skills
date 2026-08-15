import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Must match RESUME_DIRECTIVE in skills/copilot-delegate/scripts/relay.mjs
const RESUME_DIRECTIVE =
  "Execute the instructions in the referenced file, then report what you did. Do not just summarize the file: ";

export async function runCopilot(h) {
for (const scenario of [
  {
    name: "default",
    relayArgs: [],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off"],
    readOnly: false,
    allowAllTools: false,
    resumed: false,
  },
  {
    name: "read only",
    relayArgs: ["--read-only"],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off", "--mode", "plan"],
    readOnly: true,
    allowAllTools: false,
    resumed: false,
  },
  {
    name: "allow all tools",
    relayArgs: ["--allow-all-tools"],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off", "--allow-all-tools"],
    readOnly: false,
    allowAllTools: true,
    resumed: false,
  },
  {
    name: "session resume",
    relayArgs: ["--session", "copilot-session-1"],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off", "--resume=copilot-session-1"],
    readOnly: false,
    allowAllTools: false,
    resumed: true,
  },
  {
    name: "resume last",
    relayArgs: ["--resume-last"],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off", "--continue"],
    readOnly: false,
    allowAllTools: false,
    resumed: true,
  },
  {
    name: "model and effort",
    relayArgs: ["--model", "gpt-5.4", "--effort", "high"],
    forwarded: ["--output-format", "json", "--no-color", "--stream", "off", "--model", "gpt-5.4", "--effort", "high"],
    readOnly: false,
    allowAllTools: false,
    resumed: false,
  },
]) {
  const outDir = join(h.scratch, `out-${scenario.name}-copilot`);
  const workDir = h.freshRepo(`work-${scenario.name}-copilot`);
  const argsFile = join(h.scratch, `args-${scenario.name}-copilot`);
  const run = spawnSync(process.execPath, [
    h.relayPath("copilot"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...scenario.relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "copilot-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? JSON.parse(readFileSync(argsFile, "utf8"))
    : [];
  h.check(`copilot ${scenario.name}: relay exits zero`, run.status === 0);
  const expectedArgv = [
    ...scenario.forwarded,
    "-p", scenario.resumed
      ? `${RESUME_DIRECTIVE}@${join(outDir, "brief.txt")}`
      : `@${join(outDir, "brief.txt")}`,
  ];
  h.check(`copilot ${scenario.name}: documented argv is exact`,
    JSON.stringify(args) === JSON.stringify(expectedArgv));
  h.check(`copilot ${scenario.name}: result and assistant output are captured`,
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "completed" &&
    h.result(outDir).finalMessage === "fake copilot completed" &&
    h.result(outDir).resumed === scenario.resumed &&
    h.result(outDir).readOnly === scenario.readOnly &&
    h.result(outDir).allowAllTools === scenario.allowAllTools &&
    h.result(outDir).sessionId === "copilot-session-1");
}
// Denial detection: copilot exits 0 but tools denied → relay reports failed
{
  const outDir = join(h.scratch, "out-denied-copilot");
  const workDir = h.freshRepo("work-denied-copilot");
  const argsFile = join(h.scratch, "args-denied-copilot");
  const run = spawnSync(process.execPath, [
    h.relayPath("copilot"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "copilot-denied", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  h.check("copilot denied: relay exits non-zero despite copilot exit 0",
    run.status !== 0);
  h.check("copilot denied: result reports failed with denial error",
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "failed" &&
    h.result(outDir).error?.includes("auto-denied") &&
    h.result(outDir).error?.includes("--allow-all-tools"));
}
// --read-only and --allow-all-tools conflict → exit 2
{
  const workDir = h.freshRepo("work-conflict-copilot");
  const outDir = join(h.scratch, "out-conflict-copilot");
  const conflict = spawnSync(process.execPath, [
    h.relayPath("copilot"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--read-only",
    "--allow-all-tools",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("copilot conflict: --read-only + --allow-all-tools exits 2",
    conflict.status === 2);
}
for (const [mode, expectedStatus, expectedExit] of [
  ["copilot-version-hang", "timeout", 124],
  ["copilot-version-fail", "failed", 7],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("copilot"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`copilot preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-copilot");
  const outDir = join(h.scratch, "out-unavailable-copilot");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("copilot"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("copilot unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "copilot_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
if (!h.WIN) {
  const workDir = h.freshRepo("work-abort-preflight-copilot");
  const outDir = join(h.scratch, "out-abort-preflight-copilot");
  const preflight = h.runRelay("copilot", workDir, outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "copilot-version-hang",
  });
  h.check("copilot preflight abort: run artifacts are prepared",
    await h.until(() => existsSync(join(outDir, "events.jsonl")), 2000));
  preflight.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    preflight.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("copilot preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
}
