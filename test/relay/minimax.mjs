import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const CONSTANT = ["exec", "--input", "-", "--output-format", "stream-json"];

function dispatch(h, name, relayArgs, mode = "minimax-success") {
  const outDir = join(h.scratch, `out-${name}-minimax`);
  const workDir = h.freshRepo(`work-${name}-minimax`);
  const argsFile = join(h.scratch, `args-${name}-minimax`);
  const run = spawnSync(process.execPath, [
    h.relayPath("minimax"),
    "--brief", h.briefPath,
    "--cd", workDir,
    "--out-dir", outDir,
    ...relayArgs,
  ], {
    env: { ...h.baseEnv, SMOKE_MODE: mode, SMOKE_ARGS_FILE: argsFile },
    encoding: "utf8",
    timeout: 30_000,
  });
  const captured = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : { args: [], brief: "", cwd: "" };
  return { run, outDir, workDir, captured };
}

const samePath = (a, b) => {
  try {
    return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
};

export async function runMinimax(h) {
  {
    const { run, outDir, workDir, captured } = dispatch(h, "success", []);
    const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    if (run.status !== 0) {
      console.error(`minimax stdout:\n${run.stdout}`);
      console.error(`minimax stderr:\n${run.stderr}`);
    }
    h.check("minimax success: exit 0 and status completed", run.status === 0 && result.status === "completed");
    h.check("minimax success: brief arrives on stdin, never argv",
      captured.brief.includes("smoke brief") && !captured.args.some((arg) => arg.includes("smoke brief")));
    h.check("minimax success: argv is exactly the constant exec flags",
      JSON.stringify(captured.args) === JSON.stringify(CONSTANT));
    h.check("minimax success: --cd is the child cwd", samePath(captured.cwd, workDir));
    h.check("minimax success: finalMessage is the exec result output", result.finalMessage === "fake mcode completed");
    h.check("minimax success: session id, resolved model, and usage captured",
      result.sessionId === "mvs_smoke_minimax" &&
      result.resolvedModel === "minimax/MiniMax-Smoke" &&
      result.usage?.totalTokens === 5);
    h.check("minimax success: result schema and tool", result.schema === "delegate-relay.result.v1" && result.tool === "minimax");
    h.check("minimax success: touchedFiles is [] on a clean tree", Array.isArray(result.touchedFiles) && result.touchedFiles.length === 0);
  }
  {
    const { run, captured } = dispatch(h, "dials", [
      "--model", "minimax/MiniMax-M3",
      "--effort", "high",
      "--permission", "full",
      "--max-steps", "5",
      "--session", "mvs_abc123",
    ]);
    h.check("minimax dials: forwarded in mcode's own flags",
      run.status === 0 &&
      JSON.stringify(captured.args) === JSON.stringify([
        ...CONSTANT,
        "--model", "minimax/MiniMax-M3",
        "--effort", "high",
        "--permission", "full",
        "--max-steps", "5",
        "--session", "mvs_abc123",
      ]));
  }
  {
    const { run, captured } = dispatch(h, "resume-last", ["--resume-last"]);
    h.check("minimax --resume-last: maps to --continue",
      run.status === 0 && JSON.stringify(captured.args) === JSON.stringify([...CONSTANT, "--continue"]));
  }
  {
    const { run, outDir } = dispatch(h, "failed", [], "minimax-failed");
    const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : {};
    h.check("minimax failed: an exec result of failed is failed even when mcode exits 0",
      run.status === 1 && result.status === "failed" && result.exitCode === 1);
    h.check("minimax failed: mcode's error is recorded", result.mcodeError?.message === "fake model unavailable");
    h.check("minimax failed: finalMessage falls back to the last agent message", result.finalMessage === "fake mcode progress");
  }
  for (const [name, args] of [
    ["permission ask", ["--permission", "ask"]],
    ["shell metacharacter in --model", ["--model", "a&calc"]],
    ["non-integer --max-steps", ["--max-steps", "5x"]],
    ["--resume-last with --session", ["--resume-last", "--session", "mvs_abc"]],
  ]) {
    const { run, outDir } = dispatch(h, `usage-${name.replace(/[^a-z]+/gi, "-")}`, args);
    h.check(`minimax usage error (${name}): exits 2 with no result`,
      run.status === 2 && !existsSync(join(outDir, "result.json")));
  }
}
