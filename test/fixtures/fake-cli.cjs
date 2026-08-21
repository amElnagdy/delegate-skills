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
if (versionProbe && process.env.SMOKE_PREFLIGHT_PID_FILE) {
  fs.writeFileSync(process.env.SMOKE_PREFLIGHT_PID_FILE, String(process.pid));
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
// dsh prints exactly the final assistant message on stdout (with leading blank
// lines, as the real CLI does), reads no stdin, and exits 0. The task rides argv
// only, so the capture includes it for the pointer-task assertions.
if (process.env.SMOKE_MODE === "dsh-success") {
  if (process.env.SMOKE_ARGS_FILE) {
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({
      args,
      cwd: process.cwd(),
      permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
    }));
  }
  // When asked, persist a two-frame session record the way dsh's
  // session-persistence-jsonl does (each append its own zstd frame) — created
  // DURING the dispatch, because the relay's harvest attributes only records
  // born in the run's own window; a fixture pre-seeded by the test would (and
  // must) be rejected as stale. Skipped silently on a Node without zlib zstd;
  // the test gates its harvest cases on the same feature.
  if (process.env.SMOKE_DSH_RECORD_DIR) {
    const zlib = require("node:zlib");
    if (typeof zlib.zstdCompressSync === "function") {
      const frame = (lines) => zlib.zstdCompressSync(Buffer.from(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8"));
      const id = process.env.SMOKE_DSH_SESSION_ID || "session-33333333-cccc-4ccc-8ccc-333333333333";
      fs.mkdirSync(process.env.SMOKE_DSH_RECORD_DIR, { recursive: true });
      fs.writeFileSync(require("node:path").join(process.env.SMOKE_DSH_RECORD_DIR, "session.jsonl.zstd"), Buffer.concat([
        frame([{ type: "session", version: 3, id, createdAt: Date.now(), cwd: process.cwd(), delegationDepth: 0 }]),
        frame([
          { type: "permission/preset", seq: 1, time: 1, data: { preset: "workspace-write" } },
          { type: "sandbox/mode", seq: 2, time: 1, data: { mode: "workspace-write" } },
          { type: "approval/policy", seq: 3, time: 1, data: { policy: "ask" } },
          { type: "request/header", seq: 4, time: 1, data: { header: { config: { provider: "fake-provider", model: "fake-model", maxTokens: 1024, reasoningEffort: "low" } } } },
          { type: "assistant/message", seq: 5, time: 1, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "working" }] }, usage: { inputTokens: 20, outputTokens: 5 } } },
          { type: "assistant/message", seq: 6, time: 1, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { inputTokens: 10, outputTokens: 2 } } },
          { type: "turn/end", seq: 7, time: 1, data: { turn: 1, reason: { kind: "completed" } } },
        ]),
      ]));
    }
  }
  console.log("");
  console.log("fake dsh completed");
  process.exit(0);
}
// The measured live failure shape: a one-line diagnostic on stderr, nothing on
// stdout, exit 1.
if (process.env.SMOKE_MODE === "dsh-error") {
  console.error('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"');
  process.exit(1);
}
// One very long stderr line with no newline at all, so the relay's bounded held
// fragment is exercised rather than its whole-line tail. Exit nonzero: the relay
// reports stderrTail only for a run it did not call completed.
if (process.env.SMOKE_MODE === "dsh-unterminated-stderr") {
  for (let i = 0; i < 200; i += 1) process.stderr.write("x".repeat(10000));
  process.stdout.write("fake dsh done\n");
  process.exit(1);
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
if (["omp-success", "omp-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "omp-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    console.log(JSON.stringify({ type: "session", version: 3, id: "omp-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: failed ? "fake omp failed" : "fake omp completed" }],
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
} else if (["pi-success", "pi-error"].includes(process.env.SMOKE_MODE)) {
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
} else if ([
  "commandcode-success",
  "commandcode-unfinished",
  "commandcode-read-only-clean",
  "commandcode-read-only-append",
  "commandcode-truncated-tail",
].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const unfinished = process.env.SMOKE_MODE === "commandcode-unfinished";
    if (process.env.SMOKE_MODE === "commandcode-read-only-append") {
      fs.appendFileSync(process.env.SMOKE_APPEND_FILE ?? "already-dirty.txt", "appended by fake commandcode\n");
    }
    if (process.env.SMOKE_ARGS_FILE) fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief, cwd: process.cwd() }));
    // Blocking writes in the truncated case, so the cut tail is the only thing under test:
    // an async write followed by process.exit would drop these earlier lines too, which is
    // the CLI bug itself rather than the parsing contract this case exists to pin.
    const emit = process.env.SMOKE_MODE === "commandcode-truncated-tail"
      ? (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`)
      : (value) => console.log(JSON.stringify(value));
    // The session id arrives on the FIRST line, and the report in a message_end, both well
    // before the oversized tail — which is why the relay reads them from here.
    emit({ type: "event", event: { type: "run_start", sessionId: "commandcode-session-1" } });
    emit({
      type: "event",
      event: {
        type: "message_end",
        content: [{ type: "text", text: unfinished ? "ran out of turns partway" : "fake commandcode completed" }],
      },
    });
    emit({ type: "event", event: { type: "turn_end", turnNumber: 1, hadToolCalls: true } });
    if (process.env.SMOKE_MODE === "commandcode-truncated-tail") {
      // What cmd does on a real run: an oversized run_end cut mid-write, and no result
      // line after it. writeSync so the cut is the only thing under test — an async write
      // followed by process.exit would drop the earlier lines too, which is the CLI bug
      // itself rather than the parsing contract this case is here to pin.
      fs.writeSync(1, `{"type":"event","event":{"type":"run_end","result":{"nextState":{"blob":"${"y".repeat(4096)}`);
      process.exit(0);
    }
    // run_end carries the session id nested, as the real CLI does; the result line repeats it.
    emit({
      type: "event",
      event: { type: "run_end", result: { nextState: { sessionId: "commandcode-session-1" } } },
    });
    emit({
      type: "result",
      subtype: unfinished ? "max_turns" : "success",
      sessionId: "commandcode-session-1",
      stopReason: unfinished ? "max_turns" : "end_turn",
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
      durationMs: 42,
      finalText: unfinished ? "ran out of turns partway" : "fake commandcode completed",
    });
    // The real CLI exits 0 for a clean run even when the task did not finish.
    process.exit(0);
  });
} else if (process.env.SMOKE_MODE === "copilot-success") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({ type: "assistant.message", data: { content: "working" }, ephemeral: false }));
  console.log(JSON.stringify({ type: "assistant.message", data: { content: "fake copilot completed" }, ephemeral: false }));
  console.log(JSON.stringify({ type: "result", sessionId: "copilot-session-1", exitCode: 0, usage: { codeChanges: { linesAdded: 5, linesRemoved: 2, filesModified: ["src/main.js"] } } }));
  process.exit(0);
} else if (process.env.SMOKE_MODE === "copilot-denied") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  console.log(JSON.stringify({ type: "tool.execution_complete", data: { success: false, error: { message: "Permission denied and could not request permission from user", code: "denied" } } }));
  console.log(JSON.stringify({ type: "result", sessionId: "copilot-session-denied", exitCode: 0, usage: { codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }));
  process.exit(0);
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
