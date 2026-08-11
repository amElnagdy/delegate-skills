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
if (process.env.SMOKE_MODE === "agy-permission-denied") {
  console.error('jetski: no output produced — a tool required the "write_file" permission that headless\nmode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow\nin settings.json (e.g. write_file(<target>)). Alternatively, re-run with\n--dangerously-skip-permissions to auto-approve all tools.');
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-analysis") {
  console.log("fake agy analysis completed");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-silent-edit") {
  fs.appendFileSync(process.env.SMOKE_EDIT_FILE, "dispatch edit\n");
  process.exit(0);
}
if (process.env.SMOKE_MODE === "agy-silent-noop") process.exit(0);
if (process.env.SMOKE_MODE === "zcode-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  // ZCode's bundled AI SDK prints this banner with console.info — i.e. on stdout,
  // ahead of the JSON document. The relay must parse past it.
  console.log("AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.");
  console.log(JSON.stringify({
    sessionId: "sess_smoke-1",
    traceId: "trace-1",
    turnId: "turn_1",
    response: "fake zcode completed",
    usage: {
      source: "provider",
      modelRequestCount: 1,
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    eventCount: 12,
    projection: {
      status: "idle",
      turnCount: 1,
      totalTokenCount: 9,
      contextUsed: 9,
      contextWindow: 200000,
    },
  }, null, 2));
  process.exit(0);
}
if (process.env.SMOKE_MODE === "zcode-garbled") {
  // Exit 0 with output that never parses: the relay must still complete, but say so.
  console.log("not json at all");
  process.exit(0);
}
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
