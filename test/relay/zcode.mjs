import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runZcode(h) {
  const workDir = h.freshRepo("work-zcode");
  // zcode's fake is fake-cli.cjs on both platforms (a .cmd shim on Windows), and
  // that fake writes JSON. Only the skills backed by the compiled native fake
  // write one argument per line, so no platform branch belongs here.
  const capturedArgs = (file) =>
    (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);

  // --- mode validation -----------------------------------------------------
  // build/edit exit 0 having changed nothing in a real headless run (no
  // permission client), so they must never reach dispatch. See issue #55.
  for (const [label, value] of [
    ["build", "build"],
    ["edit", "edit"],
    ["bogus", "definitely-not-a-mode"],
  ]) {
    const outDir = join(h.scratch, `out-reject-mode-${label}`);
    const run = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", outDir, "--mode", value,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`zcode validation: --mode ${label} is rejected before artifacts`,
      run.status === 2 && !existsSync(outDir));
  }

  const conflictOutDir = join(h.scratch, "out-reject-conflict");
  const conflict = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", conflictOutDir, "--read-only", "--mode", "yolo",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("zcode validation: --read-only conflicting with --mode yolo is rejected",
    conflict.status === 2 && !existsSync(conflictOutDir));

  const badSessionOutDir = join(h.scratch, "out-reject-session");
  const badSession = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", badSessionOutDir, "--session", "not-a-zcode-session",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("zcode validation: a session id without the sess_ prefix is rejected",
    badSession.status === 2 && !existsSync(badSessionOutDir));

  // --- unavailable ---------------------------------------------------------
  // Deliberately NOT PATH-based: bundle discovery would still find an installed
  // ZCode desktop app, so clearing PATH proves nothing on a developer machine.
  // Naming a CLI that does not exist is the same condition and is deterministic.
  const missingOutDir = join(h.scratch, "out-unavailable-zcode");
  const missing = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", missingOutDir,
  ], {
    env: { ...h.baseEnv, ZCODE_CLI: join(h.scratch, "no-such-zcode.cjs") },
    encoding: "utf8",
  });
  h.check("zcode unavailable: an explicitly named missing CLI writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "zcode_unavailable");

  // --- success -------------------------------------------------------------
  const outDir = join(h.scratch, "out-success-zcode");
  const argsFile = join(h.scratch, "args-success-zcode");
  const run = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--session", "sess_prior-0", "--disallowed-tools", "Write,Edit",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = capturedArgs(argsFile);
  h.check("zcode success: relay exits zero", run.status === 0);
  h.check("zcode success: --mode is always explicit, never left to ZCode's yolo default",
    h.pair(args, "--mode", "yolo"));
  h.check("zcode success: the brief is attached, never passed as prompt text",
    args.includes("--attach") &&
    /brief\.md"?$/.test(args[args.indexOf("--attach") + 1] || "") &&
    /^"?Follow the attached brief exactly\."?$/.test(args[args.indexOf("--prompt") + 1] || ""));
  h.check("zcode success: documented resume and denylist flags are used",
    h.pair(args, "--resume", "sess_prior-0") &&
    args.includes("--disallowed-tools") &&
    !args.includes("-c"));
  h.check("zcode success: --json and --no-color are always passed",
    args.includes("--json") && args.includes("--no-color"));
  h.check("zcode success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("zcode success: the JSON document is parsed past the stdout banner",
      value.status === "completed" &&
      value.sessionId === "sess_smoke-1" &&
      value.finalMessage === "fake zcode completed" &&
      !value.parseWarning);
    h.check("zcode success: usage and context window are carried through",
      value.usage?.totalTokens === 9 &&
      value.contextWindow === 200000 &&
      value.mode === "yolo" &&
      value.readOnlyViolation === null);
    h.check("zcode success: the raw output is preserved beside the result",
      typeof value.outputPath === "string" && existsSync(value.outputPath));
  }

  // --- resume-last uses ZCode's own -c -------------------------------------
  const latestOutDir = join(h.scratch, "out-resume-last-zcode");
  const latestArgsFile = join(h.scratch, "args-resume-last-zcode");
  const latest = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", latestOutDir, "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: latestArgsFile },
    encoding: "utf8",
  });
  const latestArgs = capturedArgs(latestArgsFile);
  h.check("zcode resume-last: uses documented -c, not --resume",
    latest.status === 0 &&
    latestArgs.includes("-c") &&
    !latestArgs.includes("--resume"));

  // --- read-only ------------------------------------------------------------
  const readOnlyOutDir = join(h.scratch, "out-read-only-zcode");
  const readOnlyArgsFile = join(h.scratch, "args-read-only-zcode");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOutDir, "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: readOnlyArgsFile },
    encoding: "utf8",
  });
  const readOnlyArgs = capturedArgs(readOnlyArgsFile);
  h.check("zcode read-only: maps to ZCode's plan mode and reports a clean tripwire",
    readOnly.status === 0 &&
    h.pair(readOnlyArgs, "--mode", "plan") &&
    existsSync(join(readOnlyOutDir, "result.json")) &&
    h.result(readOnlyOutDir).mode === "plan" &&
    h.result(readOnlyOutDir).readOnlyViolation === false);

  // --- unparseable stdout is reported, not hidden --------------------------
  const garbledOutDir = join(h.scratch, "out-garbled-zcode");
  const garbled = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", garbledOutDir,
  ], { env: { ...h.baseEnv, SMOKE_MODE: "zcode-garbled" }, encoding: "utf8" });
  const garbledResult = existsSync(join(garbledOutDir, "result.json")) ? h.result(garbledOutDir) : {};
  h.check("zcode garbled: an unparseable document still completes but says so",
    garbled.status === 0 &&
    garbledResult.status === "completed" &&
    garbledResult.sessionId === null &&
    typeof garbledResult.parseWarning === "string" &&
    garbledResult.finalMessage.includes("not json at all"));

  // --- preflight ------------------------------------------------------------
  // zcode is deliberately absent from preflight.mjs, whose unavailable sub-test
  // clears PATH; these are the equivalent checks, as qoder does.
  for (const [mode, expectedStatus, expectedExit] of [
    ["zcode-version-hang", "timeout", 124],
    ["zcode-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", preflightOutDir, "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(preflightOutDir, "result.json")) ? h.result(preflightOutDir) : {};
    h.check(`zcode preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }
}
