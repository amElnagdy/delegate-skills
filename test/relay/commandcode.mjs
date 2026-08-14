import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runCommandCode(h) {
  {
    const outDir = join(h.scratch, "out-success-commandcode");
    const workDir = h.freshRepo("work-success-commandcode");
    const captureFile = join(h.scratch, "capture-success-commandcode.json");
    const run = spawnSync(process.execPath, [
      h.relayPath("commandcode"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--model", "fake/model",
      "--effort", "high",
      "--max-turns", "7",
      "--timeout", "5s",
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "commandcode-success", SMOKE_CAPTURE_FILE: captureFile },
      encoding: "utf8",
      timeout: 15_000,
    });
    h.check("commandcode success: relay exits zero", run.status === 0);
    h.check("commandcode success: unborn HEAD probe stays quiet", run.stderr === "");
    h.check("commandcode success: result.json exists", existsSync(join(outDir, "result.json")));
    h.check("commandcode success: fake captured the launch", existsSync(captureFile));
    if (existsSync(captureFile)) {
      const capture = JSON.parse(readFileSync(captureFile, "utf8"));
      h.check("commandcode success: brief delivered through stdin",
        capture.brief === "smoke brief: run until killed.");
      h.check("commandcode success: print JSON launch selected",
        capture.args.includes("-p") &&
        h.pair(capture.args, "--output-format", "json") &&
        capture.args.includes("--skip-onboarding") &&
        capture.args.includes("--no-auto-update") &&
        !capture.args.includes("smoke brief: run until killed."));
      h.check("commandcode success: trust and write autonomy selected",
        capture.args.includes("--trust") && capture.args.includes("--yolo") && !capture.args.includes("--plan"));
      h.check("commandcode success: model, effort, and turn cap forwarded",
        h.pair(capture.args, "--model", "fake/model") &&
        h.pair(capture.args, "--effort", "high") &&
        h.pair(capture.args, "--max-turns", "7"));
    }
    if (existsSync(join(outDir, "result.json"))) {
      const result = h.result(outDir);
      h.check("commandcode success: status and tool are normalized",
        result.status === "completed" && result.tool === "commandcode");
      h.check("commandcode success: session and final message parsed",
        result.sessionId === "commandcode-session-1" && result.finalMessage === "fake command code completed");
      h.check("commandcode success: usage and duration parsed",
        result.usage?.totalTokens === 9 && result.durationMs === 42);
      h.check("commandcode success: watchdog recorded", result.timeout === "5s");
    }
    if (run.status !== 0) console.error(`commandcode success relay stderr:\n${run.stderr}\n${run.stdout}\n${existsSync(join(outDir, "result.json")) ? readFileSync(join(outDir, "result.json"), "utf8") : ""}`);
  }

  {
    const outDir = join(h.scratch, "out-read-only-commandcode");
    const workDir = h.freshRepo("work-read-only-commandcode");
    const captureFile = join(h.scratch, "capture-read-only-commandcode.json");
    const run = spawnSync(process.execPath, [
      h.relayPath("commandcode"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
      "--read-only",
      "--session", "commandcode-session-1",
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: "commandcode-read-only", SMOKE_CAPTURE_FILE: captureFile },
      encoding: "utf8",
      timeout: 15_000,
    });
    h.check("commandcode read-only: relay exits zero", run.status === 0);
    h.check("commandcode read-only: result.json exists", existsSync(join(outDir, "result.json")));
    h.check("commandcode read-only: fake captured the launch", existsSync(captureFile));
    if (existsSync(captureFile)) {
      const capture = JSON.parse(readFileSync(captureFile, "utf8"));
      h.check("commandcode read-only: plan and exact-session flags selected",
        capture.args.includes("--plan") && h.pair(capture.args, "--resume", "commandcode-session-1"));
      h.check("commandcode read-only: bypass and model override omitted",
        !capture.args.includes("--yolo") && !capture.args.includes("--model"));
    }
    if (existsSync(join(outDir, "result.json"))) {
      const result = h.result(outDir);
      h.check("commandcode read-only: clean tripwire passes",
        result.status === "completed" &&
        result.autonomy === "read-only" &&
        result.requestedSessionId === "commandcode-session-1" &&
        result.readOnlyViolation === false);
    }
    if (run.status !== 0) console.error(`commandcode read-only relay stderr:\n${run.stderr}\n${run.stdout}\n${existsSync(join(outDir, "result.json")) ? readFileSync(join(outDir, "result.json"), "utf8") : ""}`);
  }

  {
    const outDir = join(h.scratch, "out-read-only-write-commandcode");
    const workDir = h.freshRepo("work-read-only-write-commandcode");
    const run = spawnSync(process.execPath, [
      h.relayPath("commandcode"), "--brief", h.briefPath, "--cd", workDir,
      "--out-dir", outDir, "--read-only",
    ], {
      env: {
        ...h.baseEnv,
        SMOKE_MODE: "commandcode-read-only",
        SMOKE_CAPTURE_FILE: join(h.scratch, "capture-read-only-write-commandcode.json"),
        SMOKE_WRITE_FILE: join(workDir, "violation.txt"),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("commandcode read-only violation: relay fails closed",
      run.status === 1 && result.status === "failed" && result.readOnlyViolation === true);
  }

  {
    const outDir = join(h.scratch, "out-staged-commandcode");
    const workDir = h.freshRepo("work-staged-commandcode");
    const tracked = join(workDir, "index-dirty.txt");
    writeFileSync(tracked, "base\n");
    spawnSync("git", ["-C", workDir, "add", "index-dirty.txt"]);
    spawnSync("git", ["-C", workDir, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
    writeFileSync(tracked, "worktree content\n");
    const run = spawnSync(process.execPath, [
      h.relayPath("commandcode"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
    ], {
      env: {
        ...h.baseEnv,
        SMOKE_MODE: "commandcode-success",
        SMOKE_CAPTURE_FILE: join(h.scratch, "capture-staged-commandcode.json"),
        SMOKE_INDEX_ONLY_FILE: "index-dirty.txt",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("commandcode staged-index violation: relay fails closed",
      run.status === 1 && result.status === "failed" && result.gitMutationViolation === true);
  }
}
