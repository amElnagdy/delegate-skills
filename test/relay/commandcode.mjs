import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every dispatch carries these, in this order: JSON output is what makes the run
// machine-readable, and the other three keep an automated run from stalling on
// onboarding, a trust prompt, or a background self-update.
const CONSTANT = ["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update", "-t"];

function dispatch(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-${name}-commandcode`);
  const workDir = h.freshRepo(`work-${name}-commandcode`);
  const argsFile = join(h.scratch, `args-${name}-commandcode`);
  const run = spawnSync(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "commandcode-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
  });
  const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : { args: [], brief: "" };
  return { run, outDir, workDir, captured };
}

export async function runCommandcode(h) {
if (h.WIN) {
  // Windows support is unverified. Keep the collision guard covered without pretending
  // the POSIX fixture scenarios exercise a native Command Code executable.
  const workDir = h.freshRepo("work-win-guard-commandcode");
  const outDir = join(h.scratch, "out-win-guard-commandcode");
  const guarded = spawnSync(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...h.baseEnv, COMMANDCODE_BIN: "" }, encoding: "utf8" });
  h.check("commandcode windows guard: refuses to run without COMMANDCODE_BIN",
    guarded.status === 2 &&
    /COMMANDCODE_BIN/.test(guarded.stderr) &&
    !existsSync(join(outDir, "result.json")));
  console.log("  skip  commandcode dispatch scenarios: native Windows launch is unverified");
  return;
}
{
  const workDir = h.freshRepo("work-reused-out-dir-commandcode");
  const outDir = join(h.scratch, "out-reused-commandcode");
  const resultPath = join(outDir, "result.json");
  const finalPath = join(outDir, "final.txt");
  mkdirSync(outDir);
  writeFileSync(resultPath, "{\"status\":\"stale\"}\n");
  writeFileSync(finalPath, "stale report\n");
  const child = spawn(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "5s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "commandcode-version-hang" }, stdio: "ignore" });
  h.check("commandcode reused out-dir: stale terminal artifacts disappear before completion",
    await h.until(() => !existsSync(resultPath) && !existsSync(finalPath), 4_000));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  h.check("commandcode reused out-dir: current run publishes its own terminal result",
    exitCode === 124 && h.result(outDir).status === "timeout");
}
for (const scenario of [
  { name: "default", relayArgs: [], forwarded: [...CONSTANT, "--yolo"], readOnly: false, toolsAll: false },
  { name: "read-only", relayArgs: ["--read-only"], forwarded: [...CONSTANT, "--permission-mode", "plan"], readOnly: true, toolsAll: false },
  { name: "tools-all", relayArgs: ["--tools-all"], forwarded: [...CONSTANT, "--yolo", "--tools-all"], readOnly: false, toolsAll: true },
  { name: "session", relayArgs: ["--session", "commandcode-session-1"], forwarded: [...CONSTANT, "--yolo", "--resume", "commandcode-session-1"], readOnly: false, toolsAll: false },
  { name: "continue-last", relayArgs: ["--continue-last"], forwarded: [...CONSTANT, "--yolo", "--continue"], readOnly: false, toolsAll: false },
  {
    name: "dials",
    relayArgs: ["--model", "fake/model", "--effort", "high", "--max-turns", "7"],
    forwarded: [...CONSTANT, "--yolo", "-m", "fake/model", "--effort", "high", "--max-turns", "7"],
    readOnly: false,
    toolsAll: false,
  },
  // --tools-all does not lift the headless write gate, so it must not silently imply
  // a write-capable run when --read-only asked for the opposite.
  { name: "read-only-wins", relayArgs: ["--read-only", "--tools-all"], forwarded: [...CONSTANT, "--permission-mode", "plan"], readOnly: true, toolsAll: false },
]) {
  const { run, outDir, captured } = dispatch(h, scenario.name, scenario.relayArgs);
  h.check(`commandcode ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`commandcode ${scenario.name}: documented argv is exact`,
    JSON.stringify(captured.args) === JSON.stringify(scenario.forwarded));
  h.check(`commandcode ${scenario.name}: the brief arrives on stdin, never in argv`,
    captured.brief.includes("smoke brief") &&
    !captured.args.some((arg) => arg.includes("smoke brief")));
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`commandcode ${scenario.name}: result line is parsed into the result`,
    value.status === "completed" &&
    value.finalMessage === "fake commandcode completed" &&
    value.sessionId === "commandcode-session-1" &&
    value.resultLine === "complete" &&
    value.resultSubtype === "success" &&
    value.stopReason === "end_turn" &&
    value.usage?.outputTokens === 2 &&
    value.readOnly === scenario.readOnly &&
    value.toolsAll === scenario.toolsAll);
  h.check(`commandcode ${scenario.name}: final.txt holds the report`,
    value.finalPath === join(outDir, "final.txt") &&
    readFileSync(join(outDir, "final.txt"), "utf8").trim() === "fake commandcode completed");
}
// A clean exit with an unfinished task is a failure, not a completion: Command Code
// exits 0 for a run that stopped at the turn cap or refused every write.
{
  const { run, outDir } = dispatch(h, "unfinished", [], { SMOKE_MODE: "commandcode-unfinished" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("commandcode unfinished: relay exits non-zero despite cmd exit 0", run.status === 1);
  h.check("commandcode unfinished: result reports failed and names the subtype",
    value.status === "failed" &&
    value.resultSubtype === "max_turns" &&
    value.stopReason === "max_turns" &&
    value.error?.includes("max_turns") &&
    value.finalMessage === "ran out of turns partway");
}
// cmd embeds the whole transcript in run_end and exits without draining stdout, so the
// result line is routinely lost. A successful run must survive that, with the loss named.
{
  const { run, outDir } = dispatch(h, "truncated-tail", [], { SMOKE_MODE: "commandcode-truncated-tail" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("commandcode truncated tail: exit 0 is still a completed run", run.status === 0 && value.status === "completed");
  h.check("commandcode truncated tail: the loss is named, not hidden",
    value.resultLine === "truncated" &&
    value.resultSubtype === null &&
    value.usage === null);
  h.check("commandcode truncated tail: session id and report survive via the early events",
    value.sessionId === "commandcode-session-1" &&
    value.finalMessage === "fake commandcode completed");
}
// The read-only guarantee is the CLI's permission layer, not a sandbox, so the relay
// proves it after the fact — both directions.
{
  const { outDir } = dispatch(h, "read-only-clean", ["--read-only"]);
  h.check("commandcode read-only clean: no violation on an untouched tree",
    h.result(outDir).readOnlyViolation === false);
}
{
  const { outDir } = dispatch(h, "read-only-write", ["--read-only"], { SMOKE_WRITE_FILE: "sneaked.txt" });
  h.check("commandcode read-only write: a tree change is reported as a violation",
    h.result(outDir).readOnlyViolation === true);
}
{
  const { outDir } = dispatch(h, "write-capable", []);
  h.check("commandcode write-capable: the read-only question does not apply",
    h.result(outDir).readOnlyViolation === null);
}
// Usage errors: exit 2, a named cause, and no result.json — nothing was dispatched.
for (const [name, args, pattern] of [
  ["invalid effort", ["--effort", "very fast"], /invalid --effort/],
  ["invalid max-turns", ["--max-turns", "0"], /invalid --max-turns/],
  ["invalid model", ["--model", "a b;c"], /--model contains unsupported characters/],
  ["session conflict", ["--session", "abc", "--continue-last"], /mutually exclusive/],
  ["keep-env without clean-env", ["--keep-env", "PATH"], /--keep-env requires --clean-env/],
]) {
  const workDir = h.freshRepo(`work-${name.replace(/\s+/g, "-")}-commandcode`);
  const outDir = join(h.scratch, `out-${name.replace(/\s+/g, "-")}-commandcode`);
  const bad = spawnSync(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...args,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check(`commandcode ${name}: exits 2 before dispatch`,
    bad.status === 2 && pattern.test(bad.stderr) && !existsSync(join(outDir, "result.json")));
}
for (const [mode, expectedStatus, expectedExit, timeout] of [
  ["commandcode-version-hang", "timeout", 124, "1s"],
  // No 1s cap on the failure case: the probe is expected to exit on its own, and under a
  // loaded suite a 1s bound turns a slow-starting fake into a timeout instead.
  ["commandcode-version-fail", "failed", 7, "30s"],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", timeout,
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`commandcode preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-commandcode");
  const outDir = join(h.scratch, "out-unavailable-commandcode");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("commandcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], {
    // No PATH and no COMMANDCODE_BIN: the binary genuinely cannot be found.
    env: { ...process.env, PATH: "", COMMANDCODE_BIN: "" },
    encoding: "utf8",
  });
  h.check("commandcode unavailable: structured result replaces the stale one",
    missing.status === 127 && h.result(outDir).status === "commandcode_unavailable");
}
}
