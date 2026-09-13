import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function capturedArgs(h, argsFile) {
  if (!existsSync(argsFile)) return [];
  return h.WIN
    ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
    : JSON.parse(readFileSync(argsFile, "utf8"));
}

function dispatch(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-${name}-muse`);
  const workDir = h.freshRepo(`work-${name}-muse`);
  const argsFile = join(h.scratch, `args-${name}-muse`);
  const run = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "muse-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
  });
  return { run, outDir, workDir, args: capturedArgs(h, argsFile) };
}

function baseArgv(workDir, outDir) {
  return [
    "exec",
    "--json",
    "--prompt-file", join(outDir, "brief.txt"),
    "--disable-approval",
    "--trust-workspace",
    "--workspace", workDir,
    "--user-input-auto-resolve",
  ];
}

export async function runMuse(h) {
for (const scenario of [
  { name: "default", relayArgs: [], extra: [], resumed: false, readOnly: false },
  {
    name: "read-only",
    relayArgs: ["--read-only"],
    extra: ["--disable-write", "--disable-shell"],
    resumed: false,
    readOnly: true,
  },
  {
    name: "session",
    relayArgs: ["--session", "01a06628-aaaa-bbbb-cccc-ddddeeeeffff"],
    extra: ["--session-id", "01a06628-aaaa-bbbb-cccc-ddddeeeeffff"],
    resumed: true,
    readOnly: false,
  },
  {
    name: "dials",
    relayArgs: ["--model", "fake-model", "--effort", "high", "--provider", "echo"],
    extra: ["--provider", "echo", "--model", "fake-model", "--reasoning-effort", "high"],
    resumed: false,
    readOnly: false,
  },
]) {
  const { run, outDir, workDir, args } = dispatch(h, scenario.name, scenario.relayArgs);
  h.check(`muse ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`muse ${scenario.name}: documented argv is exact`,
    JSON.stringify(args) === JSON.stringify([...baseArgv(workDir, outDir), ...scenario.extra]));
  h.check(`muse ${scenario.name}: --yolo is never passed`, !args.includes("--yolo"));
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`muse ${scenario.name}: result and assistant output are captured`,
    value.status === "completed" &&
    value.finalMessage === "fake muse completed" &&
    value.sessionId === "01a06628-aaaa-bbbb-cccc-ddddeeeeffff" &&
    value.readOnly === scenario.readOnly &&
    value.resumed === scenario.resumed);
}

{
  const { run, outDir } = dispatch(h, "unfinished", [], { SMOKE_MODE: "muse-unfinished" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("muse unfinished: relay exits non-zero despite muse exit 0", run.status === 1);
  h.check("muse unfinished: result reports failed and names the missing terminal event",
    value.status === "failed" &&
    value.error?.includes("run.terminal.completed") &&
    value.sessionId === "01a06628-aaaa-bbbb-cccc-ddddeeeeffff");
}

{
  const workDir = h.freshRepo("work-resume-last-muse");
  const outDir = join(h.scratch, "out-resume-last-muse");
  const rejected = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--resume-last",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("muse validation: --resume-last is TUI-only",
    rejected.status === 2 &&
    /TUI-only/.test(rejected.stderr) &&
    !existsSync(outDir));
}

{
  const workDir = h.freshRepo("work-bad-effort-muse");
  const rejected = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--effort", "banana",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("muse validation: unknown --effort is rejected", rejected.status === 2);
}

{
  const workDir = h.freshRepo("work-bad-provider-muse");
  const rejected = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--provider", "openai",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("muse validation: --provider must be echo or meta", rejected.status === 2);
}

for (const [mode, expectedStatus, expectedExit] of [
  ["muse-version-hang", "timeout", 124],
  ["muse-version-fail", "failed", 7],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`muse preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-muse");
  const outDir = join(h.scratch, "out-unavailable-dedicated-muse");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("muse"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("muse unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "muse_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
}
