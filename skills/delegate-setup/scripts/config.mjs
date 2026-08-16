#!/usr/bin/env node
/**
 * config.mjs — load, merge, validate, and write delegate-fleet.v1 lane maps.
 *
 * Usage:
 *   node config.mjs load [--cwd <dir>]
 *   node config.mjs validate <file>
 *   node config.mjs write --scope global|project [--cwd <dir>] <file>
 *   node config.mjs --help
 *
 * Node built-ins only. No network, credentials, or telemetry.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  AGY_EFFORT,
  ALL_DIALS,
  CLAUDE_EFFORT,
  COPILOT_EFFORT,
  CODEX_SANDBOX,
  CONFIG_VERSION,
  GROK_SANDBOX,
  IMPLEMENTER_BY_KEY,
  LANE_NAME,
  MODEL_TOKEN,
  QODER_PERMISSION,
  TIMEOUT_RE,
} from "./implementers.mjs";

/** Same ceiling relays use for --timeout (Node setTimeout max ~24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

const HELP = `config.mjs — load / validate / write delegate-fleet.v1 lane maps

Usage:
  node config.mjs load [--cwd <dir>]
  node config.mjs validate <file>
  node config.mjs write --scope global|project [--cwd <dir>] <file>
  node config.mjs --help

Paths:
  global   ~/.config/delegate-skills/config.json
  project  <git-root>/.delegate/config.json  (requires a git repo)

load prints the effective lane map (project whole-lane replaces global) as JSON.
`;

export function globalConfigPath() {
  // Prefer XDG when set; otherwise ~/.config (homedir() → HOME / USERPROFILE).
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "delegate-skills", "config.json");
}

export function findGitRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  const root = (r.stdout || "").trim();
  return root || null;
}

export function projectConfigPath(cwd) {
  const root = findGitRoot(cwd);
  if (!root) return null;
  return join(root, ".delegate", "config.json");
}

function projectTrustPath(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  const gitDir = (r.stdout || "").trim();
  return gitDir ? join(gitDir, "delegate-skills", "project-config.sha256") : null;
}

function fail(message) {
  process.stderr.write(`config.mjs: ${message}\n`);
  process.exit(2);
}

/**
 * @returns {{ ok: true, document: object } | { ok: false, error: string }}
 */
export function parseConfigDocument(raw, label = "config") {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `${label}: invalid JSON (${error.message})` };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, error: `${label}: expected a JSON object` };
  }
  if (document.version !== CONFIG_VERSION) {
    return {
      ok: false,
      error: `${label}: unsupported version ${JSON.stringify(document.version)} (expected ${CONFIG_VERSION})`,
    };
  }
  if (!document.lanes || typeof document.lanes !== "object" || Array.isArray(document.lanes)) {
    return { ok: false, error: `${label}: lanes must be an object` };
  }
  for (const [name, lane] of Object.entries(document.lanes)) {
    const laneError = validateLane(name, lane, label);
    if (laneError) return { ok: false, error: laneError };
  }
  return { ok: true, document };
}

function validateLane(name, lane, label) {
  if (!LANE_NAME.test(name)) {
    return `${label}: invalid lane name ${JSON.stringify(name)}`;
  }
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
    return `${label}: lane ${name} must be an object`;
  }
  if (typeof lane.implementer !== "string" || IMPLEMENTER_BY_KEY[lane.implementer] == null) {
    return `${label}: lane ${name} needs implementer (one of: ${Object.keys(IMPLEMENTER_BY_KEY).join(", ")})`;
  }
  const impl = IMPLEMENTER_BY_KEY[lane.implementer];
  for (const field of Object.keys(lane)) {
    if (field === "implementer") continue;
    if (!ALL_DIALS.includes(field)) {
      return `${label}: lane ${name} has unknown field ${JSON.stringify(field)}`;
    }
    if (!impl.supports.includes(field)) {
      return `${label}: lane ${name}: ${impl.key} does not support ${field} (supports: ${impl.supports.join(", ") || "none"})`;
    }
    if (field === "readOnly" || field === "force") {
      if (typeof lane[field] !== "boolean") {
        return `${label}: lane ${name}.${field} must be a boolean`;
      }
      continue;
    }
    if (typeof lane[field] !== "string" || lane[field].length === 0) {
      return `${label}: lane ${name}.${field} must be a non-empty string`;
    }
    const valueError = validateDialValue(impl.key, field, lane[field], name, label);
    if (valueError) return valueError;
  }
  if (impl.key === "opencode") {
    if (typeof lane.model !== "string" || !lane.model) {
      return `${label}: lane ${name}: opencode requires model (provider/model)`;
    }
    const separator = lane.model.indexOf("/");
    if (separator <= 0 || !/[^/]/.test(lane.model.slice(separator + 1))) {
      return `${label}: lane ${name}.model must be provider/model (e.g. opencode/grok)`;
    }
  }
  const autonomyError = validateAutonomyConsistency(impl.key, lane, name, label);
  if (autonomyError) return autonomyError;
  return null;
}

function validateAutonomyConsistency(implementer, lane, laneName, label) {
  if (lane.readOnly !== true) return null;
  if (implementer === "codex" && typeof lane.sandbox === "string" && lane.sandbox !== "read-only") {
    return `${label}: lane ${laneName}: readOnly contradicts sandbox ${JSON.stringify(lane.sandbox)}`;
  }
  if (implementer === "grok" && typeof lane.sandbox === "string" && lane.sandbox !== "read-only") {
    return `${label}: lane ${laneName}: readOnly contradicts sandbox ${JSON.stringify(lane.sandbox)}`;
  }
  if (
    implementer === "qoder" &&
    typeof lane.permissionMode === "string" &&
    lane.permissionMode !== "plan"
  ) {
    return `${label}: lane ${laneName}: readOnly contradicts permissionMode ${JSON.stringify(lane.permissionMode)}`;
  }
  if (implementer === "cursor" && lane.force === true) {
    return `${label}: lane ${laneName}: readOnly contradicts force true`;
  }
  return null;
}

function parseTimeoutMs(value) {
  const match = TIMEOUT_RE.exec(value);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function validateDialValue(implementer, field, value, laneName, label) {
  if (field === "timeout") {
    if (parseTimeoutMs(value) === null) {
      return `${label}: lane ${laneName}.timeout must be a positive h/m/s duration no longer than about 24 days (e.g. 30m)`;
    }
    return null;
  }
  if (field === "effort") {
    if (implementer === "agy" && !AGY_EFFORT.includes(value)) {
      return `${label}: lane ${laneName}.effort must be one of: ${AGY_EFFORT.join(", ")}`;
    }
    if (implementer === "claude" && !CLAUDE_EFFORT.includes(value)) {
      return `${label}: lane ${laneName}.effort must be one of: ${CLAUDE_EFFORT.join(", ")}`;
    }
    if (implementer === "copilot" && !COPILOT_EFFORT.includes(value)) {
      return `${label}: lane ${laneName}.effort must be one of: ${COPILOT_EFFORT.join(", ")}`;
    }
    if ((implementer === "codex" || implementer === "grok") && !/^[a-z][a-z0-9-]*$/i.test(value)) {
      return `${label}: lane ${laneName}.effort must be a bare token`;
    }
    return null;
  }
  if (field === "sandbox") {
    if (implementer === "codex" && !CODEX_SANDBOX.includes(value)) {
      return `${label}: lane ${laneName}.sandbox must be one of: ${CODEX_SANDBOX.join(", ")}`;
    }
    if (implementer === "grok" && !GROK_SANDBOX.includes(value)) {
      return `${label}: lane ${laneName}.sandbox must be one of: ${GROK_SANDBOX.join(", ")}`;
    }
    return null;
  }
  if (field === "permissionMode" && implementer === "qoder" && !QODER_PERMISSION.includes(value)) {
    return `${label}: lane ${laneName}.permissionMode must be one of: ${QODER_PERMISSION.join(", ")}`;
  }
  if (field === "variant") {
    // OpenCode appends --variant on win32 shell:true; reject cmd metacharacters.
    if (!MODEL_TOKEN.shellSafe.test(value)) {
      return `${label}: lane ${laneName}.variant has unsupported characters (allowed: letters, digits, . _ : / -)`;
    }
    return null;
  }
  if (field === "model" || field === "provider") {
    const modelError = validateModelOrProvider(implementer, field, value, laneName, label);
    if (modelError) return modelError;
  }
  return null;
}

function validateModelOrProvider(implementer, field, value, laneName, label) {
  if (implementer === "qoder" && !value.trim()) {
    return `${label}: lane ${laneName}.${field} must not be empty`;
  }
  let pattern = null;
  let hint = "";
  if (implementer === "claude") {
    pattern = MODEL_TOKEN.claude;
    hint = "letters, digits, . _ : @ / [ ] -";
  } else if (implementer === "cursor") {
    pattern = MODEL_TOKEN.cursor;
    hint = "letters, digits, . _ : @ / [ ] , = -";
  } else if (
    implementer === "grok" ||
    implementer === "pi" ||
    implementer === "opencode" ||
    // codex (and any other win32 shell:true relay) must not accept cmd metacharacters in -m.
    implementer === "codex" ||
    IMPLEMENTER_BY_KEY[implementer]?.winShell
  ) {
    pattern = MODEL_TOKEN.shellSafe;
    hint = "letters, digits, . _ : / -";
  }
  if (pattern && !pattern.test(value)) {
    return `${label}: lane ${laneName}.${field} has unsupported characters for ${implementer} (allowed: ${hint})`;
  }
  return null;
}

/**
 * Refuse project writes that escape the git root via a symlinked `.delegate`.
 */
export function assertSafeProjectConfigPath(cwd) {
  const root = findGitRoot(cwd);
  if (!root) throw new Error("project scope requires a git repository (--cwd)");
  const delegateDir = join(root, ".delegate");
  if (existsSync(delegateDir) && lstatSync(delegateDir).isSymbolicLink()) {
    throw new Error("refusing to write: .delegate is a symlink");
  }
  mkdirSync(delegateDir, { recursive: true });
  if (lstatSync(delegateDir).isSymbolicLink()) {
    throw new Error("refusing to write: .delegate is a symlink");
  }
  const realRoot = realpathSync(root);
  const realDelegate = realpathSync(delegateDir);
  const rel = relative(realRoot, realDelegate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("refusing to write: .delegate resolves outside the git repository");
  }
  if (rel !== ".delegate" && !rel.startsWith(`.delegate${sep}`)) {
    throw new Error("refusing to write: unexpected .delegate path");
  }
  return join(delegateDir, "config.json");
}

export function readConfigFile(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path);
  const parsed = parseConfigDocument(raw.toString("utf8"), path);
  if (!parsed.ok) throw new Error(parsed.error);
  return { path, document: parsed.document, digest: configDigest(raw) };
}

function configDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function projectConfigTrusted(cwd, digest) {
  const trustPath = projectTrustPath(cwd);
  if (!digest || !trustPath || !existsSync(trustPath)) return false;
  return readFileSync(trustPath, "utf8").trim() === digest;
}

function trustProjectConfig(cwd, digest) {
  const trustPath = projectTrustPath(cwd);
  if (!trustPath) throw new Error("project scope requires writable git metadata");
  mkdirSync(dirname(trustPath), { recursive: true });
  writeFileSync(trustPath, `${digest}\n`, "utf8");
}

/**
 * Effective lanes: start from global, whole-lane replace from project.
 */
export function effectiveLanes(globalDoc, projectDoc) {
  /** @type {Record<string, { lane: object, source: "global"|"project" }>} */
  const out = {};
  if (globalDoc?.lanes) {
    for (const [name, lane] of Object.entries(globalDoc.lanes)) {
      out[name] = { lane: { ...lane }, source: "global" };
    }
  }
  if (projectDoc?.lanes) {
    for (const [name, lane] of Object.entries(projectDoc.lanes)) {
      out[name] = { lane: { ...lane }, source: "project" };
    }
  }
  return out;
}

export function loadEffective(cwd = process.cwd()) {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);
  const globalFile = readConfigFile(globalPath);
  const projectFile = projectPath ? readConfigFile(projectPath) : null;
  const projectTrusted = Boolean(projectFile && projectConfigTrusted(cwd, projectFile.digest));
  const effective = effectiveLanes(globalFile?.document, projectFile?.document);
  return {
    version: CONFIG_VERSION,
    globalPath,
    projectPath,
    globalPresent: Boolean(globalFile),
    projectPresent: Boolean(projectFile),
    projectTrusted,
    lanes: Object.fromEntries(
      Object.entries(effective).map(([name, { lane, source }]) => [
        name,
        { ...lane, source },
      ]),
    ),
  };
}

export function writeAtomic(targetPath, document) {
  const parsed = parseConfigDocument(JSON.stringify(document), "write payload");
  if (!parsed.ok) throw new Error(parsed.error);
  mkdirSync(dirname(targetPath), { recursive: true });
  // Temp file must live beside the target: renameSync across drives fails on Windows (EXDEV).
  const tmp = join(
    dirname(targetPath),
    `.config.${process.pid}.${Date.now()}.tmp`,
  );
  const raw = `${JSON.stringify(parsed.document, null, 2)}\n`;
  try {
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, targetPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
  return configDigest(raw);
}

function main(argv) {
  try {
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
      process.stdout.write(HELP);
      process.exit(argv.length === 0 ? 2 : 0);
    }

    const cmd = argv[0];
    let cwd = process.cwd();
    const cwdIdx = argv.indexOf("--cwd");
    if (cwdIdx !== -1) {
      if (!argv[cwdIdx + 1]) fail("--cwd needs a directory");
      cwd = resolve(argv[cwdIdx + 1]);
    }

    if (cmd === "load") {
      process.stdout.write(`${JSON.stringify(loadEffective(cwd), null, 2)}\n`);
      return;
    }

    if (cmd === "validate") {
      const file = argv.find(
        (a, i) => i > 0 && !a.startsWith("--") && argv[i - 1] !== "--cwd",
      );
      if (!file) fail("validate needs a file path");
      const parsed = parseConfigDocument(readFileSync(resolve(file), "utf8"), file);
      if (!parsed.ok) fail(parsed.error);
      process.stdout.write(`${JSON.stringify({ ok: true, path: resolve(file), lanes: Object.keys(parsed.document.lanes) }, null, 2)}\n`);
      return;
    }

    if (cmd === "write") {
      const scopeIdx = argv.indexOf("--scope");
      const scope = scopeIdx !== -1 ? argv[scopeIdx + 1] : null;
      if (scope !== "global" && scope !== "project") fail("--scope must be global or project");
      const file = argv.filter((a, i) => {
        if (a.startsWith("--")) return false;
        if (i > 0 && (argv[i - 1] === "--cwd" || argv[i - 1] === "--scope")) return false;
        return i > 0;
      }).at(-1);
      if (!file) fail("write needs a JSON file path");
      const parsed = parseConfigDocument(readFileSync(resolve(file), "utf8"), file);
      if (!parsed.ok) fail(parsed.error);
      const target =
        scope === "global" ? globalConfigPath() : assertSafeProjectConfigPath(cwd);
      const writtenDigest = writeAtomic(target, parsed.document);
      if (scope === "project") trustProjectConfig(cwd, writtenDigest);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        path: target,
        lanes: Object.keys(parsed.document.lanes),
        ...(scope === "project" ? { projectTrusted: true } : {}),
      }, null, 2)}\n`);
      return;
    }

    fail(`unknown command ${JSON.stringify(cmd)}. Use --help.`);
  } catch (error) {
    fail(error.message || String(error));
  }
}

// realpath BOTH sides, not resolve: skill dirs are commonly symlinked (e.g.
// ~/.claude/skills → ~/.agents/skills) and a plain resolve() mismatch made this file
// silently no-op when run through a symlink. The module URL side needs it too —
// under --preserve-symlinks-main it keeps the symlink path.
const isMain = (() => {
  if (!process.argv[1]) return false;
  const toReal = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return toReal(process.argv[1]) === toReal(fileURLToPath(import.meta.url));
})();
if (isMain) main(process.argv.slice(2));
