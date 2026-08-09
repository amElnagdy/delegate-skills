import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runVibe(h) {
for (const scenario of [
  { name: "default", relayArgs: [], agent: "accept-edits", forwarded: [], resumed: false },
  { name: "plan only", relayArgs: ["--plan-only"], agent: "plan", forwarded: [], resumed: false },
  {
    name: "full access",
    relayArgs: ["--full-access", "--max-turns", "3", "--max-price", "0.5", "--max-tokens", "1000"],
    agent: "auto-approve",
    forwarded: ["--max-turns", "3", "--max-price", "0.5", "--max-tokens", "1000"],
    resumed: false,
  },
  {
    name: "session and tools",
    relayArgs: ["--session", "vibe-session-1", "--enabled-tools", "read_file", "--disabled-tools", "bash"],
    agent: "accept-edits",
    forwarded: ["--resume", "vibe-session-1", "--enabled-tools", "read_file", "--disabled-tools", "bash"],
    resumed: true,
  },
  {
    name: "resume last",
    relayArgs: ["--resume-last"],
    agent: "accept-edits",
    forwarded: ["--continue"],
    resumed: true,
  },
]) {
  const outDir = join(h.scratch, `out-${scenario.name}-vibe`);
  const workDir = h.freshRepo(`work-${scenario.name}-vibe`);
  const argsFile = join(h.scratch, `args-${scenario.name}-vibe`);
  const run = spawnSync(process.execPath, [
    h.relayPath("vibe"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...scenario.relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: "vibe-success", SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
  });
  const args = existsSync(argsFile)
    ? h.WIN
      ? readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean)
      : JSON.parse(readFileSync(argsFile, "utf8"))
    : [];
  h.check(`vibe ${scenario.name}: relay exits zero`, run.status === 0);
  h.check(`vibe ${scenario.name}: documented argv is exact`,
    JSON.stringify(args) === JSON.stringify([
      "--output", "streaming",
      "--agent", scenario.agent,
      "--trust",
      ...scenario.forwarded,
      "--prompt=smoke brief: run until killed.",
    ]));
  h.check(`vibe ${scenario.name}: result and assistant output are captured`,
    existsSync(join(outDir, "result.json")) &&
    h.result(outDir).status === "completed" &&
    h.result(outDir).finalMessage === "fake vibe completed" &&
    h.result(outDir).resumed === scenario.resumed &&
    h.result(outDir).sessionId === null);
}
for (const [mode, expectedStatus, expectedExit] of [
  ["vibe-version-hang", "timeout", 124],
  ["vibe-version-fail", "failed", 7],
]) {
  const workDir = h.freshRepo(`work-${mode}`);
  const outDir = join(h.scratch, `out-${mode}`);
  const preflight = spawnSync(process.execPath, [
    h.relayPath("vibe"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    "--timeout", "1s",
  ], { env: { ...h.baseEnv, SMOKE_MODE: mode }, encoding: "utf8", timeout: 5000 });
  const value = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
  h.check(`vibe preflight: ${mode} is explicit and prevents dispatch`,
    preflight.status === expectedExit &&
    value.status === expectedStatus &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-unavailable-vibe");
  const outDir = join(h.scratch, "out-unavailable-vibe");
  mkdirSync(outDir);
  writeFileSync(join(outDir, "result.json"), "{\"status\":\"stale\"}\n");
  writeFileSync(join(outDir, "final.txt"), "stale final\n");
  const missing = spawnSync(process.execPath, [
    h.relayPath("vibe"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: { ...process.env, PATH: "" }, encoding: "utf8" });
  h.check("vibe unavailable: structured result replaces stale artifacts",
    missing.status === 127 &&
    h.result(outDir).status === "vibe_unavailable" &&
    !existsSync(join(outDir, "final.txt")));
}
if (!h.WIN) {
  const workDir = h.freshRepo("work-abort-preflight-vibe");
  const outDir = join(h.scratch, "out-abort-preflight-vibe");
  const preflight = h.runRelay("vibe", workDir, outDir, ["--timeout", "1s"], {
    SMOKE_MODE: "vibe-version-hang",
  });
  h.check("vibe preflight abort: run artifacts are prepared",
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
  h.check("vibe preflight abort: result is aborted and dispatch never starts",
    exited &&
    value.status === "aborted" &&
    value.signal === "SIGTERM" &&
    value.error?.includes("version preflight") &&
    value.error?.includes("was not dispatched"));
}
{
  const workDir = h.freshRepo("work-nul-brief-vibe");
  const nulBrief = join(h.scratch, "nul-vibe-brief.txt");
  const outDir = join(h.scratch, "out-nul-brief-vibe");
  writeFileSync(nulBrief, Buffer.from("brief\0tail"));
  const rejected = spawnSync(process.execPath, [
    h.relayPath("vibe"),
    "--brief", nulBrief,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("vibe validation: NUL brief is rejected before artifacts",
    rejected.status === 2 && !existsSync(outDir));
}
if (h.WIN) {
  const workDir = h.freshRepo("work-long-brief-vibe");
  const longBrief = join(h.scratch, "long-vibe-brief.txt");
  const outDir = join(h.scratch, "out-long-brief-vibe");
  writeFileSync(longBrief, "x".repeat(13 * 1024));
  const rejected = spawnSync(process.execPath, [
    h.relayPath("vibe"),
    "--brief", longBrief,
    "--cd", workDir,
    "--out-dir", outDir,
  ], { env: h.baseEnv, encoding: "utf8" });
  h.check("vibe Windows: oversized argv brief is rejected before artifacts",
    rejected.status === 2 && !existsSync(outDir));
}
}
