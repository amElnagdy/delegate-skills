import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runClaude(h) {
  let baselineProfile = null;
  const outDir = join(h.scratch, "out success claude");
  const workDir = h.freshRepo("work success claude");
  const captureFile = join(h.scratch, "capture-success-claude.json");
  const child = h.runRelay("claude", workDir, outDir, [], {
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    SMOKE_CAPTURE_FILE: captureFile,
    SMOKE_MODE: "claude-success",
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  h.check("claude success: relay exits zero", exitCode === 0);
  h.check("claude success: relay close wait did not time out", exited);
  h.check("claude success: result.json exists", existsSync(join(outDir, "result.json")));
  h.check("claude success: fake captured the launch", existsSync(captureFile));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check(`claude success: status is completed (got ${value.status})`, value.status === "completed");
    h.check("claude success: session id parsed", value.sessionId === "11111111-1111-4111-8111-111111111111");
    h.check("claude success: final message parsed", value.finalMessage === "fake claude completed");
    h.check("claude success: result subtype parsed", value.resultSubtype === "success");
    h.check("claude success: turns and cost parsed", value.numTurns === 3 && value.totalCostUsd === 0.0123);
    h.check("claude success: token usage parsed", value.usage?.input_tokens === 10 && value.usage?.output_tokens === 5);
    h.check("claude success: omitted autocompact stays absent from result",
      !Object.prototype.hasOwnProperty.call(value, "autocompact"));
  }
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    h.check("claude success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
    h.check("claude success: inherited CLAUDECODE removed", capture.claudeCode === null);
    h.check("claude success: child-session marker preserved", capture.childSession === "1");
    h.check("claude success: print stream-json launch selected",
      capture.args.includes("-p") &&
      h.pair(capture.args, "--output-format", "stream-json") &&
      capture.args.includes("--verbose"));
    h.check("claude success: normal permission profile selected",
      h.pair(capture.args, "--permission-mode", "acceptEdits"));
    h.check("claude success: forbidden modes omitted",
      !capture.args.includes("--bg") &&
      !capture.args.includes("--bare"));
    h.check("claude success: normal tool surface selected",
      h.pair(capture.args, "--tools", `Read,Glob,Grep,Edit,Write,${h.WIN ? "PowerShell" : "Bash"}`));
    h.check("claude success: all MCP tools disallowed",
      h.pair(capture.args, "--disallowedTools", "mcp__*"));
    h.check("claude success: generated profile selected",
      h.pair(capture.args, "--settings", join(outDir, "profile.json")));
    h.check("claude success: restriction flags selected",
      capture.args.includes("--strict-mcp-config") &&
      capture.args.includes("--disable-slash-commands"));

    const settingsPath = capture.args[capture.args.indexOf("--settings") + 1];
    h.check("claude success: generated profile exists", Boolean(settingsPath) && existsSync(settingsPath));
    if (settingsPath && existsSync(settingsPath)) {
      baselineProfile = readFileSync(settingsPath, "utf8");
      const profile = JSON.parse(readFileSync(settingsPath, "utf8"));
      const shell = h.WIN ? "PowerShell" : "Bash";
      const expectedDeny = [
        `${shell}(git commit *)`,
        `${shell}(git * commit *)`,
        `${shell}(git * commit)`,
        `${shell}(git push *)`,
        `${shell}(git * push *)`,
        `${shell}(git * push)`,
        `${shell}(claude *)`,
        `${shell}(*claude-delegate*)`,
      ];
      h.check("claude success: Claude.ai connectors disabled",
        profile.disableClaudeAiConnectors === true);
      h.check("claude success: deny rules match the write profile",
        JSON.stringify(profile.permissions?.deny) === JSON.stringify(expectedDeny));
      if (h.WIN) {
        h.check("claude success: native Windows profile omits the sandbox",
          !Object.prototype.hasOwnProperty.call(profile, "sandbox"));
        h.check("claude success: native Windows profile enables PowerShell",
          profile.env?.CLAUDE_CODE_USE_POWERSHELL_TOOL === "1");
      } else {
        h.check("claude success: POSIX sandbox is strict",
          profile.sandbox?.enabled === true &&
          profile.sandbox?.failIfUnavailable === true &&
          profile.sandbox?.autoAllowBashIfSandboxed === true &&
          profile.sandbox?.allowUnsandboxedCommands === false);
      }
    }
    h.check("claude success: omitted autocompact stays absent from argv",
      !capture.args.includes("--autocompact"));
  }
  if (exitCode !== 0) console.error(`claude success relay stderr:\n${stderr}`);

  for (const scenario of [
    { name: "new", value: "400k", relayArgs: [] },
    { name: "session", value: "auto", relayArgs: ["--session", "22222222-2222-4222-8222-222222222222"] },
    { name: "resume-last", value: "1m", relayArgs: ["--resume-last"] },
    { name: "integer", value: "400000", relayArgs: [] },
  ]) {
    const compactOut = join(h.scratch, `out autocompact ${scenario.name} claude`);
    const compactWork = h.freshRepo(`work autocompact ${scenario.name} claude`);
    const compactCapture = join(h.scratch, `capture-autocompact-${scenario.name}-claude.json`);
    const compactChild = h.runRelay("claude", compactWork, compactOut,
      [...scenario.relayArgs, "--autocompact", scenario.value], {
        SMOKE_CAPTURE_FILE: compactCapture,
        SMOKE_MODE: "claude-success",
      });
    let compactExit = null;
    const compactExited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 15_000);
      compactChild.on("close", (code) => {
        clearTimeout(timer);
        compactExit = code;
        resolveExit(true);
      });
    });
    h.check(`claude autocompact ${scenario.name}: relay close wait did not time out`, compactExited);
    h.check(`claude autocompact ${scenario.name}: relay exits zero`, compactExit === 0);
    h.check(`claude autocompact ${scenario.name}: fake captured the launch`, existsSync(compactCapture));
    if (existsSync(compactCapture)) {
      const capture = JSON.parse(readFileSync(compactCapture, "utf8"));
      h.check(`claude autocompact ${scenario.name}: requested value reaches argv`,
        h.pair(capture.args, "--autocompact", scenario.value));
      if (scenario.name === "session") {
        h.check("claude autocompact session: exact resume is preserved",
          h.pair(capture.args, "--resume", "22222222-2222-4222-8222-222222222222"));
      }
      if (scenario.name === "resume-last") {
        h.check("claude autocompact resume-last: continue is preserved",
          capture.args.includes("--continue"));
      }
    }
    if (existsSync(join(compactOut, "result.json"))) {
      h.check(`claude autocompact ${scenario.name}: requested value is durable run metadata`,
        h.result(compactOut).autocompact === scenario.value);
    }
    if (existsSync(join(compactOut, "profile.json")) && baselineProfile !== null) {
      h.check(`claude autocompact ${scenario.name}: provider settings profile is unchanged`,
        readFileSync(join(compactOut, "profile.json"), "utf8") === baselineProfile);
    }
  }

  for (const [index, invalid] of ["", "auto2", "abc", "400 k", "-400k", "400k;echo", "0"].entries()) {
    const invalidOut = join(h.scratch, `out invalid autocompact ${index} claude`);
    const invalidWork = h.freshRepo(`work invalid autocompact ${index} claude`);
    const invalidCapture = join(h.scratch, `capture-invalid-autocompact-${index}-claude.json`);
    const preflightPid = join(h.scratch, `preflight-invalid-autocompact-${index}-claude.pid`);
    const invalidRun = spawnSync(process.execPath, [
      h.relayPath("claude"), "--brief", h.briefPath, "--cd", invalidWork,
      "--out-dir", invalidOut, "--autocompact", invalid,
    ], {
      env: {
        ...h.baseEnv,
        SMOKE_CAPTURE_FILE: invalidCapture,
        SMOKE_PREFLIGHT_PID_FILE: preflightPid,
        SMOKE_MODE: "claude-success",
      },
      encoding: "utf8",
    });
    h.check(`claude invalid autocompact ${JSON.stringify(invalid)}: exits with usage error`, invalidRun.status === 2);
    h.check(`claude invalid autocompact ${JSON.stringify(invalid)}: provider preflight was not spawned`, !existsSync(preflightPid));
    h.check(`claude invalid autocompact ${JSON.stringify(invalid)}: dispatch was not spawned`, !existsSync(invalidCapture));
  }

  {
    const missingWork = h.freshRepo("work missing autocompact value claude");
    const preflightPid = join(h.scratch, "preflight-missing-autocompact-value-claude.pid");
    const missingRun = spawnSync(process.execPath, [
      h.relayPath("claude"), "--brief", h.briefPath, "--cd", missingWork, "--autocompact",
    ], {
      env: { ...h.baseEnv, SMOKE_PREFLIGHT_PID_FILE: preflightPid, SMOKE_MODE: "claude-success" },
      encoding: "utf8",
    });
    h.check("claude missing autocompact value: exits with usage error", missingRun.status === 2);
    h.check("claude missing autocompact value: provider preflight was not spawned", !existsSync(preflightPid));
  }

for (const scenario of [
  { name: "violation", mode: "claude-read-only-write", expectedViolation: true },
  { name: "clean", mode: "claude-read-only-clean", expectedViolation: false },
  { name: "already-dirty", mode: "claude-read-only-append", expectedViolation: true, dirtyFirst: true },
]) {
  const outDir = join(h.scratch, `out read-only ${scenario.name} claude`);
  const workDir = h.freshRepo(`work read-only ${scenario.name} claude`);
  if (scenario.dirtyFirst) writeFileSync(join(workDir, "already-dirty.txt"), "pre-existing\n");
  const captureFile = join(h.scratch, `capture-read-only-${scenario.name}-claude.json`);
  const child = h.runRelay("claude", workDir, outDir, ["--read-only"], {
    SMOKE_CAPTURE_FILE: captureFile,
    SMOKE_MODE: scenario.mode,
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  h.check(`claude read-only ${scenario.name}: relay close wait did not time out`, exited);
  h.check(`claude read-only ${scenario.name}: relay exits zero`, exitCode === 0);
  h.check(`claude read-only ${scenario.name}: result.json exists`, existsSync(join(outDir, "result.json")));
  h.check(`claude read-only ${scenario.name}: fake captured the launch`, existsSync(captureFile));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check(`claude read-only ${scenario.name}: violation result is ${scenario.expectedViolation}`,
      value.readOnlyViolation === scenario.expectedViolation);
    h.check(`claude read-only ${scenario.name}: tool surface is read-only`,
      JSON.stringify(value.toolSurface) === JSON.stringify(["Read", "Glob", "Grep"]));
    h.check(`claude read-only ${scenario.name}: permission mode is plan`,
      value.permissionMode === "plan");
  }
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    const tools = capture.args[capture.args.indexOf("--tools") + 1] ?? "";
    h.check(`claude read-only ${scenario.name}: plan mode selected`,
      h.pair(capture.args, "--permission-mode", "plan"));
    h.check(`claude read-only ${scenario.name}: read-only tools selected`,
      h.pair(capture.args, "--tools", "Read,Glob,Grep"));
    h.check(`claude read-only ${scenario.name}: write and shell tools omitted`,
      !["Edit", "Write", "Bash", "PowerShell"].some((tool) => tools.split(",").includes(tool)));
  }
  if (exitCode !== 0) console.error(`claude read-only ${scenario.name} relay stderr:\n${stderr}`);
}

{
  const outDir = join(h.scratch, "out chunked claude");
  const workDir = h.freshRepo("work chunked claude");
  const child = h.runRelay("claude", workDir, outDir, [], { SMOKE_MODE: "claude-chunked" });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let exitCode = null;
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      resolveExit(true);
    });
  });
  h.check("claude chunked: relay close wait did not time out", exited);
  h.check("claude chunked: relay exits zero", exitCode === 0);
  h.check("claude chunked: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    h.check("claude chunked: multi-byte final message round-trips",
      h.result(outDir).finalMessage === "café — done ✅");
  }
  if (exitCode !== 0) console.error(`claude chunked relay stderr:\n${stderr}`);
}
}
