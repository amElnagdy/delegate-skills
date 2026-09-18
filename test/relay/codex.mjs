import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runCodex(h) {
const effortOutDir = join(h.scratch, "out-effort-codex");
const effortArgsFile = join(h.scratch, "args-effort-codex");
const effortWorkDir = h.freshRepo("work-effort-codex");
const effortRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--cd", effortWorkDir, "--out-dir", effortOutDir, "--effort", "low"],
  { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: effortArgsFile }, encoding: "utf8" });
const effortArgs = existsSync(effortArgsFile) ? JSON.parse(readFileSync(effortArgsFile, "utf8")) : [];
h.check("codex effort: forwarded as a config override",
  effortRun.status === 0 && effortArgs.includes("-c") && effortArgs[effortArgs.indexOf("-c") + 1] === "model_reasoning_effort=low");
h.check("codex effort: recorded in result.json",
  existsSync(join(effortOutDir, "result.json")) && h.result(effortOutDir).effort === "low");
// ---- codex --ignore-user-config isolates reviews from ambient MCP/user config ----
const isolatedOutDir = join(h.scratch, "out-ignore-user-config-codex");
const isolatedArgsFile = join(h.scratch, "args-ignore-user-config-codex");
const isolatedRun = spawnSync(process.execPath, [
  h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo("work-ignore-user-config-codex"),
  "--out-dir", isolatedOutDir, "--read-only", "--ignore-user-config",
], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: isolatedArgsFile }, encoding: "utf8" });
const isolatedArgs = existsSync(isolatedArgsFile) ? JSON.parse(readFileSync(isolatedArgsFile, "utf8")) : [];
h.check("codex ignore-user-config: forwarded before exec options",
  isolatedRun.status === 0 && isolatedArgs[0] === "exec" && isolatedArgs[1] === "--ignore-user-config");
h.check("codex ignore-user-config: recorded in result.json",
  existsSync(join(isolatedOutDir, "result.json")) && h.result(isolatedOutDir).ignoreUserConfig === true);
// ---- codex --clean-env isolates both preflight and dispatch ----
const cleanEnvHelp = spawnSync(process.execPath, [h.relayPath("codex"), "--help"], { encoding: "utf8" });
h.check("codex clean-env: help scopes the flag to inherited variables, not same-user secrets",
  cleanEnvHelp.status === 0 && cleanEnvHelp.stdout.includes("does not protect files or other")
    && cleanEnvHelp.stdout.includes("same-user secrets")
    && cleanEnvHelp.stdout.includes("environment-backed auth"));
const cleanEnvOutDir = join(h.scratch, "out-cleanenv-codex");
const cleanEnvArgsFile = join(h.scratch, "args-cleanenv-codex");
const cleanEnvFile = join(h.scratch, "env-cleanenv-codex");
const cleanEnvPreflightFile = join(h.scratch, "env-cleanenv-preflight-codex");
const fallbackPath = join(h.scratch, "shim", "smoke-fallback.json");
writeFileSync(fallbackPath, JSON.stringify({
  SMOKE_MODE: "capture",
  SMOKE_ARGS_FILE: cleanEnvArgsFile,
  SMOKE_ENV_FILE: cleanEnvFile,
  SMOKE_PREFLIGHT_ENV_FILE: cleanEnvPreflightFile,
}));
const cleanEnvRun = spawnSync(process.execPath, [
  h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo("work-cleanenv-codex"),
  "--out-dir", cleanEnvOutDir, "--clean-env", "--keep-env", "SMOKE_PROVIDER_TOKEN",
], {
  env: { ...h.baseEnv, HOME: h.scratch, SMOKE_PROVIDER_TOKEN: "required", SMOKE_SECRET_TOKEN: "must-not-leak" },
  encoding: "utf8",
});
rmSync(fallbackPath, { force: true });
const cleanEnvCapture = existsSync(cleanEnvFile) ? JSON.parse(readFileSync(cleanEnvFile, "utf8")) : null;
const cleanEnvPreflightCapture = existsSync(cleanEnvPreflightFile) ? JSON.parse(readFileSync(cleanEnvPreflightFile, "utf8")) : null;
h.check("codex clean-env: the run completes", cleanEnvRun.status === 0);
h.check("codex clean-env: unrelated variables miss preflight and dispatch",
  cleanEnvPreflightCapture?.SMOKE_SECRET_TOKEN === undefined && cleanEnvCapture?.SMOKE_SECRET_TOKEN === undefined);
h.check("codex clean-env: PATH and HOME reach preflight and dispatch",
  [cleanEnvPreflightCapture, cleanEnvCapture].every((env) => env?.PATH && env.HOME === h.scratch));
h.check("codex clean-env: an explicitly kept provider variable reaches both processes",
  [cleanEnvPreflightCapture, cleanEnvCapture].every((env) => env?.SMOKE_PROVIDER_TOKEN === "required"));
h.check("codex clean-env: mode and kept names are recorded without values", (() => {
  if (!existsSync(join(cleanEnvOutDir, "result.json"))) return false;
  const value = h.result(cleanEnvOutDir);
  return value.cleanEnv === true && JSON.stringify(value.keepEnv) === JSON.stringify(["SMOKE_PROVIDER_TOKEN"])
    && !JSON.stringify(value).includes("required");
})());
const inheritedEnvFile = join(h.scratch, "env-inherited-codex");
spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo("work-inherited-codex"), "--out-dir", join(h.scratch, "out-inherited-codex")],
  { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(h.scratch, "args-inherited-codex"), SMOKE_ENV_FILE: inheritedEnvFile, SMOKE_SECRET_TOKEN: "inherited" }, encoding: "utf8" });
const inheritedCapture = existsSync(inheritedEnvFile) ? JSON.parse(readFileSync(inheritedEnvFile, "utf8")) : null;
h.check("codex clean-env: without the flag the environment is still inherited",
  inheritedCapture?.SMOKE_SECRET_TOKEN === "inherited");
// ---- codex PATH: Store WindowsApps entries never reach a sandboxed child on win32 ----
// The two shapes a Store install puts on PATH: the package folder itself and the per-user
// alias folder. Off win32 the relay must leave PATH byte-identical, entries like these included.
const windowsAppsEntries = [
  "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe",
  "C:\\Users\\smoke\\AppData\\Local\\Microsoft\\WindowsApps",
];
const pathWithWindowsApps = [windowsAppsEntries[0], h.baseEnv.PATH, windowsAppsEntries[1]].join(h.WIN ? ";" : ":");
const pathWithoutWindowsApps = h.WIN
  ? pathWithWindowsApps.split(";").filter((entry) => !/(^|[\\/])WindowsApps([\\/]|$)/i.test(entry)).join(";")
  : pathWithWindowsApps;
const windowsAppsEnv = { ...h.baseEnv, PATH: pathWithWindowsApps, ...(h.WIN ? { Path: pathWithWindowsApps } : {}) };
const capturePath = (name, flags, extraEnv) => {
  const envFile = join(h.scratch, `env-${name}`);
  const preflightFile = join(h.scratch, `env-preflight-${name}`);
  const run = spawnSync(process.execPath,
    [h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo(`work-${name}`), "--out-dir", join(h.scratch, `out-${name}`), ...flags],
    { env: { ...windowsAppsEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(h.scratch, `args-${name}`), SMOKE_ENV_FILE: envFile, SMOKE_PREFLIGHT_ENV_FILE: preflightFile, ...extraEnv }, encoding: "utf8" });
  const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).PATH : null);
  return { status: run.status, dispatch: read(envFile), preflight: read(preflightFile) };
};
const sandboxedPath = capturePath("windowsapps-sandboxed", []);
h.check("codex PATH: a sandboxed run completes with WindowsApps entries present", sandboxedPath.status === 0);
h.check(`codex PATH: ${h.WIN ? "WindowsApps entries are removed from" : "off win32 nothing is removed from"} the dispatch PATH`,
  sandboxedPath.dispatch === pathWithoutWindowsApps);
h.check("codex PATH: the preflight sees the same PATH as the dispatch", sandboxedPath.preflight === sandboxedPath.dispatch);
h.check("codex PATH: the shim entry survives the filter",
  Boolean(sandboxedPath.dispatch?.split(h.WIN ? ";" : ":").includes(join(h.scratch, "shim"))));
const readOnlyPath = capturePath("windowsapps-read-only", ["--read-only"]);
h.check("codex PATH: --read-only filters like workspace-write", readOnlyPath.status === 0 && readOnlyPath.dispatch === pathWithoutWindowsApps);
const fullAccessPath = capturePath("windowsapps-full-access", ["--sandbox", "danger-full-access"]);
h.check("codex PATH: danger-full-access passes PATH through unchanged",
  fullAccessPath.status === 0 && fullAccessPath.dispatch === pathWithWindowsApps && fullAccessPath.preflight === pathWithWindowsApps);
writeFileSync(fallbackPath, JSON.stringify({
  SMOKE_MODE: "capture",
  SMOKE_ARGS_FILE: join(h.scratch, "args-windowsapps-clean-env"),
  SMOKE_ENV_FILE: join(h.scratch, "env-windowsapps-clean-env"),
  SMOKE_PREFLIGHT_ENV_FILE: join(h.scratch, "env-preflight-windowsapps-clean-env"),
}));
const cleanEnvPath = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo("work-windowsapps-clean-env"), "--out-dir", join(h.scratch, "out-windowsapps-clean-env"), "--clean-env"],
  { env: windowsAppsEnv, encoding: "utf8" });
rmSync(fallbackPath, { force: true });
const cleanEnvPathCapture = existsSync(join(h.scratch, "env-windowsapps-clean-env"))
  ? JSON.parse(readFileSync(join(h.scratch, "env-windowsapps-clean-env"), "utf8")).PATH : null;
h.check("codex PATH: --clean-env filters the kept PATH the same way",
  cleanEnvPath.status === 0 && cleanEnvPathCapture === pathWithoutWindowsApps);
const windowsAppsHelp = spawnSync(process.execPath, [h.relayPath("codex"), "--help"], { encoding: "utf8" });
h.check("codex PATH: help documents the WindowsApps filter and the full-access exemption",
  windowsAppsHelp.status === 0 && windowsAppsHelp.stdout.includes("WindowsApps") && windowsAppsHelp.stdout.includes("0xC0070005")
    && windowsAppsHelp.stdout.includes("danger-full-access") && windowsAppsHelp.stdout.includes("PATH unchanged"));
for (const [name, flags] of [
  ["requires clean-env", ["--keep-env", "HOME"]],
  ["rejects an invalid name", ["--clean-env", "--keep-env", "BAD-NAME"]],
  ["rejects an unset name", ["--clean-env", "--keep-env", "SMOKE_MISSING_ENV"]],
]) {
  const outDir = join(h.scratch, `out-keep-env-${name.replaceAll(" ", "-")}`);
  const run = spawnSync(process.execPath,
    [h.relayPath("codex"), "--brief", h.briefPath, "--out-dir", outDir, ...flags],
    { env: h.baseEnv, encoding: "utf8" });
  h.check(`codex keep-env: ${name} before artifacts`, run.status === 2 && !existsSync(outDir));
}
// ---- codex --session resumes one exact thread ----
const sessionOutDir = join(h.scratch, "out-session-codex");
const sessionArgsFile = join(h.scratch, "args-session-codex");
const sessionWorkDir = h.freshRepo("work-session-codex");
const sessionRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--cd", sessionWorkDir, "--out-dir", sessionOutDir, "--session", "thread-abc"],
  { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: sessionArgsFile }, encoding: "utf8" });
const sessionArgs = existsSync(sessionArgsFile) ? JSON.parse(readFileSync(sessionArgsFile, "utf8")) : [];
h.check("codex session: resumes the named thread",
  sessionRun.status === 0 && sessionArgs[0] === "exec" && sessionArgs[1] === "resume" && sessionArgs[2] === "thread-abc");
h.check("codex session: an unqualified resume leaves the active Codex sandbox config alone", !sessionArgs.includes("-s"));
h.check("codex session: recorded in result.json",
  existsSync(join(sessionOutDir, "result.json")) && h.result(sessionOutDir).session === "thread-abc");
const bothResumeRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--session", "thread-abc", "--resume-last"],
  { env: h.baseEnv, encoding: "utf8" });
h.check("codex session: --session with --resume-last is rejected", bothResumeRun.status === 2);
for (const [name, value] of [
  ["an empty id", ""],
  ["an option-like id", "--resume-last"],
  ["a shell-unsafe id", "thread & whoami"],
]) {
  const invalidSessionRun = spawnSync(process.execPath,
    [h.relayPath("codex"), "--brief", h.briefPath, "--session", value],
    { env: h.baseEnv, encoding: "utf8" });
  h.check(`codex session: ${name} is rejected`, invalidSessionRun.status === 2);
}

const emptyEffortRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--effort", ""],
  { env: h.baseEnv, encoding: "utf8" });
h.check("codex effort: an empty value is rejected", emptyEffortRun.status === 2);
// ---- codex stderr: the full log survives a transcript longer than the tail ----
const floodOutDir = join(h.scratch, "out-stderr-flood-codex");
const floodRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath, "--cd", h.freshRepo("work-stderr-flood-codex"), "--out-dir", floodOutDir],
  { env: { ...h.baseEnv, SMOKE_MODE: "codex-stderr-flood" }, encoding: "utf8" });
const floodResult = existsSync(join(floodOutDir, "result.json")) ? h.result(floodOutDir) : null;
const floodTail = floodResult?.stderrTail ?? [];
const floodLog = floodResult?.stderrPath && existsSync(floodResult.stderrPath)
  ? readFileSync(floodResult.stderrPath, "utf8")
  : "";
h.check("codex stderr: the flooded run still fails with the implementer's exit",
  floodRun.status === 1 && floodResult?.status === "failed" && floodResult.exitCode === 1);
h.check("codex stderr: result.json points at the full log",
  Boolean(floodResult?.stderrPath) && existsSync(floodResult.stderrPath));
h.check("codex stderr: the full log keeps a diagnostic the tail cannot hold",
  floodLog.includes("early marker") && !floodTail.some((line) => line.includes("early marker")));
h.check("codex stderr: the full log drops nothing",
  floodLog.split("\n").filter((line) => line.includes("failed to renew cache TTL")).length === 300);
h.check("codex stderr: the tail stays bounded and ends at the failure",
  floodTail.length === 20 && Boolean(floodTail.at(-1)?.includes("fatal: dispatch failed")));

// PR #102: a small heap must still publish the failure after a large stderr stream.
const largeOutDir = join(h.scratch, "out-stderr-large-codex");
const largeRun = spawnSync(process.execPath,
  ["--max-old-space-size=32", h.relayPath("codex"), "--brief", h.briefPath,
    "--cd", h.freshRepo("work-stderr-large-codex"), "--out-dir", largeOutDir],
  { env: { ...h.baseEnv, SMOKE_MODE: "codex-stderr-large" }, stdio: "ignore", timeout: 30_000 });
const largeResult = existsSync(join(largeOutDir, "result.json")) ? h.result(largeOutDir) : null;
h.check("codex stderr: large logs preserve the failure result under a small heap",
  largeRun.status === 7 && largeResult?.status === "failed" && largeResult.exitCode === 7);
h.check("codex stderr: the tail preserves logical lines, UTF-8, and an unterminated final line",
  JSON.stringify(largeResult?.stderrTail) === JSON.stringify([
    ...Array(18).fill("x"), "fatal: café انتهى 🐎", "last diagnostic without newline",
  ]));
h.check("codex stderr: the complete large stream remains on disk",
  existsSync(join(largeOutDir, "stderr.txt")) &&
  statSync(join(largeOutDir, "stderr.txt")).size === 4 * 1024 * 1024 +
    Buffer.byteLength("\r\n  \r\nfatal: café انتهى 🐎\r\nlast diagnostic without newline"));

for (const [mode, expectedTail] of [
  ["codex-stderr-long-line", ["[truncated; read stderrPath] " + "🐎".repeat(16383) + "fin"]],
  ["codex-stderr-window-boundary", ["first complete diagnostic", "last diagnostic"]],
  ["codex-version-fail", ["fake version failure"]],
]) {
  const outDir = join(h.scratch, `out-${mode}`);
  const run = spawnSync(process.execPath,
    ["--max-old-space-size=32", h.relayPath("codex"), "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-${mode}`), "--out-dir", outDir],
    { env: { ...h.baseEnv, SMOKE_MODE: mode }, stdio: "ignore", timeout: 30_000 });
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  h.check(`codex stderr: ${mode} preserves the bounded diagnostic and failure code`,
    run.status === 7 && result?.status === "failed" && result.exitCode === 7 &&
    JSON.stringify(result.stderrTail) === JSON.stringify(expectedTail));
}

// ---- codex: a normal exit must settle even while an orphan holds the stdio pipes ----
// codex runs each command through a shell, and on Windows a grandchild of that shell
// routinely outlives it. Having inherited the pipes, it keeps the relay's stdout/stderr
// open after codex itself is gone: "exit" fires and "close" never does. A relay that
// settles only on "close" then waits forever and writes no result.json, so the
// orchestrator sees a run that neither completed nor failed. The watchdog is not a
// backstop here — a run without --timeout has none, and one with a timeout reports
// "timeout" for a run that actually succeeded.
const orphanOutDir = join(h.scratch, "out-orphan-codex");
const orphanGrandPidFile = join(h.scratch, "grandpid-orphan-codex");
const orphanRun = spawnSync(process.execPath,
  [h.relayPath("codex"), "--brief", h.briefPath,
    "--cd", h.freshRepo("work-orphan-codex"), "--out-dir", orphanOutDir],
  {
    env: { ...h.baseEnv, SMOKE_MODE: "orphan-holds-stdio", SMOKE_GRAND_PID_FILE: orphanGrandPidFile },
    encoding: "utf8",
    timeout: 20_000,
  });
const orphanResult = existsSync(join(orphanOutDir, "result.json")) ? h.result(orphanOutDir) : null;
h.check("codex orphan: the relay exits instead of waiting on the held pipes",
  orphanRun.signal === null && orphanRun.status === 0);
h.check("codex orphan: the successful run is reported as completed",
  orphanResult?.status === "completed" && orphanResult.exitCode === 0);
h.check("codex orphan: the final report survives the early stream teardown",
  orphanResult?.finalMessage === "fake codex completed");
// The relay does not own the orphan on the normal-exit path, so the suite must not leak it.
if (existsSync(orphanGrandPidFile)) {
  const orphanPid = Number(readFileSync(orphanGrandPidFile, "utf8"));
  try { process.kill(orphanPid, "SIGKILL"); } catch { /* already gone */ }
}
}
