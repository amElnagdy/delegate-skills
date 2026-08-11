import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runGemini(h) {
  const workDir = h.freshRepo("work-success-gemini");
  const outDir = join(h.scratch, "out-success-gemini");
  const captureFile = join(h.scratch, "capture-success-gemini.json");
  const run = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--model", "gemini-2.5-pro",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "gemini-success", SMOKE_CAPTURE_FILE: captureFile },
    encoding: "utf8",
  });
  const capture = existsSync(captureFile) ? JSON.parse(readFileSync(captureFile, "utf8")) : {};
  h.check("gemini success: relay exits zero", run.status === 0);
  h.check("gemini success: documented headless argv is exact",
    JSON.stringify(capture.args) === JSON.stringify([
      "--output-format", "stream-json", "--approval-mode", "auto_edit",
      "--model", "gemini-2.5-pro",
    ]));
  h.check("gemini success: brief delivered through stdin", capture.brief === "smoke brief: run until killed.");
  h.check("gemini success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("gemini success: result/session/model parsed",
      value.contract === "delegate-relay.result.v1" &&
      value.status === "completed" &&
      value.sessionId === "gemini-session-1" &&
      value.finalMessage === "fake gemini completed" &&
      value.actualModel === "gemini-2.5-pro" &&
      value.stopReason === "success" &&
      value.usage?.input_tokens === 7 &&
      value.usage?.output_tokens === 2);
  }

  const readOnlyOut = join(h.scratch, "out-read-only-gemini");
  const readOnlyCapture = join(h.scratch, "capture-read-only-gemini.json");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOut, "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "gemini-success", SMOKE_CAPTURE_FILE: readOnlyCapture },
    encoding: "utf8",
  });
  const roCapture = existsSync(readOnlyCapture) ? JSON.parse(readFileSync(readOnlyCapture, "utf8")) : {};
  h.check("gemini read-only: plan approval is explicit", readOnly.status === 0 &&
    roCapture.args?.includes("--approval-mode") && roCapture.args?.includes("plan") &&
    h.result(readOnlyOut).readOnly === true);

  const violationOut = join(h.scratch, "out-read-only-violation-gemini");
  const violation = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", violationOut, "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "gemini-read-only-write" },
    encoding: "utf8",
  });
  h.check("gemini read-only: Git tripwire reports a write", violation.status === 0 &&
    h.result(violationOut).readOnlyViolation === true &&
    h.result(violationOut).touchedFiles?.some((file) => file.includes("gemini-read-only-violation.txt")));

  const errorOut = join(h.scratch, "out-error-gemini");
  const error = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", errorOut,
  ], { env: { ...h.baseEnv, SMOKE_MODE: "gemini-error" }, encoding: "utf8" });
  const errorResult = existsSync(join(errorOut, "result.json")) ? h.result(errorOut) : {};
  h.check("gemini provider error: exit-zero error event is failed", error.status === 1 &&
    errorResult.status === "failed" && errorResult.error?.includes("provider failure"));

  const resumeOut = join(h.scratch, "out-resume-gemini");
  const resumeCapture = join(h.scratch, "capture-resume-gemini.json");
  const resume = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", resumeOut, "--resume-last",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "gemini-success", SMOKE_CAPTURE_FILE: resumeCapture }, encoding: "utf8" });
  const resumeArgs = existsSync(resumeCapture) ? JSON.parse(readFileSync(resumeCapture, "utf8")).args : [];
  h.check("gemini resume-last: maps to --resume latest", resume.status === 0 &&
    JSON.stringify(resumeArgs).includes('"--resume","latest"') && h.result(resumeOut).resumed === true);

  const unsafe = spawnSync(process.execPath, [h.relayPath("gemini"), "--brief", h.briefPath, "--model", "bad && whoami"], {
    env: h.baseEnv, encoding: "utf8",
  });
  h.check("gemini model: shell-unsafe value is rejected", unsafe.status === 2);

  const missingOut = join(h.scratch, "out-unavailable-gemini");
  const missing = spawnSync(process.execPath, [
    h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", missingOut,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("gemini unavailable: missing binary writes structured result", missing.status === 127 &&
    existsSync(join(missingOut, "result.json")) && h.result(missingOut).status === "gemini_unavailable");

  for (const [mode, expectedStatus, expectedExit] of [
    ["gemini-version-fail", "failed", 7],
    ["gemini-version-hang", "timeout", 124],
  ]) {
    const preflightOut = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("gemini"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", preflightOut, "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
    const preflightResult = existsSync(join(preflightOut, "result.json")) ? h.result(preflightOut) : {};
    h.check(`gemini preflight: ${mode} blocks dispatch`, preflight.status === expectedExit &&
      preflightResult.status === expectedStatus && preflightResult.error?.includes("version preflight") &&
      preflightResult.error?.includes("not dispatched"));
  }
}
