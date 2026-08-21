import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";

/**
 * dsh-delegate contract cases. Beyond the shared timeout/abort matrix these pin:
 * the exact `--profile headless` argv with pointer-task brief delivery, the
 * generated agent-default-model overlay, DSH_PERMISSION_MODE handling — flag
 * wins, an already-exported environment value is honored and reported rather
 * than silently stripped — the session-record harvest (multi-frame zstd, matched
 * by the header's own cwd), the measured MISSING_CREDENTIAL failure shape, the
 * bounded unterminated-stderr fragment, and the win32 cmd metacharacter guard.
 */
const METACHARACTERS = ["%", "!", "&", "|", "^", "<", ">", '"'];

const seedFrames = (lines) =>
  Buffer.concat(lines.map((group) => zlib.zstdCompressSync(Buffer.from(`${group.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8"))));

export function runDsh(h) {
  const workDir = h.freshRepo("work-dsh");
  const runRelay = (name, extraArgs, extraEnv) => {
    const outDir = join(h.scratch, `out-${name}-dsh`);
    const argsFile = join(h.scratch, `args-${name}-dsh`);
    const run = spawnSync(process.execPath, [
      h.relayPath("dsh"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      ...extraArgs,
    ], { env: { SMOKE_MODE: "dsh-success", ...h.baseEnv, SMOKE_ARGS_FILE: argsFile, ...extraEnv }, encoding: "utf8" });
    const capture = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
    return { run, outDir, capture };
  };

  // --- documented argv, pointer-task delivery, and the generated overlay -----
  const success = runRelay("success", ["--model", "fake-model", "--provider", "fake-provider", "--permission-mode", "read-only"], {});
  const overlayPath = join(success.outDir, "model-overlay.yml");
  const briefCopy = join(success.outDir, "brief.md");
  h.check("dsh success: relay exits zero", success.run.status === 0);
  // On win32 the .cmd shim launch pre-quotes spaceable values; strip surrounding
  // quotes before comparing so the assertion holds however cmd re-tokenized them.
  const unquote = (value) => String(value).replace(/^"|"$/g, "");
  h.check("dsh success: documented argv is exact",
    JSON.stringify((success.capture.args ?? []).map(unquote)) === JSON.stringify([
      "--profile", "headless",
      "--patch", overlayPath,
      `Read the task brief at ${briefCopy} and execute it fully.`,
    ]));
  h.check("dsh success: the brief travels as a file, verbatim",
    existsSync(briefCopy) && readFileSync(briefCopy, "utf8") === readFileSync(h.briefPath, "utf8"));
  h.check("dsh success: the overlay replaces the whole agent-default-model config",
    existsSync(overlayPath) &&
    readFileSync(overlayPath, "utf8") === "- id: agent-default-model\n  config:\n    provider: fake-provider\n    model: fake-model\n");
  h.check("dsh success: DSH_PERMISSION_MODE reaches the child",
    success.capture.permissionMode === "read-only");
  // Skipped on win32: tmpdir() can hand out an 8.3 short path while process.cwd()
  // reports the long form, and this check is about the relay's cwd wiring, not
  // Windows path aliasing.
  if (!h.WIN) h.check("dsh success: the child cwd is the workspace root", success.capture.cwd === workDir);
  if (existsSync(join(success.outDir, "result.json"))) {
    const value = h.result(success.outDir);
    h.check("dsh success: result fields",
      value.status === "completed" &&
      value.exitCode === 0 &&
      value.finalMessage === "fake dsh completed" &&
      value.permissionMode === "read-only" &&
      value.permissionModeSource === "flag" &&
      value.readOnly === true &&
      value.readOnlyViolation === false &&
      value.modelOverlay?.provider === "fake-provider" &&
      value.modelOverlay?.model === "fake-model" &&
      typeof value.sessionHarvest === "string");
  } else {
    h.check("dsh success: result.json exists", false);
  }

  // --- an exported DSH_PERMISSION_MODE is honored and reported, never stripped
  const ambient = runRelay("ambient", [], { DSH_PERMISSION_MODE: "read-only" });
  h.check("dsh ambient posture: environment read-only is honored, not stripped",
    ambient.run.status === 0 &&
    ambient.capture.permissionMode === "read-only" &&
    h.result(ambient.outDir).permissionMode === "read-only" &&
    h.result(ambient.outDir).permissionModeSource === "environment" &&
    h.result(ambient.outDir).readOnly === true);
  const override = runRelay("override", ["--permission-mode", "workspace-write"], { DSH_PERMISSION_MODE: "read-only" });
  h.check("dsh ambient posture: an explicit flag overrides the environment",
    override.run.status === 0 &&
    override.capture.permissionMode === "workspace-write" &&
    h.result(override.outDir).permissionModeSource === "flag");

  // --- usage errors: exit 2 before any run, no result file --------------------
  const usageCases = [
    ["provider without model", ["--provider", "fake-provider"]],
    ["invalid --permission-mode", ["--permission-mode", "bogus"]],
    ["--read-only conflicting with a write mode", ["--read-only", "--permission-mode", "workspace-write"]],
    ["missing --patch file", ["--patch", join(h.scratch, "no-such-overlay.yml")]],
    ["unknown option", ["--resume-last"]],
  ];
  for (const [name, extraArgs] of usageCases) {
    const outDir = join(h.scratch, `out-usage-${usageCases.findIndex(([n]) => n === name)}-dsh`);
    const run = spawnSync(process.execPath, [
      h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, ...extraArgs,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`dsh usage error (${name}): exits 2 with no result file`,
      run.status === 2 && !existsSync(join(outDir, "result.json")));
  }
  const badAmbient = runRelay("bad-ambient", [], { DSH_PERMISSION_MODE: "bogus" });
  h.check("dsh usage error (invalid exported DSH_PERMISSION_MODE): exits 2, names the variable",
    badAmbient.run.status === 2 && String(badAmbient.run.stderr).includes("DSH_PERMISSION_MODE"));

  // --- session-record harvest (zlib zstd needs Node 22.15+; skipped below it) -
  if (typeof zlib.zstdCompressSync === "function") {
    const home = join(h.scratch, "dsh-home");
    const sessionId = "session-11111111-aaaa-4aaa-8aaa-111111111111";
    const sessionDir = join(home, "sessions", "workspace-a", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Two frames on purpose: the header append and a later append are separate
    // zstd frames in the real record, and a one-shot decompress sees only the
    // first — the frame walk is the thing under test.
    writeFileSync(join(sessionDir, "session.jsonl.zstd"), seedFrames([
      [{ type: "session", version: 3, id: sessionId, createdAt: Date.now(), cwd: workDir, delegationDepth: 0 }],
      [
        { type: "permission/preset", seq: 1, time: 1, data: { preset: "workspace-write" } },
        { type: "sandbox/mode", seq: 2, time: 1, data: { mode: "workspace-write" } },
        { type: "approval/policy", seq: 3, time: 1, data: { policy: "ask" } },
        { type: "request/header", seq: 4, time: 1, data: { header: { config: { provider: "fake-provider", model: "fake-model", maxTokens: 1024, reasoningEffort: "low" } } } },
        { type: "assistant/message", seq: 5, time: 1, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "working" }] }, usage: { inputTokens: 20, outputTokens: 5 } } },
        { type: "assistant/message", seq: 6, time: 1, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { inputTokens: 10, outputTokens: 2 } } },
        { type: "turn/end", seq: 7, time: 1, data: { turn: 1, reason: { kind: "completed" } } },
      ],
    ]));
    // A record for another workspace must not match — candidates are matched by
    // the header's own cwd, never by predicting the directory-name escape.
    const otherDir = join(home, "sessions", "workspace-b", "session-22222222-bbbb-4bbb-8bbb-222222222222");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "session.jsonl.zstd"), seedFrames([
      [{ type: "session", version: 3, id: "session-22222222-bbbb-4bbb-8bbb-222222222222", createdAt: Date.now(), cwd: join(h.scratch, "elsewhere"), delegationDepth: 0 }],
    ]));
    const harvested = runRelay("harvest", [], { DSH_HOME: home });
    const value = existsSync(join(harvested.outDir, "result.json")) ? h.result(harvested.outDir) : {};
    h.check("dsh harvest: the multi-frame session record is walked and matched by cwd",
      harvested.run.status === 0 &&
      value.sessionHarvest === "ok" &&
      value.sessionId === sessionId &&
      value.sessionRecordPath === join(sessionDir, "session.jsonl.zstd"));
    h.check("dsh harvest: the request header names what actually served the run",
      value.actualProvider === "fake-provider" &&
      value.actualModel === "fake-model" &&
      value.reasoningEffort === "low");
    h.check("dsh harvest: usage is summed across assistant messages",
      value.usage?.inputTokens === 30 &&
      value.usage?.outputTokens === 7 &&
      value.usage?.assistantMessages === 2);
    h.check("dsh harvest: turn-end reason and recorded posture are reported",
      value.turnEndReason === "completed" &&
      value.recordedPermissionMode === "workspace-write" &&
      value.recordedSandboxMode === "workspace-write" &&
      value.recordedApprovalPolicy === "ask");
    const unmatched = runRelay("harvest-miss", ["--cd", h.freshRepo("work-dsh-miss")], { DSH_HOME: home });
    const missValue = existsSync(join(unmatched.outDir, "result.json")) ? h.result(unmatched.outDir) : {};
    h.check("dsh harvest: no matching record reports not-found with null fields",
      unmatched.run.status === 0 &&
      missValue.sessionHarvest === "not-found" &&
      missValue.sessionId === null &&
      missValue.actualModel === null &&
      missValue.usage === null);
  } else {
    console.log("  (dsh harvest cases skipped: this Node has no zlib zstd)");
  }

  // --- the measured failure shape --------------------------------------------
  const failed = runRelay("error", [], { SMOKE_MODE: "dsh-error" });
  const failedValue = existsSync(join(failed.outDir, "result.json")) ? h.result(failed.outDir) : {};
  h.check("dsh failed path: exit 1 with the diagnostic in stderrTail",
    failed.run.status === 1 &&
    failedValue.status === "failed" &&
    failedValue.exitCode === 1 &&
    (failedValue.stderrTail ?? []).some((line) => line.includes("MISSING_CREDENTIAL")));

  // --- missing binary: 127 WITH a result file ---------------------------------
  const missingOutDir = join(h.scratch, "out-unavailable-dsh");
  const missing = spawnSync(process.execPath, [
    h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", missingOutDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("dsh unavailable: missing binary writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "dsh_unavailable");

  // --- bounded preflight -------------------------------------------------------
  for (const [mode, expectedStatus, expectedExit] of [
    ["dsh-version-fail", "failed", 7],
    ["dsh-version-hang", "timeout", 124],
  ]) {
    const outDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check(`dsh preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }

  // --- 2 MB of stderr with no newline: the held fragment stays bounded --------
  const floodOut = join(h.scratch, "out-stderr-flood-dsh");
  const flood = spawnSync(process.execPath, [
    h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", floodOut,
    // The relay echoes the child's stderr to its own, so this spawnSync needs room
    // for all 2 MB; the default 1 MB maxBuffer would kill the relay mid-run.
  ], { env: { ...h.baseEnv, SMOKE_MODE: "dsh-unterminated-stderr" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  h.check("dsh stderr flood: relay survives an unterminated 2 MB line", flood.status === 1);
  if (existsSync(join(floodOut, "result.json"))) {
    const tail = h.result(floodOut).stderrTail ?? [];
    h.check("dsh stderr flood: the fragment is one bounded, marked entry",
      tail.length === 1 && tail[0].length <= 65_536 && tail[0].startsWith("[truncated] "));
  } else {
    h.check("dsh stderr flood: result.json exists", false);
  }

  // --- win32 cmd metacharacter guard ------------------------------------------
  // Paths reach cmd.exe there because the .cmd shim needs shell:true, and quoting
  // is not a boundary in cmd; the relay rejects such paths with exit 2 and no
  // result file. POSIX spawns argv directly, so the guard must not fire at all.
  for (const character of METACHARACTERS) {
    const index = METACHARACTERS.indexOf(character);
    const patch = join(h.scratch, `overlay${character}.yml`);
    if (!h.WIN) writeFileSync(patch, "- id: agent-default-model\n", "utf8");
    const outDir = join(h.scratch, `out-patch-metachar-${index}-dsh`);
    const run = spawnSync(process.execPath, [
      h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, "--patch", patch,
    ], { env: { SMOKE_MODE: "dsh-success", ...h.baseEnv }, encoding: "utf8" });
    if (h.WIN) {
      h.check(`dsh win32 --patch ${JSON.stringify(character)}: exits 2, no result file`,
        run.status === 2 &&
        run.stderr.includes("--patch") &&
        run.stderr.includes(JSON.stringify(character)) &&
        !existsSync(join(outDir, "result.json")));
    } else {
      h.check(`dsh posix --patch ${JSON.stringify(character)}: no usage exit`, run.status !== 2);
    }
    const dirOut = join(h.scratch, `out-dir-metachar${character}-dsh`);
    const dirRun = spawnSync(process.execPath, [
      h.relayPath("dsh"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", dirOut,
    ], { env: { SMOKE_MODE: "dsh-success", ...h.baseEnv }, encoding: "utf8" });
    if (h.WIN) {
      h.check(`dsh win32 --out-dir ${JSON.stringify(character)}: exits 2, no result file`,
        dirRun.status === 2 && !existsSync(join(dirOut, "result.json")));
    } else {
      h.check(`dsh posix --out-dir ${JSON.stringify(character)}: no usage exit`, dirRun.status !== 2);
    }
  }
}
