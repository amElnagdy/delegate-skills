import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runClaude(h) {
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
  }
  if (exitCode !== 0) console.error(`claude success relay stderr:\n${stderr}`);

for (const scenario of [
  { name: "violation", mode: "claude-read-only-write", expectedViolation: true },
  { name: "clean", mode: "claude-read-only-clean", expectedViolation: false },
]) {
  const outDir = join(h.scratch, `out read-only ${scenario.name} claude`);
  const workDir = h.freshRepo(`work read-only ${scenario.name} claude`);
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
