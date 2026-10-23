import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Every dispatch carries these, in this order: the brief arrives on stdin (--input -),
// stream-json is what makes the run machine-readable, and the permission policy is explicit.
const CONSTANT = ["exec", "--input", "-", "--output-format", "stream-json", "--permission"];

function dispatch(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-${name}-mcode`);
  const workDir = h.freshRepo(`work-${name}-mcode`);
  const argsFile = join(h.scratch, `args-${name}-mcode`);
  const run = spawnSync(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "mcode-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
  });
  const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : { args: [], brief: "" };
  return { run, outDir, workDir, captured };
}

export async function runMcode(h) {
if (h.WIN) {
  for (const [name, relayArgs] of [["windows-mcode-shim", []], ["windows-mcode-shim-read-only", ["--read-only"]]]) {
    const { run, captured } = dispatch(h, name, relayArgs);
    const worked = run.status === 0 && captured.brief.includes("smoke brief");
    if (!worked) {
      console.error(`mcode ${name} stdout:\n${run.stdout}`);
      console.error(`mcode ${name} stderr:\n${run.stderr}`);
    }
    h.check(`mcode ${name}: mcode.cmd receives the brief through stdin`, worked);
  }
  return;
}
{
  const workDir = h.freshRepo("work-reused-out-dir-mcode");
  const outDir = join(h.scratch, "out-reused-mcode");
  const resultPath = join(outDir, "result.json");
  const finalPath = join(outDir, "final.txt");
  mkdirSync(outDir);
  writeFileSync(resultPath, "{\"schema\":\"delegate-relay.result.v1\"}\n");
  writeFileSync(finalPath, "stale report\n");
  const child = spawn(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "5s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "mcode-version-hang" }, stdio: "ignore" });
  h.check("mcode reused out-dir: stale terminal artifacts disappear before completion",
    await h.until(() => !existsSync(resultPath) && !existsSync(finalPath), 4_000));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  h.check("mcode reused out-dir: current run publishes its own terminal result",
    exitCode === 124 && h.result(outDir).status === "timeout");
}
{
  const workDir = h.freshRepo("work-untrusted-out-dir-mcode");
  const outDir = join(h.scratch, "out-untrusted-mcode");
  mkdirSync(outDir);
  const finalPath = join(outDir, "final.txt");
  writeFileSync(finalPath, "user report\n");
  const rejected = spawnSync(process.execPath, [
    h.relayPath("mcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("mcode untrusted out-dir: existing artifacts are rejected untouched",
    rejected.status === 2 && readFileSync(finalPath, "utf8") === "user report\n");
}
{
  const workDir = h.freshRepo("work-result-symlink-mcode");
  const outDir = join(h.scratch, "out-result-symlink-mcode");
  const victimPath = join(h.scratch, "result-symlink-victim-mcode");
  mkdirSync(outDir);
  writeFileSync(victimPath, "protected\n");
  const resultPath = join(outDir, "result.json");
  symlinkSync(victimPath, resultPath);
  const rejected = spawnSync(process.execPath, [
    h.relayPath("mcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("mcode result symlink: rejects without replacing the link or target",
    rejected.status === 2 && lstatSync(resultPath).isSymbolicLink() && readFileSync(victimPath, "utf8") === "protected\n");
}
// The installer's bin directory is often off a non-login PATH, so an explicit path must
// reach both the preflight and the dispatch — from the flag and from MCODE_CLI.
{
  const missingPath = join(h.scratch, "missing-mcode-override");
  const mcodeShim = join(h.scratch, "shim", "mcode");
  // The shim itself needs node, dirname, and sh, but nothing that would resolve `mcode`.
  const pathless = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":") };
  const viaFlag = dispatch(h, "mcode-path-flag", ["--mcode-path", mcodeShim], pathless);
  h.check("mcode --mcode-path: preflight and dispatch use the named executable without PATH",
    viaFlag.run.status === 0 && viaFlag.captured.brief.includes("smoke brief"));
  const viaEnv = dispatch(h, "mcode-cli-env", [], { ...pathless, MCODE_CLI: `./${relative(process.cwd(), mcodeShim)}` });
  h.check("mcode relative MCODE_CLI: preflight and dispatch use the same executable",
    viaEnv.run.status === 0 && viaEnv.captured.brief.includes("smoke brief"));
  const flagWins = dispatch(h, "mcode-path-wins", ["--mcode-path", mcodeShim], { MCODE_CLI: missingPath });
  h.check("mcode --mcode-path: the flag wins over MCODE_CLI", flagWins.run.status === 0);
}
{
  const workDir = h.freshRepo("work-private-artifacts-mcode");
  const run = spawnSync(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--read-only",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "mcode-success" }, encoding: "utf8" });
  const resultPath = /^result: (.+)$/m.exec(run.stdout)?.[1];
  const runResult = resultPath && existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf8"))
    : null;
  const outDir = resultPath ? dirname(resultPath) : null;
  const artifactPaths = runResult
    ? [runResult.briefPath, runResult.eventsPath, runResult.finalPath, resultPath, join(outDir, "read-only-prompt.txt")]
    : [];
  h.check("mcode default artifacts: directory and files are private",
    run.status === 0 &&
    outDir !== null &&
    (statSync(outDir).mode & 0o777) === 0o700 &&
    artifactPaths.every((path) => path && (statSync(path).mode & 0o777) === 0o600));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}
for (const scenario of [
  { name: "default", relayArgs: [], forwarded: () => [...CONSTANT, "smart"], readOnly: false, permission: "smart" },
  { name: "full", relayArgs: ["--permission", "full"], forwarded: () => [...CONSTANT, "full"], readOnly: false, permission: "full" },
  {
    name: "read-only",
    relayArgs: ["--read-only"],
    forwarded: (out) => [...CONSTANT, "smart", "--append-system-prompt-file", join(out, "read-only-prompt.txt")],
    readOnly: true,
    permission: "smart",
  },
  { name: "session", relayArgs: ["--session", "mvs_prior-1"], forwarded: () => [...CONSTANT, "smart", "--session", "mvs_prior-1"], readOnly: false, permission: "smart" },
  {
    name: "dials",
    relayArgs: ["--model", "minimax/Fake-Model#thinking", "--effort", "high"],
    forwarded: () => [...CONSTANT, "smart", "--model", "minimax/Fake-Model#thinking", "--effort", "high"],
    readOnly: false,
    permission: "smart",
  },
]) {
  const { run, outDir, workDir, captured } = dispatch(h, scenario.name, scenario.relayArgs);
  h.check(`mcode ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`mcode ${scenario.name}: documented argv is exact`,
    JSON.stringify(captured.args) === JSON.stringify(scenario.forwarded(outDir)));
  h.check(`mcode ${scenario.name}: the brief arrives on stdin, never in argv, and the workspace is the cwd`,
    captured.brief.includes("smoke brief") &&
    !captured.args.some((arg) => arg.includes("smoke brief")) &&
    captured.cwd === realpathSync(workDir));
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`mcode ${scenario.name}: exec.completed is parsed into the result`,
    value.status === "completed" &&
    value.finalMessage === "fake mcode completed" &&
    value.sessionId === "mvs_fake-session" &&
    value.runId === "exec_turn_fake" &&
    value.execStatus === "succeeded" &&
    value.resolvedModel === "minimax/Fake-Model#thinking" &&
    value.usage?.outputTokens === 2 &&
    value.durationMs === 42 &&
    value.readOnly === scenario.readOnly &&
    value.permission === scenario.permission);
  h.check(`mcode ${scenario.name}: final.txt holds the report`,
    value.finalPath === join(outDir, "final.txt") &&
    readFileSync(join(outDir, "final.txt"), "utf8").trim() === "fake mcode completed");
}
{
  const { outDir } = dispatch(h, "read-only-prompt", ["--read-only"]);
  h.check("mcode read-only: the appended prompt forbids edits",
    /read-only/.test(readFileSync(join(outDir, "read-only-prompt.txt"), "utf8")));
}
// A step-limit stop is unfinished work: mcode's own non-zero exit is preserved, and the
// streamed agent message still reaches the report.
{
  const { run, outDir } = dispatch(h, "limit", [], { SMOKE_MODE: "mcode-limit" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("mcode limit: relay preserves mcode's exit 7", run.status === 7);
  h.check("mcode limit: result reports failed and names the status",
    value.status === "failed" &&
    value.execStatus === "limit_exceeded" &&
    value.error?.includes("limit_exceeded") &&
    value.finalMessage === "fake mcode streamed report");
}
// Exit 0 is not proof: without exec.completed nothing shows the task finished.
{
  const { run, outDir } = dispatch(h, "no-completion", [], { SMOKE_MODE: "mcode-no-completion" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("mcode no completion: relay exits 1 despite mcode exit 0", run.status === 1);
  h.check("mcode no completion: result reports failed and says why",
    value.status === "failed" &&
    value.execStatus === null &&
    value.error?.includes("exec.completed") &&
    value.sessionId === "mvs_fake-session");
}
// --read-only is only a prompt, so the relay proves it after the fact — both directions.
{
  const { outDir } = dispatch(h, "read-only-clean", ["--read-only"]);
  h.check("mcode read-only clean: no violation on an untouched tree",
    h.result(outDir).readOnlyViolation === false);
}
{
  const { outDir } = dispatch(h, "read-only-write", ["--read-only"], { SMOKE_WRITE_FILE: "sneaked.txt" });
  h.check("mcode read-only write: a tree change is reported as a violation",
    h.result(outDir).readOnlyViolation === true);
}
{
  const { outDir } = dispatch(h, "write-capable", []);
  h.check("mcode write-capable: the read-only question does not apply",
    h.result(outDir).readOnlyViolation === null);
}
// Usage errors: exit 2, a named cause, and no result.json — nothing was dispatched.
for (const [name, args, pattern] of [
  ["invalid effort", ["--effort", "very fast"], /invalid --effort/],
  ["invalid model", ["--model", "a b;c"], /--model contains unsupported characters/],
  ["permission off", ["--permission", "off"], /"off" is refused/],
  ["read-only with full", ["--read-only", "--permission", "full"], /cannot be combined/],
  ["invalid session", ["--session", "-x"], /--session must be a session id/],
  ["keep-env without clean-env", ["--keep-env", "PATH"], /--keep-env requires --clean-env/],
]) {
  const workDir = h.freshRepo(`work-${name.replace(/\s+/g, "-")}-mcode`);
  const outDir = join(h.scratch, `out-${name.replace(/\s+/g, "-")}-mcode`);
  const bad = spawnSync(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...args,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check(`mcode ${name}: exits 2 before dispatch`,
    bad.status === 2 && pattern.test(bad.stderr) && !existsSync(join(outDir, "result.json")));
}
for (const [mode, expectedStatus, expectedExit, timeout] of [
  ["mcode-version-hang", "timeout", 124, "1s"],
  ["mcode-version-fail", "failed", 7, "30s"],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", timeout,
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`mcode preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-abort-preflight-mcode");
  const outDir = join(h.scratch, "out-abort-preflight-mcode");
  const preflight = h.runRelay("mcode", workDir, outDir, [], {
    SMOKE_MODE: "mcode-version-hang",
  });
  h.check("mcode preflight abort: run artifacts are prepared",
    await h.until(() => existsSync(join(outDir, "events.jsonl")), 2000));
  preflight.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    preflight.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("mcode preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-mcode");
  const outDir = join(h.scratch, "out-unavailable-mcode");
  const missing = spawnSync(process.execPath, [
    h.relayPath("mcode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--read-only",
  ], {
    // Keep git available for the read-only verdict while naming a missing CLI directly.
    env: { ...h.baseEnv, MCODE_CLI: join(h.scratch, "missing-mcode") },
    encoding: "utf8",
  });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("mcode unavailable: structured result names the missing CLI",
    missing.status === 127 && value.status === "mcode_unavailable" && /--mcode-path/.test(missing.stderr));
  h.check("mcode unavailable: the read-only verdict is still truthful",
    value.readOnlyViolation === false);
}
}
