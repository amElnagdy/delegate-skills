import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

function runGit(cwd, args) {
  const command = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (command.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${command.stderr}`);
  return command.stdout.trim();
}

function addDirtySubmodule(workDir) {
  const submodule = join(workDir, "unknown-submodule");
  mkdirSync(submodule);
  runGit(submodule, ["init", "-q"]);
  writeFileSync(join(submodule, "tracked.txt"), "submodule fixture\n");
  runGit(submodule, ["add", "tracked.txt"]);
  runGit(submodule, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
  const head = runGit(submodule, ["rev-parse", "HEAD"]);
  runGit(workDir, ["update-index", "--add", "--cacheinfo", `160000,${head},unknown-submodule`]);
}

async function waitFor(child, timeoutMs = 15_000) {
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolve(true);
    });
  });
  return { exited, exitCode, stderr };
}

async function runScenario(h, skill, scenario) {
  const workName = `work-${skill}-${scenario.name}${scenario.trailingSpaceRoot ? " " : ""}`;
  if (scenario.trailingSpaceRoot) h.freshRepo(workName.slice(0, -1));
  const workDir = scenario.repo === false
    ? join(h.scratch, workName)
    : h.freshRepo(workName);
  if (scenario.repo === false) mkdirSync(workDir);
  if (scenario.unknown) addDirtySubmodule(workDir);
  if (scenario.dirty) writeFileSync(join(workDir, "already-dirty.txt"), "pre-existing\n");
  if (scenario.artifactSymlink) {
    writeFileSync(join(workDir, "already-dirty.txt"), "pre-existing\n");
    symlinkSync("already-dirty.txt", join(workDir, "final.txt"));
  }
  if (scenario.rawSymlinkTarget) {
    symlinkSync(Buffer.from([0xff]), join(workDir, "already-dirty-link"));
  }
  if (scenario.caseAliasedArtifact || scenario.caseRenamedArtifact || scenario.caseDistinctUserWrite) {
    writeFileSync(join(workDir, "FINAL.TXT"), "tracked user file\n");
    runGit(workDir, ["add", "FINAL.TXT"]);
    runGit(workDir, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
    if (scenario.caseRenamedArtifact) {
      renameSync(join(workDir, "FINAL.TXT"), join(workDir, "Final.txt"));
    }
    if (scenario.caseDistinctUserWrite) {
      writeFileSync(join(workDir, "FINAL.TXT"), "pre-existing user change\n", { flag: "a" });
    }
  }
  if (scenario.invalidUtf8) {
    writeFileSync(Buffer.concat([Buffer.from(`${workDir}/invalid-`), Buffer.from([0xff])]), "pre-existing\n");
  }
  if (scenario.untrackedDirectory) {
    mkdirSync(join(workDir, "loose"));
    writeFileSync(join(workDir, "loose", "existing.txt"), "pre-existing\n");
  }
  if (scenario.artifactEndpointRename || scenario.preexistingArtifactRename) {
    writeFileSync(join(workDir, "source.txt"),
      scenario.preexistingArtifactRename ? `fake ${skill} completed` : "tracked source\n");
    runGit(workDir, ["add", "source.txt"]);
    runGit(workDir, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
    if (scenario.preexistingArtifactRename) runGit(workDir, ["mv", "source.txt", "final.txt"]);
  }
  if (scenario.indexOnly) {
    writeFileSync(join(workDir, "index-dirty.txt"), "base\n");
    runGit(workDir, ["add", "index-dirty.txt"]);
    runGit(workDir, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
    writeFileSync(join(workDir, "index-dirty.txt"), "old staged content\n");
    runGit(workDir, ["add", "index-dirty.txt"]);
    writeFileSync(join(workDir, "index-dirty.txt"), "worktree content\n");
  }
  const outDir = scenario.artifactsInside
    ? workDir
    : join(h.scratch, `out-${skill}-${scenario.name}`);
  const appendFile = scenario.dirty
    ? "already-dirty.txt"
    : scenario.caseDistinctUserWrite ? "FINAL.TXT" : null;
  const child = h.runRelay(skill, workDir, outDir, ["--read-only"], {
    SMOKE_MODE: skill === "grok"
      ? "grok-read-only"
      : skill === "commandcode"
        ? (appendFile ? "commandcode-read-only-append" : "commandcode-read-only-clean")
        : appendFile ? "claude-read-only-append" : "claude-read-only-clean",
    ...(appendFile ? { SMOKE_APPEND_FILE: appendFile } : {}),
    ...(scenario.untrackedDirectory ? { SMOKE_WRITE_FILE: join("loose", "new.txt") } : {}),
    ...(scenario.invalidUtf8 ? { SMOKE_APPEND_INVALID_UTF8: "696e76616c69642dff" } : {}),
    ...(scenario.rawSymlinkTarget ? {
      SMOKE_RETARGET_SYMLINK: "already-dirty-link",
      SMOKE_SYMLINK_TARGET_HEX: "fe",
    } : {}),
    ...(scenario.indexOnly ? { SMOKE_INDEX_ONLY_FILE: "index-dirty.txt" } : {}),
    ...(scenario.artifactEndpointRename ? {
      SMOKE_GIT_RENAME_FROM: "source.txt",
      SMOKE_GIT_RENAME_TO: "final.txt",
    } : {}),
  });
  const outcome = await waitFor(child);
  const expectedExit = skill === "commandcode" && scenario.commandcodeExit !== undefined
    ? scenario.commandcodeExit
    : 0;
  const expectedResult = skill === "commandcode" && scenario.commandcodeResult !== undefined
    ? scenario.commandcodeResult
    : true;
  h.check(`${skill} ${scenario.name}: relay close wait did not time out`, outcome.exited);
  h.check(`${skill} ${scenario.name}: relay exits ${expectedExit}`, outcome.exitCode === expectedExit);
  h.check(`${skill} ${scenario.name}: result.json ${expectedResult ? "exists" : "is not created"}`,
    existsSync(join(outDir, "result.json")) === expectedResult);
  if (existsSync(join(outDir, "result.json"))) {
    const verdict = h.result(outDir).readOnlyViolation;
    const expected = skill === "commandcode" && scenario.commandcodeExpected !== undefined
      ? scenario.commandcodeExpected
      : scenario.expected;
    h.check(`${skill} ${scenario.name}: verdict is ${String(expected)} (got ${String(verdict)})`,
      verdict === expected);
  }
  if (skill === "commandcode" && scenario.artifactSymlink) {
    h.check("commandcode artifact-symlink-target-write: final report does not overwrite the symlink target",
      readFileSync(join(workDir, "already-dirty.txt"), "utf8") === "pre-existing\n");
  }
  if (outcome.exitCode !== 0) console.error(`${skill} ${scenario.name} relay stderr:\n${outcome.stderr}`);
}

export async function runReadOnlyTripwire(h) {
  let invalidUtf8Filenames = !h.WIN;
  if (invalidUtf8Filenames) {
    const probeDir = join(h.scratch, "invalid-utf8-probe");
    mkdirSync(probeDir);
    try {
      writeFileSync(Buffer.concat([Buffer.from(`${probeDir}/probe-`), Buffer.from([0xff])]), "probe\n");
    } catch {
      invalidUtf8Filenames = false;
    }
  }
  if (!invalidUtf8Filenames) {
    console.log("  skip  invalid UTF-8 filename: host filesystem rejects arbitrary filename bytes");
  }
  const caseProbe = join(h.scratch, "case-sensitive-probe");
  writeFileSync(caseProbe, "lower\n");
  writeFileSync(join(h.scratch, "CASE-SENSITIVE-PROBE"), "upper\n");
  const caseSensitiveFilenames = readFileSync(caseProbe, "utf8") === "lower\n";
  const scenarios = [
    { name: "clean", expected: false },
    { name: "unknown", repo: false, expected: null },
    { name: "already-dirty", dirty: true, expected: true },
    ...(!h.WIN ? [{ name: "trailing-space-root", trailingSpaceRoot: true, dirty: true, expected: true }] : []),
    { name: "index-only-already-dirty", indexOnly: true, expected: true },
    { name: "proof-over-unknown", dirty: true, unknown: true, expected: true },
    ...(invalidUtf8Filenames ? [{ name: "invalid-utf8-filename", invalidUtf8: true, expected: null }] : []),
    { name: "new-file-in-untracked-directory", untrackedDirectory: true, expected: true },
    { name: "relay-artifacts", artifactsInside: true, expected: false },
    { name: "case-aliased-relay-artifact", artifactsInside: true, caseAliasedArtifact: true, expected: false, ...(!caseSensitiveFilenames ? { commandcodeExit: 1 } : {}) },
    { name: "case-renamed-relay-artifact", artifactsInside: true, caseRenamedArtifact: true, expected: false, ...(!caseSensitiveFilenames ? { commandcodeExit: 1 } : {}) },
    ...(caseSensitiveFilenames ? [{
      name: "case-distinct-user-write",
      artifactsInside: true,
      caseDistinctUserWrite: true,
      expected: true,
    }] : []),
    { name: "preexisting-artifact-rename", artifactsInside: true, preexistingArtifactRename: true, expected: false, commandcodeExit: 2, commandcodeResult: false },
    { name: "artifact-endpoint-rename", artifactsInside: true, artifactEndpointRename: true, expected: true, commandcodeExit: 1 },
    { name: "relay-artifacts-plus-write", artifactsInside: true, dirty: true, expected: true },
    ...(!h.WIN ? [{ name: "raw-symlink-target-write", rawSymlinkTarget: true, expected: true }] : []),
    ...(!h.WIN ? [{ name: "artifact-symlink-target-write", artifactsInside: true, artifactSymlink: true, expected: true, commandcodeExit: 2, commandcodeResult: false }] : []),
  ];
  const tripwireSkills = ["claude", "grok", ...(!h.WIN ? ["commandcode"] : [])];
  if (h.WIN) console.log("  skip  commandcode tripwire scenarios: Git-visible tripwire coverage is POSIX-only");
  for (const skill of tripwireSkills) {
    for (const scenario of scenarios) await runScenario(h, skill, scenario);
  }

  if (h.WIN) {
    console.log("  skip  grok abort/result artifacts: Windows delivers no catchable SIGTERM");
    console.log("  skip  grok spawn error: shell:true reports a shell exit, not a spawn error, on Windows");
    return;
  }
  {
    const workDir = h.freshRepo("work-grok-abort-artifacts");
    const pidFile = join(h.scratch, "pid-grok-abort-artifacts");
    const grandPidFile = join(h.scratch, "grandpid-grok-abort-artifacts");
    const child = h.runRelay("grok", workDir, workDir, ["--read-only"], {
      SMOKE_MODE: "abort",
      SMOKE_PID_FILE: pidFile,
      SMOKE_GRAND_PID_FILE: grandPidFile,
      SMOKE_LATE_FILE: join(h.scratch, "late-grok-abort-artifacts.txt"),
    });
    h.check("grok abort/result artifacts: fake implementer came up",
      await h.until(() => existsSync(pidFile), 10_000));
    const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
    child.kill("SIGTERM");
    const outcome = await waitFor(child);
    h.check("grok abort/result artifacts: relay exits after grace window", outcome.exited);
    h.check("grok abort/result artifacts: result.json exists", existsSync(join(workDir, "result.json")));
    if (existsSync(join(workDir, "result.json"))) {
      const result = h.result(workDir);
      h.check("grok abort/result artifacts: status is aborted", result.status === "aborted");
      h.check("grok abort/result artifacts: relay files do not prove a violation",
        result.readOnlyViolation === false);
    }
    h.check("grok abort/result artifacts: implementer subprocess is dead",
      grandPid !== null && await h.until(() => !h.alive(grandPid), 10_000));
  }
  const workDir = join(h.scratch, "work-grok-spawn-error");
  const outDir = join(h.scratch, "out-grok-spawn-error");
  mkdirSync(workDir);
  const shimDir = h.baseEnv.PATH.split(delimiter)[0];
  const removedShim = join(shimDir, "grok.removed");
  const grokShim = join(shimDir, "grok");
  writeFileSync(grokShim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(shimDir, "fake-cli.cjs"))} "$@"\n`);
  const child = spawn(process.execPath, [
    h.relayPath("grok"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, "--read-only",
  ], { env: { ...h.baseEnv, PATH: shimDir, SMOKE_MODE: "grok-spawn-error" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  let outcome;
  try {
    outcome = await waitFor(child);
  } finally {
    if (existsSync(removedShim)) renameSync(removedShim, grokShim);
  }
  h.check("grok spawn error: relay exits one", outcome.exitCode === 1);
  h.check("grok spawn error: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const result = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
    h.check("grok spawn error: unknown verdict is present", result.readOnlyViolation === null);
  }
  h.check("grok spawn error: summary warns about incomplete coverage", stdout.includes("incomplete"));
  h.check("grok spawn error: summary is printed once", stdout.split("relay: failed").length === 2);
}
