import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runOpencode(h) {
  const workDir = h.freshRepo("work-opencode");

  // Model + variant on opencode 2.x: 2.x replaced the --variant flag with a
  // provider/model#variant model value (2.0.11's run --help), so the relay joins the dials.
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
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "opencode-success",
      SMOKE_ARGS_FILE: variantArgsFile,
      SMOKE_VERSION: "opencode v2.0.11",
    },
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
      value.opencodeVersion === "opencode v2.0.11");
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

  // Plan agent on 2.x: the join still applies, and --auto must never reach a read-only run.
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
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "opencode-success",
      SMOKE_ARGS_FILE: planArgsFile,
      SMOKE_VERSION: "opencode v2.0.11",
    },
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

  // opencode 1.x still documents --variant; the probe gates the mapping back to the flag.
  const v1OutDir = join(h.scratch, "out-opencode-v1-variant");
  const v1ArgsFile = join(h.scratch, "args-opencode-v1-variant");
  const v1Run = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", v1OutDir,
    "--model", "fake/model",
    "--variant", "high",
  ], {
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "opencode-success",
      SMOKE_ARGS_FILE: v1ArgsFile,
      SMOKE_VERSION: "1.18.30",
    },
    encoding: "utf8",
  });
  const v1Capture = existsSync(v1ArgsFile) ? JSON.parse(readFileSync(v1ArgsFile, "utf8")) : {};
  h.check("opencode 1.x model+variant: --variant is passed as its own flag",
    v1Run.status === 0 &&
    JSON.stringify(v1Capture.args) === JSON.stringify([
      "run", "--format", "json",
      "--agent", "build",
      "--model", "fake/model",
      "--variant", "high",
      "--auto",
    ]) &&
    existsSync(join(v1OutDir, "result.json")) &&
    h.result(v1OutDir).opencodeVersion === "1.18.30" &&
    h.result(v1OutDir).variant === "high");

  // An unparseable version keeps the 1.x mapping — the long-standing behavior.
  const unknownOutDir = join(h.scratch, "out-opencode-unknown-version");
  const unknownArgsFile = join(h.scratch, "args-opencode-unknown-version");
  const unknownRun = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", unknownOutDir,
    "--model", "fake/model",
    "--variant", "high",
  ], {
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "opencode-success",
      SMOKE_ARGS_FILE: unknownArgsFile,
      SMOKE_VERSION: "unknown",
    },
    encoding: "utf8",
  });
  const unknownCapture = existsSync(unknownArgsFile) ? JSON.parse(readFileSync(unknownArgsFile, "utf8")) : {};
  h.check("opencode unknown version: falls back to the 1.x --variant mapping",
    unknownRun.status === 0 &&
    unknownCapture.args.includes("--variant") &&
    !unknownCapture.args.some((a) => typeof a === "string" && a.includes("#")));

  // A joined model value is forwarded verbatim on 2.x.
  const joinedOutDir = join(h.scratch, "out-opencode-joined-model");
  const joinedArgsFile = join(h.scratch, "args-opencode-joined-model");
  const joinedRun = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", joinedOutDir,
    "--model", "fake/model#high",
  ], {
    env: {
      ...h.baseEnv,
      SMOKE_MODE: "opencode-success",
      SMOKE_ARGS_FILE: joinedArgsFile,
      SMOKE_VERSION: "opencode v2.0.11",
    },
    encoding: "utf8",
  });
  const joinedCapture = existsSync(joinedArgsFile) ? JSON.parse(readFileSync(joinedArgsFile, "utf8")) : {};
  h.check("opencode joined model value: forwarded verbatim, no --variant",
    joinedRun.status === 0 &&
    h.pair(joinedCapture.args, "--model", "fake/model#high") &&
    !joinedCapture.args.includes("--variant"));

  // A model that already carries a variant plus an explicit --variant is ambiguous.
  const conflict = spawnSync(process.execPath, [
    h.relayPath("opencode"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--model", "fake/model#high",
    "--variant", "low",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("opencode joined model plus --variant is a usage error",
    conflict.status === 2 && /already carries a variant/.test(conflict.stderr));
}
