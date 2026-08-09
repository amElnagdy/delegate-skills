import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  const outDir = scenario.artifactsInside
    ? workDir
    : join(h.scratch, `out-${skill}-${scenario.name}`);
  const child = h.runRelay(skill, workDir, outDir, ["--read-only"], {
    SMOKE_MODE: skill === "grok"
      ? "grok-read-only"
      : scenario.dirty ? "claude-read-only-append" : "claude-read-only-clean",
    ...(skill === "grok" && scenario.dirty ? { SMOKE_APPEND_FILE: "already-dirty.txt" } : {}),
    ...(skill === "grok" && scenario.artifactsInside ? { SMOKE_EMPTY_FINAL: "1" } : {}),
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
  const scenarios = [
    { name: "clean", expected: false },
    { name: "unknown", repo: false, expected: null },
    { name: "already-dirty", dirty: true, expected: true },
    { name: "proof-over-unknown", dirty: true, unknown: true, expected: true },
    { name: "relay-artifacts", artifactsInside: true, expected: false },
    { name: "relay-artifacts-plus-write", artifactsInside: true, dirty: true, expected: true },
  ];
  for (const skill of ["claude", "grok"]) {
    for (const scenario of scenarios) await runScenario(h, skill, scenario);
  }

  if (h.WIN) {
    console.log("  skip  grok spawn error: shell:true reports a shell exit, not a spawn error, on Windows");
    return;
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
}
