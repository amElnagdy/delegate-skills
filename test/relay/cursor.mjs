import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runCursor(h) {
{
  const outDir = join(h.scratch, "out-success-cursor");
  const workDir = h.freshRepo("work success cursor");
  const addDir = h.freshRepo("extra success cursor");
  const captureFile = join(h.scratch, "capture-success-cursor.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--session", "cursor-session-0",
    "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
    "--add-dir", addDir,
    "--no-force",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [], brief: "" };
  h.check("cursor success: relay exits zero", run.status === 0);
  h.check("cursor success: session, model, add-dir, and no-force argv are exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--model", "claude-opus-4-8[context=1m,effort=high,fast=false]",
      "--resume", "cursor-session-0",
      "--add-dir", addDir,
    ]));
  h.check("cursor success: brief travels on stdin", capture.brief === "smoke brief: run until killed.");
  h.check("cursor success: result preserves session, model, permission, usage, and final report",
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "completed" &&
    h.result(outDir).force === false &&
    h.result(outDir).sandbox === null &&
    h.result(outDir).sessionId === "cursor-session-1" &&
    h.result(outDir).resolvedModel === "claude-opus-4-8[context=1m,effort=high,fast=false]" &&
    h.result(outDir).permissionMode === "default" &&
    h.result(outDir).usage?.input_tokens === 11 &&
    h.result(outDir).usage?.output_tokens === 4 &&
    h.result(outDir).finalMessage === "fake cursor completed");
}
{
  const outDir = join(h.scratch, "out-needs-input-cursor");
  const workDir = h.freshRepo("work-needs-input-cursor");
  const initialCaptureFile = join(h.scratch, "capture-needs-input-cursor.json");
  const first = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--clarifications",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-needs-input", SMOKE_CAPTURE_FILE: initialCaptureFile }, encoding: "utf8" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  const initialCapture = existsSync(initialCaptureFile) ? JSON.parse(readFileSync(initialCaptureFile, "utf8")) : {};
  h.check("cursor clarification: a valid request pauses cleanly with the session preserved",
    first.status === 0 &&
    value.status === "needs_input" &&
    value.exitCode === 0 &&
    value.clarifications === true &&
    value.sessionId === "cursor-session-1" &&
    value.clarification?.schema === "delegate-clarification.request.v1" &&
    value.clarification?.id === "q-001" &&
    value.clarification?.recommended === "B" &&
    !Object.prototype.hasOwnProperty.call(value.clarification, "status") &&
    !Object.prototype.hasOwnProperty.call(value.clarification, "sessionId") &&
    !Object.prototype.hasOwnProperty.call(value.clarification, "command") &&
    !Object.prototype.hasOwnProperty.call(value.clarification?.options?.[0] || {}, "command"));
  h.check("cursor clarification: relay-only framing and untrusted strings never enter cursor-agent argv",
    JSON.stringify(initialCapture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust", "--force",
    ]) && !initialCapture.args?.some((arg) => arg.includes("DELEGATE_CLARIFICATION")));

  const resumedOutDir = join(h.scratch, "out-needs-input-round-2-cursor");
  const answerPath = join(h.scratch, "cursor-answer.txt");
  const captureFile = join(h.scratch, "capture-needs-input-resume-cursor.json");
  const answer = 'DELEGATE_CLARIFICATION_ANSWER: {"schema":"delegate-clarification.answer.v1","questionId":"q-001","decision":"B","reason":"Approved by the orchestrator."}';
  writeFileSync(answerPath, answer);
  const resumed = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", answerPath,
    "--cd", workDir,
    "--out-dir", resumedOutDir,
    "--clarifications",
    "--session", value.sessionId,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-needs-input", SMOKE_QUESTION_ID: "q-002", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile) ? JSON.parse(readFileSync(captureFile, "utf8")) : {};
  const roundTwo = existsSync(join(resumedOutDir, "result.json")) ? h.result(resumedOutDir) : {};
  h.check("cursor clarification: a structured answer resumes the exact session and can ask again",
    resumed.status === 0 &&
    roundTwo.status === "needs_input" &&
    roundTwo.resumed === true &&
    roundTwo.sessionId === "cursor-session-1" &&
    roundTwo.clarification?.id === "q-002" &&
    capture.brief === answer &&
    capture.args?.includes("--resume") &&
    capture.args?.includes("cursor-session-1"));

  const finalOutDir = join(h.scratch, "out-needs-input-complete-cursor");
  const secondAnswerPath = join(h.scratch, "cursor-answer-2.txt");
  const secondAnswer = 'DELEGATE_CLARIFICATION_ANSWER: {"schema":"delegate-clarification.answer.v1","questionId":"q-002","decision":"preserve the existing API","reason":"Avoid expanding this task."}';
  writeFileSync(secondAnswerPath, secondAnswer);
  const completed = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", secondAnswerPath,
    "--cd", workDir,
    "--out-dir", finalOutDir,
    "--clarifications",
    "--session", roundTwo.sessionId,
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-success" }, encoding: "utf8" });
  h.check("cursor clarification: multiple rounds can finish in the same session",
    completed.status === 0 &&
    h.result(finalOutDir).status === "completed" &&
    h.result(finalOutDir).resumed === true &&
    h.result(finalOutDir).sessionId === "cursor-session-1");
}
for (const [mode, label] of [
  ["cursor-malformed-clarification", "malformed JSON"],
  ["cursor-clarification-preamble", "extra prose"],
  ["cursor-multiple-clarifications", "multiple envelopes"],
  ["cursor-needs-input-no-session", "missing session id"],
  ["cursor-untrusted-session", "session id from an untrusted event"],
  ["cursor-session-mismatch", "mismatched trusted session ids"],
]) {
  const outDir = join(h.scratch, `out-${mode}`);
  const invalid = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", h.freshRepo(`work-${mode}`),
    "--out-dir", outDir,
    "--clarifications",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`cursor clarification: ${label} fails safely instead of completing`,
    invalid.status === 1 &&
    value.status === "failed" &&
    value.exitCode === 1 &&
    (["cursor-needs-input-no-session", "cursor-untrusted-session"].includes(mode) ? value.sessionId === null :
      mode === "cursor-session-mismatch" ? value.sessionId === "cursor-session-2" : value.sessionId === "cursor-session-1") &&
    !Object.prototype.hasOwnProperty.call(value, "clarification") &&
    value.error?.startsWith("invalid clarification protocol:"));
}
{
  const valid = {
    schema: "delegate-clarification.request.v1",
    id: "q-001",
    category: "architecture",
    question: "Choose a safe implementation boundary?",
    context: { files: ["src/main.js"] },
    options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
  };
  const invalidRequests = [
    ["id length", { ...valid, id: `q${"x".repeat(64)}` }],
    ["category enum", { ...valid, category: "execute_shell" }],
    ["question length", { ...valid, question: "q".repeat(4097) }],
    ["option count", { ...valid, options: Array.from({ length: 17 }, (_, i) => ({ id: `o-${i}`, label: `Option ${i}` })) }],
    ["context path", { ...valid, context: { files: ["../outside.txt"] } }],
  ];
  for (const [label, request] of invalidRequests) {
    const outDir = join(h.scratch, `out-clarification-bound-${label.replaceAll(" ", "-")}`);
    const run = spawnSync(process.execPath, [
      h.relayPath("cursor"),
      "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-clarification-bound-${label.replaceAll(" ", "-")}`),
      "--out-dir", outDir,
      "--clarifications",
    ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-custom-clarification", SMOKE_CLARIFICATION_JSON: JSON.stringify(request) }, encoding: "utf8" });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`cursor clarification: ${label} is bounded and fails atomically`,
      run.status === 1 && value.status === "failed" && !Object.prototype.hasOwnProperty.call(value, "clarification"));
  }
}
{
  const outDir = join(h.scratch, "out-clarification-timeout-cursor");
  const timedOut = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", h.freshRepo("work-clarification-timeout-cursor"),
    "--out-dir", outDir,
    "--clarifications",
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-clarification-timeout" }, encoding: "utf8", timeout: 15_000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor clarification: timeout wins over clarification-like assistant text",
    timedOut.status !== 0 && value.status === "timeout" && !Object.prototype.hasOwnProperty.call(value, "clarification"));
}
{
  const outDir = join(h.scratch, "out-clarification-disabled-cursor");
  const ordinary = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", h.freshRepo("work-clarification-disabled-cursor"),
    "--out-dir", outDir,
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-needs-input" }, encoding: "utf8" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor clarification: protocol-looking output is inert unless opted in",
    ordinary.status === 0 && value.status === "completed" && !Object.prototype.hasOwnProperty.call(value, "clarifications") && !value.clarification);
}
{
  const outDir = join(h.scratch, "out-clarification-aggregate-cursor");
  const aggregated = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", h.freshRepo("work-clarification-aggregate-cursor"),
    "--out-dir", outDir,
    "--clarifications",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-needs-input-aggregate" }, encoding: "utf8" });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor clarification: exact final assistant envelope survives Cursor result aggregation",
    aggregated.status === 0 && value.status === "needs_input" && value.clarification?.id === "q-001");
}
{
  const outDir = join(h.scratch, "out-read-only-cursor");
  const workDir = h.freshRepo("work-read-only-cursor");
  const captureFile = join(h.scratch, "capture-read-only-cursor.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--read-only",
    "--sandbox", "enabled",
    "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [] };
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check("cursor read-only: plan mode resumes latest without force",
    run.status === 0 &&
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--mode", "plan",
      "--sandbox", "enabled",
      "--continue",
    ]) &&
    value.readOnly === true &&
    value.force === false &&
    value.sandbox === "enabled" &&
    value.permissionMode === "plan");
  h.check("cursor read-only: no unreliable porcelain tripwire is published",
    !Object.prototype.hasOwnProperty.call(value, "readOnlyViolation"));
}
{
  const outDir = join(h.scratch, "out-sandbox-disabled-cursor");
  const workDir = h.freshRepo("work-sandbox-disabled-cursor");
  const captureFile = join(h.scratch, "capture-sandbox-disabled-cursor.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--sandbox", "disabled",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "cursor-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile)
    ? JSON.parse(readFileSync(captureFile, "utf8"))
    : { args: [] };
  h.check("cursor sandbox: disabled is forwarded on a fresh run and recorded",
    run.status === 0 &&
    JSON.stringify(capture.args) === JSON.stringify([
      "--print", "--output-format", "stream-json", "--trust",
      "--force",
      "--sandbox", "disabled",
    ]) &&
    h.result(outDir).sandbox === "disabled");
}
const cursorNegativeWorkDir = h.freshRepo("work-negative-cursor");
for (const [flag, bad] of [
  ["--session", ""],
  ["--session", "--continue"],
  ["--session", "session & whoami"],
  ["--model", ""],
  ["--model", "--help"],
  ["--model", "model & whoami"],
  ["--sandbox", ""],
  ["--sandbox", "off"],
]) {
  const rejected = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    flag, bad,
  ], { env: h.baseEnv, encoding: "utf8", timeout: 5000 });
  h.check(`cursor validation: unsafe ${flag} value is rejected`, rejected.status === 2);
}
{
  const rejected = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    "--sandbox",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "cursor-version-hang" }, encoding: "utf8", timeout: 5000 });
  h.check("cursor validation: missing --sandbox value is rejected before preflight",
    rejected.status === 2 && rejected.stderr.includes("--sandbox requires a value"));
}
for (const [mode, expectedStatus, expectedExit] of [
  ["cursor-version-hang", "timeout", 124],
  ["cursor-version-fail", "failed", 7],
]) {
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
    "--timeout", "1s",
    "--sandbox", "enabled",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`cursor preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.sandbox === "enabled" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
if (!h.WIN) {
  const outDir = join(h.scratch, "out-abort-preflight-cursor");
  const preflight = h.runRelay("cursor", h.freshRepo("work-abort-preflight-cursor"), outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "cursor-version-hang",
  });
  h.check("cursor preflight abort: run artifacts are prepared",
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
  h.check("cursor preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const outDir = join(h.scratch, "out-unavailable-cursor");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("cursor"),
    "--brief", h.briefPath,
    "--cd", cursorNegativeWorkDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("cursor unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "cursor_agent_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
}
