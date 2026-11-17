import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every dispatch carries these, in this order: stream-json is what makes the run
// machine-readable, and --workspace makes a resumed session refuse another folder.
const constant = (workDir) => ["run", "--output-format", "stream-json", "--workspace", workDir];

function dispatch(h, name, relayArgs, env = {}) {
  const outDir = join(h.scratch, `out-${name}-codeneter`);
  const workDir = h.freshRepo(`work-${name}-codeneter`);
  const argsFile = join(h.scratch, `args-${name}-codeneter`);
  const run = spawnSync(process.execPath, [
    h.relayPath("codeneter"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "codeneter-success", SMOKE_ARGS_FILE: argsFile, ...env },
    encoding: "utf8",
  });
  const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : { args: [], brief: "" };
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  return { run, outDir, workDir, captured, value };
}

// A HOME whose ~/.codeneter/config.json says what the scenario needs.
function homeWith(h, name, contents) {
  const home = join(h.scratch, `home-${name}-codeneter`);
  mkdirSync(join(home, ".codeneter"), { recursive: true });
  if (contents !== null) writeFileSync(join(home, ".codeneter", "config.json"), contents);
  return home;
}

export async function runCodeneter(h) {
if (h.WIN) {
  const { run, captured } = dispatch(h, "windows-codeneter-shim", []);
  const worked = run.status === 0 && captured.brief.includes("smoke brief");
  if (!worked) {
    console.error(`codeneter windows shim stdout:\n${run.stdout}`);
    console.error(`codeneter windows shim stderr:\n${run.stderr}`);
  }
  h.check("codeneter windows: codeneter.cmd receives the brief through stdin", worked);
  return;
}
// The host's own config must not decide these scenarios: pin a HOME with no config.
const cleanHome = homeWith(h, "clean", null);
for (const scenario of [
  { name: "default", relayArgs: [], extra: [] },
  { name: "auto", relayArgs: ["--auto"], extra: ["--auto"] },
  { name: "session", relayArgs: ["--session", "session-1789999999999-prior1"], extra: ["--resume", "session-1789999999999-prior1"] },
  { name: "model", relayArgs: ["--model", "anthropic/fake-model"], extra: ["--model", "anthropic/fake-model"] },
  { name: "effort", relayArgs: ["--model", "anthropic/fake-model", "--effort", "high"], extra: ["--model", "anthropic/fake-model?effort=high"] },
  { name: "mode", relayArgs: ["--mode", "plan"], extra: ["--mode", "plan"] },
]) {
  const { run, workDir, outDir, captured, value } = dispatch(h, scenario.name, scenario.relayArgs, { HOME: cleanHome });
  h.check(`codeneter ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`codeneter ${scenario.name}: documented argv is exact`,
    JSON.stringify(captured.args) === JSON.stringify([...constant(workDir), ...scenario.extra]));
  h.check(`codeneter ${scenario.name}: the brief arrives on stdin, never in argv, and the workspace is the cwd`,
    captured.brief.includes("smoke brief") &&
    !captured.args.some((arg) => arg.includes("smoke brief")) &&
    captured.cwd === realpathSync(workDir));
  h.check(`codeneter ${scenario.name}: init and result events are parsed into the result`,
    value.status === "completed" &&
    value.exitCode === 0 &&
    value.finalMessage === "fake codeneter completed" &&
    value.sessionId === "session-1790000000000-fake01" &&
    value.resolvedModel === "anthropic/fake-model" &&
    value.resolvedMode === "agent" &&
    value.auto === scenario.relayArgs.includes("--auto") &&
    value.resumed === scenario.relayArgs.includes("--session") &&
    JSON.stringify(value.tools) === JSON.stringify({ started: 2, failed: 1, refused: 1 }) &&
    Array.isArray(value.touchedFiles) && value.touchedFiles.length === 0);
  h.check(`codeneter ${scenario.name}: final.txt holds the report`,
    value.finalPath === join(outDir, "final.txt") &&
    readFileSync(join(outDir, "final.txt"), "utf8").trim() === "fake codeneter completed");
}
{
  const { run } = dispatch(h, "refused-note", [], { HOME: cleanHome });
  h.check("codeneter refused: the summary says approvals were refused",
    /1 action was refused because approvals are off/.test(run.stdout));
}
{
  const { value } = dispatch(h, "touched", [], { HOME: cleanHome, SMOKE_WRITE_FILE: "edited.txt" });
  h.check("codeneter touched: a file the CLI wrote is in touchedFiles",
    Array.isArray(value.touchedFiles) && value.touchedFiles.includes("?? edited.txt"));
}
// A sign-in failure is the CLI's own result event, carried through with its kind.
{
  const { run, value } = dispatch(h, "sign-in", [], { HOME: cleanHome, SMOKE_MODE: "codeneter-sign-in" });
  h.check("codeneter sign-in: relay preserves the CLI's exit 1", run.status === 1);
  h.check("codeneter sign-in: result reports failed with errorKind and a login hint",
    value.status === "failed" &&
    value.errorKind === "sign_in_required" &&
    value.error?.includes("Not authenticated") &&
    /codeneter login/.test(run.stdout));
}
// A usage limit is unfinished work, and the streamed message still reaches the report.
{
  const { run, value } = dispatch(h, "limit", [], { HOME: cleanHome, SMOKE_MODE: "codeneter-limit" });
  h.check("codeneter limit: relay exits 1", run.status === 1);
  h.check("codeneter limit: result reports failed and names the limit",
    value.status === "failed" &&
    value.limit?.title === "Usage limit reached" &&
    value.error?.includes("usage limit") &&
    value.finalMessage === "fake codeneter streamed report");
}
// Exit 0 is not proof: without a result event nothing shows the task finished.
{
  const { run, value } = dispatch(h, "no-result", [], { HOME: cleanHome, SMOKE_MODE: "codeneter-no-result" });
  h.check("codeneter no result: relay exits 1 despite the CLI's exit 0", run.status === 1);
  h.check("codeneter no result: result reports failed and says why",
    value.status === "failed" &&
    value.error?.includes("without a result event") &&
    value.sessionId === "session-1790000000000-fake01");
}
// autoApprove in the CLI's config would approve everything with no flag: refuse it
// unless the orchestrator passed --auto, and never guess at a config it cannot read.
for (const [name, contents, relayArgs, expectedExit, pattern] of [
  ["auto-approve-on", "{\"autoApprove\":true}", [], 2, /autoApprove on/],
  ["config-invalid", "not json", [], 2, /not a JSON object/],
  ["config-array", "[]", [], 2, /not a JSON object/],
  ["auto-approve-accepted", "{\"autoApprove\":true}", ["--auto"], 0, null],
  ["auto-approve-off", "{\"autoApprove\":false}", [], 0, null],
]) {
  const home = homeWith(h, name, contents);
  const { run, outDir, captured, value } = dispatch(h, name, relayArgs, { HOME: home });
  if (expectedExit === 2) {
    h.check(`codeneter ${name}: refused before dispatch`,
      run.status === 2 && pattern.test(run.stderr) && captured.args.length === 0 && !existsSync(outDir));
  } else {
    h.check(`codeneter ${name}: dispatched`, run.status === 0 && value.status === "completed");
  }
}
{
  const { value } = dispatch(h, "auto-approve-recorded", ["--auto"], { HOME: homeWith(h, "auto-approve-recorded", "{\"autoApprove\":true}") });
  h.check("codeneter autoApprove: the config value is recorded", value.configAutoApprove === true && value.auto === true);
}
// Usage errors: exit 2, a named cause, and no result.json — nothing was dispatched.
{
  const slashBrief = join(h.scratch, "slash-brief-codeneter.txt");
  writeFileSync(slashBrief, "/review everything\n");
  for (const [name, args, pattern] of [
    ["invalid mode", ["--mode", "yolo"], /invalid --mode/],
    ["effort without model", ["--effort", "high"], /--effort requires --model/],
    ["invalid model", ["--model", "a b;c"], /--model must be a Model ID/],
    ["model with effort query", ["--model", "anthropic/fake-model?effort=high"], /pass effort with --effort/],
    ["invalid session", ["--session", "-x"], /--session must be a session id/],
    ["slash brief", ["--brief", slashBrief], /starts with "\/"/],
    ["missing workspace", ["--cd", join(h.scratch, "no-such-dir-codeneter")], /is not a directory/],
  ]) {
    const slug = name.replace(/\s+/g, "-");
    const workDir = h.freshRepo(`work-${slug}-codeneter`);
    const outDir = join(h.scratch, `out-${slug}-codeneter`);
    const bad = spawnSync(process.execPath, [
      h.relayPath("codeneter"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...args,
    ], { env: { ...h.baseEnv, HOME: cleanHome }, encoding: "utf8" });
    h.check(`codeneter ${name}: exits 2 before dispatch`,
      bad.status === 2 && pattern.test(bad.stderr) && !existsSync(join(outDir, "result.json")));
  }
}
// Session, model, and effort values reach cmd.exe on Windows (shell:true for the
// codeneter.cmd shim). Reject unsafe tokens before even the version probe.
for (const [flag, prefix, pattern, before] of [
  ["--session", "session-1", /--session must be a session id/, []],
  ["--model", "anthropic/fake-model", /--model must be a Model ID/, []],
  ["--effort", "high", /invalid --effort/, ["--model", "anthropic/fake-model"]],
]) {
  for (const [name, value] of [
    ["empty", ""],
    ["option-like", "--help"],
    ["space", `${prefix} extra`],
    ["ampersand", `${prefix}&echo smoke`],
    ["pipe", `${prefix}|echo smoke`],
    ["output redirection", `${prefix}>smoke`],
    ["input redirection", `${prefix}<smoke`],
    ["caret", `${prefix}^smoke`],
    ["double quote", `${prefix}"smoke`],
    ["single quote", `${prefix}'smoke`],
    ["percent expansion", `${prefix}%SMOKE_MODE%`],
    ["delayed expansion", `${prefix}!SMOKE_MODE!`],
    ["parentheses", `${prefix}(smoke)`],
    ["newline", `${prefix}\nsmoke`],
    ["carriage return", `${prefix}\rsmoke`],
    ["tab", `${prefix}\tsmoke`],
  ]) {
    const slug = `${flag.slice(2)}-${name.replaceAll(" ", "-")}`;
    const workDir = h.freshRepo(`work-invalid-${slug}-codeneter`);
    const outDir = join(h.scratch, `out-invalid-${slug}-codeneter`);
    const argsFile = join(h.scratch, `args-invalid-${slug}-codeneter`);
    const probeFile = join(h.scratch, `probe-invalid-${slug}-codeneter`);
    const bad = spawnSync(process.execPath, [
      h.relayPath("codeneter"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...before,
      flag, value,
    ], {
      env: { ...h.baseEnv, HOME: cleanHome, SMOKE_MODE: "codeneter-success", SMOKE_ARGS_FILE: argsFile, SMOKE_PREFLIGHT_PID_FILE: probeFile },
      encoding: "utf8",
    });
    h.check(`codeneter ${flag} (${name}): usage error names the flag`,
      bad.status === 2 && pattern.test(bad.stderr));
    h.check(`codeneter ${flag} (${name}): no preflight, dispatch, or artifacts`,
      !existsSync(probeFile) && !existsSync(argsFile) && !existsSync(outDir));
  }
}
{
  const workDir = h.freshRepo("work-abort-preflight-codeneter");
  const outDir = join(h.scratch, "out-abort-preflight-codeneter");
  const preflight = h.runRelay("codeneter", workDir, outDir, [], {
    HOME: cleanHome,
    SMOKE_MODE: "codeneter-version-hang",
  });
  h.check("codeneter preflight abort: run artifacts are prepared",
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
  h.check("codeneter preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
}
