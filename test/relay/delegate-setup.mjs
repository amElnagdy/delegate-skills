import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

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
    "discover covers every implementer in the smoke matrix",
    Array.isArray(report?.discovered) &&
      Array.isArray(report?.missing) &&
      [...report.discovered, ...report.missing].map((entry) => entry.key).sort().join(",") ===
        [...h.SKILLS].sort().join(","),
  );

  if (!h.WIN) {
    const commandCodeOverride = join(h.scratch, "commandcode-override");
    writeFileSync(commandCodeOverride, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo override-commandcode; exit 0; fi\nexit 1\n");
    chmodSync(commandCodeOverride, 0o755);
    const overrideDiscover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", COMMANDCODE_BIN: commandCodeOverride },
    });
    const overrideReport = JSON.parse(overrideDiscover.stdout);
    h.check(
      "discover honors COMMANDCODE_BIN outside Windows",
      overrideReport.discovered.some(({ key, path, version }) =>
        key === "commandcode" && path === commandCodeOverride && version === "override-commandcode"),
    );

    // An empty PATH component is the current directory in POSIX lookup, so a
    // relay's spawn would find a binary there. Discovery must agree, or it
    // reports a CLI as missing that dispatch can actually run.
    const cwdProbe = join(h.scratch, "discover-cwd");
    mkdirSync(cwdProbe);
    writeFileSync(
      join(cwdProbe, "codex"),
      '#!/bin/sh\ncase "$1" in --version) echo "9.9.9"; exit 0;; esac\nexit 0\n',
    );
    chmodSync(join(cwdProbe, "codex"), 0o755);
    for (const [label, pathValue] of [
      ["an empty PATH component", delimiter],
      ["a set-but-empty PATH", ""],
    ]) {
      const cwdDiscover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
        encoding: "utf8",
        cwd: cwdProbe,
        env: { ...process.env, PATH: pathValue },
      });
      const cwdReport = cwdDiscover.status === 0 ? JSON.parse(cwdDiscover.stdout) : null;
      h.check(
        `discover honours ${label} as the current directory`,
        cwdReport?.discovered.find((d) => d.key === "codex")?.version === "9.9.9",
      );
    }
  }

  if (h.WIN) {
    const withoutConfiguredCommandCode = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
      encoding: "utf8",
      env: { ...h.baseEnv, COMMANDCODE_BIN: "" },
    });
    const commandCode = JSON.parse(withoutConfiguredCommandCode.stdout);
    h.check(
      "discover uses the Windows cmdc shim instead of cmd.exe",
      commandCode.discovered.some(({ key, path }) =>
        key === "commandcode" && /cmdc\.cmd$/i.test(path)),
    );
    const comspec = h.baseEnv.ComSpec || h.baseEnv.COMSPEC;
    for (const [name, commandCodeBin] of [
      ["bare COMMANDCODE_BIN=cmd", "cmd"],
      ...(comspec ? [["COMMANDCODE_BIN=COMSPEC", comspec]] : []),
    ]) {
      const rejectedOverride = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
        encoding: "utf8",
        env: { ...h.baseEnv, COMMANDCODE_BIN: commandCodeBin },
      });
      const rejectedReport = JSON.parse(rejectedOverride.stdout);
      h.check(
        `discover rejects ${name} on Windows`,
        rejectedReport.missing.some(({ key }) => key === "commandcode") &&
          !rejectedReport.discovered.some(({ key }) => key === "commandcode"),
      );
    }
    const commandCodeShim = join(h.scratch, "commandcode.cmd");
    writeFileSync(commandCodeShim, "@echo override-commandcode\r\n");
    const withCommandCodeShim = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
      encoding: "utf8",
      env: { ...h.baseEnv, COMMANDCODE_BIN: commandCodeShim },
    });
    const shimmedCommandCode = JSON.parse(withCommandCodeShim.stdout);
    h.check(
      "discover probes a configured Command Code .cmd shim",
      shimmedCommandCode.discovered.some(({ key, path, version }) =>
        key === "commandcode" && path === commandCodeShim && version === "override-commandcode"),
    );
    h.check("discover .cmd probes avoid DEP0190 on Windows Node 24+",
      Number(process.versions.node.split(".")[0]) < 24 || !withCommandCodeShim.stderr.includes("DEP0190"));
  }

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

  const grokProbeDir = join(h.scratch, "discover-grok");
  mkdirSync(grokProbeDir);
  const grokProbeSource = `
const fs = require("node:fs");
const [command] = process.argv.slice(2);
if (command === "version" || command === "--version") {
  console.log("fake-grok 1.0.0");
  process.exit(0);
}
if (command !== "models") process.exit(2);
let count = 0;
try { count = Number(fs.readFileSync(process.env.GROK_PROBE_COUNT, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(process.env.GROK_PROBE_COUNT, String(count));
const first = process.env.GROK_PROBE_FIRST;
const observation = count === 1
  ? first
  : first === "models" ? "unauthenticated" : first === "unauthenticated" ? "models" : "ambiguous";
if (observation === "models") {
  console.log("Available models");
  console.log("* grok-code-fast-1 (default)");
} else if (observation === "unauthenticated") {
  console.error("You are not authenticated.");
  process.exit(1);
} else {
  console.error("Temporary service failure.");
  process.exit(1);
}
`;
  if (h.WIN) {
    writeFileSync(join(grokProbeDir, "fake-grok.cjs"), grokProbeSource);
    writeFileSync(
      join(grokProbeDir, "grok.cmd"),
      `@"${process.execPath}" "%~dp0fake-grok.cjs" %*\r\n`,
    );
  } else {
    const grokProbePath = join(grokProbeDir, "grok");
    writeFileSync(grokProbePath, `#!${process.execPath}\n${grokProbeSource}`);
    chmodSync(grokProbePath, 0o755);
  }
  for (const [first, authenticated, modelStatus] of [
    ["models", true, "reported"],
    ["unauthenticated", false, "failed"],
    ["ambiguous", null, "failed"],
  ]) {
    const countPath = join(grokProbeDir, `${first}.count`);
    const grokDiscover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: grokProbeDir,
        GROK_PROBE_COUNT: countPath,
        GROK_PROBE_FIRST: first,
      },
    });
    let grokReport = null;
    try {
      if (grokDiscover.status === 0) grokReport = JSON.parse(grokDiscover.stdout);
    } catch {
      grokReport = null;
    }
    const grok = grokReport?.discovered.find(({ key }) => key === "grok");
    h.check(
      `Grok shares one ${first} observation across auth and model discovery`,
      readFileSync(countPath, "utf8") === "1" &&
        grok?.authenticated === authenticated &&
        grok?.models?.status === modelStatus &&
        (first !== "models" || grok.models.values[0] === "grok-code-fast-1"),
    );
    if (h.WIN && Number(process.versions.node.split(".")[0]) >= 24) {
      h.check(`Grok .cmd probes avoid DEP0190 when ${first}`, !grokDiscover.stderr.includes("DEP0190"));
    }
  }

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
    for (const [field, value] of [["model", "a b;c"], ["effort", "very fast"]]) {
      const badCommandCodeDial = {
        version: "delegate-fleet.v1",
        lanes: { feature: { implementer: "commandcode", [field]: value } },
      };
      const badCommandCodeDialFile = join(cfgRepo, `bad-commandcode-${field}.json`);
      writeFileSync(badCommandCodeDialFile, `${JSON.stringify(badCommandCodeDial)}\n`);
      const rejected = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", badCommandCodeDialFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(`config validate rejects Command Code ${field} tokens the relay would reject`,
        rejected.status === 2);
    }
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

    // OpenCode catalog ids carry '@' and '~', neither of which is a shell metacharacter.
    for (const [shape, model] of [
      ["Workers AI @cf/", "cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
      ["Vertex @default", "google-vertex-anthropic/claude-opus-4-8@default"],
      ["region @eu", "requesty/gpt-6.1-sol@eu"],
      ["OpenRouter ~latest", "openrouter/~anthropic/claude-sonnet-latest"],
    ]) {
      const catalogModel = {
        version: "delegate-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const catalogModelFile = join(cfgRepo, `catalog-opencode-model-${shape.replace(/\W+/g, "-")}.json`);
      writeFileSync(catalogModelFile, `${JSON.stringify(catalogModel)}\n`);
      const acceptCatalogModel = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", catalogModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(`config validate accepts opencode catalog model id (${shape})`, acceptCatalogModel.status === 0);
    }
    // '@' and '~' must not open the door to cmd.exe metacharacters ('&', '%') riding alongside them.
    for (const [index, model] of ["x/@cf & whoami", "x/~%PATH%"].entries()) {
      const badOpenCodeModel = {
        version: "delegate-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const badOpenCodeModelFile = join(cfgRepo, `bad-opencode-model-${index}.json`);
      writeFileSync(badOpenCodeModelFile, `${JSON.stringify(badOpenCodeModel)}\n`);
      const rejectOpenCodeModel = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", badOpenCodeModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        `config validate rejects shell-unsafe opencode model (${model})`,
        rejectOpenCodeModel.status === 2 && /unsupported characters/.test(rejectOpenCodeModel.stderr),
      );
    }

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

    const badAgy = {
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "agy", effort: "ultra" } },
    };
    const badAgyFile = join(cfgRepo, "bad-agy.json");
    writeFileSync(badAgyFile, `${JSON.stringify(badAgy)}\n`);
    const rejectAgy = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badAgyFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown Agy effort",
      rejectAgy.status === 2 && /low, medium, high/.test(rejectAgy.stderr));

    const badCopilot = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "copilot", effort: "foo" } },
    };
    const badCopilotFile = join(cfgRepo, "bad-copilot.json");
    writeFileSync(badCopilotFile, `${JSON.stringify(badCopilot)}\n`);
    const rejectCopilot = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badCopilotFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown copilot effort",
      rejectCopilot.status === 2 && /low, medium, high, xhigh, max/.test(rejectCopilot.stderr));

    const badOmp = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "omp", effort: "inherit" } },
    };
    const badOmpFile = join(cfgRepo, "bad-omp.json");
    writeFileSync(badOmpFile, `${JSON.stringify(badOmp)}\n`);
    const rejectOmp = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badOmpFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown omp thinking effort",
      rejectOmp.status === 2 && /off, auto, minimal, low, medium, high, xhigh, max/.test(rejectOmp.stderr));

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

    const ompThinking = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "omp", effort: "high", model: "google/fake-model" } },
    };
    const ompThinkingFile = join(cfgRepo, "omp-thinking.json");
    writeFileSync(ompThinkingFile, `${JSON.stringify(ompThinking)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", ompThinkingFile], {
      encoding: "utf8",
      env: process.env,
    });
    const ompResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", bare, "--lane", "feature", "--implementer", "omp"],
      { encoding: "utf8", env: process.env },
    );
    let ompDials = null;
    try {
      ompDials = JSON.parse(ompResolve.stdout);
    } catch {
      ompDials = null;
    }
    h.check(
      "lane resolve: omp effort → thinking",
      ompResolve.status === 0 &&
        ompDials?.dials?.thinking === "high" &&
        ompDials?.dials?.effort === undefined &&
        ompDials?.dials?.model === "google/fake-model",
    );
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

    // ---- per-orchestrator agent fleets (global `agents` + selector) ----
    const agentDoc = {
      version: "delegate-fleet.v1",
      lanes: {
        feature: { implementer: "opencode", model: "opencode/shared-fake", variant: "high" },
        tests: { implementer: "grok", effort: "medium" },
      },
      agents: {
        claude: {
          lanes: {
            feature: { implementer: "opencode", model: "opencode/agent-fake" },
            review: { implementer: "claude", readOnly: true },
          },
        },
      },
    };
    const agentFile = join(cfgRepo, "agent-lanes.json");
    writeFileSync(agentFile, `${JSON.stringify(agentDoc, null, 2)}\n`);

    // Validation: the agents map rides the same lane validator shape-by-shape.
    const validateAgents = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", agentFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config validate accepts a map with agent fleets", validateAgents.status === 0);
    for (const [index, [label, doc]] of [
      ["non-object agents", { agents: "claude" }],
      ["unknown agent field", { agents: { claude: { model: "opencode/grok" } } }],
      ["missing lanes object", { agents: { claude: {} } }],
      ["agents array", { agents: [1] }],
      ["unsafe identity ../evil", { agents: { "../evil": { lanes: {} } } }],
      ["agent fleet lane below the shared bar", { agents: { claude: { lanes: { f: { implementer: "opencode" } } } } }],
    ].entries()) {
      const bad = { version: "delegate-fleet.v1", lanes: { ok: { implementer: "claude", effort: "high" } }, ...doc };
      const badFile = join(cfgRepo, `bad-agents-${index}.json`);
      writeFileSync(badFile, `${JSON.stringify(bad, null, 2)}\n`);
      const rejected = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", badFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(`config validate rejects agent fleets: ${label}`, rejected.status === 2);
    }
    // A raw "__proto__" key survives JSON.parse as an own property; build the
    // payload as text or the object literal would swallow it into the prototype.
    const protoFile = join(cfgRepo, "bad-agents-proto.json");
    writeFileSync(
      protoFile,
      `{"version":"delegate-fleet.v1","lanes":{"ok":{"implementer":"claude"}},"agents":{"__proto__":{"lanes":{}}}}\n`,
    );
    const rejectProto = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", protoFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config validate rejects agent fleets: unsafe identity __proto__", rejectProto.status === 2);

    // Project scope never carries agent fleets (fail closed, not silently ignored).
    const projectWithAgents = {
      version: "delegate-fleet.v1",
      lanes: { feature: { implementer: "claude", effort: "high" } },
      agents: { claude: { lanes: {} } },
    };
    const projectWithAgentsFile = join(cfgRepo, "project-agents.json");
    writeFileSync(projectWithAgentsFile, `${JSON.stringify(projectWithAgents, null, 2)}\n`);
    const rejectProjectAgents = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", cfgRepo, projectWithAgentsFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config write --scope project refuses agents (global-only fleets)",
      rejectProjectAgents.status === 2 && /global-scope/.test(rejectProjectAgents.stderr),
    );
    mkdirSync(join(cfgRepo, ".delegate"), { recursive: true });
    writeFileSync(join(cfgRepo, ".delegate", "config.json"), JSON.stringify(projectWithAgents));
    const rejectProjectLoad = spawnSync(process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo], { encoding: "utf8", env: process.env });
    h.check("project config with agents fails load rather than silently ignoring the field",
      rejectProjectLoad.status === 2 && /project fleet config cannot define agents/.test(rejectProjectLoad.stderr));
    rmSync(join(cfgRepo, ".delegate", "config.json"));

    const writeAgents = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "global", agentFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config write --scope global accepts agent fleets", writeAgents.status === 0);

    const agentLoad = (env, extraArgs) => spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo, ...(extraArgs ?? [])],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    const parseOutput = (run) => {
      try { return JSON.parse(run.stdout); } catch { return null; }
    };
    const noSelector = parseOutput(agentLoad());
    h.check(
      "load without a selector uses shared lanes and lists configured fleets",
      noSelector?.lanes?.feature?.model === "opencode/shared-fake" &&
        noSelector?.lanes?.feature?.variant === "high" &&
        noSelector?.agent === null &&
        noSelector?.agentFleets?.join(",") === "claude" &&
        noSelector?.lanes?.review === undefined,
    );
    const claudeByEnv = parseOutput(agentLoad({ DELEGATE_ORCHESTRATOR: "claude" }));
    h.check(
      "DELEGATE_ORCHESTRATOR selects the agent fleet",
      claudeByEnv?.agent === "claude" &&
        claudeByEnv?.lanes?.feature?.model === "opencode/agent-fake" &&
        claudeByEnv?.lanes?.review?.implementer === "claude",
    );
    // Whole-lane replacement: the agent lane replaces the shared lane wholesale,
    // so the shared `variant` dial must not leak into the agent view.
    h.check(
      "agent fleet lane replaces the whole shared lane (no dial merge)",
      claudeByEnv?.lanes?.feature?.variant === undefined,
    );
    const claudeByFlag = parseOutput(agentLoad({}, ["--agent", "claude"]));
    h.check(
      "--agent selects the same fleet, reported as the selector",
      claudeByFlag?.agent === "claude" && claudeByFlag?.chosenBy === "--agent" &&
        claudeByFlag?.lanes?.feature?.model === "opencode/agent-fake",
    );
    // Explicit --agent beats a disagreeing env selector (explicit wins, like dials);
    // the env value would otherwise be unconfigured.
    const flagBeatsEnv = parseOutput(agentLoad({ DELEGATE_ORCHESTRATOR: "cursor" }, ["--agent", "claude"]));
    h.check(
      "--agent wins over DELEGATE_ORCHESTRATOR",
      flagBeatsEnv?.agent === "claude" && flagBeatsEnv?.agentFleets?.join(",") === "claude",
    );
    const rejectUnknownAgent = agentLoad({}, ["--agent", "cursor"]);
    h.check(
      "unknown agent selector fails closed",
      rejectUnknownAgent.status === 2 && /agent "cursor" has no fleet/.test(rejectUnknownAgent.stderr) &&
        /configured: claude/.test(rejectUnknownAgent.stderr),
    );
    const rejectPrototypeAgent = agentLoad({}, ["--agent", "constructor"]);
    h.check("inherited object property cannot masquerade as an agent fleet",
      rejectPrototypeAgent.status === 2 && /has no fleet/.test(rejectPrototypeAgent.stderr));
    const rejectUnsafeEnv = agentLoad({ DELEGATE_ORCHESTRATOR: "../evil" });
    h.check(
      "unsafe DELEGATE_ORCHESTRATOR fails closed",
      rejectUnsafeEnv.status === 2 && /invalid agent selector/.test(rejectUnsafeEnv.stderr),
    );
    const rejectUnsafeFlag = agentLoad({}, ["--agent", "head chair"]);
    h.check(
      "unsafe --agent identity fails closed",
      rejectUnsafeFlag.status === 2 && /invalid agent selector/.test(rejectUnsafeFlag.stderr),
    );
    const emptyEnv = agentLoad({ DELEGATE_ORCHESTRATOR: "   " });
    h.check(
      "whitespace-only DELEGATE_ORCHESTRATOR counts as no selection",
      parseOutput(emptyEnv)?.agent === null && emptyEnv.status === 0,
    );

    // Selector with no agents block at all (shared-only config): fail closed.
    const preventAccidentalRemoval = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8", env: process.env,
    });
    h.check("global write refuses to drop existing agent fleets without explicit approval",
      preventAccidentalRemoval.status === 2 && /would remove agent fleets: claude/.test(preventAccidentalRemoval.stderr) &&
      JSON.parse(readFileSync(join(cfgHome, ".config", "delegate-skills", "config.json"), "utf8")).agents?.claude !== undefined);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", "--allow-agent-removal", goodFile], {
      encoding: "utf8",
      env: process.env,
    });
    const rejectNoFleets = agentLoad({ DELEGATE_ORCHESTRATOR: "claude" });
    h.check(
      "agent selector with no agents block fails closed (no silent shared fleet)",
      rejectNoFleets.status === 2 && /no agent fleets are configured/.test(rejectNoFleets.stderr),
    );
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", agentFile], {
      encoding: "utf8",
      env: process.env,
    });

    // Lane resolution under a selector: agent lanes override same-name shared lanes.
    const agentLaneResolve = (env, extraArgs) => spawnSync(
      process.execPath,
      [
        join(setupDir, "lane.mjs"), "resolve",
        "--cwd", cfgRepo, "--lane", "feature", "--implementer", "opencode",
        ...(extraArgs ?? []),
      ],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    let sharedResolve = null;
    try { sharedResolve = JSON.parse(agentLaneResolve().stdout); } catch { sharedResolve = null; }
    h.check("lane resolve without a selector refuses an overridden shared lane",
      sharedResolve === null && /differs by orchestrator/.test(agentLaneResolve().stderr));
    const deliberateShared = parseOutput(agentLaneResolve({ DELEGATE_ORCHESTRATOR: "__shared__" }));
    h.check("explicit shared selector resolves an overridden shared lane",
      deliberateShared?.dials?.model === "opencode/shared-fake" && deliberateShared?.source === "global");
    let agentResolve = null;
    try { agentResolve = JSON.parse(agentLaneResolve({ DELEGATE_ORCHESTRATOR: "claude" }).stdout); } catch { agentResolve = null; }
    h.check(
      "lane resolve with DELEGATE_ORCHESTRATOR applies agent dials",
      agentResolve?.dials?.model === "opencode/agent-fake" && agentResolve?.dials?.variant === undefined,
    );
    const agentOnlySharedMiss = agentLaneResolve({}, ["--lane", "review", "--implementer", "claude"]);
    h.check(
      "agent-only lane is inaccessible without a selector, with a pointing error",
      agentOnlySharedMiss.status === 2 &&
        /fleet lane "review" differs by orchestrator/.test(agentOnlySharedMiss.stderr) &&
        /DELEGATE_ORCHESTRATOR/.test(agentOnlySharedMiss.stderr),
    );
    const agentOnlyWithSelector = agentLaneResolve({ DELEGATE_ORCHESTRATOR: "claude" }, ["--lane", "review", "--implementer", "claude"]);
    let agentOnlyJson = null;
    try { agentOnlyJson = JSON.parse(agentOnlyWithSelector.stdout); } catch { agentOnlyJson = null; }
    h.check(
      "agent-only lane resolves under its selector",
      agentOnlyWithSelector.status === 0 && agentOnlyJson?.dials?.readOnly === true,
    );
    // Names like "constructor" are legal lane/identity tokens but inherited
    // Object properties must not become accidental lanes or hint lists.
    const prototypeName = agentLaneResolve({}, ["--lane", "constructor"]);
    h.check("prototype property names are not treated as configured lanes",
      prototypeName.status === 2 && /fleet lane not found: constructor/.test(prototypeName.stderr));
    const agentImplementerMismatch = agentLaneResolve({ DELEGATE_ORCHESTRATOR: "claude" }, ["--lane", "feature", "--implementer", "claude"]);
    h.check(
      "agent view keeps implementer containment (mismatch fails loud)",
      agentImplementerMismatch.status === 2 && /use opencode-delegate/.test(agentImplementerMismatch.stderr),
    );

    // Project lanes continue to override both shared and agent-specific global lanes.
    const projectFeature = { version: "delegate-fleet.v1", lanes: { feature: { implementer: "claude", effort: "high" } } };
    const projectFeatureFile = join(cfgRepo, "project-feature.json");
    writeFileSync(projectFeatureFile, `${JSON.stringify(projectFeature, null, 2)}\n`);
    const writeProjectFeature = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", cfgRepo, projectFeatureFile],
      { encoding: "utf8", env: process.env },
    );
    // The project feature lane is implementer claude; under the claude selector it
    // wins over both the shared lane (opencode) and the agents' own feature lane.
    const projectWinnerRun = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "claude", "--agent", "claude"],
      { encoding: "utf8", env: { ...process.env, DELEGATE_ORCHESTRATOR: "claude" } },
    );
    let projectWinner = null;
    try { projectWinner = JSON.parse(projectWinnerRun.stdout); } catch { projectWinner = null; }
    h.check(
      "project lane overrides the agent fleet (trusted project still wins)",
      writeProjectFeature.status === 0 && projectWinner?.source === "project" &&
        projectWinner?.dials?.effort === "high" && projectWinner?.dials?.model === undefined,
    );
    // Restore a pristine project scope and the shared-only global map for the rest
    // of the fleet suite.
    rmSync(join(cfgRepo, ".delegate", "config.json"), { force: true });
    rmSync(join(cfgRepo, ".git", "delegate-skills", "project-config.sha256"), { force: true });
    rmSync(join(cfgRepo, ".git", "delegate-skills"), { recursive: true, force: true });
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", "--allow-agent-removal", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

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

    const agyRoLane = {
      version: "delegate-fleet.v1",
      lanes: { review: { implementer: "agy", effort: "high", readOnly: true } },
    };
    const agyRoFile = join(cfgRepo, "agy-readonly.json");
    writeFileSync(agyRoFile, `${JSON.stringify(agyRoLane)}\n`);
    const writeAgyLane = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "global", agyRoFile],
      { encoding: "utf8", env: process.env },
    );
    const agyLaneOut = join(cfgRepo, "out-agy-lane");
    const agyLaneArgsFile = join(h.scratch, "args-lane-agy");
    const agyLane = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", laneBrief,
      "--cd", cfgRepo,
      "--out-dir", agyLaneOut,
      "--lane", "review",
    ], {
      encoding: "utf8",
      env: { ...fleetEnv, SMOKE_MODE: "agy-analysis", SMOKE_ARGS_FILE: agyLaneArgsFile },
    });
    const agyLaneArgs = existsSync(agyLaneArgsFile)
      ? h.WIN
        ? readFileSync(agyLaneArgsFile, "utf8").split(/\r?\n/).filter(Boolean)
        : JSON.parse(readFileSync(agyLaneArgsFile, "utf8"))
      : [];
    // A readOnly lane dial reaches agy as the sandbox plus auto-approve inside
    // it, not `--mode plan`: plan mode auto-denies the first tool needing a
    // permission prompt, which headless --print cannot answer.
    h.check("relay --lane: Agy applies effort and readOnly dials",
      writeAgyLane.status === 0 &&
      agyLane.status === 0 &&
      h.pair(agyLaneArgs, "--effort", "high") &&
      agyLaneArgs.includes("--sandbox") &&
      agyLaneArgs.includes("--dangerously-skip-permissions") &&
      !agyLaneArgs.includes("--mode") &&
      h.result(agyLaneOut).effort === "high" &&
      h.result(agyLaneOut).readOnly === true);

    const agyDspOut = join(cfgRepo, "out-agy-dsp");
    const agyDspArgsFile = join(h.scratch, "args-dsp-agy");
    const agyDsp = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", laneBrief,
      "--cd", cfgRepo,
      "--out-dir", agyDspOut,
      "--lane", "review",
      "--dangerously-skip-permissions",
    ], {
      encoding: "utf8",
      env: { ...fleetEnv, SMOKE_MODE: "agy-analysis", SMOKE_ARGS_FILE: agyDspArgsFile },
    });
    const agyDspArgs = existsSync(agyDspArgsFile)
      ? h.WIN
        ? readFileSync(agyDspArgsFile, "utf8").split(/\r?\n/).filter(Boolean)
        : JSON.parse(readFileSync(agyDspArgsFile, "utf8"))
      : [];
    h.check("relay --lane: Agy explicit dangerous permissions wins over readOnly lane",
      agyDsp.status === 0 &&
      agyDspArgs.includes("--dangerously-skip-permissions") &&
      !agyDspArgs.includes("--mode") &&
      h.result(agyDspOut).dangerouslySkipPermissions === true &&
      h.result(agyDspOut).readOnly === false);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", "--allow-agent-removal", goodFile], {
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
        env: {
          ...fleetEnv,
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: laneArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    const laneArgs = existsSync(laneArgsFile) ? JSON.parse(readFileSync(laneArgsFile, "utf8")) : [];
    // opencode 2.x has no --variant flag: the relay joins the dials as --model provider/model#variant.
    h.check("relay --lane: opencode applies model+variant from lane",
      laneDispatch.status === 0 &&
        h.pair(laneArgs, "--model", "opencode/grok#high") &&
        !laneArgs.includes("--variant"));
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
        env: {
          ...fleetEnv,
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: overrideArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    const overrideArgs = existsSync(overrideArgsFile) ? JSON.parse(readFileSync(overrideArgsFile, "utf8")) : [];
    h.check("relay --lane: explicit flags win over lane dials",
      overrideRun.status === 0 &&
        h.pair(overrideArgs, "--model", "openai/gpt-test#low") &&
        !overrideArgs.includes("--variant"));

    // ---- relay passes the orchestrator identity through to lane resolution ----
    // Relays never derive the agent from the implementer key: the dispatching
    // orchestrator exports DELEGATE_ORCHESTRATOR and the relay's environment
    // reaches lane.mjs unchanged. Restore the agents doc for these runs.
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", agentFile], {
      encoding: "utf8",
      env: process.env,
    });
    const agentRelayOut = join(cfgRepo, "out-lane-agent-select");
    const agentRelayArgsFile = join(cfgRepo, "args-lane-agent-select.json");
    mkdirSync(agentRelayOut, { recursive: true });
    const agentRelayRun = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--out-dir", agentRelayOut, "--lane", "feature"],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          DELEGATE_ORCHESTRATOR: "claude",
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: agentRelayArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    const agentRelayArgs = existsSync(agentRelayArgsFile) ? JSON.parse(readFileSync(agentRelayArgsFile, "utf8")) : [];
    h.check("relay --lane: DELEGATE_ORCHESTRATOR selects the agent fleet through the relay",
      agentRelayRun.status === 0 &&
        h.pair(agentRelayArgs, "--model", "opencode/agent-fake") &&
        !agentRelayArgs.includes("--variant"));
    h.check("relay --lane: result records agent-selected lane as global source",
      existsSync(join(agentRelayOut, "result.json")) &&
        h.result(agentRelayOut).lane === "feature" &&
        h.result(agentRelayOut).laneSource === "global" &&
        h.result(agentRelayOut).model === "opencode/agent-fake");

    // An empty selector cannot silently select a shared lane overridden by an agent.
    const sharedRelayOut = join(cfgRepo, "out-lane-agent-shared");
    const sharedRelayArgsFile = join(cfgRepo, "args-lane-agent-shared.json");
    mkdirSync(sharedRelayOut, { recursive: true });
    const sharedRelayRun = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--out-dir", sharedRelayOut, "--lane", "feature"],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          DELEGATE_ORCHESTRATOR: "",
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: sharedRelayArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    h.check("relay --lane: empty selector refuses an overridden shared lane",
      sharedRelayRun.status === 2 && /differs by orchestrator/.test(sharedRelayRun.stderr));
    const deliberateSharedRelay = spawnSync(process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--out-dir", sharedRelayOut, "--lane", "feature"],
      { encoding: "utf8", env: { ...fleetEnv, DELEGATE_ORCHESTRATOR: "__shared__", SMOKE_MODE: "capture", SMOKE_ARGS_FILE: sharedRelayArgsFile, SMOKE_VERSION: "opencode v2.0.11" } });
    const explicitSharedArgs = existsSync(sharedRelayArgsFile) ? JSON.parse(readFileSync(sharedRelayArgsFile, "utf8")) : [];
    h.check("relay --lane: explicit shared selector uses shared lanes",
      deliberateSharedRelay.status === 0 && h.pair(explicitSharedArgs, "--model", "opencode/shared-fake#high"));

    // Unconfigured selector: the relay fails loud before spawning the implementer.
    const unknownAgentOut = join(cfgRepo, "out-lane-agent-unknown");
    mkdirSync(unknownAgentOut, { recursive: true });
    const unknownAgentRun = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--out-dir", unknownAgentOut, "--lane", "feature"],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          DELEGATE_ORCHESTRATOR: "cursor",
          SMOKE_MODE: "capture",
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    h.check("relay --lane: unconfigured agent selector fails closed (exit 2, no result)",
      unknownAgentRun.status === 2 &&
        /agent "cursor" has no fleet/.test(unknownAgentRun.stderr) &&
        !existsSync(join(unknownAgentOut, "result.json")));

    // Back to the shared-only global map for the rest of the fleet suite.
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", "--allow-agent-removal", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

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
