#!/usr/bin/env node
/**
 * Run an ordered local-first delegation profile. This controller never commits:
 * it delegates through the installed sibling relays and leaves review and landing
 * to the orchestrator.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const IMPLEMENTERS = new Set(["aider", "agy", "copilot", "codex"]);
const SAFE_EFFORTS = new Set(["low", "medium"]);
const DEFAULT_TIMEOUT = "30m";
const TEST_MODE = process.env.SMOKE_NODE === process.execPath;

const DEFAULT_PROFILES = {
  routine: { candidates: [
    { implementer: "aider", model: "ollama_chat/qwen3-coder:30b", editFormat: "whole" },
    { implementer: "agy", model: "gemini-3.8-flash-medium", effort: "medium" },
    { implementer: "copilot", model: "auto", effort: "medium" },
    { implementer: "codex", model: "gpt-5.6-terra", effort: "medium" },
  ] },
  complex: { candidates: [
    { implementer: "codex", model: "gpt-5.6-sol", effort: "medium" },
    { implementer: "agy", model: "claude-sonnet-4-6", effort: "medium" },
    { implementer: "copilot", model: "auto", effort: "medium" },
    { implementer: "aider", model: "ollama_chat/qwen3-coder:30b", editFormat: "whole" },
  ] },
  critical: { candidates: [
    { implementer: "codex", model: "gpt-6-astra", effort: "medium" },
    { implementer: "agy", model: "claude-opus-4-6-thinking", effort: "medium" },
    { implementer: "copilot", model: "auto", effort: "medium" },
    { implementer: "aider", model: "ollama_chat/qwen3-coder:30b", editFormat: "whole" },
  ] },
};

function fail(message) {
  process.stderr.write(`resilient-delegate: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { brief: null, cd: process.cwd(), profile: "routine", config: null, timeout: DEFAULT_TIMEOUT, outDir: null, allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) fail(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--brief") opts.brief = resolve(value());
    else if (arg === "--cd") opts.cd = resolve(value());
    else if (arg === "--profile") opts.profile = value();
    else if (arg === "--config") opts.config = resolve(value());
    else if (arg === "--timeout") opts.timeout = value();
    else if (arg === "--out-dir") opts.outDir = resolve(value());
    else if (arg === "--allow-dirty") opts.allowDirty = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: resilient.mjs --brief <file> --cd <git-repo> [--profile routine|complex|critical] [--config file] [--timeout duration] [--out-dir dir] [--allow-dirty]\n");
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  if (!opts.brief || !existsSync(opts.brief)) fail("--brief must name an existing file");
  if (!readFileSync(opts.brief, "utf8").trim()) fail("brief must not be empty");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(opts.profile)) fail("--profile must be a bare profile name");
  if (!/^(?:[1-9][0-9]*[hms])+$/.test(opts.timeout)) fail("--timeout must use a positive h/m/s duration");
  return opts;
}

function git(cwd, args) {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd(); }
  catch { return null; }
}

function requireCleanRepo(opts) {
  if (git(opts.cd, ["rev-parse", "--is-inside-work-tree"]) !== "true") fail("--cd must be inside a Git working tree");
  const dirty = git(opts.cd, ["status", "--porcelain"]);
  if (dirty === null) fail("could not inspect the Git working tree");
  if (dirty && !opts.allowDirty) fail("working tree is dirty; pass --allow-dirty to explicitly preserve existing changes");
}

function configFor(opts) {
  if (!opts.config) return { profiles: DEFAULT_PROFILES };
  let value;
  try { value = JSON.parse(readFileSync(opts.config, "utf8")); } catch { fail("--config must contain valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "resilient-delegate.config.v1" || !value.profiles || typeof value.profiles !== "object") {
    fail("config must be an object with schema resilient-delegate.config.v1 and profiles");
  }
  if (Object.keys(value).some((key) => !["schema", "profiles"].includes(key))) fail("config contains an unknown top-level field");
  return value;
}

function validateCandidates(config, profile) {
  const selected = config.profiles[profile];
  if (!selected || typeof selected !== "object" || !Array.isArray(selected.candidates) || selected.candidates.length === 0) fail(`profile "${profile}" must contain candidates`);
  for (const candidate of selected.candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !IMPLEMENTERS.has(candidate.implementer)) fail("each candidate must name aider, agy, copilot, or codex");
    const permitted = ["implementer", "model", "effort", "apiBase", "editFormat"];
    const fixture = ["testResult", "testTouchedFiles", "testExecution"];
    if (Object.keys(candidate).some((key) => !permitted.includes(key) && !(TEST_MODE && profile === "smoke" && fixture.includes(key)))) fail("candidate contains an unsupported field");
    // Codex receives an explicit bounded default, so an otherwise valid simple
    // candidate cannot inherit an unsafe ambient reasoning configuration.
    if (candidate.implementer === "codex" && candidate.effort === undefined) candidate.effort = "medium";
    if (candidate.effort !== undefined && (typeof candidate.effort !== "string" || !SAFE_EFFORTS.has(candidate.effort))) fail("candidate effort must be low or medium");
    if (candidate.implementer === "codex" && !SAFE_EFFORTS.has(candidate.effort)) fail("Codex candidates require low or medium effort");
    if (candidate.model === "gpt-6-astra" && !SAFE_EFFORTS.has(candidate.effort)) fail("GPT-6 Astra effort must be low or medium");
    if (candidate.testResult !== undefined && (!candidate.testResult || typeof candidate.testResult !== "object" || typeof candidate.testResult.status !== "string")) fail("testResult must be a structured relay result");
    if (candidate.testExecution !== undefined && (!candidate.testExecution || typeof candidate.testExecution !== "object" || typeof candidate.testExecution.kind !== "string")) fail("testExecution must name a fixture outcome");
  }
  return selected.candidates;
}

function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function classify(result) {
  const text = `${result.status || ""}\n${result.error || ""}\n${result.finalMessage || ""}\n${(result.stderrTail || []).join("\n")}`.toLowerCase();
  // Semantic failures are terminal even when a relay reports a misleading
  // unavailable status. An unavailable binary is failover-safe; a denied
  // permission or failed project gate is not.
  if (/permission denied|auto-denied|not permitted/.test(text)) return "permission_denied";
  if (/bad arguments?|invalid arguments?|usage:|unknown option|config/.test(text)) return "invalid_arguments";
  if (/malformed result|invalid json/.test(text)) return "malformed_result";
  if (/project (?:test|gate|failure)|test failure|gate failure/.test(text)) return "project_failure";
  if (result.status === "timeout" || /watchdog|timed out/.test(text)) return "watchdog_timeout";
  if (/_unavailable$/.test(result.status || "")) return /unauthenticated|not authenticated|login|api.?key/.test(text) ? "unauthenticated" : "missing_implementer";
  if (/\b429\b|rate.?limit|quota|usage.?limit|billing.?cap/.test(text)) return "rate_limited";
  if (/\b503\b|service unavailable/.test(text)) return "service_unavailable";
  if (/\b529\b|overloaded/.test(text)) return "overloaded";
  if (/connection|econn|network unreachable|socket/.test(text)) return "connection_failure";
  return "implementation_failure";
}

function attemptBrief(original, prior) {
  if (!prior.length) return original;
  return `${original.trimEnd()}\n\nContinuation note: earlier infrastructure outcomes were ${prior.join(", ")}. Inspect the existing working-tree diff before continuing. Do not reuse another provider's session.\n`;
}

function missingArtifactResult(child, implementer) {
  const errorCode = child.error?.code;
  const details = [child.error?.message, child.stderr, child.stdout].filter(Boolean).map(String).join("\n");
  if (errorCode === "ETIMEDOUT" || child.status === 124 || /watchdog|timed out/.test(details)) {
    return { status: "timeout", error: `relay watchdog timeout before result.json${details ? `: ${details}` : ""}`, touchedFiles: [] };
  }
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND"].includes(errorCode) || /connection|econn|network unreachable|socket/.test(details.toLowerCase())) {
    return { status: "failed", error: `connection failure before result.json${details ? `: ${details}` : ""}`, touchedFiles: [] };
  }
  if (errorCode === "ENOENT") return { status: `${implementer}_unavailable`, error: `${implementer} relay could not be spawned`, touchedFiles: [] };
  return { status: "failed", error: `malformed result.json from ${implementer}`, touchedFiles: [] };
}

function invoke(opts, candidate, index, attemptDir, brief) {
  if (candidate.testResult) return { ...candidate.testResult, touchedFiles: candidate.testTouchedFiles ?? [] };
  if (candidate.testExecution) {
    const child = candidate.testExecution.kind === "watchdog"
      ? { status: 124, stderr: "relay watchdog timeout" }
      : candidate.testExecution.kind === "connection"
        ? { error: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, status: null, stderr: "" }
        : { status: 7, stderr: "relay exited without a result" };
    return missingArtifactResult(child, candidate.implementer);
  }
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const relay = join(root, `${candidate.implementer}-delegate`, "scripts", "relay.mjs");
  if (!existsSync(relay)) return { status: `${candidate.implementer}_unavailable`, error: `relay for ${candidate.implementer} is not installed`, touchedFiles: [] };
  mkdirSync(attemptDir, { recursive: true });
  const briefPath = join(attemptDir, "brief.txt");
  writeFileSync(briefPath, brief, "utf8");
  const argv = [relay, "--brief", briefPath, "--cd", opts.cd, "--out-dir", attemptDir, "--timeout", opts.timeout];
  if (candidate.model) argv.push("--model", candidate.model);
  if (candidate.effort) argv.push("--effort", candidate.effort);
  if (candidate.implementer === "aider" && candidate.apiBase) argv.push("--api-base", candidate.apiBase);
  if (candidate.implementer === "aider" && candidate.editFormat) argv.push("--edit-format", candidate.editFormat);
  const child = spawnSync(process.execPath, argv, { cwd: opts.cd, encoding: "utf8", timeout: 2_147_483_647 });
  const resultPath = join(attemptDir, "result.json");
  if (!existsSync(resultPath)) return missingArtifactResult(child, candidate.implementer);
  try { return JSON.parse(readFileSync(resultPath, "utf8")); }
  catch { return { status: "failed", error: `malformed result.json from ${candidate.implementer}`, touchedFiles: [] }; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  requireCleanRepo(opts);
  const candidates = validateCandidates(configFor(opts), opts.profile);
  const outDir = opts.outDir || join(tmpdir(), "resilient-delegate", `${Date.now()}-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const attempts = [];
  const priorInfrastructure = [];
  const original = readFileSync(opts.brief, "utf8");
  for (const [index, candidate] of candidates.entries()) {
    const result = invoke(opts, candidate, index, join(outDir, `attempt-${index + 1}`), attemptBrief(original, priorInfrastructure));
    const failureClass = result.status === "completed" ? null : classify(result);
    attempts.push({ implementer: candidate.implementer, status: result.status, error: result.error ?? null, failureClass, touchedFiles: result.touchedFiles ?? [] });
    if (result.status === "completed") {
      const aggregate = { schema: "resilient-delegate.result.v1", status: "completed", selectedImplementer: candidate.implementer, stopReason: "completed", attempts, touchedFiles: result.touchedFiles ?? [] };
      writeAtomic(join(outDir, "result.json"), aggregate);
      process.exitCode = 0;
      return;
    }
    if (["rate_limited", "missing_implementer", "unauthenticated", "service_unavailable", "overloaded", "connection_failure", "watchdog_timeout"].includes(failureClass)) {
      priorInfrastructure.push(failureClass);
      continue;
    }
    const aggregate = { schema: "resilient-delegate.result.v1", status: "failed", selectedImplementer: null, stopReason: failureClass, attempts, touchedFiles: result.touchedFiles ?? [] };
    writeAtomic(join(outDir, "result.json"), aggregate);
    process.exitCode = 1;
    return;
  }
  const final = attempts.at(-1)?.touchedFiles ?? [];
  writeAtomic(join(outDir, "result.json"), { schema: "resilient-delegate.result.v1", status: "failed", selectedImplementer: null, stopReason: "capacity_exhausted", attempts, touchedFiles: final });
  process.exitCode = 1;
}

main();
