import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runAgy(h) {
  const run = (name, mode, preexistingFile = null) => {
    const outDir = join(h.scratch, `out-${name}-agy`);
    const workDir = h.freshRepo(`work-${name}-agy`);
    if (preexistingFile) writeFileSync(join(workDir, preexistingFile), "pre-existing change\n");
    const result = spawnSync(process.execPath, [
      h.relayPath("agy"),
      "--brief", h.briefPath,
      "--cd", workDir,
      "--out-dir", outDir,
    ], {
      env: { ...h.baseEnv, SMOKE_MODE: mode, ...(preexistingFile ? { SMOKE_EDIT_FILE: preexistingFile } : {}) },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { result, value: existsSync(join(outDir, "result.json")) ? h.result(outDir) : {} };
  };

  const denied = run("permission-denied", "agy-permission-denied");
  h.check("agy permission denial: exit-zero no-op is reported as failed with diagnostics",
    denied.result.status === 1 &&
    denied.value.status === "failed" &&
    denied.value.exitCode === 1 &&
    denied.value.error?.includes("headless --print") &&
    denied.value.stderrTail?.some((line) => line.includes("auto-denied")));

  const silent = run("silent-noop", "agy-silent-noop");
  h.check("agy silent no-op: no final message or edits cannot report completed",
    silent.result.status === 1 &&
    silent.value.status === "failed" &&
    silent.value.exitCode === 1 &&
    silent.value.error?.includes("without a final message"));

  const dirtySilent = run("dirty-silent-noop", "agy-silent-noop", "pre-existing.txt");
  h.check("agy PR #56 regression: pre-existing dirt is not dispatch evidence",
    dirtySilent.result.status === 1 &&
    dirtySilent.value.status === "failed" &&
    dirtySilent.value.exitCode === 1 &&
    dirtySilent.value.error?.includes("without a final message") &&
    dirtySilent.value.touchedFiles?.some((line) => line.endsWith("pre-existing.txt")));

  const dirtyEdited = run("dirty-silent-edit", "agy-silent-edit", "pre-existing.txt");
  h.check("agy PR #56 regression: editing pre-existing dirt is dispatch evidence",
    dirtyEdited.result.status === 0 &&
    dirtyEdited.value.status === "completed" &&
    dirtyEdited.value.exitCode === 0 &&
    dirtyEdited.value.finalMessage === "" &&
    dirtyEdited.value.touchedFiles?.some((line) => line.endsWith("pre-existing.txt")));

  const analysis = run("analysis", "agy-analysis");
  h.check("agy analysis: a report without edits remains completed",
    analysis.result.status === 0 &&
    analysis.value.status === "completed" &&
    analysis.value.exitCode === 0 &&
    analysis.value.finalMessage === "fake agy analysis completed");
}
