import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
}
