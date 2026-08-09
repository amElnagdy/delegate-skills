import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
