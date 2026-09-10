import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = (h) => join(h.testDir, "..", "skills", "resilient-delegate", "scripts", "resilient.mjs");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runController(h, name, candidates, options = {}) {
  const workDir = h.freshRepo(`work-resilient-${name}`);
  const outDir = join(h.scratch, `out-resilient-${name}`);
  const configPath = join(h.scratch, `resilient-${name}.json`);
  const briefPath = join(h.scratch, `resilient-${name}.txt`);
  writeFileSync(briefPath, "Implement the focused resilient delegation smoke scenario.\n", "utf8");
  writeJson(configPath, {
    schema: "resilient-delegate.config.v1",
    profiles: { smoke: { candidates } },
  });
  if (options.dirty) writeFileSync(join(workDir, "preexisting.txt"), "uncommitted\n", "utf8");
  const args = [SCRIPT(h), "--brief", briefPath, "--cd", workDir, "--profile", "smoke", "--config", configPath, "--out-dir", outDir];
  if (options.allowDirty) args.push("--allow-dirty");
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...h.baseEnv, ...options.env },
  });
  return { run, workDir, outDir, result: existsSync(join(outDir, "result.json")) ? h.result(outDir) : null };
}

function candidate(implementer, extra = {}) {
  return { implementer, ...extra };
}

export function runResilientDelegate(h) {
  // This guard makes the RED phase diagnostic precise: it must fail because Task 2 has
  // not created the controller, not because this test module has a syntax problem.
  if (!existsSync(SCRIPT(h))) {
    h.check("resilient-delegate controller is present for behavioral smoke tests", false);
    return;
  }

  const complete = runController(h, "first-success", [
    candidate("aider", {
      testResult: { status: "completed", finalMessage: "first candidate completed" },
      testTouchedFiles: [" M src/first-success.mjs"],
    }),
    candidate("codex", { testResult: { status: "completed", finalMessage: "must not run" } }),
  ]);
  h.check("resilient: first candidate succeeds and stops the chain",
    complete.run.status === 0 && complete.result?.status === "completed" &&
    complete.result.selectedImplementer === "aider" && complete.result.attempts?.length === 1 &&
    complete.result.touchedFiles?.includes(" M src/first-success.mjs"));

  // The controller's test relay fixture emits each listed outcome in sequence. These
  // cases name the failover boundary: only capacity/infrastructure may advance.
  for (const [name, failure, failureClass] of [
    ["429-rate-limit", { status: "failed", error: "HTTP 429 rate limit exceeded" }, "rate_limited"],
    ["missing-implementer", { status: "aider_unavailable", error: "aider was not found on PATH" }, "missing_implementer"],
    ["unauthenticated", { status: "aider_unavailable", error: "aider is installed but unauthenticated" }, "unauthenticated"],
    ["503", { status: "failed", error: "HTTP 503 service unavailable" }, "service_unavailable"],
    ["529", { status: "failed", error: "HTTP 529 overloaded" }, "overloaded"],
    ["connection", { status: "failed", error: "connection refused by endpoint" }, "connection_failure"],
    ["watchdog", { status: "timeout", error: "relay watchdog timeout" }, "watchdog_timeout"],
  ]) {
    const value = runController(h, name, [candidate("aider", { testResult: failure }), candidate("codex", { testResult: { status: "completed" } })]);
    h.check(`resilient: ${name} advances to the next candidate`,
      value.run.status === 0 && value.result?.selectedImplementer === "codex" && value.result.attempts?.length === 2 &&
      value.result.attempts[0]?.failureClass === failureClass);
  }

  for (const [name, failure, stopReason] of [
    ["permission", { status: "failed", error: "Permission denied" }, "permission_denied"],
    ["bad-arguments", { status: "failed", error: "bad arguments" }, "invalid_arguments"],
    ["malformed-result", { status: "failed", error: "malformed result.json" }, "malformed_result"],
    ["project-failure", { status: "failed", error: "project test failure" }, "project_failure"],
    ["arbitrary", { status: "failed", error: "implementation failed" }, "implementation_failure"],
  ]) {
    const value = runController(h, name, [candidate("aider", { testResult: failure }), candidate("codex", { testResult: { status: "completed" } })]);
    h.check(`resilient: ${name} stops as ${stopReason} without advancing`,
      value.run.status !== 0 && value.result?.selectedImplementer === null && value.result?.stopReason === stopReason &&
      value.result.attempts?.length === 1 && value.result.attempts[0]?.failureClass === stopReason);
  }

  const aggregate = runController(h, "aggregate", [
    candidate("aider", { testResult: { status: "failed", error: "HTTP 429 rate limit exceeded" } }),
    candidate("codex", { testResult: { status: "completed" }, testTouchedFiles: [" M src/example.mjs"] }),
  ]);
  h.check("resilient: aggregate result records attempts, selected implementer, stop reason, and final touched files",
    aggregate.run.status === 0 && Array.isArray(aggregate.result?.attempts) && aggregate.result.attempts.length === 2 &&
    aggregate.result.selectedImplementer === "codex" && typeof aggregate.result.stopReason === "string" &&
    Array.isArray(aggregate.result.touchedFiles) && aggregate.result.touchedFiles.includes(" M src/example.mjs"));

  const dirty = runController(h, "dirty-tree", [candidate("aider")], { dirty: true });
  h.check("resilient: dirty tree is rejected unless explicitly allowed",
    dirty.run.status === 2 && dirty.result === null);
  const allowedDirty = runController(h, "allow-dirty", [candidate("aider", { testResult: { status: "completed" } })], { dirty: true, allowDirty: true });
  h.check("resilient: --allow-dirty permits an explicitly accepted dirty tree",
    allowedDirty.run.status === 0 && allowedDirty.result?.status === "completed");

  for (const effort of ["high", "xhigh"]) {
    const rejected = runController(h, `astra-${effort}`, [candidate("codex", { model: "gpt-6-astra", effort })]);
    h.check(`resilient: Codex Astra ${effort} effort is rejected`, rejected.run.status === 2 && rejected.result === null);
  }
  for (const effort of ["low", "medium"]) {
    const accepted = runController(h, `astra-${effort}`, [candidate("codex", { model: "gpt-6-astra", effort, testResult: { status: "completed" } })]);
    h.check(`resilient: Codex Astra ${effort} effort is accepted`, accepted.run.status === 0 && accepted.result?.status === "completed");
  }
}
