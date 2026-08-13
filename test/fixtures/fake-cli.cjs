const fs = require("node:fs");
const args = process.argv.slice(2);
const capturedEnv = () => Object.fromEntries(
  ["PATH", "HOME", "SMOKE_PROVIDER_TOKEN", "SMOKE_SECRET_TOKEN"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
// Environment-isolation tests cannot pass their control variables through the
// environment. Load their fixture beside the fake before handling --version so
// the preflight and dispatch can be captured independently.
if (!process.env.SMOKE_MODE) {
  try {
    Object.assign(process.env, JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "smoke-fallback.json"), "utf8")));
  } catch { /* no environment-isolation fixture */ }
}
// Every probe form one relay or another uses: --version, grok's \`version\` subcommand, and
// agy's \`changelog\`. Treating them alike lets any relay's hang/fail mode be driven by name.
const versionProbe = args.includes("--version") || args[0] === "version" || args[0] === "changelog";
if (versionProbe && process.env.SMOKE_PREFLIGHT_ENV_FILE) {
  fs.writeFileSync(process.env.SMOKE_PREFLIGHT_ENV_FILE, JSON.stringify(capturedEnv()));
}
if (versionProbe && process.env.SMOKE_MODE === "grok-spawn-error" && process.platform !== "win32") {
  fs.renameSync(require("node:path").join(__dirname, "grok"), require("node:path").join(__dirname, "grok.removed"));
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
} else if (versionProbe && process.env.SMOKE_MODE === "grok-version-fallback-budget") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  if (args[0] === "version") {
    console.error("fake documented version failure");
    process.exit(7);
  }
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
} else if (versionProbe && /-version-hang$/.test(process.env.SMOKE_MODE || "")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (versionProbe && /-version-fail-silent$/.test(process.env.SMOKE_MODE || "")) {
  process.exit(7);
} else if (versionProbe && /-version-fail$/.test(process.env.SMOKE_MODE || "")) {
  console.error("fake version failure");
  process.exit(7);
} else if (versionProbe) {
  console.log("fake-cli 0.0.0-smoke");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "capture") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  if (process.env.SMOKE_ENV_FILE) fs.writeFileSync(process.env.SMOKE_ENV_FILE, JSON.stringify(capturedEnv()));
  process.exit(0);
}
if (process.env.SMOKE_WRITE_FILE) {
  fs.writeFileSync(process.env.SMOKE_WRITE_FILE, "written by fake cli\n");
}
if (process.env.SMOKE_APPEND_INVALID_UTF8) {
  fs.appendFileSync(Buffer.from(process.env.SMOKE_APPEND_INVALID_UTF8, "hex"), "appended by fake cli\n");
}
if (process.env.SMOKE_RETARGET_SYMLINK && process.env.SMOKE_SYMLINK_TARGET_HEX) {
  fs.unlinkSync(process.env.SMOKE_RETARGET_SYMLINK);
  fs.symlinkSync(Buffer.from(process.env.SMOKE_SYMLINK_TARGET_HEX, "hex"), process.env.SMOKE_RETARGET_SYMLINK);
}
if (process.env.SMOKE_INDEX_ONLY_FILE) {
  const { execFileSync } = require("node:child_process");
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    input: "new staged content\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["update-index", "--cacheinfo", `100644,${oid},${process.env.SMOKE_INDEX_ONLY_FILE}`]);
}
if (process.env.SMOKE_GIT_RENAME_FROM && process.env.SMOKE_GIT_RENAME_TO) {
  require("node:child_process").execFileSync("git", [
    "mv", "-f", process.env.SMOKE_GIT_RENAME_FROM, process.env.SMOKE_GIT_RENAME_TO,
  ]);
}
if (process.env.SMOKE_MODE === "agy-usage-preflight") {
  // agy's headless quota query and the dispatch that follows it are two invocations of the
  // same binary inside one relay run, so one mode serves both. SMOKE_USAGE_MODE drives the
  // query; anything else is the dispatch, which must NOT happen when the query says the
  // account is exhausted — SMOKE_ARGS_FILE existing is the proof that it did.
  if (args.includes("/usage")) {
    const usageMode = process.env.SMOKE_USAGE_MODE || "healthy";
    if (usageMode === "hang") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (usageMode === "fail") {
      console.error("Error: fake usage query failure");
      process.exit(2);
    }
    if (usageMode === "unparseable") {
      console.log(JSON.stringify({ conversation_id: "", status: "SUCCESS", num_turns: 0, command: { name: "model", data: {} } }));
      process.exit(0);
    }
    const spent = usageMode === "exhausted";
    const bucket = (id, name, window, remaining, reset) =>
      ({ id, name, window, remaining_fraction: remaining, reset_time: reset });
    console.log(JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      response: "",
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      command: {
        name: "usage",
        data: {
          groups: [
            { name: "Gemini Models", buckets: [
              bucket("gemini-weekly", "Weekly Limit Remaining", "weekly", spent ? 0 : 0.9833731055259705, "2026-08-18T20:59:10Z"),
              bucket("gemini-5h", "5 Hour Limit Remaining", "5h", spent ? 0 : 1, "2026-08-13T22:04:33Z"),
            ] },
            // The healthy case deliberately leaves this one at zero: a single exhausted
            // bucket must NOT block a dispatch, only every bucket at once may.
            { name: "Claude and GPT models", buckets: [
              bucket("3p-weekly", "Weekly Limit Remaining", "weekly", spent ? 0 : 0.5, "2026-08-17T09:30:00Z"),
              bucket("3p-5h", "5 Hour Limit Remaining", "5h", 0, "2026-08-13T21:15:00Z"),
            ] },
          ],
        },
      },
    }));
    process.exit(0);
  }
  if (process.env.SMOKE_ARGS_FILE) fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  const logAt = args.indexOf("--log-file");
  if (logAt !== -1) fs.writeFileSync(args[logAt + 1], "fake agy log\n");
  console.log("fake agy dispatch completed");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "usage-limit") {
  // Replay a usage-limit capture bundle (test/fixtures/usage-limit/<cli>.json) transport
  // faithfully: the real event ordering, the real exit code, and — when asked — chunk
  // boundaries that split a line mid-signature and a final record with no trailing
  // newline. One mode serves every relay; the bundle and scenario say which CLI and case.
  const bundle = JSON.parse(fs.readFileSync(process.env.SMOKE_LIMIT_FIXTURE, "utf8"));
  const scenario = bundle.scenarios[process.env.SMOKE_LIMIT_SCENARIO];
  if (!scenario) {
    fs.writeSync(2, `fake-cli: unknown usage-limit scenario ${process.env.SMOKE_LIMIT_SCENARIO}\n`);
    process.exit(99);
  }
  const fd = process.env.SMOKE_LIMIT_STREAM === "stderr" ? 2 : 1;
  const lines = scenario.events;
  let payload = lines.join("\n");
  // Default to a trailing newline; the no-newline variant proves the relay still scans a
  // terminal event that arrives unterminated.
  if (process.env.SMOKE_LIMIT_NO_TRAILING_NEWLINE !== "1") payload += "\n";
  if (process.env.SMOKE_LIMIT_SPLIT === "1") {
    // Deliberately awkward chunk size: lands mid-token, mid-JSON-escape, and mid-multibyte.
    const buf = Buffer.from(payload, "utf8");
    for (let i = 0; i < buf.length; i += 7) fs.writeSync(fd, buf.subarray(i, i + 7));
  } else {
    fs.writeSync(fd, payload);
  }
  if (process.env.SMOKE_LIMIT_HANG === "1") {
    // Emit the limit signature, then never exit: lets the matrix drive the precedence
    // cases where the relay itself ends the run (watchdog timeout, orchestrator kill),
    // which must outrank any classification.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  process.exit(scenario.exitCode);
}
if (process.env.SMOKE_MODE === "aider-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  // Mentions OPENAI_API_KEY in prose so a bare-substring matcher would false-fail.
  console.log("Applied the edit and updated docs to explain OPENAI_API_KEY setup.");
  console.log("If OPENAI_API_KEY is not set, the tool exits.");
  console.log("Unable to connect without following the documented placeholder key steps.");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "aider-auth-fail") {
  console.log("litellm.AuthenticationError: Authentication Error, Invalid API key");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "aider-exit-nonzero") {
  console.error("fake aider nonzero exit");
  process.exit(7);
}
if (process.env.SMOKE_MODE === "agy-permission-denied") {
  console.error('jetski: no output produced — a tool required the "write_file" permission that headless\nmode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow\nin settings.json (e.g. write_file(<target>)). Alternatively, re-run with\n--dangerously-skip-permissions to auto-approve all tools.');
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-analysis") {
  if (process.env.SMOKE_ARGS_FILE) fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  const logAt = args.indexOf("--log-file");
  if (logAt !== -1) fs.writeFileSync(args[logAt + 1], "fake agy log\n");
  console.log("fake agy analysis completed");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-silent-edit") {
  fs.appendFileSync(process.env.SMOKE_EDIT_FILE, "dispatch edit\n");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-silent-noop") process.exit(0);
if (process.env.SMOKE_MODE === "qoder-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "qoder-session-1",
    model: "performance",
    permissionMode: "auto",
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    session_id: "qoder-session-1",
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "qoder-session-1",
    result: "fake qoder completed",
    usage: { input_tokens: 7, output_tokens: 2 },
  }));
  process.exit(0);
}
if (process.env.SMOKE_MODE === "vibe-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({ role: "assistant", content: "working" }));
  fs.writeSync(1, JSON.stringify({ role: "assistant", content: "fake vibe completed" }));
  process.exit(0);
}
if (process.env.SMOKE_MODE === "grok-read-only") {
  if (process.env.SMOKE_APPEND_FILE) {
    fs.appendFileSync(process.env.SMOKE_APPEND_FILE, "appended by fake grok\n");
  }
  console.log(JSON.stringify({ type: "text", data: "fake grok completed" }));
  console.log(JSON.stringify({ type: "end", sessionId: "grok-session-1" }));
  process.exit(0);
}
if (["pi-success", "pi-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "pi-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    console.log(JSON.stringify({ type: "session", version: 3, id: "pi-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: failed ? "fake pi failed" : "fake pi completed" }],
        provider: "google",
        model: "fake-model",
        usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } },
        stopReason: failed ? "error" : "stop",
        ...(failed ? { errorMessage: "fake provider failure" } : {}),
      },
    }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    process.exit(0);
  });
} else if (["cline-success", "cline-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "cline-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief, cwd: process.cwd() }));
    console.log(JSON.stringify({
      type: "run_start",
      modelId: "fake-model",
      providerId: "fake",
      cwd: process.cwd(),
    }));
    console.log(JSON.stringify({ type: "agent_event", agentType: "task", subagent: false, message: { type: "text", text: "working" } }));
    console.log(JSON.stringify({
      type: "run_result",
      finishReason: failed ? "error" : "completed",
      text: failed ? "fake cline failed" : "fake cline completed",
      usage: { inputTokens: 7, outputTokens: 2 },
      model: { id: "fake-model", provider: "fake" },
      durationMs: 42,
    }));
    process.exit(failed ? 1 : 0);
  });
} else if (["cursor-success", "claude-success", "claude-read-only-write", "claude-read-only-clean", "claude-read-only-append", "claude-chunked"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", async () => {
    const mode = process.env.SMOKE_MODE;
    if (mode === "cursor-success") {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({ args, brief }));
      console.log(JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-1",
        model: "claude-opus-4-8[context=1m,effort=high,fast=false]",
        permissionMode: args.includes("plan") ? "plan" : "default",
      }));
      console.log(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "cursor-session-1",
        result: "fake cursor completed",
        usage: { input_tokens: 11, output_tokens: 4 },
      }));
      return;
    }
    if (mode === "claude-read-only-write") {
      fs.writeFileSync("read-only-violation.txt", "written by fake claude\n");
    }
    if (mode === "claude-read-only-append") {
      fs.appendFileSync(process.env.SMOKE_APPEND_FILE ?? "already-dirty.txt", "appended by fake claude\n");
    }
    if (process.env.SMOKE_CAPTURE_FILE) {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({
        args,
        brief,
        claudeCode: process.env.CLAUDECODE ?? null,
        childSession: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
      }));
    }
    const permissionMode = mode.startsWith("claude-read-only") ? "plan" : "acceptEdits";
    console.log(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
      permissionMode,
    }));
    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "11111111-1111-4111-8111-111111111111",
      result: mode === "claude-chunked" ? "café — done ✅" : "fake claude completed",
      num_turns: 3,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (mode === "claude-chunked") {
      const output = Buffer.from(JSON.stringify(resultEvent));
      for (let i = 0; i < output.length; i += 1) {
        process.stdout.write(output.subarray(i, i + 1));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write("\n");
    } else {
      console.log(JSON.stringify(resultEvent));
    }
  });
} else {
  process.stdin.resume();
  const grandProgram = process.env.SMOKE_GRAND_IGNORES_SIGTERM
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  const grand = require("node:child_process").spawn(process.execPath, ["-e", grandProgram], { stdio: "ignore" });
  fs.writeFileSync(process.env.SMOKE_GRAND_PID_FILE, String(grand.pid));
  fs.writeFileSync(process.env.SMOKE_PID_FILE, String(process.pid)); // written last: its existence means both pid files are readable
  if (process.env.SMOKE_MODE === "abort") {
    process.on("SIGTERM", () => { fs.writeFileSync(process.env.SMOKE_LATE_FILE, "flushed during shutdown"); process.exit(0); });
  } else if (process.env.SMOKE_MODE === "timeout-yield") {
    process.on("SIGTERM", () => process.exit(0)); // the parent complies while the grandchild ignores
  } else {
    process.on("SIGTERM", () => {}); // ignore, so the relay's SIGKILL escalation is what ends it
  }
  setInterval(() => {}, 1000);
}
