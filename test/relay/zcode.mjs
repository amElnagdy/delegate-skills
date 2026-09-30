import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runZcode(h) {
  const workDir = h.freshRepo("work-zcode");
  // zcode's fake is fake-cli.cjs on both platforms (a .cmd shim on Windows), and
  // that fake writes JSON. Only the skills backed by the compiled native fake
  // write one argument per line, so no platform branch belongs here.
  const capturedArgs = (file) =>
    (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);

  // --- mode validation -----------------------------------------------------
  // build/edit exit 0 having changed nothing in a real headless run (no
  // permission client), so they must never reach dispatch. See issue #55.
  for (const [label, value] of [
    ["build", "build"],
    ["edit", "edit"],
    ["bogus", "definitely-not-a-mode"],
  ]) {
    const outDir = join(h.scratch, `out-reject-mode-${label}`);
    const run = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", outDir, "--mode", value,
    ], { env: h.baseEnv, encoding: "utf8" });
    h.check(`zcode validation: --mode ${label} is rejected before artifacts`,
      run.status === 2 && !existsSync(outDir));
  }

  const conflictOutDir = join(h.scratch, "out-reject-conflict");
  const conflict = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", conflictOutDir, "--read-only", "--mode", "yolo",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("zcode validation: --read-only conflicting with --mode yolo is rejected",
    conflict.status === 2 && !existsSync(conflictOutDir));

  const badSessionOutDir = join(h.scratch, "out-reject-session");
  const badSession = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", badSessionOutDir, "--session", "not-a-zcode-session",
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("zcode validation: a session id without the sess_ prefix is rejected",
    badSession.status === 2 && !existsSync(badSessionOutDir));

  // --- unavailable ---------------------------------------------------------
  // Deliberately NOT PATH-based: bundle discovery would still find an installed
  // ZCode desktop app, so clearing PATH proves nothing on a developer machine.
  // Naming a CLI that does not exist is the same condition and is deterministic.
  const missingOutDir = join(h.scratch, "out-unavailable-zcode");
  const missing = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", missingOutDir,
  ], {
    env: { ...h.baseEnv, ZCODE_CLI: join(h.scratch, "no-such-zcode.cjs") },
    encoding: "utf8",
  });
  h.check("zcode unavailable: an explicitly named missing CLI writes the structured result",
    missing.status === 127 &&
    existsSync(join(missingOutDir, "result.json")) &&
    h.result(missingOutDir).status === "zcode_unavailable");

  // --- success -------------------------------------------------------------
  const outDir = join(h.scratch, "out-success-zcode");
  const argsFile = join(h.scratch, "args-success-zcode");
  const run = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", outDir, "--session", "sess_prior-0", "--disallowed-tools", "Write,Edit",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = capturedArgs(argsFile);
  h.check("zcode success: relay exits zero", run.status === 0);
  h.check("zcode success: --mode is always explicit, never left to ZCode's yolo default",
    h.pair(args, "--mode", "yolo"));
  h.check("zcode success: the brief is attached, never passed as prompt text",
    args.includes("--attach") &&
    /brief\.md"?$/.test(args[args.indexOf("--attach") + 1] || "") &&
    /^"?Follow the attached brief exactly\."?$/.test(args[args.indexOf("--prompt") + 1] || ""));
  h.check("zcode success: documented resume and denylist flags are used",
    h.pair(args, "--resume", "sess_prior-0") &&
    args.includes("--disallowed-tools") &&
    !args.includes("-c"));
  h.check("zcode success: --json and --no-color are always passed",
    args.includes("--json") && args.includes("--no-color"));
  h.check("zcode success: result.json exists", existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const value = h.result(outDir);
    h.check("zcode success: the JSON document is parsed past the stdout banner",
      value.status === "completed" &&
      value.sessionId === "sess_smoke-1" &&
      value.finalMessage === "fake zcode completed" &&
      !value.parseWarning);
    h.check("zcode success: usage and context window are carried through",
      value.usage?.totalTokens === 9 &&
      value.contextWindow === 200000 &&
      value.mode === "yolo" &&
      value.readOnlyViolation === null);
    h.check("zcode success: the raw output is preserved beside the result",
      typeof value.outputPath === "string" && existsSync(value.outputPath));
  }

  // --- resume-last uses ZCode's own -c -------------------------------------
  const latestOutDir = join(h.scratch, "out-resume-last-zcode");
  const latestArgsFile = join(h.scratch, "args-resume-last-zcode");
  const latest = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", latestOutDir, "--resume-last",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: latestArgsFile },
    encoding: "utf8",
  });
  const latestArgs = capturedArgs(latestArgsFile);
  h.check("zcode resume-last: uses documented -c, not --resume",
    latest.status === 0 &&
    latestArgs.includes("-c") &&
    !latestArgs.includes("--resume"));

  // --- read-only ------------------------------------------------------------
  const readOnlyOutDir = join(h.scratch, "out-read-only-zcode");
  const readOnlyArgsFile = join(h.scratch, "args-read-only-zcode");
  const readOnly = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", readOnlyOutDir, "--read-only",
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success", SMOKE_ARGS_FILE: readOnlyArgsFile },
    encoding: "utf8",
  });
  const readOnlyArgs = capturedArgs(readOnlyArgsFile);
  h.check("zcode read-only: maps to ZCode's plan mode and reports a clean tripwire",
    readOnly.status === 0 &&
    h.pair(readOnlyArgs, "--mode", "plan") &&
    existsSync(join(readOnlyOutDir, "result.json")) &&
    h.result(readOnlyOutDir).mode === "plan" &&
    h.result(readOnlyOutDir).readOnlyViolation === false);

  // --- unparseable stdout is reported, not hidden --------------------------
  const garbledOutDir = join(h.scratch, "out-garbled-zcode");
  const garbled = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", garbledOutDir,
  ], { env: { ...h.baseEnv, SMOKE_MODE: "zcode-garbled" }, encoding: "utf8" });
  const garbledResult = existsSync(join(garbledOutDir, "result.json")) ? h.result(garbledOutDir) : {};
  h.check("zcode garbled: an unparseable document still completes but says so",
    garbled.status === 0 &&
    garbledResult.status === "completed" &&
    garbledResult.sessionId === null &&
    typeof garbledResult.parseWarning === "string" &&
    garbledResult.finalMessage.includes("not json at all"));

  // --- preflight ------------------------------------------------------------
  // zcode is deliberately absent from preflight.mjs, whose unavailable sub-test
  // clears PATH; these are the equivalent checks, as qoder does.
  for (const [mode, expectedStatus, expectedExit] of [
    ["zcode-version-hang", "timeout", 124],
    ["zcode-version-fail", "failed", 7],
  ]) {
    const preflightOutDir = join(h.scratch, `out-${mode}`);
    const preflight = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", preflightOutDir, "--timeout", "1s",
    ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 15_000 });
    const value = existsSync(join(preflightOutDir, "result.json")) ? h.result(preflightOutDir) : {};
    h.check(`zcode preflight: ${mode} is explicit and prevents dispatch`,
      preflight.status === expectedExit &&
      value.status === expectedStatus &&
      value.error?.includes("version preflight") &&
      value.error?.includes("was not dispatched"));
  }

  // --- model selection -------------------------------------------------------
  // ZCode has no --model flag: the relay generates a config in a per-run home and
  // repoints the child's home at it. The key must come from the environment, so
  // these assert the generated file never carries one.
  const modelTriple = [
    "--model", "openrouter/z-ai/glm-5.2:free",
    "--model-base-url", "https://openrouter.ai/api/v1",
    "--model-kind", "openai-compatible",
  ];
  const modelKeyEnv = { OPENROUTER_API_KEY: "smoke-not-a-real-key" };

  // h.baseEnv inherits the host environment, so the no-key case must delete the
  // candidate variables rather than merely not set them: a machine that exports
  // ZCODE_API_KEY for its own ZCode install would otherwise satisfy the check and
  // red this test on someone else's machine. Deleted, not set to undefined —
  // Node stringifies undefined into the child environment.
  const strippedEnv = () => {
    const env = { ...h.baseEnv };
    for (const name of ["OPENROUTER_API_KEY", "ZCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      delete env[name];
    }
    return env;
  };

  for (const [label, extra, env] of [
    ["--model without its two companions", ["--model", "openrouter/z-ai/glm-5.2:free"], { ...h.baseEnv, ...modelKeyEnv }],
    ["--model-kind without --model", ["--model-kind", "openai-compatible"], { ...h.baseEnv, ...modelKeyEnv }],
    ["an unqualified model id", [...modelTriple.slice(0, 1), "glm-5.2", ...modelTriple.slice(2)], { ...h.baseEnv, ...modelKeyEnv }],
    ["an unknown provider kind", [...modelTriple.slice(0, 4), "--model-kind", "not-a-kind"], { ...h.baseEnv, ...modelKeyEnv }],
    ["a non-http base URL", [...modelTriple.slice(0, 2), "--model-base-url", "file:///etc/passwd", ...modelTriple.slice(4)], { ...h.baseEnv, ...modelKeyEnv }],
    ["--model with --session", [...modelTriple, "--session", "sess_prior-0"], { ...h.baseEnv, ...modelKeyEnv }],
    ["--model with --resume-last", [...modelTriple, "--resume-last"], { ...h.baseEnv, ...modelKeyEnv }],
    ["--model with no key anywhere in the environment", modelTriple, strippedEnv()],
  ]) {
    const rejectOutDir = join(h.scratch, `out-model-reject-${label.replace(/[^a-z0-9]+/gi, "-")}`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", rejectOutDir, ...extra,
    ], { env, encoding: "utf8" });
    h.check(`zcode model: ${label} is rejected before artifacts`,
      rejected.status === 2 && !existsSync(rejectOutDir));
  }

  const modelOutDir = join(h.scratch, "out-model-zcode");
  const modelEnvFile = join(h.scratch, "env-model-zcode");
  const modelRun = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir,
    "--out-dir", modelOutDir, ...modelTriple,
  ], {
    env: {
      ...h.baseEnv, ...modelKeyEnv,
      SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(h.scratch, "args-model-zcode"),
      SMOKE_ENV_FILE: modelEnvFile,
    },
    encoding: "utf8",
  });
  h.check("zcode model: a complete triple dispatches", modelRun.status === 0);

  // The home is deliberately outside --out-dir: it becomes live ZCode state
  // (session db, logs, plugin cache) and --out-dir can point into the repo under
  // review. result.json names it, which is how the test finds it.
  const modelResult = existsSync(join(modelOutDir, "result.json")) ? h.result(modelOutDir) : {};
  const generatedHome = modelResult.modelHome ?? "";
  const generatedConfig = join(generatedHome, ".zcode", "cli", "config.json");
  h.check("zcode model: the generated config lands in a per-run home outside the out-dir",
    generatedHome !== "" &&
    existsSync(generatedConfig) &&
    !existsSync(join(modelOutDir, "zcode-home")) &&
    !generatedHome.startsWith(modelOutDir));
  if (existsSync(generatedConfig)) {
    const raw = readFileSync(generatedConfig, "utf8");
    const parsed = JSON.parse(raw);
    // apiKeyRequired is expected and says only that a key is needed; an
    // "apiKey" field, or the key's value, must never be written.
    h.check("zcode model: the generated config carries no key of any kind",
      !/"apiKey"\s*:/.test(raw) &&
      !raw.includes("smoke-not-a-real-key") &&
      parsed.provider.openrouter.options.apiKey === undefined);
    h.check("zcode model: provider routing and the model are pinned",
      parsed.model.main === "openrouter/z-ai/glm-5.2:free" &&
      parsed.provider.openrouter.kind === "openai-compatible" &&
      parsed.provider.openrouter.options.baseURL === "https://openrouter.ai/api/v1" &&
      parsed.provider.openrouter.options.apiKeyRequired === true &&
      // The model id keeps every segment after the FIRST slash.
      Object.keys(parsed.provider.openrouter.models)[0] === "z-ai/glm-5.2:free");
  }

  const childEnvSeen = existsSync(modelEnvFile) ? JSON.parse(readFileSync(modelEnvFile, "utf8")) : {};
  h.check("zcode model: the child's home is repointed on both platform variables",
    generatedHome !== "" &&
    childEnvSeen.HOME === generatedHome &&
    childEnvSeen.USERPROFILE === generatedHome);

  h.check("zcode model: the pinned model and its home are recorded in the result",
    modelResult.model === "openrouter/z-ai/glm-5.2:free" && typeof modelResult.modelHome === "string");

  // Regression: the generated home used to live under --out-dir, so a --model
  // --read-only run with --out-dir inside the repo filled the worktree with
  // ZCode's session store and the tripwire reported a violation ZCode had not
  // caused. The fake writes under the home to stand in for that state.
  const tripRepo = h.freshRepo("work-zcode-model-tripwire");
  // freshRepo leaves an empty repository. Commit one file so the tripwire has a
  // committed baseline: with nothing committed its honest answer is null
  // ("cannot tell"), and this case is about distinguishing false from true.
  writeFileSync(join(tripRepo, "tracked.txt"), "committed baseline\n");
  spawnSync("git", ["-C", tripRepo, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", [
    "-C", tripRepo, "-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke",
    "commit", "-qm", "baseline",
  ], { encoding: "utf8" });
  const tripOutDir = join(tripRepo, "relay-run");
  const tripRun = spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", tripRepo,
    "--out-dir", tripOutDir, "--read-only", ...modelTriple,
  ], {
    env: {
      ...h.baseEnv, ...modelKeyEnv,
      SMOKE_MODE: "zcode-success",
      SMOKE_ARGS_FILE: join(h.scratch, "args-model-tripwire-zcode"),
      // Written inside the generated home, exactly where ZCode puts its session store.
      SMOKE_WRITE_IN_HOME: "zcode-session-store.sqlite",
    },
    encoding: "utf8",
  });
  const tripValue = existsSync(join(tripOutDir, "result.json")) ? h.result(tripOutDir) : {};
  // touchedFiles still lists the out-dir when it sits inside the repo: it is the
  // raw porcelain review aid, documented as such. Only the verdict must be right.
  h.check("zcode model: relay-owned home state does not trip the read-only tripwire",
    tripRun.status === 0 &&
    tripValue.readOnlyViolation === false &&
    !existsSync(join(tripOutDir, "zcode-home")));

  const plainOutDir = join(h.scratch, "out-model-absent-zcode");
  spawnSync(process.execPath, [
    h.relayPath("zcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", plainOutDir,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "zcode-success" },
    encoding: "utf8",
  });
  if (existsSync(join(plainOutDir, "result.json"))) {
    const value = h.result(plainOutDir);
    h.check("zcode model: a run without --model leaves the home alone and records null",
      value.model === null &&
      value.modelHome === null &&
      !existsSync(join(plainOutDir, "zcode-home")));
  }
}
