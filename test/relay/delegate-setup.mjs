import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- delegate-setup: discover + fleet (fleet lanes) ----
export function runDelegateSetup(h) {
  const setupDir = join(h.testDir, "..", "skills", "delegate-setup", "scripts");
  for (const script of ["discover.mjs", "config.mjs", "implementers.mjs", "lane.mjs"]) {
    const c = spawnSync(process.execPath, ["--check", join(setupDir, script)], { encoding: "utf8" });
    h.check(`syntax: delegate-setup/scripts/${script}`, c.status === 0);
  }

  const help = spawnSync(process.execPath, [join(setupDir, "discover.mjs"), "--help"], { encoding: "utf8" });
  h.check("discover --help exits 0", help.status === 0 && /discover\.mjs/.test(help.stdout));

  const discover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
    encoding: "utf8",
    timeout: 120_000,
  });
  h.check("discover exits 0", discover.status === 0);
  let report = null;
  try {
    report = JSON.parse(discover.stdout);
  } catch {
    report = null;
  }
  h.check("discover reports version", report?.version === "delegate-discover.v1");
  h.check("discover lists discovered or missing", Array.isArray(report?.discovered) && Array.isArray(report?.missing));
  h.check(
    "discover covers all ten implementers",
    Array.isArray(report?.discovered) &&
      Array.isArray(report?.missing) &&
      report.discovered.length + report.missing.length === h.SKILLS.length,
  );

  const agyProbeDir = join(h.scratch, "discover-agy");
  mkdirSync(agyProbeDir);
  const agyProbePath = join(agyProbeDir, h.WIN ? "agy.cmd" : "agy");
  writeFileSync(agyProbePath, h.WIN ? "@echo 1.2.3:\r\n" : "#!/bin/sh\nprintf '1.2.3:\\n'\n");
  if (!h.WIN) chmodSync(agyProbePath, 0o755);
  const agyDiscover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PATH: agyProbeDir },
  });
  let agyReport = null;
  try {
    if (agyDiscover.status === 0) agyReport = JSON.parse(agyDiscover.stdout);
  } catch {
    agyReport = null;
  }
  h.check(
    "Agy changelog heading reports the bare version",
    agyReport?.discovered.find(({ key }) => key === "agy")?.version === "1.2.3",
  );

  // Keep fixtures inside the repo tree so sandboxed CI/dev runs can write; seed a
  // minimal .git without `git init` (hooks/config writes are often blocked).
  const fleetRoot = mkdtempSync(join(h.testDir, "..", ".tmp-fleet-smoke-"));
  const cfgHome = join(fleetRoot, "home");
  const cfgRepo = join(fleetRoot, "repo");
  const bare = join(fleetRoot, "bare");
  mkdirSync(cfgHome);
  mkdirSync(cfgRepo);
  mkdirSync(bare);
  mkdirSync(join(cfgRepo, ".git", "objects"), { recursive: true });
  mkdirSync(join(cfgRepo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cfgRepo, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(
    join(cfgRepo, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
  );
  // Node's os.homedir() uses HOME on POSIX and USERPROFILE on Windows.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = cfgHome;
  process.env.USERPROFILE = cfgHome;
  delete process.env.XDG_CONFIG_HOME;

  try {
    const good = {
      version: "delegate-fleet.v1",
      lanes: {
        feature: { implementer: "opencode", model: "opencode/grok", variant: "high" },
        tests: { implementer: "grok", effort: "medium" },
        "codex-review": { implementer: "codex", readOnly: true },
        "opencode-review": { implementer: "opencode", model: "opencode/grok", readOnly: true },
      },
    };
    const goodFile = join(cfgRepo, "lanes.json");
    writeFileSync(goodFile, `${JSON.stringify(good, null, 2)}\n`);

    const validate = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", goodFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate accepts a good map", validate.status === 0);

    const bareOpenCode = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "opencode" } },
    };
    const bareOpenCodeFile = join(cfgRepo, "bare-opencode.json");
    writeFileSync(bareOpenCodeFile, `${JSON.stringify(bareOpenCode)}\n`);
    const rejectBare = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", bareOpenCodeFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate requires model on opencode", rejectBare.status === 2);

    const bareModel = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "grok" } },
    };
    const bareModelFile = join(cfgRepo, "bare-model.json");
    writeFileSync(bareModelFile, `${JSON.stringify(bareModel)}\n`);
    const rejectBareModel = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", bareModelFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate requires provider/model for opencode", rejectBareModel.status === 2);

    for (const [model, boundary] of [
      ["opencode/", "after"],
      ["/grok", "before"],
      ["opencode//", "after"],
    ]) {
      const malformedModel = {
        version: "delegate-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const malformedModelFile = join(cfgRepo, `malformed-opencode-model-${boundary}-${model.length}.json`);
      writeFileSync(malformedModelFile, `${JSON.stringify(malformedModel)}\n`);
      const rejected = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", malformedModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        `config validate requires model text ${boundary} the opencode provider separator (${model})`,
        rejected.status === 2,
      );
    }

    const hugeTimeout = {
      version: "delegate-fleet.v1",
      lanes: { slow: { implementer: "kimi", timeout: "999999999h" } },
    };
    const hugeTimeoutFile = join(cfgRepo, "huge-timeout.json");
    writeFileSync(hugeTimeoutFile, `${JSON.stringify(hugeTimeout)}\n`);
    const rejectTimeout = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", hugeTimeoutFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects timeout above relay ceiling", rejectTimeout.status === 2);

    const conflictAutonomy = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "codex", readOnly: true, sandbox: "danger-full-access" } },
    };
    const conflictFile = join(cfgRepo, "conflict-autonomy.json");
    writeFileSync(conflictFile, `${JSON.stringify(conflictAutonomy)}\n`);
    const rejectConflict = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", conflictFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects contradictory readOnly+sandbox", rejectConflict.status === 2);

    const badClaudeModel = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "claude", model: "bad model" } },
    };
    const badClaudeModelFile = join(cfgRepo, "bad-claude-model.json");
    writeFileSync(badClaudeModelFile, `${JSON.stringify(badClaudeModel)}\n`);
    const rejectClaudeModel = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badClaudeModelFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects claude model tokens the relay would reject",
      rejectClaudeModel.status === 2 && /unsupported characters/.test(rejectClaudeModel.stderr),
    );

    const badCodexModel = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "codex", model: "x & whoami" } },
    };
    const badCodexModelFile = join(cfgRepo, "bad-codex-model.json");
    writeFileSync(badCodexModelFile, `${JSON.stringify(badCodexModel)}\n`);
    const rejectCodexModel = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badCodexModelFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects shell-unsafe codex model",
      rejectCodexModel.status === 2 && /unsupported characters/.test(rejectCodexModel.stderr),
    );
    const unsafeCodexFlag = spawnSync(
      process.execPath,
      [h.relayPath("codex"), "--brief", h.briefPath, "--model", "x & whoami"],
      { encoding: "utf8", env: h.baseEnv },
    );
    h.check("codex relay rejects shell-unsafe --model", unsafeCodexFlag.status === 2);

    const badVariant = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "opencode/grok", variant: "high & whoami" } },
    };
    const badVariantFile = join(cfgRepo, "bad-variant.json");
    writeFileSync(badVariantFile, `${JSON.stringify(badVariant)}\n`);
    const rejectVariant = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badVariantFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects shell-unsafe opencode variant",
      rejectVariant.status === 2 && /variant/.test(rejectVariant.stderr),
    );
    const unsafeVariantFlag = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", h.briefPath, "--model", "opencode/grok", "--variant", "high & whoami"],
      { encoding: "utf8", env: h.baseEnv },
    );
    h.check("opencode relay rejects shell-unsafe --variant", unsafeVariantFlag.status === 2);

    const badEffort = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "opencode/grok", effort: "high" } },
    };
    const badFile = join(cfgRepo, "bad.json");
    writeFileSync(badFile, `${JSON.stringify(badEffort)}\n`);
    const rejectEffort = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects effort on opencode", rejectEffort.status === 2);

    const badClaude = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "claude", effort: "banana" } },
    };
    const badClaudeFile = join(cfgRepo, "bad-claude.json");
    writeFileSync(badClaudeFile, `${JSON.stringify(badClaude)}\n`);
    const rejectClaude = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badClaudeFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown claude effort", rejectClaude.status === 2);

    const badCursorSandbox = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "cursor", sandbox: "workspace-write" } },
    };
    const badCursorFile = join(cfgRepo, "bad-cursor.json");
    writeFileSync(badCursorFile, `${JSON.stringify(badCursorSandbox)}\n`);
    const rejectCursor = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badCursorFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects cursor sandbox dial", rejectCursor.status === 2);

    const writeGlobal = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config write --scope global", writeGlobal.status === 0);
    const globalPath = join(cfgHome, ".config", "delegate-skills", "config.json");
    h.check("global config file created", existsSync(globalPath));

    // Phase 2: --lane resolve / mismatch / flag override (global map only so far).
    const laneResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "opencode"],
      { encoding: "utf8", env: process.env },
    );
    let laneJson = null;
    try {
      laneJson = JSON.parse(laneResolve.stdout);
    } catch {
      laneJson = null;
    }
    h.check(
      "lane resolve: feature → opencode dials",
      laneResolve.status === 0 &&
        laneJson?.implementer === "opencode" &&
        laneJson?.dials?.model === "opencode/grok" &&
        laneJson?.dials?.variant === "high" &&
        laneJson?.source === "global",
    );

    const grokReadOnly = {
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "grok", readOnly: true } },
    };
    const grokReadOnlyFile = join(cfgRepo, "grok-readonly.json");
    writeFileSync(grokReadOnlyFile, `${JSON.stringify(grokReadOnly)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", grokReadOnlyFile], {
      encoding: "utf8",
      env: process.env,
    });
    const grokResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", bare, "--lane", "review", "--implementer", "grok"],
      { encoding: "utf8", env: process.env },
    );
    let grokDials = null;
    try {
      grokDials = JSON.parse(grokResolve.stdout);
    } catch {
      grokDials = null;
    }
    h.check(
      "lane resolve: grok readOnly → autonomy read-only",
      grokResolve.status === 0 &&
        grokDials?.dials?.autonomy === "read-only" &&
        grokDials?.dials?.readOnly === undefined,
    );
    // Restore the multi-lane global map for the rest of the fleet suite.
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

    const laneMismatchResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "claude"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: wrong implementer fails loud",
      laneMismatchResolve.status === 2 && /use opencode-delegate/.test(laneMismatchResolve.stderr),
    );

    const laneBrief = join(cfgRepo, "lane-brief.txt");
    writeFileSync(laneBrief, "fleet lane smoke brief\n");
    const laneOut = join(cfgRepo, "out-lane-opencode");
    const laneArgsFile = join(cfgRepo, "args-lane-opencode.json");
    mkdirSync(laneOut, { recursive: true });
    // h.baseEnv snapped process.env before this block cleared XDG_CONFIG_HOME — drop it again.
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome, USERPROFILE: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;

    // Explicit Claude full-access must win over a readOnly lane (flags win).
    const claudeRoLane = {
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "claude", readOnly: true } },
    };
    const claudeRoFile = join(cfgRepo, "claude-readonly.json");
    writeFileSync(claudeRoFile, `${JSON.stringify(claudeRoLane)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", claudeRoFile], {
      encoding: "utf8",
      env: process.env,
    });
    const claudeDspOut = join(cfgRepo, "out-claude-dsp");
    mkdirSync(claudeDspOut, { recursive: true });
    const claudeDspBrief = join(cfgRepo, "claude-dsp-brief.txt");
    writeFileSync(claudeDspBrief, "claude dsp override smoke\n");
    const claudeDsp = spawnSync(
      process.execPath,
      [
        h.relayPath("claude"),
        "--brief", claudeDspBrief,
        "--cd", cfgRepo,
        "--out-dir", claudeDspOut,
        "--lane", "review",
        "--dangerously-skip-permissions",
      ],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          SMOKE_MODE: "claude-success",
          SMOKE_CAPTURE_FILE: join(cfgRepo, "claude-dsp-capture.json"),
        },
      },
    );
    h.check(
      "relay --lane: Claude --dangerously-skip-permissions wins over readOnly lane",
      claudeDsp.status === 0 &&
        existsSync(join(claudeDspOut, "result.json")) &&
        h.result(claudeDspOut).dangerouslySkipPermissions === true &&
        h.result(claudeDspOut).readOnly === false,
    );
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

    const laneDispatch = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", laneOut,
        "--lane", "feature",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: laneArgsFile },
      },
    );
    const laneArgs = existsSync(laneArgsFile) ? JSON.parse(readFileSync(laneArgsFile, "utf8")) : [];
    h.check("relay --lane: opencode applies model+variant from lane",
      laneDispatch.status === 0 &&
        h.pair(laneArgs, "--model", "opencode/grok") &&
        h.pair(laneArgs, "--variant", "high"));
    h.check("relay --lane: result records lane provenance",
      existsSync(join(laneOut, "result.json")) &&
        h.result(laneOut).lane === "feature" &&
        h.result(laneOut).laneSource === "global" &&
        h.result(laneOut).model === "opencode/grok" &&
        h.result(laneOut).variant === "high");

    const codexResumeOut = join(cfgRepo, "out-lane-codex-resume");
    const codexResumeArgsFile = join(cfgRepo, "args-lane-codex-resume.json");
    mkdirSync(codexResumeOut, { recursive: true });
    const codexResume = spawnSync(
      process.execPath,
      [
        h.relayPath("codex"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", codexResumeOut,
        "--lane", "codex-review",
        "--session", "thread-review",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: codexResumeArgsFile },
      },
    );
    const codexResumeArgs = existsSync(codexResumeArgsFile)
      ? JSON.parse(readFileSync(codexResumeArgsFile, "utf8"))
      : [];
    h.check("relay --lane: Codex read-only lane applies before resume",
      codexResume.status === 0 &&
        h.pair(codexResumeArgs, "-s", "read-only") &&
        codexResumeArgs.indexOf("-s") < codexResumeArgs.indexOf("resume") &&
        h.result(codexResumeOut).sandbox === "read-only");

    const opencodeResumeOut = join(cfgRepo, "out-lane-opencode-resume");
    const opencodeResumeArgsFile = join(cfgRepo, "args-lane-opencode-resume.json");
    mkdirSync(opencodeResumeOut, { recursive: true });
    const opencodeResume = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", opencodeResumeOut,
        "--lane", "opencode-review",
        "--session", "ses_review",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: opencodeResumeArgsFile },
      },
    );
    const opencodeResumeArgs = existsSync(opencodeResumeArgsFile)
      ? JSON.parse(readFileSync(opencodeResumeArgsFile, "utf8"))
      : [];
    h.check("relay --lane: OpenCode read-only lane selects plan on resume",
      opencodeResume.status === 0 &&
        h.pair(opencodeResumeArgs, "--agent", "plan") &&
        !opencodeResumeArgs.includes("--auto") &&
        h.result(opencodeResumeOut).agent === "plan" &&
        h.result(opencodeResumeOut).resumed === true);

    const wrongSkill = spawnSync(
      process.execPath,
      [h.relayPath("claude"), "--brief", laneBrief, "--cd", cfgRepo, "--lane", "feature"],
      { encoding: "utf8", env: fleetEnv },
    );
    h.check(
      "relay --lane: wrong skill fails loud (no remap)",
      wrongSkill.status === 2 &&
        /use opencode-delegate/.test(wrongSkill.stderr) &&
        !existsSync(join(cfgRepo, "result.json")),
    );

    const overrideOut = join(cfgRepo, "out-lane-override");
    const overrideArgsFile = join(cfgRepo, "args-lane-override.json");
    mkdirSync(overrideOut, { recursive: true });
    const overrideRun = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", overrideOut,
        "--lane", "feature",
        "--model", "openai/gpt-test",
        "--variant", "low",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: overrideArgsFile },
      },
    );
    const overrideArgs = existsSync(overrideArgsFile) ? JSON.parse(readFileSync(overrideArgsFile, "utf8")) : [];
    h.check("relay --lane: explicit flags win over lane dials",
      overrideRun.status === 0 &&
        h.pair(overrideArgs, "--model", "openai/gpt-test") &&
        h.pair(overrideArgs, "--variant", "low"));

    const projectOnly = {
      version: "delegate-fleet.v1",
      lanes: {
        feature: { implementer: "claude", effort: "high" },
      },
    };
    const projectFile = join(cfgRepo, "project-lanes.json");
    writeFileSync(projectFile, `${JSON.stringify(projectOnly, null, 2)}\n`);

    const untrustedProject = {
      version: "delegate-fleet.v1",
      lanes: {
        feature: { implementer: "codex", sandbox: "danger-full-access" },
      },
    };
    mkdirSync(join(cfgRepo, ".delegate"), { recursive: true });
    writeFileSync(
      join(cfgRepo, ".delegate", "config.json"),
      `${JSON.stringify(untrustedProject, null, 2)}\n`,
    );
    const rejectUntrustedProject = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: cloned project config fails closed until approved",
      rejectUntrustedProject.status === 2 && /project fleet config is not trusted/.test(rejectUntrustedProject.stderr),
    );

    const writeProject = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", cfgRepo, projectFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config write --scope project", writeProject.status === 0);
    h.check("project config file created", existsSync(join(cfgRepo, ".delegate", "config.json")));
    h.check(
      "project config approval hash lives under git metadata",
      existsSync(join(cfgRepo, ".git", "delegate-skills", "project-config.sha256")),
    );

    // Symlinked .delegate must not escape the repo.
    const escapeRepo = join(fleetRoot, "escape-repo");
    const escapeOutside = join(fleetRoot, "escape-outside");
    mkdirSync(escapeRepo);
    mkdirSync(escapeOutside);
    mkdirSync(join(escapeRepo, ".git", "objects"), { recursive: true });
    mkdirSync(join(escapeRepo, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(escapeRepo, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(escapeRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    try {
      symlinkSync(escapeOutside, join(escapeRepo, ".delegate"));
      const escapeWrite = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", escapeRepo, projectFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        "config write rejects symlinked .delegate",
        escapeWrite.status === 2 &&
          /symlink/.test(escapeWrite.stderr) &&
          !existsSync(join(escapeOutside, "config.json")),
      );
    } catch (error) {
      h.check(`config write symlink guard runnable (${error.code || error.message})`, process.platform === "win32");
    }

    const load = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo],
      { encoding: "utf8", env: process.env },
    );
    h.check("config load exits 0", load.status === 0);
    let effective = null;
    try {
      effective = JSON.parse(load.stdout);
    } catch {
      effective = null;
    }
    h.check(
      "effective feature lane is project (whole-lane replace)",
      effective?.lanes?.feature?.implementer === "claude" &&
        effective?.lanes?.feature?.source === "project" &&
        effective?.lanes?.feature?.effort === "high" &&
        effective?.projectTrusted === true,
    );
    h.check(
      "effective tests lane falls through to global",
      effective?.lanes?.tests?.implementer === "grok" && effective?.lanes?.tests?.source === "global",
    );

    // Outside a project: load with cwd = non-git dir still sees global.
    const loadBare = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", bare],
      { encoding: "utf8", env: process.env },
    );
    let bareEff = null;
    try {
      bareEff = JSON.parse(loadBare.stdout);
    } catch {
      bareEff = null;
    }
    h.check("load outside git uses global only", loadBare.status === 0 && bareEff?.lanes?.feature?.source === "global");
    h.check("load outside git does not invent .delegate", !existsSync(join(bare, ".delegate")));

    // After project whole-lane replace, feature → claude; opencode must fail.
    const afterOverlay = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--lane", "feature"],
      { encoding: "utf8", env: fleetEnv },
    );
    h.check(
      "relay --lane: project overlay remaps implementer (opencode fails)",
      afterOverlay.status === 2 && /use claude-delegate/.test(afterOverlay.stderr),
    );

    writeFileSync(
      join(cfgRepo, ".delegate", "config.json"),
      `${JSON.stringify(untrustedProject, null, 2)}\n`,
    );
    const rejectChangedProject = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: project config changes invalidate approval",
      rejectChangedProject.status === 2 && /project fleet config is not trusted/.test(rejectChangedProject.stderr),
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(fleetRoot, { recursive: true, force: true });
  }
}
