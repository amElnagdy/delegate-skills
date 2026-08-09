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
  const workDir = scenario.repo === false
    ? join(h.scratch, `work-${skill}-${scenario.name}`)
    : h.freshRepo(`work-${skill}-${scenario.name}`);
  if (scenario.repo === false) mkdirSync(workDir);
  if (scenario.unknown) addDirtySubmodule(workDir);
  if (scenario.dirty) writeFileSync(join(workDir, "already-dirty.txt"), "pre-existing\n");
  if (scenario.artifactSymlink) {
    writeFileSync(join(workDir, "already-dirty.txt"), "pre-existing\n");
    symlinkSync("already-dirty.txt", join(workDir, "final.txt"));
  }
  if (scenario.caseAliasedArtifact || scenario.caseDistinctUserWrite) {
    writeFileSync(join(workDir, "FINAL.TXT"), "tracked user file\n");
    runGit(workDir, ["add", "FINAL.TXT"]);
    runGit(workDir, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
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
      : appendFile ? "claude-read-only-append" : "claude-read-only-clean",
    ...(appendFile ? { SMOKE_APPEND_FILE: appendFile } : {}),
    ...(scenario.untrackedDirectory ? { SMOKE_WRITE_FILE: join("loose", "new.txt") } : {}),
    ...(scenario.invalidUtf8 ? { SMOKE_APPEND_INVALID_UTF8: "696e76616c69642dff" } : {}),
    ...(scenario.indexOnly ? { SMOKE_INDEX_ONLY_FILE: "index-dirty.txt" } : {}),
    ...(scenario.artifactEndpointRename ? {
      SMOKE_GIT_RENAME_FROM: "source.txt",
      SMOKE_GIT_RENAME_TO: "final.txt",
    } : {}),
  });
  const outcome = await waitFor(child);
  h.check(`${skill} ${scenario.name}: relay close wait did not time out`, outcome.exited);
  h.check(`${skill} ${scenario.name}: relay exits zero`, outcome.exitCode === 0);
  h.check(`${skill} ${scenario.name}: result.json exists`, existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const verdict = h.result(outDir).readOnlyViolation;
    h.check(`${skill} ${scenario.name}: verdict is ${String(scenario.expected)} (got ${String(verdict)})`,
      verdict === scenario.expected);
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
    { name: "index-only-already-dirty", indexOnly: true, expected: true },
    { name: "proof-over-unknown", dirty: true, unknown: true, expected: true },
    ...(invalidUtf8Filenames ? [{ name: "invalid-utf8-filename", invalidUtf8: true, expected: null }] : []),
    { name: "new-file-in-untracked-directory", untrackedDirectory: true, expected: true },
    { name: "relay-artifacts", artifactsInside: true, expected: false },
    { name: "case-aliased-relay-artifact", artifactsInside: true, caseAliasedArtifact: true, expected: false },
    ...(caseSensitiveFilenames ? [{
      name: "case-distinct-user-write",
      artifactsInside: true,
      caseDistinctUserWrite: true,
      expected: true,
    }] : []),
    { name: "preexisting-artifact-rename", artifactsInside: true, preexistingArtifactRename: true, expected: false },
    { name: "artifact-endpoint-rename", artifactsInside: true, artifactEndpointRename: true, expected: true },
    { name: "relay-artifacts-plus-write", artifactsInside: true, dirty: true, expected: true },
    ...(!h.WIN ? [{ name: "artifact-symlink-target-write", artifactsInside: true, artifactSymlink: true, expected: true }] : []),
  ];
  for (const skill of ["claude", "grok"]) {
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
  const child = spawn(process.execPath, [
    h.relayPath("grok"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, "--read-only",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "grok-spawn-error" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  const shimDir = h.baseEnv.PATH.split(delimiter)[0];
  const removedShim = join(shimDir, "grok.removed");
  const grokShim = join(shimDir, "grok");
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
