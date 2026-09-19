import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runOpencode(h) {
  const workDir = h.freshRepo("work-opencode");

  // Model + variant: opencode run has no --variant flag, so the relay joins the
  // dials as --model provider/model#variant (documented in `opencode run --help`).
  const variantOutDir = join(h.scratch, "out-opencode-model-variant");
  const variantArgsFile = join(h.scratch, "args-opencode-model-variant");
  const variantRun = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", variantOutDir,
    "--model", "fake/model",
    "--variant", "high",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "opencode-success", SMOKE_ARGS_FILE: variantArgsFile },
    encoding: "utf8",
  });
  const variantCapture = existsSync(variantArgsFile) ? JSON.parse(readFileSync(variantArgsFile, "utf8")) : {};
  h.check("opencode model+variant: relay exits zero", variantRun.status === 0);
  h.check("opencode model+variant: variant joins the model value",
    JSON.stringify(variantCapture.args) === JSON.stringify([
      "run", "--format", "json",
      "--agent", "build",
      "--model", "fake/model#high",
      "--auto",
    ]));
  h.check("opencode model+variant: brief delivered through stdin",
    variantCapture.brief === "smoke brief: run until killed.");
  h.check("opencode model+variant: result.json exists", existsSync(join(variantOutDir, "result.json")));
  if (existsSync(join(variantOutDir, "result.json"))) {
    const value = h.result(variantOutDir);
    h.check("opencode model+variant: event stream parsed (session, text parts, cost)",
      value.status === "completed" &&
      value.sessionId === "ses_smoke_opencode" &&
      // prt_1's streamed update replaced its partial text; prt_2 appended after it.
      value.finalMessage === "fake opencode completed — second segment" &&
      value.cost === 0.0035 &&
      value.model === "fake/model" &&
      value.variant === "high" &&
      value.agent === "build" &&
      value.auto === true &&
      value.resumed === false &&
      Array.isArray(value.touchedFiles) &&
      value.finalPath !== null &&
      value.opencodeVersion === "fake-cli 0.0.0-smoke");
  }

  // Model only: no # join, no --variant anywhere.
  const modelOutDir = join(h.scratch, "out-opencode-model-only");
  const modelArgsFile = join(h.scratch, "args-opencode-model-only");
  const modelRun = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", modelOutDir,
    "--model", "fake/model",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "opencode-success", SMOKE_ARGS_FILE: modelArgsFile },
    encoding: "utf8",
  });
  const modelCapture = existsSync(modelArgsFile) ? JSON.parse(readFileSync(modelArgsFile, "utf8")) : {};
  h.check("opencode model only: argv is exact",
    modelRun.status === 0 &&
    JSON.stringify(modelCapture.args) === JSON.stringify([
      "run", "--format", "json",
      "--agent", "build",
      "--model", "fake/model",
      "--auto",
    ]) &&
    existsSync(join(modelOutDir, "result.json")) &&
    h.result(modelOutDir).model === "fake/model" &&
    h.result(modelOutDir).variant === null);

  // Plan agent: the join still applies, and --auto must never reach a read-only run.
  const planOutDir = join(h.scratch, "out-opencode-plan-variant");
  const planArgsFile = join(h.scratch, "args-opencode-plan-variant");
  const planRun = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", planOutDir,
    "--agent", "plan",
    "--model", "fake/model",
    "--variant", "low",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "opencode-success", SMOKE_ARGS_FILE: planArgsFile },
    encoding: "utf8",
  });
  const planCapture = existsSync(planArgsFile) ? JSON.parse(readFileSync(planArgsFile, "utf8")) : {};
  h.check("opencode plan: variant joins the model value and no --auto is passed",
    planRun.status === 0 &&
    JSON.stringify(planCapture.args) === JSON.stringify([
      "run", "--format", "json",
      "--agent", "plan",
      "--model", "fake/model#low",
    ]) &&
    existsSync(join(planOutDir, "result.json")) &&
    h.result(planOutDir).agent === "plan");

  // A variant does not satisfy the model requirement on a fresh run.
  const bareVariant = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--variant", "high",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("opencode --variant without --model is a usage error",
    bareVariant.status === 2 && /--model/.test(bareVariant.stderr));
}
