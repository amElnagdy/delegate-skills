import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export async function runAgy(h) {
  const readArgs = (path) => !existsSync(path)
    ? []
    : h.WIN
      ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(path, "utf8"));
  const runGit = (cwd, args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  };
  const dirtySubmoduleRepo = (name) => {
    const sourceDir = h.freshRepo(`source-${name}-agy`);
    writeFileSync(join(sourceDir, "tracked.txt"), "committed\n");
    runGit(sourceDir, ["add", "tracked.txt"]);
    runGit(sourceDir, ["-c", "user.name=Relay Smoke", "-c", "user.email=relay-smoke@example.invalid", "commit", "-qm", "fixture"]);

    const workDir = h.freshRepo(`work-${name}-agy`);
    runGit(workDir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sourceDir, "nested"]);
    runGit(workDir, ["-c", "user.name=Relay Smoke", "-c", "user.email=relay-smoke@example.invalid", "commit", "-qm", "fixture"]);
    writeFileSync(join(workDir, "nested", "tracked.txt"), "pre-existing submodule dirt\n");
    return workDir;
  };
  const unbornNestedRepo = (name) => {
    const workDir = h.freshRepo(`work-${name}-agy`);
    const nestedDir = join(workDir, "nested");
    mkdirSync(nestedDir);
    runGit(nestedDir, ["init", "-q"]);
    return workDir;
  };
  const run = (name, mode, preexistingFile = null, workDir = h.freshRepo(`work-${name}-agy`), extraArgs = []) => {
    const outDir = join(h.scratch, `out-${name}-agy`);
    if (preexistingFile) writeFileSync(join(workDir, preexistingFile), "pre-existing change\n");
    const result = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...extraArgs,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: mode, ...(preexistingFile ? { SMOKE_EDIT_FILE: preexistingFile } : {}) },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { result, value: existsSync(join(outDir, "result.json")) ? h.result(outDir) : {} };
  };

  const denied = run("permission-denied", "agy-permission-denied");
  h.check("agy permission denial: exit-zero no-op is reported as failed with diagnostics",
    denied.result.status === 1 &&
    denied.value.status === "failed" &&
    denied.value.exitCode === 1 &&
    denied.value.error?.includes("headless --print") &&
    denied.value.stderrTail?.some((line) => line.includes("auto-denied")));

  const silent = run("silent-noop", "agy-silent-noop");
  h.check("agy silent no-op: no final message or edits cannot report completed",
    silent.result.status === 1 &&
    silent.value.status === "failed" &&
    silent.value.exitCode === 1 &&
    silent.value.error?.includes("without a final message"));

  const silentReadOnly = run("silent-read-only-noop", "agy-silent-noop", null, undefined, ["--read-only"]);
  h.check("agy read-only silent no-op: no final message cannot report completed",
    silentReadOnly.result.status === 1 &&
    silentReadOnly.value.status === "failed" &&
    silentReadOnly.value.exitCode === 1 &&
    silentReadOnly.value.readOnly === true &&
    silentReadOnly.value.readOnlyViolation === false &&
    silentReadOnly.value.error?.includes("without a final message"));

  const directConflictOut = join(h.scratch, "out-direct-conflict-agy");
  const directConflict = spawnSync(process.execPath, [
    h.relayPath("agy"),
    "--brief", h.briefPath,
    "--out-dir", directConflictOut,
    "--read-only",
    "--dangerously-skip-permissions",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("agy permissions: direct read-only and dangerous flags remain rejected",
    directConflict.status === 2 && !existsSync(join(directConflictOut, "result.json")));

  for (const changed of [false, true]) {
    const name = changed ? "dirty" : "clean";
    const workDir = h.freshRepo(`work-artifacts-${name}-agy`);
    const argsFile = join(h.scratch, `args-artifacts-${name}-agy`);
    const result = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", workDir,
      "--read-only",
      "--effort", "high",
    ], {
      env: {
        ...h.baseEnv,
        SMOKE_MODE: "agy-analysis",
        SMOKE_ARGS_FILE: argsFile,
        ...(changed ? { SMOKE_WRITE_FILE: join(workDir, "user-change.txt") } : {}),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    const value = existsSync(join(workDir, "result.json")) ? h.result(workDir) : {};
    const args = readArgs(argsFile);
    // read-only is the sandbox plus auto-approve inside it, NOT `--mode plan`:
    // plan mode auto-denies the first tool needing a permission prompt, which
    // headless --print cannot answer, so the run returned nothing at all.
    // Assert both flags reach agy and that plan mode is gone.
    h.check(`agy read-only ${name}: effort and sandboxed auto-approve reach agy and result metadata`,
      result.status === 0 &&
      h.pair(args, "--effort", "high") &&
      args.includes("--sandbox") &&
      args.includes("--dangerously-skip-permissions") &&
      !args.includes("--mode") &&
      value.effort === "high" &&
      value.readOnly === true);
    h.check(`agy read-only ${name}: relay artifacts are excluded from the verdict (got ${String(value.readOnlyViolation)})`,
      value.readOnlyViolation === changed);
    if (value.readOnlyViolation !== changed) console.error(value.touchedFiles);
  }

  const dirtySilent = run("dirty-silent-noop", "agy-silent-noop", "pre-existing.txt");
  h.check("agy PR #56 regression: pre-existing dirt is not dispatch evidence",
    dirtySilent.result.status === 1 &&
    dirtySilent.value.status === "failed" &&
    dirtySilent.value.exitCode === 1 &&
    dirtySilent.value.error?.includes("without a final message") &&
    dirtySilent.value.touchedFiles?.some((line) => line.endsWith("pre-existing.txt")));

  const dirtyEdited = run("dirty-silent-edit", "agy-silent-edit", "pre-existing.txt");
  h.check("agy PR #56 regression: editing pre-existing dirt is dispatch evidence",
    dirtyEdited.result.status === 0 &&
    dirtyEdited.value.status === "completed" &&
    dirtyEdited.value.exitCode === 0 &&
    dirtyEdited.value.finalMessage === "" &&
    dirtyEdited.value.touchedFiles?.some((line) => line.endsWith("pre-existing.txt")));

  const dirtySubmoduleNoop = run("dirty-submodule-noop", "agy-silent-noop", null, dirtySubmoduleRepo("dirty-submodule-noop"));
  h.check("agy PR #56 regression: unchanged dirty submodule is not dispatch evidence",
    dirtySubmoduleNoop.result.status === 1 &&
    dirtySubmoduleNoop.value.status === "failed" &&
    dirtySubmoduleNoop.value.exitCode === 1 &&
    dirtySubmoduleNoop.value.error?.includes("without a final message") &&
    dirtySubmoduleNoop.value.touchedFiles?.some((line) => line.endsWith("nested")));

  const dirtySubmoduleEdited = run("dirty-submodule-edit", "agy-silent-edit", join("nested", "tracked.txt"), dirtySubmoduleRepo("dirty-submodule-edit"));
  h.check("agy PR #56 regression: editing an already-dirty submodule is dispatch evidence",
    dirtySubmoduleEdited.result.status === 0 &&
    dirtySubmoduleEdited.value.status === "completed" &&
    dirtySubmoduleEdited.value.exitCode === 0 &&
    dirtySubmoduleEdited.value.finalMessage === "" &&
    dirtySubmoduleEdited.value.touchedFiles?.some((line) => line.endsWith("nested")));

  const unbornNestedEdited = run("unborn-nested-edit", "agy-silent-edit", "pre-existing.txt", unbornNestedRepo("unborn-nested-edit"));
  h.check("agy PR #56 regression: an unborn nested repo does not erase dispatch evidence",
    unbornNestedEdited.result.status === 0 &&
    unbornNestedEdited.value.status === "completed" &&
    unbornNestedEdited.value.exitCode === 0 &&
    unbornNestedEdited.value.finalMessage === "" &&
    unbornNestedEdited.value.touchedFiles?.some((line) => line.endsWith("nested/")) &&
    unbornNestedEdited.value.touchedFiles?.some((line) => line.endsWith("pre-existing.txt")));

  const analysis = run("analysis", "agy-analysis");
  h.check("agy analysis: a report without edits remains completed",
    analysis.result.status === 0 &&
    analysis.value.status === "completed" &&
    analysis.value.exitCode === 0 &&
    analysis.value.finalMessage === "fake agy analysis completed" &&
    analysis.value.stallTimeout === null);

  // #89: a run whose log keeps growing with reconnect handshakes but no generation call
  // is stalled, not slow - the stall watchdog must end it long before the wall clock.
  // The relay kills the stalled fake with SIGTERM on POSIX and taskkill /f on Windows.
  const stallExit = h.WIN ? { exitCode: 1, signal: null } : { exitCode: 143, signal: "SIGTERM" };
  const stallRun = (name, { workDir = h.freshRepo(`work-${name}-agy`), dirt = null, edit = null, extraArgs = [], env = {} } = {}) => {
    const outDir = join(h.scratch, `out-${name}-agy`);
    if (dirt) writeFileSync(join(workDir, dirt), "pre-existing change\n");
    const result = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--stall-timeout", "1s",
      ...extraArgs,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "agy-stall", ...(edit ? { SMOKE_EDIT_FILE: join(workDir, edit) } : {}), ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { result, value: existsSync(join(outDir, "result.json")) ? h.result(outDir) : {} };
  };
  const sameList = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
    actual.every((line, i) => line.replaceAll("\\", "/") === expected[i]);
  const stalledAs = (label, { result, value }, touchedFiles, readOnlyViolation = null) => {
    const touchedOk = touchedFiles === null ? value.touchedFiles === null
      : typeof touchedFiles === "function" ? touchedFiles(value.touchedFiles)
        : sameList(value.touchedFiles, touchedFiles);
    h.check(`agy stall ${label}: exact stalled result fields`,
      result.status === stallExit.exitCode &&
      value.schema === "delegate-relay.result.v1" &&
      value.status === "stalled" &&
      value.exitCode === stallExit.exitCode &&
      value.signal === stallExit.signal &&
      value.stallTimeout === "1s" &&
      value.finalMessage === "" &&
      value.error === "agy logged no streamGenerateContent call for --stall-timeout 1s; killed by the relay stall watchdog — the working tree may hold nearly finished work, inspect it before re-dispatching" &&
      Array.isArray(value.stderrTail) &&
      touchedOk &&
      value.readOnlyViolation === readOnlyViolation);
    if (!touchedOk) console.error(value.touchedFiles);
  };

  stalledAs("clean", stallRun("stall-clean"), []);
  stalledAs("clean with edits", stallRun("stall-edit", { edit: "work.txt" }), ["?? work.txt"]);
  stalledAs("pre-dirty", stallRun("stall-pre-dirty", { dirt: "pre-existing.txt" }), ["?? pre-existing.txt"]);
  stalledAs("same dirty path", stallRun("stall-same-dirty", { dirt: "pre-existing.txt", edit: "pre-existing.txt" }), ["?? pre-existing.txt"]);
  stalledAs("dirty submodule", stallRun("stall-dirty-submodule", { workDir: dirtySubmoduleRepo("stall-dirty-submodule") }),
    (lines) => Array.isArray(lines) && lines.some((line) => line.endsWith("nested")));
  // POSIX: the fake's shell shim needs `node` and `dirname`, and node's own directory may
  // hold git (/usr/bin), so expose just those two through a private bin directory.
  const noGitBin = join(h.scratch, "no-git-bin");
  mkdirSync(noGitBin);
  if (!h.WIN) {
    symlinkSync(process.execPath, join(noGitBin, "node"));
    const dirnameTool = spawnSync("sh", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(dirnameTool, join(noGitBin, "dirname"));
  }
  const noGitPath = [join(h.scratch, "shim"), noGitBin,
    ...(h.WIN ? [dirname(process.execPath), join(process.env.SystemRoot, "System32")] : [])].join(delimiter);
  stalledAs("git unavailable", stallRun("stall-no-git", { env: { PATH: noGitPath } }), null);
  stalledAs("read-only clean", stallRun("stall-read-only-clean", { extraArgs: ["--read-only"] }), [], false);
  stalledAs("read-only with edits", stallRun("stall-read-only-edit", { edit: "work.txt", extraArgs: ["--read-only"] }), ["?? work.txt"], true);

  const streaming = run("streaming", "agy-streaming", null, undefined, ["--stall-timeout", "1s"]);
  h.check("agy stall: steady generation calls (markers split across writes) keep a 3s run alive under a 1s --stall-timeout",
    streaming.result.status === 0 &&
    streaming.value.status === "completed" &&
    streaming.value.finalMessage === "fake agy streamed to completion");

  const stallOff = run("stall-off", "agy-stall", null, undefined, ["--timeout", "2s"]);
  h.check("agy stall: the stall watchdog is opt-in; without it the wall-clock watchdog reports timeout",
    stallOff.result.status !== 0 &&
    stallOff.value.status === "timeout" &&
    stallOff.value.stallTimeout === null);

  for (const bad of ["0s", "soon", "999999h"]) {
    const badOut = join(h.scratch, `out-bad-stall-${bad}-agy`);
    const badRun = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", h.briefPath,
      "--out-dir", badOut,
      "--stall-timeout", bad,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`agy stall: --stall-timeout ${bad} is a usage error with no result file`,
      badRun.status === 2 && badRun.stderr.includes("--stall-timeout") && !existsSync(join(badOut, "result.json")));
  }
}
