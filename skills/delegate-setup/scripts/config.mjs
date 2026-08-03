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
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  ALL_DIALS,
  CLAUDE_EFFORT,
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

// Fleet maps are small; this bounds memory and work on hostile project files.
const MAX_CONFIG_BYTES = 256 * 1024;
const NONBLOCKING_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
const PROJECT_READ_FLAGS =
  NONBLOCKING_READ_FLAGS |
  (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));

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

/** Repository-shaping environment: set means a repo is in play even if git failed. */
const GIT_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

/** A local rev-parse answers instantly; this only bounds a wedged or hung git. */
const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;

/** Backstop for the marker walk; the root check already terminates it. */
const MAX_GIT_WALK_DEPTH = 256;

function hasEntry(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Did git fail because there is no repository, or because it refused to serve one?
 * Answered by looking for the marker ourselves - git's stderr is localized and
 * version-dependent, so it is not a contract we can parse.
 */
function repositoryMarkerNear(cwd) {
  if (GIT_ENV_VARS.some((name) => process.env[name])) return true;
  let dir = resolve(cwd);
  for (let depth = 0; depth < MAX_GIT_WALK_DEPTH; depth += 1) {
    // Linked worktrees and submodules use a .git FILE, so accept any entry type.
    if (hasEntry(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function gitFailureMessage(cwd, reason) {
  return (
    `cannot determine the git repository for ${cwd}: ${reason}. ` +
    "A project fleet config may apply here, so falling back to the global map would risk " +
    "running a lane the project meant to replace. Common causes: dubious repository ownership " +
    "(git config --global --add safe.directory <path>), a corrupt .git/config, or git missing from PATH."
  );
}

/**
 * One bounded probe for both git paths this file needs. Returns null ONLY when
 * this genuinely is not a repository; throws when git refused to serve one,
 * because a silent global-only fallback swaps a trusted read-only project lane
 * for a same-named global lane that may be write-capable.
 * @returns {{ root: string, gitDir: string } | null}
 */
function gitContext(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_PROBE_TIMEOUT_MS,
    // SIGTERM alone never escalates for a child that ignores it.
    killSignal: "SIGKILL",
    maxBuffer: GIT_PROBE_MAX_BUFFER,
  });
  if (!r.error && r.status === 0) {
    const lines = (r.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2) return { root: lines[0], gitDir: lines[1] };
    throw new Error(gitFailureMessage(cwd, "git reported an unexpected repository layout"));
  }
  if (!repositoryMarkerNear(cwd)) return null;
  let reason;
  if (r.error?.code === "ETIMEDOUT") reason = `git did not respond within ${GIT_PROBE_TIMEOUT_MS} ms`;
  else if (r.error?.code === "ENOENT") reason = "git is not installed or not on PATH";
  else if (r.error) reason = `git could not run (${r.error.code || r.error.message})`;
  else if (r.signal) reason = `git was terminated by ${r.signal}`;
  else reason = `git exited with status ${r.status}`;
  throw new Error(gitFailureMessage(cwd, reason));
}

export function findGitRoot(cwd) {
  return gitContext(cwd)?.root ?? null;
}

export function projectConfigPath(cwd) {
  const git = gitContext(cwd);
  return git ? join(git.root, ".delegate", "config.json") : null;
}

function projectTrustPath(git) {
  return git ? join(git.gitDir, "delegate-skills", "project-config.sha256") : null;
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
    if (implementer === "claude" && !CLAUDE_EFFORT.includes(value)) {
      return `${label}: lane ${laneName}.effort must be one of: ${CLAUDE_EFFORT.join(", ")}`;
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

function lstatProjectEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertProjectPathContained(root, path, operation) {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const rel = relative(realRoot, realPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to ${operation}: project path resolves outside the git repository`);
  }
  return rel;
}

function assertSafeProjectDelegateDirectory(root, delegateDir, operation) {
  const stat = lstatSync(delegateDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to ${operation}: .delegate is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`refusing to ${operation}: .delegate is not a directory`);
  }
  const rel = assertProjectPathContained(root, delegateDir, operation);
  if (rel !== ".delegate" && !rel.startsWith(`.delegate${sep}`)) {
    throw new Error(`refusing to ${operation}: unexpected .delegate path`);
  }
}

/**
 * Refuse project writes that escape the git root via a symlinked `.delegate`.
 */
export function assertSafeProjectConfigPath(cwd, git = gitContext(cwd)) {
  const root = git?.root;
  if (!root) throw new Error("project scope requires a git repository (--cwd)");
  const delegateDir = join(root, ".delegate");
  if (!lstatProjectEntry(delegateDir)) mkdirSync(delegateDir, { recursive: true });
  assertSafeProjectDelegateDirectory(root, delegateDir, "write");
  return join(delegateDir, "config.json");
}

function readBoundedConfigBytes(path, flags) {
  let descriptor;
  try {
    descriptor = openSync(path, flags);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${path}: expected a regular file`);
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`${path}: exceeds the ${MAX_CONFIG_BYTES / 1024} KiB size limit`);
    }
    const raw = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < raw.length) {
      const bytesRead = readSync(descriptor, raw, offset, raw.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === raw.length ? raw : raw.subarray(0, offset);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readConfigFile(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readBoundedConfigBytes(path, NONBLOCKING_READ_FLAGS);
  const parsed = parseConfigDocument(raw.toString("utf8"), path);
  if (!parsed.ok) throw new Error(parsed.error);
  return { path, document: parsed.document, digest: configDigest(raw) };
}

function readProjectConfigFile(path) {
  // projectConfigPath() built this as <git-root>/.delegate/config.json, so the root is
  // recoverable by name - cheaper than a second `git rev-parse` on every dispatch.
  const root = dirname(dirname(path));
  const delegateDir = dirname(path);
  if (!lstatProjectEntry(delegateDir)) return null;
  assertSafeProjectDelegateDirectory(root, delegateDir, "read");
  const configStat = lstatProjectEntry(path);
  if (!configStat) return null;
  // Type first: containment resolves the real path, which throws a raw ENOENT on a
  // dangling symlink instead of the sanitized message a repo-supplied file must get.
  if (!configStat.isFile()) {
    throw new Error(`refusing to read: ${path} is not a regular file`);
  }
  assertProjectPathContained(root, path, "read");
  const raw = readBoundedConfigBytes(path, PROJECT_READ_FLAGS);
  const parsed = parseConfigDocument(raw.toString("utf8"), path);
  if (!parsed.ok) {
    const reason = parsed.error.startsWith(`${path}: invalid JSON (`)
      ? "invalid JSON"
      : "invalid schema";
    throw new Error(`${path}: ${reason}`);
  }
  return { path, document: parsed.document, digest: configDigest(raw) };
}

function configDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function projectConfigTrusted(git, digest) {
  const trustPath = projectTrustPath(git);
  if (!digest || !trustPath || !existsSync(trustPath)) return false;
  return readFileSync(trustPath, "utf8").trim() === digest;
}

function trustProjectConfig(git, digest) {
  const trustPath = projectTrustPath(git);
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
  // One git probe for the whole load: the config path and the trust marker must
  // describe the same repository, and re-probing risks two different answers.
  const git = gitContext(cwd);
  const projectPath = git ? join(git.root, ".delegate", "config.json") : null;
  const globalFile = readConfigFile(globalPath);
  // A repo-supplied project file must not take the user's own global map down
  // with it: `load` still has to render the map so delegate-setup can walk the
  // operator through fixing it. Dispatch is the caller's call - see projectError.
  let projectFile = null;
  let projectError = null;
  if (projectPath) {
    try {
      projectFile = readProjectConfigFile(projectPath);
    } catch (error) {
      projectError = error.message || String(error);
    }
  }
  const projectTrusted = Boolean(projectFile && projectConfigTrusted(git, projectFile.digest));
  const effective = effectiveLanes(globalFile?.document, projectFile?.document);
  return {
    version: CONFIG_VERSION,
    globalPath,
    projectPath,
    globalPresent: Boolean(globalFile),
    // Present means "there is a project file here", readable or not - otherwise
    // an unreadable one looks identical to no project config at all.
    projectPresent: Boolean(projectFile) || projectError !== null,
    projectTrusted,
    projectError,
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
      // Probe once so the config path and the trust marker cannot describe
      // two different repositories.
      const git = scope === "project" ? gitContext(cwd) : null;
      const target =
        scope === "global" ? globalConfigPath() : assertSafeProjectConfigPath(cwd, git);
      const writtenDigest = writeAtomic(target, parsed.document);
      if (scope === "project") trustProjectConfig(git, writtenDigest);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
