#!/usr/bin/env node
/**
 * delegate-skills · codex-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenAI Codex CLI (`codex exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Codex-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codex`, `git` and, on Windows, `tasklist.exe`.
 * The `codex` process it launches does authenticate — exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * It deliberately does NOT commit. Whether Codex's sandbox can write `.git`
 * varies by Codex version, OS, and execution path, so committing is always the
 * orchestrator's job — after it reviews the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Codex (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Codex model (default: Codex's own configured default).
 *   --effort <level>        Reasoning effort, passed to Codex as
 *                           `-c model_reasoning_effort=<level>` (default: Codex's
 *                           own configured default).
 *   --subagent-model <name> Default model for subagents Codex spawns during the run,
 *                           passed as `-c agents.default_subagent_model=<name>`.
 *   --subagent-effort <level>
 *                           Default reasoning effort for those subagents, passed as
 *                           `-c agents.default_subagent_reasoning_effort=<level>`.
 *                           Without either, subagents follow Codex's own config. A model
 *                           TOML reads as a number (e.g. 5.5) fails at startup; an
 *                           unknown model or unsupported effort fails only the spawn, so
 *                           the run can still exit 0. Pass them again on every resume:
 *                           Codex does not carry them over.
 *   --web-search <mode>     Codex's web search mode, passed as `-c web_search=<mode>`
 *                           (Codex's modes: disabled | cached | indexed | live; default:
 *                           Codex's own configured default). Search is a hosted tool, so
 *                           it works under every sandbox, read-only included. Pass it
 *                           again on every resume: Codex does not carry it over.
 *   --network-access        Allow network access inside the workspace-write sandbox, passed
 *                           to Codex as `-c sandbox_workspace_write.network_access=true`.
 *                           Pass it again on every resume, with the sandbox named by
 *                           --sandbox or a fleet lane: Codex does not carry it over.
 *                           Rejected with a read-only sandbox, which Codex keeps offline.
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           An explicit --sandbox/--read-only override applies to the resumed turn.
 *                           "last" is global across parallel sessions: it is not owned by this
 *                           relay invocation, and cwd filtering does not make it safe when parallel
 *                           runs share a workspace. Prefer --session; the relay warns on every use.
 *   --session <id>          Continue a specific Codex session by thread id (from a prior
 *                           result.json). Mutually exclusive with --resume-last.
 *   --isolated              Isolate Codex from ambient user configuration: pass
 *                           --ignore-user-config and --disable apps (ignoring the config alone does
 *                           not remove account connectors), and on Windows preserve a configured
 *                           sandbox backend as `-c windows.sandbox=<value>`. Default: on for a --lane
 *                           whose resolved sandbox is read-only, off otherwise.
 *   --no-isolated           Opt out of that default. Precedence: the last of --isolated /
 *                           --no-isolated, then the lane's `isolated` dial, then the read-only-lane
 *                           default. --clean-env is independent of isolation.
 *   --ignore-user-config    Enables the same isolation bundle, even together with --no-isolated.
 *                           Authentication still uses CODEX_HOME. Ignoring user config also drops
 *                           its default model, custom providers, profiles and approval settings; an
 *                           explicit --model does not restore a custom provider.
 *   --disable <feature>     Disable a Codex feature (repeatable). The name must start with a letter
 *                           or digit, followed by letters, digits, . _ : / -.
 *                           Isolation always disables `apps` as well; duplicates are dropped.
 *   --clean-env             Launch Codex and its version preflight with only runtime basics.
 *                           Changes inherited variables only; does not protect files or other
 *                           same-user secrets.
 *   --keep-env <name>       Keep one additional variable under --clean-env (repeatable).
 *                           Required for environment-backed auth and other stripped variables.
 *   --skip-git-repo-check   Allow running outside a git repository.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the codex child is killed
 *                           and result.json gets status "timeout". Codex has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh, unique dir under
 *                           <temp>/delegate-relay, so the repo under review stays clean). An
 *                           explicit dir is locked for the run (see Output directories).
 *   -h, --help              Show this help.
 *
 * Argument placement: a fresh run puts the isolation flags right after `exec`. A resumed run puts
 * `-s <mode>` before `resume` (observed enforced on resume) and the isolation flags and every `-c`
 * override after the resume target: placed before `resume`, they were observed to leave every
 * command "blocked by policy" while Codex still exited 0. There is no `-c sandbox_mode` fallback.
 * A resume with no explicit or lane sandbox passes no `-s` and keeps Codex's own setting.
 *
 * Windows isolation: an isolated run reads only the `[windows] sandbox` (or top-level
 * `windows.sandbox`) value from $CODEX_HOME/config.toml (else ~/.codex/config.toml) and passes it
 * on. A missing file or key is a warning and the run proceeds with no backend override; an
 * invalid, duplicate, ambiguous or unreadable setting stops before dispatch with status "failed",
 * exit 2 and a published result.json. A Windows run checks (warn-only) for a running node_repl.exe
 * only when it is not danger-full-access, its backend is not resolved to unelevated, and
 * `codex --version` is not known to carry the Desktop ACL fix (openai/codex#51822): older CLIs
 * could fail the elevated setup refresh while node_repl.exe (Codex Desktop) ran. An unknown backend
 * or unrecognised version keeps the check.
 * A sandboxed cwd under %TEMP% can be denied to the sandbox user; use an accessible workspace.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain, null if git can't report), stderrTail on a
 *   run that did not succeed, and the paths to events.jsonl, final.txt and stderr.txt. stderr.txt
 *   holds the complete stderr stream; stderrTail is up to 20 nonblank lines from its final
 *   64 KiB, with a partial first line marked as truncated. Also:
 *   isolated, disabledFeatures, windowsSandbox (null unless passed on), warnings (relay warnings,
 *   also printed to stderr), mcpCalls {count, names: [{server, tool}]}, mcpViolation (an MCP call
 *   in an isolated or known read-only run: reject that result), sandboxFailureReasons,
 *   childExitCode, watchdogFired and abortSignal.
 *
 * Statuses: completed, failed, timeout (the --timeout watchdog fired), aborted (the relay itself
 * was killed and forwarded the kill to codex), codex_unavailable, and sandbox_failed: Codex's
 * stderr (the whole stream, not only the tail) contained "setup refresh had errors" or "blocked by
 * policy", so its sandbox could not run commands even if Codex exited 0. sandbox_failed outranks
 * aborted, which outranks timeout, which outranks failed. An "Access ... is denied" message is not
 * a signature: it can be correct read-only enforcement. Phrases inside events are not scanned.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a busy --out-dir) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127; sandbox_failed
 * exits 1; an invalid Windows isolation setting exits 2 with a result; otherwise the exit code
 * mirrors Codex's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates and the output directory is secured, `result.json` is written on every
 * outcome. An orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 *
 * Output directories: an explicit --out-dir is locked with <dir>/.relay.lock ({pid, startedAt})
 * for the whole run. A second relay on the same dir exits 2 without touching it: that invocation
 * has no result, and any result.json there belongs to the lock owner. Sequential reuse is fine;
 * the next run clears the previous result.json and final.txt. A relay killed outright (on Windows,
 * an orchestrator timeout or stopped task) leaves its lock behind: confirm that relay is gone,
 * then remove the stale lock, or use another directory. The relay never takes a lock over.
 *
 * Windows: a sandboxed run (read-only or workspace-write) gets a PATH with every
 * `WindowsApps` entry removed, for the preflight and the dispatch alike. The Microsoft
 * Store installs apps — including PowerShell 7 — under a folder whose ACLs deny
 * execution to the restricted token Codex's sandbox runs commands with, and Codex
 * prefers a `pwsh` found on PATH, so a Store `pwsh` makes every sandboxed command
 * fail with 0xC0070005. Without those entries Codex falls back to System32
 * powershell.exe. `--sandbox danger-full-access` runs without the restricted token
 * and gets PATH unchanged.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  mkdirSync, mkdtempSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync,
  openSync, fstatSync, readSync, writeSync, closeSync, rmSync, unlinkSync, realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Model reaches cmd.exe on win32 (shell:true for the codex.cmd shim) — same shell-safe
// family as grok/pi. Keep in lockstep with delegate-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// Effort and web search modes are Codex-owned enums that vary by version; the relay
// checks only for a bare token, which also keeps them inert in cmd.exe on win32.
const BARE_TOKEN = /^[a-z][a-z0-9-]*$/i;
// Feature names reach cmd.exe too, so they get the same shell-safe token shape.
const SAFE_FEATURE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const WINDOWS_SANDBOX_VALUES = new Set(["elevated", "unelevated"]);

// Codex config scanning: fixed-size reads. A line is the bytes before its "\n", or before the end
// of the file (the "\r" of a CRLF ending counts); one longer than this is invalid, and its bytes
// are never buffered.
export const MAX_CONFIG_LINE_BYTES = 1024 * 1024;
export const CONFIG_READ_CHUNK_BYTES = 16 * 1024;
// Most arrays plus inline tables a value may hold open at once; one more is invalid, so the
// scanner's bracket tracker never holds more than this many entries.
export const MAX_CONFIG_NESTING_DEPTH = 256;

// Canonical, lower-case stderr phrases that mean Codex's sandbox could not run commands.
const SANDBOX_SIGNATURES = ["setup refresh had errors", "blocked by policy"];
const MCP_LIFECYCLE_EVENTS = new Set(["item.started", "item.updated", "item.completed"]);
const MAX_WARNINGS = 50;
const MAX_WARNING_CHARS = 600;
const PREFLIGHT_TIMEOUT_MS = 2000;
const PREFLIGHT_MAX_BUFFER = 256 * 1024;
const LOCK_NAME = ".relay.lock";
const MAX_LOCK_BYTES = 1024;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const RESUME_LAST_WARNING = '--resume-last: "last" is global across parallel sessions; prefer --session <threadId>. ' +
  "Global means it is not owned by this relay invocation; cwd filtering does not make it safe when parallel runs share a workspace.";
const NO_MODEL_WARNING = "isolated run without an explicit model: ignoring the user config drops its default model, " +
  "custom providers, profiles and approval settings, so Codex uses its built-in default model (pass --model or set a lane model).";
const MCP_NO_ID_WARNING = "MCP tool-call events without an item id were counted once per event, so mcpCalls.count may overstate distinct calls.";

const IMPLEMENTER_KEY = "codex";

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the delegate-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  // Captured before explicit flags filter the dials: an explicit --sandbox overrides the lane's
  // sandbox but must not hide that the lane itself is read-only (the isolation default).
  opts.laneReadOnly = resolved.dials?.sandbox === "read-only";
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (field === "isolated") {
      opts.laneIsolated = typeof value === "boolean" ? value : null;
      continue;
    }
    if (flagged.has(field)) continue;
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (field === "planOnly" && (flagged.has("planOnly") || flagged.has("readOnly"))) continue;
    if (field === "readOnly" && flagged.has("readOnly")) continue;
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
    if (field === "sandbox") opts.sandboxConfigured = true;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    laneReadOnly: false,
    laneIsolated: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    subagentModel: null,
    subagentEffort: null,
    webSearch: null,
    networkAccess: false,
    sandbox: "workspace-write",
    sandboxConfigured: false,
    resumeLast: false,
    session: null,
    cleanEnv: false,
    isolatedFlag: null,
    ignoreUserConfigFlag: false,
    disable: [],
    // Effective values, settled after lane resolution.
    isolated: false,
    ignoreUserConfig: false,
    disabledFeatures: [],
    windowsSandbox: null,
    keepEnv: [],
    skipGitRepoCheck: false,
    timeout: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--subagent-model": opts.subagentModel = next(); break;
      case "--subagent-effort": opts.subagentEffort = next(); break;
      case "--web-search": opts.webSearch = next(); break;
      case "--network-access": opts.networkAccess = true; break;
      case "--sandbox": opts.sandbox = next(); opts.sandboxConfigured = true; flagged.add("sandbox"); break;
      case "--read-only": opts.sandbox = "read-only"; opts.sandboxConfigured = true; flagged.add("sandbox"); flagged.add("readOnly"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--clean-env": opts.cleanEnv = true; break;
      case "--isolated": opts.isolatedFlag = true; flagged.add("isolated"); break;
      case "--no-isolated": opts.isolatedFlag = false; flagged.add("isolated"); break;
      case "--ignore-user-config": opts.ignoreUserConfigFlag = true; break;
      case "--disable": opts.disable.push(next()); break;
      case "--keep-env": opts.keepEnv.push(next()); break;
      case "--skip-git-repo-check": opts.skipGitRepoCheck = true; break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (!SANDBOX_MODES.has(opts.sandbox)) {
    fail(`invalid --sandbox "${opts.sandbox}" (expected: ${[...SANDBOX_MODES].join(", ")})`);
  }
  // Codex ignores the workspace-write network key under read-only and the run stays
  // offline without a word, so refuse the pair rather than record access that never happened.
  if (opts.networkAccess && opts.sandbox === "read-only") {
    fail("--network-access cannot be combined with a read-only sandbox: Codex keeps read-only offline");
  }
  // An unqualified resume runs under Codex's configured sandbox, which may be read-only
  // and drop the override without a word; require the sandbox named so the record holds.
  if (opts.networkAccess && (opts.session || opts.resumeLast) && !opts.sandboxConfigured) {
    fail("--network-access on a resumed run needs the sandbox named by --sandbox (e.g. --sandbox workspace-write) or a fleet lane");
  }
  if (opts.effort !== null && !BARE_TOKEN.test(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected a non-empty bare token)`);
  }
  if (opts.webSearch !== null && !BARE_TOKEN.test(opts.webSearch)) {
    fail(`invalid --web-search "${opts.webSearch}" (expected a non-empty bare token)`);
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.subagentModel !== null && !SAFE_MODEL.test(opts.subagentModel)) {
    fail("--subagent-model contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.subagentEffort !== null && !BARE_TOKEN.test(opts.subagentEffort)) {
    fail(`invalid --subagent-effort "${opts.subagentEffort}" (expected a non-empty bare token)`);
  }
  // Feature names reach cmd.exe on win32, so reject anything outside the model-token shape.
  const invalidFeature = opts.disable.find((name) => !isValidFeatureName(name));
  if (invalidFeature !== undefined) {
    fail(`invalid --disable ${JSON.stringify(invalidFeature)} (a feature name must start with a letter or digit, followed by letters, digits, . _ : / -)`);
  }
  if (opts.keepEnv.length && !opts.cleanEnv) {
    fail("--keep-env requires --clean-env");
  }
  const invalidEnvName = opts.keepEnv.find((name) => !SAFE_ENV_NAME.test(name));
  if (invalidEnvName) {
    fail(`invalid --keep-env "${invalidEnvName}" (expected an environment variable name)`);
  }
  const missingEnvName = opts.keepEnv.find((name) => process.env[name] === undefined);
  if (missingEnvName) {
    fail(`--keep-env "${missingEnvName}" is not set`);
  }
  // The watchdog is relay-only (codex has no timeout flag), so a malformed
  // --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.session !== null && opts.resumeLast) {
    fail("--session and --resume-last are mutually exclusive; pass only one");
  }
  // This value reaches cmd.exe on win32 (shell:true for the codex.cmd shim), so
  // accept only the same shell-safe session token shape used by sibling relays.
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session must be a shell-safe thread id (letters, digits, . _ : -)");
  }
  opts.isolated = resolveIsolation({
    explicit: opts.isolatedFlag ?? opts.laneIsolated,
    laneReadOnly: opts.laneReadOnly,
    ignoreUserConfig: opts.ignoreUserConfigFlag,
  });
  opts.ignoreUserConfig = opts.isolated;
  opts.disabledFeatures = [...new Set([...(opts.isolated ? ["apps"] : []), ...opts.disable])];
  // A resume inherits neither the lane nor isolation, sandbox or feature flags, so the printed
  // resume hint repeats whichever of them this run was given explicitly.
  opts.resumeFlags = [];
  if (opts.lane) opts.resumeFlags.push("--lane", opts.lane);
  if (opts.isolatedFlag !== null || opts.ignoreUserConfigFlag) opts.resumeFlags.push(opts.isolated ? "--isolated" : "--no-isolated");
  if (flagged.has("sandbox")) opts.resumeFlags.push(...(opts.sandbox === "read-only" ? ["--read-only"] : ["--sandbox", opts.sandbox]));
  // --network-access on a resume needs the sandbox named, so a run on the default sandbox (no
  // --sandbox flag and no lane sandbox dial) names it.
  else if (opts.networkAccess && !opts.sandboxConfigured) opts.resumeFlags.push("--sandbox", opts.sandbox);
  for (const feature of new Set(opts.disable)) opts.resumeFlags.push("--disable", feature);
  // Codex carries none of these over to a resumed turn either.
  if (opts.subagentModel !== null) opts.resumeFlags.push("--subagent-model", opts.subagentModel);
  if (opts.subagentEffort !== null) opts.resumeFlags.push("--subagent-effort", opts.subagentEffort);
  if (opts.webSearch !== null) opts.resumeFlags.push("--web-search", opts.webSearch);
  if (opts.networkAccess) opts.resumeFlags.push("--network-access");
  return opts;
}

/**
 * Effective isolation: an explicit --ignore-user-config always enables the bundle; otherwise the
 * explicit CLI/lane value (CLI already folded in by the caller) wins over the read-only-lane default.
 */
export function resolveIsolation({ explicit = null, laneReadOnly = false, ignoreUserConfig = false } = {}) {
  if (ignoreUserConfig) return true;
  if (explicit === true || explicit === false) return explicit;
  return laneReadOnly === true;
}

const DESKTOP_ACL_FIX_VERSION = /^(?:codex-cli[ \t]+)?(\d+)\.(\d+)\.(\d+)(?:-(alpha\.10\.2))?$/;

/**
 * Is this `codex --version` output a CLI known to carry the Windows Desktop ACL fix
 * (openai/codex#51822)? Stable 0.163.0 and later, plus the one tested prerelease
 * 0.163.0-alpha.10.2. Other prereleases, build metadata and unrecognised output are not known
 * fixed. An advisory recognizer, not SemVer validation.
 */
export function hasWindowsDesktopAclFix(version) {
  if (typeof version !== "string") return false;
  const match = DESKTOP_ACL_FIX_VERSION.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (match[4]) return major === 0 && minor === 163 && patch === 0;
  return major > 0 || minor >= 163;
}

/**
 * Which Windows-only checks a run needs. Off win32 there are none. The process preflight is skipped
 * for danger-full-access, for a backend resolved to unelevated (it runs no setup helper) and for a
 * CLI known to carry the Desktop ACL fix; an unknown backend or version keeps it.
 */
export function windowsRuntimeChecks(platform, { ignoreUserConfig = false, sandbox, windowsSandbox = null } = {}, version = null) {
  const win = platform === "win32";
  return {
    readSandboxSetting: win && ignoreUserConfig === true,
    preflight: win && sandbox !== "danger-full-access" && windowsSandbox !== "unelevated" && !hasWindowsDesktopAclFix(version),
  };
}

export function isValidFeatureName(value) {
  return typeof value === "string" && SAFE_FEATURE.test(value);
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
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

function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function headerComment() {
  return helpTextFrom(readFileSync(new URL(import.meta.url), "utf8"));
}

/**
 * --help text from relay.mjs source: its leading block comment, comment prefix stripped, with LF
 * line breaks only. Normalises CRLF and lone CR first: a CRLF checkout would otherwise leak
 * carriage returns into the output.
 */
export function helpTextFrom(source) {
  const src = String(source).replace(/\r\n?/g, "\n");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs \u2014 dispatch a brief to codex exec\n";
  return match[1].replace(/^[ \t]*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function versionProbeTimeout(opts) {
  // The watchdog is only armed once codex is running, so the preflight needs a bound of
  // its own: a `codex --version` that never returns would wedge the relay here, before
  // any result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function codexEnv(opts) {
  const env = opts.cleanEnv ? cleanEnvironment(opts) : { ...process.env };
  if (process.platform === "win32" && opts.sandbox !== "danger-full-access") removeWindowsAppsFromPath(env);
  return env;
}

function cleanEnvironment(opts) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "CODEX_HOME", "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "PATHEXT", "COMSPEC", ...opts.keepEnv];
  return Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

// Both Store roots: "C:\Program Files\WindowsApps\<package>" and the per-user alias
// folder "%LOCALAPPDATA%\Microsoft\WindowsApps" (a symlink into the same protected tree).
const WINDOWS_APPS_PATH_ENTRY = /(^|[\\/])WindowsApps([\\/]|$)/i;

function removeWindowsAppsFromPath(env) {
  // process.env is case-insensitive on win32, but a spread copy keeps the original key
  // casing ("Path"), and a caller-built env may carry both spellings — rewrite every one.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== "PATH") continue;
    env[key] = env[key].split(";").filter((entry) => !WINDOWS_APPS_PATH_ENTRY.test(entry)).join(";");
  }
}

function codexVersion(probeTimeoutMs, env) {
  // On Windows, npm installs `codex` as a .cmd shim; Node's CreateProcess only
  // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
  // ENOENTs on a working install. POSIX is unaffected. (git installs a real
  // git.exe and must NOT get this flag — see gitTouchedFiles.)
  // spawnSync, not execSync: the probe's stderr is needed even when it exits 0, because a
  // broken sandbox can print a failure signature and still report a version.
  const options = { encoding: "utf8", timeout: probeTimeoutMs, killSignal: "SIGKILL", env };
  const r = process.platform === "win32"
    ? spawnSync("codex --version", { ...options, shell: true })
    : spawnSync("codex", ["--version"], options);
  const stderr = String(r.stderr || "");
  if (r.error?.code === "ENOENT") return { version: null, error: null, stderr };
  // shell:true routes a missing binary through cmd.exe, which reports it as a non-zero
  // exit rather than ENOENT; that is still "not installed", not a broken install.
  if (process.platform === "win32" && r.status !== 0 &&
      /not recognized as an internal or external command/i.test(stderr)) {
    return { version: null, error: null, stderr };
  }
  // Anything else — a hung probe we killed, or a real non-zero exit — means codex is
  // installed but not usable. Reporting that as "unavailable" would send the caller
  // off to reinstall a binary that is already there.
  if (r.error || r.signal || r.status !== 0) {
    return { version: null, error: { code: r.error?.code, status: r.status, signal: r.signal, stderr }, stderr };
  }
  return { version: String(r.stdout || "").trim() || "unknown", error: null, stderr };
}

/**
 * Build the `codex` argv. Pure: same input, same output, input untouched.
 *
 * Fresh: exec <isolation> --json -o <final> -s <mode> [-m] [-c effort] [--skip-git-repo-check] -
 * Resume: exec [-s <mode>] resume <id>|--last --json -o <final> [-m] [-c effort] [...] <isolation> -
 *
 * On resume, `-s` before `resume` is enforced for the resumed turn (verified: a resumed write was
 * denied), while the isolation flags and `-c` overrides only take effect after the resume target
 * (placed before it, every command was "blocked by policy" and Codex still exited 0).
 */
export function buildArgv(opts, finalPath, platform = process.platform) {
  const resuming = Boolean(opts.session || opts.resumeLast);
  const isolation = [];
  if (opts.ignoreUserConfig) isolation.push("--ignore-user-config");
  for (const feature of opts.disabledFeatures || []) isolation.push("--disable", feature);
  // The bare enum works as a -c value (an unparseable TOML value is taken as a literal string),
  // and an allowlisted token needs no cmd.exe quoting. Windows-only: no POSIX branch exists.
  if (platform === "win32" && opts.ignoreUserConfig && WINDOWS_SANDBOX_VALUES.has(opts.windowsSandbox)) {
    isolation.push("-c", `windows.sandbox=${opts.windowsSandbox}`);
  }
  const argv = ["exec"];
  if (resuming) {
    // Reapply only an explicitly selected sandbox; otherwise leave the active Codex config alone.
    if (opts.sandboxConfigured) argv.push("-s", opts.sandbox);
    if (opts.session) argv.push("resume", opts.session);
    else argv.push("resume", "--last");
  } else {
    argv.push(...isolation);
  }
  // ponytail: shell:true on win32 (needed for the codex.cmd shim) doesn't quote
  // args, so a temp path with spaces (C:\Users\First Last\...) splits and the
  // trailing "-" misparses (issue #3). Quote the only spaceable arg in argv.
  // Ceiling: if quoting proves too blunt, drop shell:true and resolve the shim.
  const outPath = platform === "win32" ? `"${finalPath}"` : finalPath;
  argv.push("--json", "-o", outPath);
  if (!resuming) {
    argv.push("-s", opts.sandbox);
  }
  if (opts.model) argv.push("-m", opts.model);
  // `-c` is accepted by the resume subcommand after the target, so the effort, subagent, web search
  // and network overrides apply to fresh and resumed runs alike. Keep every `-c` after `resume`:
  // once one follows it, Codex drops any placed before it.
  if (opts.effort != null) argv.push("-c", `model_reasoning_effort=${opts.effort}`);
  if (opts.subagentModel != null) argv.push("-c", `agents.default_subagent_model=${opts.subagentModel}`);
  if (opts.subagentEffort != null) argv.push("-c", `agents.default_subagent_reasoning_effort=${opts.subagentEffort}`);
  if (opts.webSearch != null) argv.push("-c", `web_search=${opts.webSearch}`);
  if (opts.networkAccess) argv.push("-c", "sandbox_workspace_write.network_access=true");
  if (opts.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  if (resuming) argv.push(...isolation);
  argv.push("-"); // read the prompt from stdin
  return argv;
}

// ---------------------------------------------------------------------------------------------
// Windows sandbox setting: a narrow, bounded line scanner for one scalar in Codex's config.toml.
// It never builds a configuration object, never interprets other values, and never echoes a
// configuration line: reasons are fixed strings plus a line number.
// By design, once a line has held a multiline string delimiter or ended inside an open array or
// inline table, any later line that mentions windows or sandbox as a whole word (not inside a longer
// bare key such as sandbox_mode), or that holds a complete \xHH, \uHHHH or \UHHHHHHHH escape (which
// could spell either name), makes the scan invalid: the scanner cannot attribute such a line to the
// right table, so a config like that must be edited by hand. A backslash that does not start a
// complete escape, as in a Windows path such as C:\Users, does not count.
// ---------------------------------------------------------------------------------------------

const TARGET_PATH = ["windows", "sandbox"];
const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
// A whole-word mention of either name (not inside a longer bare key such as sandbox_mode).
const MENTION = /(?<![A-Za-z0-9_-])(?:windows|sandbox)(?![A-Za-z0-9_-])/i;
// A complete \xHH, \uHHHH or \UHHHHHHHH escape (hex in either case): in a quoted key it could spell
// either name without containing it. An incomplete one (\u12, \xZ1) or a Windows path such as
// C:\Users is not an escape.
const ESCAPE = /\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2})/;
const TARGET_VALUE = /^[ \t]*(["'])(elevated|unelevated)\1[ \t]*(?:#.*)?$/;

function skipBlank(text, index) {
  let i = index;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

// Stands for a basic-string key component with an escape: escapes are never decoded, so such a
// component may name anything, including "windows" or "sandbox".
const ANY_KEY = Symbol("escaped key component");
const couldBe = (part, name) => part === ANY_KEY || part === name;

/**
 * Parse a dotted key (bare or quoted components) at index; null when unsupported. A basic-string
 * component containing an escape becomes ANY_KEY.
 */
function parseKeyPath(text, index) {
  const parts = [];
  let i = index;
  for (;;) {
    i = skipBlank(text, i);
    const quote = text[i];
    if (quote === "'") {
      const end = text.indexOf(quote, i + 1);
      if (end === -1) return null;
      parts.push(text.slice(i + 1, end));
      i = end + 1;
    } else if (quote === '"') {
      let end = i + 1;
      let escaped = false;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") {
          escaped = true;
          end += 1;
        }
        end += 1;
      }
      if (end >= text.length) return null;
      parts.push(escaped ? ANY_KEY : text.slice(i + 1, end));
      i = end + 1;
    } else {
      BARE_KEY.lastIndex = i;
      const match = BARE_KEY.exec(text);
      if (!match) return null;
      parts.push(match[0]);
      i += match[0].length;
    }
    i = skipBlank(text, i);
    if (text[i] !== ".") return { parts, end: i };
    i += 1;
  }
}

function parseHeader(text, index) {
  let i = index + 1;
  const array = text[i] === "[";
  if (array) i += 1;
  const key = parseKeyPath(text, i);
  if (!key) return null;
  i = key.end;
  if (text[i] !== "]") return null;
  i += 1;
  if (array) {
    if (text[i] !== "]") return null;
    i += 1;
  }
  i = skipBlank(text, i);
  if (i < text.length && text[i] !== "#") return null;
  return { array, parts: key.parts };
}

const samePath = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
// "could": an ANY_KEY component matches any name.
const couldMatchPath = (path, target) => path.length === target.length && target.every((name, i) => couldBe(path[i], name));
const couldStartWith = (path, prefix) => path.length >= prefix.length && prefix.every((name, i) => couldBe(path[i], name));

// terminated: the line ended at a "\n". Only then is a final "\r" a CRLF ending to strip.
function scanConfigLine(state, raw, terminated) {
  const invalid = (reason) => { state.invalid = `${reason} (line ${state.lineNo})`; };
  let line = raw;
  if (state.lineNo === 1 && line.startsWith("\xEF\xBB\xBF")) line = line.slice(3);
  if (terminated && line.endsWith("\r")) line = line.slice(0, -1);
  // Any other CR is a lone CR, invalid TOML (including one at the end of the file with no "\n"
  // after it): final, like the tracker's unknown below.
  if (line.includes("\r")) {
    invalid("the scan cannot follow the syntax here and cannot classify the lines after it");
    return;
  }
  // Track whether lines sit inside a multiline string.
  if (state.stringMode !== "unknown") {
    state.stringMode = advanceStringState(state.stringMode, line, state.valueContext);
    if (state.valueContext.tooDeep) {
      // Final: nothing else on this line is classified, and finishLine skips the lines after it.
      invalid(`a value nests deeper than ${MAX_CONFIG_NESTING_DEPTH} levels`);
      return;
    }
    if (state.stringMode === "unknown") {
      // Final, like tooDeep: the lines after this one cannot be classified.
      invalid("the scan cannot follow the syntax here and cannot classify the lines after it");
      return;
    }
  }
  // After a delimiter or inside a multi-line value the recorded section and key position cannot be
  // trusted (a string body or nested element can look like a header or key), so any later whole-word
  // mention of windows or sandbox (or a complete \xHH, \uHHHH or \UHHHHHHHH escape that could spell
  // one; a Windows path such as C:\Users is not an escape) is ambiguous.
  // This line itself is judged by the state before it, and the flag is set below.
  if (state.ambiguousAfter && (MENTION.test(line) || ESCAPE.test(line))) {
    invalid("windows or sandbox follows a multiline string delimiter or a multi-line value, so windows.sandbox is ambiguous");
    return;
  }
  if (state.valueContext.stack.length > 0) state.ambiguousAfter = true;
  const start = skipBlank(line, 0);
  if (start >= line.length) return;
  if (line[start] === "#") return;
  if (line.includes('"""') || line.includes("'''")) state.ambiguousAfter = true;

  if (line[start] === "[") {
    const header = parseHeader(line, start);
    if (!header) {
      state.kind = "unknown";
      state.section = null;
      return;
    }
    state.kind = header.array ? "array" : "table";
    state.section = header.parts;
    if (!header.array && couldStartWith(header.parts, TARGET_PATH)) invalid("windows.sandbox is declared as a table");
    return;
  }

  const key = parseKeyPath(line, start);
  if (!key || line[key.end] !== "=") {
    // Not a supported key/value line. Ignore it unless it might be assigning the target.
    const eq = line.indexOf("=", start);
    const lhs = eq === -1 ? "" : line.slice(start, eq);
    const mayBeTarget = state.kind === "unknown" ||
      (state.kind === "table" && (state.section.length === 0 || couldMatchPath(state.section, ["windows"])));
    if (/sandbox/i.test(lhs) && mayBeTarget) invalid("an unsupported assignment may define windows.sandbox");
    return;
  }
  const keyParts = key.parts;
  const value = line.slice(key.end + 1);
  if (state.kind === "unknown") {
    if (keyParts.some((part) => couldBe(part, "sandbox")) || couldBe(keyParts[0], "windows")) {
      invalid("a sandbox key follows an unsupported table header");
    }
    return;
  }
  if (state.kind === "array") return;
  const full = [...state.section, ...keyParts];
  if (full.includes(ANY_KEY) && couldStartWith(full, TARGET_PATH)) {
    invalid("an escaped key may name windows.sandbox; escaped keys are unsupported");
    return;
  }
  if (samePath(full, TARGET_PATH)) {
    state.targets += 1;
    if (state.targets > 1) {
      invalid("windows.sandbox is defined more than once");
      return;
    }
    const match = TARGET_VALUE.exec(value);
    if (!match) {
      invalid('windows.sandbox is not a supported literal (expected "elevated" or "unelevated")');
      return;
    }
    state.value = match[2];
    return;
  }
  if (couldStartWith(full, TARGET_PATH)) {
    invalid("keys are defined beneath windows.sandbox");
    return;
  }
  if (couldMatchPath(full, ["windows"])) {
    // An assignment to the windows ancestor: an inline table there can define windows.sandbox, and
    // one that continues past its line (open string or bracket) may define it on a later line.
    const continues = state.stringMode !== null || state.valueContext.stack.length > 0;
    if (value.trimStart().startsWith("{") && (continues || /sandbox/.test(value) || value.includes("\\"))) {
      invalid("windows.sandbox is defined through an inline table, which is unsupported");
    }
  }
}

// A bare scalar's characters, and a local date that one space and a digit turn into a date-time.
const BARE_SCALAR_START = /[A-Za-z0-9_+\-.:]/;
const BARE_SCALAR = /[A-Za-z0-9_+\-.:]*/y;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGIT = /[0-9]/;

/** End index of the bare scalar that starts at index (a BARE_SCALAR_START character). */
function bareScalarEnd(line, index) {
  BARE_SCALAR.lastIndex = index;
  let end = index + BARE_SCALAR.exec(line)[0].length;
  if (line[end] === " " && DIGIT.test(line[end + 1] ?? "") && end - index === 10 && LOCAL_DATE.test(line.slice(index, end))) {
    BARE_SCALAR.lastIndex = end + 1;
    end += 1 + BARE_SCALAR.exec(line)[0].length;
  }
  return end;
}

/**
 * Multiline-string state after `line`, starting from `mode` (null outside a string, or the open
 * delimiter). Tracks comments and single-line strings so their quotes are not mistaken for
 * delimiters; accurate for valid TOML. `ctx` is the value-context tracker, carried across lines
 * and mutated here: `stack` holds the open "array" / "table" (inline table) brackets and `pos`
 * says what the next token is: a "key", a "value", "after" a complete value, or the rest of a
 * table "header" line (a `[` in a key position with no bracket open; parseHeader validates it, so
 * only its quotes are followed there). A `"""`/`'''` opens a multiline string only where a value
 * may start; one anywhere else (in a key position, after a complete value, on a table header line)
 * is invalid TOML and returns "unknown", which the caller turns into a final invalid verdict.
 * In a value position a bare scalar (number, boolean, date or time) runs over BARE_SCALAR
 * characters, plus one space when a date is followed by a digit (a local date-time); it never
 * spans lines. Any other character that cannot start a value there returns "unknown". After a
 * complete value only blanks, a comment, a `,` inside an open bracket or the open bracket's closer
 * may follow; anything else (a second value, key or `=`) returns "unknown" too.
 * When a line ends outside a string with no bracket open, the next line starts at a key, unless
 * it ended (or reached a `#` comment) in a value position right after `=`: that is a missing value
 * and returns "unknown". Inside an open bracket a line may end waiting for a value.
 * In a key position `ctx.key` tracks the key: "none" before any key character, "bare" inside a bare
 * key, "part" after a complete component and "dot" after a `.`. Once key characters have started, only
 * blanks, a `.` between components, more of the same bare key and the `=` may follow on that line.
 * These return "unknown": a line that ends, or reaches a `#` comment, after key characters with no `=`
 * (inside an open inline table too, since a key never spans lines); a second component
 * with no `.` between (`a b`, `"a" b`, `a "b"`, `"a"b`); a `.` with no component before or after it
 * (`.a`, `a..b`, `a. =`); a `[`, `]`, `{`, `}` or `,` right after key characters; and an `=` with
 * no key before it (`= 5`, `{ = 1 }`). A bare key character is `A-Za-z0-9_-`, or a byte of 0x80 or
 * more (a Unicode key, deliberately accepted). Any other ASCII character in a bare key (`a+b`, `a/b`,
 * `a$b`, a control character) is invalid TOML and returns "unknown" too.
 * A single-line string (basic or literal) with no closing quote is invalid TOML and returns
 * "unknown" too. A bracket that would hold more than MAX_CONFIG_NESTING_DEPTH open at once is
 * never pushed: it sets `ctx.tooDeep` and returns "unknown" at once, so `stack` stays bounded;
 * the caller turns the flag into the invalid verdict. A `]` or `}` that does not match the open
 * bracket on top of the stack (`]` needs an array, `}` an inline table) also returns "unknown".
 */
function advanceStringState(mode, line, ctx) {
  let current = mode;
  let i = 0;
  const top = () => ctx.stack[ctx.stack.length - 1];
  // Push an open bracket; false (and nothing pushed) when that would pass the depth cap.
  const open = (kind) => {
    if (ctx.stack.length >= MAX_CONFIG_NESTING_DEPTH) {
      ctx.tooDeep = true;
      return false;
    }
    ctx.stack.push(kind);
    return true;
  };
  const finish = (result) => {
    // Key characters with no `=` are invalid at any bracket depth (a key never spans lines).
    if (result === null && ctx.pos === "key" && ctx.key !== "none") return "unknown";
    if (result === null && ctx.stack.length === 0) {
      if (ctx.pos === "value") return "unknown"; // the line ended right after `=` with no value
      ctx.pos = "key";
    }
    if (result === null) ctx.key = "none";
    return result;
  };
  while (i < line.length) {
    if (current === '"""') {
      if (line[i] === "\\") {
        i += 2;
      } else if (line.startsWith('"""', i)) {
        i += 3;
        for (let extra = 0; extra < 2 && line[i] === '"'; extra += 1) i += 1; // `""""` ends with a quote
        current = null;
      } else {
        i += 1;
      }
      continue;
    }
    if (current === "'''") {
      const end = line.indexOf("'''", i);
      if (end === -1) return current;
      i = end + 3;
      for (let extra = 0; extra < 2 && line[i] === "'"; extra += 1) i += 1;
      current = null;
      continue;
    }
    const ch = line[i];
    if (ch === "#") return finish(null);
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      if (ctx.pos !== "value") return "unknown";
      current = line.slice(i, i + 3);
      i += 3;
      ctx.pos = "after"; // the value is complete once the string closes
    } else if (ch === '"' || ch === "'") {
      if (ch === '"') {
        i += 1;
        while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
        if (i >= line.length) return "unknown"; // no closing quote (a trailing backslash escape included)
        i += 1;
      } else {
        const end = line.indexOf("'", i + 1);
        if (end === -1) return "unknown";
        i = end + 1;
      }
      if (ctx.pos === "after") return "unknown"; // a second value after a complete one
      if (ctx.pos === "value") ctx.pos = "after"; // a quoted key or header part leaves its position as it was
      else if (ctx.pos === "key") {
        if (ctx.key === "bare" || ctx.key === "part") return "unknown"; // a second component with no `.`
        ctx.key = "part";
      }
    } else {
      if (ctx.pos === "value" && BARE_SCALAR_START.test(ch)) {
        // The scalar is complete at its end, and the character there is judged in the "after" position.
        i = bareScalarEnd(line, i);
        ctx.pos = "after";
        continue;
      }
      i += 1;
      if (ch === " " || ch === "\t") {
        if (ctx.pos === "key" && ctx.key === "bare") ctx.key = "part"; // a blank ends a bare key
        continue;
      }
      // A closer that does not match the open bracket is invalid TOML, in every position.
      if ((ch === "]" || ch === "}") && ctx.stack.length > 0 && top() !== (ch === "]" ? "array" : "table")) return "unknown";
      if (ctx.pos === "key") {
        if (ch === "=") {
          if (ctx.key === "none" || ctx.key === "dot") return "unknown"; // no key, or a `.` with no component after it
          ctx.pos = "value";
          ctx.key = "none";
        } else if (ch === ".") {
          if (ctx.key === "none" || ctx.key === "dot") return "unknown"; // no component before it, or two dots
          ctx.key = "dot";
        } else if ("[]{},".includes(ch)) {
          if (ctx.key !== "none") return "unknown"; // a delimiter right after key characters
          if (ch === "[" && ctx.stack.length === 0) ctx.pos = "header";
          else if (ch === "}" && top() === "table") {
            ctx.stack.pop();
            ctx.pos = "after";
          } else ctx.pos = "after"; // not valid in a key position
        } else {
          if (ctx.key === "part") return "unknown"; // a second component with no `.`
          if (ch < "\x80" && !BARE_KEY_CHAR.test(ch)) return "unknown"; // an ASCII character TOML never allows in a bare key
          ctx.key = "bare";
        }
      } else if (ctx.pos === "header") {
        // The rest of a table header line: parseHeader judges it.
      } else if (ctx.pos === "value") {
        if (ch === "[") {
          if (!open("array")) return "unknown";
        } else if (ch === "{") {
          if (!open("table")) return "unknown";
          ctx.pos = "key";
        } else if (ch === "]" && top() === "array") {
          ctx.stack.pop(); // an empty array, or one after a trailing comma
          ctx.pos = "after";
        } else return "unknown"; // nothing can start a value here
      } else if (ch === "," && ctx.stack.length > 0) {
        ctx.pos = top() === "array" ? "value" : "key";
      } else if ((ch === "]" && top() === "array") || (ch === "}" && top() === "table")) {
        ctx.stack.pop();
      } else return "unknown"; // trailing content after a complete value
    }
  }
  return finish(current);
}

function createConfigScanner() {
  const state = { lineNo: 0, kind: "table", section: [], ambiguousAfter: false, stringMode: null, valueContext: { stack: [], pos: "key", key: "none", tooDeep: false }, targets: 0, value: null, invalid: null };
  let pieces = [];
  let size = 0;
  let overlong = false;

  // Buffer a line's bytes only until it passes the cap; past that nothing more is kept.
  const take = (segment) => {
    if (overlong) return;
    if (size + segment.length > MAX_CONFIG_LINE_BYTES) {
      overlong = true;
      pieces = [];
      size = 0;
      return;
    }
    if (segment.length) {
      pieces.push(Buffer.from(segment));
      size += segment.length;
    }
  };

  // terminated: true when an "\n" ended the line, false for the last line at end of file.
  const finishLine = (terminated) => {
    const raw = Buffer.concat(pieces, size).toString("latin1");
    const wasOverlong = overlong;
    pieces = [];
    size = 0;
    overlong = false;
    state.lineNo += 1;
    if (state.invalid) return;
    if (wasOverlong) state.invalid = `a line is longer than the 1 MiB limit (line ${state.lineNo})`;
    else scanConfigLine(state, raw, terminated);
  };

  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline === -1) {
          if (start < buffer.length) take(buffer.subarray(start));
          return;
        }
        take(buffer.subarray(start, newline));
        finishLine(true);
        start = newline + 1;
      }
    },
    end() {
      if (size > 0 || overlong) finishLine(false);
      // A multiline string or bracket that never closes would leave every later line unclassified.
      // The string is the innermost open construct, so its reason wins over the bracket's.
      if (!state.invalid && (state.stringMode === '"""' || state.stringMode === "'''")) {
        state.invalid = `a multiline string is still open at the end of the file (line ${state.lineNo})`;
      }
      if (!state.invalid && state.valueContext.stack.length > 0) {
        state.invalid = `an array or inline table is still open at the end of the file (line ${state.lineNo})`;
      }
      if (state.invalid) return { status: "invalid", reason: state.invalid };
      if (state.targets === 0) return { status: "missing-key" };
      return { status: "found", value: state.value };
    },
  };
}

/** Scan config text (string or Buffer) for the Windows sandbox setting. */
export function scanWindowsSandbox(input) {
  const scanner = createConfigScanner();
  scanner.write(Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8"));
  return scanner.end();
}

/** Read the Windows sandbox setting from `path` with fixed-size reads through `io` (fs-compatible). */
export function readWindowsSandboxSetting(path, io = fs) {
  let fd;
  try {
    fd = io.openSync(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { status: "missing-file" };
    return { status: "unreadable", reason: `the file exists but could not be opened (${error?.code || "error"})` };
  }
  try {
    const scanner = createConfigScanner();
    const buffer = Buffer.alloc(CONFIG_READ_CHUNK_BYTES);
    for (;;) {
      const count = io.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      scanner.write(buffer.subarray(0, count));
    }
    return scanner.end();
  } catch (error) {
    return { status: "unreadable", reason: `the file could not be read (${error?.code || "error"})` };
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // Nothing more to do with a descriptor that will not close.
    }
  }
}

/** Codex's config file, as the child resolves it: $CODEX_HOME/config.toml, else <home>/.codex/config.toml. */
export function resolveCodexConfigPath(env = process.env, home = homedir()) {
  const codexHome = env?.CODEX_HOME;
  return codexHome ? join(codexHome, "config.toml") : join(home, ".codex", "config.toml");
}

// ---------------------------------------------------------------------------------------------
// Outcome classification, stderr signatures, event accounting
// ---------------------------------------------------------------------------------------------

/**
 * Map the run's facts to {status, exitCode}. Priority: sandbox signature, relay abort,
 * watchdog, launch error / signal / non-zero exit, clean exit.
 */
export function mapOutcome({
  code = null, signal = null, launchError = false, watchdogFired = false, abortSignal = null, sandboxFailureReasons = [],
} = {}) {
  if (sandboxFailureReasons && sandboxFailureReasons.length) return { status: "sandbox_failed", exitCode: 1 };
  if (abortSignal) return { status: "aborted", exitCode: 128 + (constants.signals[abortSignal] || 15) };
  const mapped = launchError ? 1 : code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
  // A timed-out run is never a success even if codex handles SIGTERM by exiting 0 -
  // orchestrators key off status and the relay exit code.
  if (watchdogFired) return { status: "timeout", exitCode: mapped === 0 ? 1 : mapped };
  if (!launchError && code === 0) return { status: "completed", exitCode: 0 };
  return { status: "failed", exitCode: mapped === 0 ? 1 : mapped };
}

/**
 * Streaming, case-insensitive matcher for the sandbox failure phrases. Keeps only enough of the
 * previous chunk to match across a boundary, so memory stays constant however long stderr runs.
 */
export function createSandboxSignatureScanner() {
  const overlap = Math.max(...SANDBOX_SIGNATURES.map((phrase) => phrase.length)) - 1;
  const found = new Set();
  let carry = "";
  return {
    write(chunk) {
      if (found.size === SANDBOX_SIGNATURES.length) return;
      // latin1 maps byte-for-byte, so a multibyte character split across chunks cannot shift
      // the ASCII phrases; lower-casing it never changes the string length.
      const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk)).toLowerCase();
      for (const phrase of SANDBOX_SIGNATURES) {
        if (!found.has(phrase) && text.includes(phrase)) found.add(phrase);
      }
      carry = text.slice(-overlap);
    },
    reasons() {
      return SANDBOX_SIGNATURES.filter((phrase) => found.has(phrase));
    },
  };
}

function extractThreadId(event) {
  return (
    event.thread_id ??
    event.threadId ??
    (event.thread && (event.thread.thread_id ?? event.thread.id)) ??
    null
  );
}

/**
 * Line-splits Codex's JSONL stdout (UTF-8 safe across chunks), hands every non-blank line to
 * onLine, and tracks the thread id and MCP tool calls. Only {server, tool} names are kept.
 */
export function createEventAccumulator({ onLine = () => {} } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let threadId = null;
  let anonymousCalls = 0;
  const callIds = new Set();
  const names = new Map();

  const recordMcp = (item) => {
    const id = item.id;
    if ((typeof id === "string" && id) || Number.isFinite(id)) callIds.add(String(id));
    else anonymousCalls += 1;
    const server = typeof item.server === "string" ? item.server : null;
    const tool = typeof item.tool === "string" ? item.tool : null;
    if (server !== null || tool !== null) names.set(JSON.stringify([server, tool]), { server, tool });
  };

  const handle = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    onLine(line);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON progress lines are preserved by onLine but carry nothing to account
    }
    if (!event || typeof event !== "object") return;
    const tid = extractThreadId(event);
    if (tid) threadId = tid;
    const item = event.item;
    if (MCP_LIFECYCLE_EVENTS.has(event.type) && item && typeof item === "object" && item.type === "mcp_tool_call") {
      recordMcp(item);
    }
  };

  const drain = () => {
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      handle(line);
    }
  };

  return {
    write(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      pending += decoder.end();
      drain();
      if (pending) {
        const last = pending;
        pending = "";
        handle(last);
      }
    },
    threadId: () => threadId,
    mcpCalls() {
      const sorted = [...names.values()].sort((a, b) =>
        String(a.server).localeCompare(String(b.server), "en") || String(a.tool).localeCompare(String(b.tool), "en"));
      return { count: callIds.size + anonymousCalls, names: sorted };
    },
    warnings: () => (anonymousCalls > 0 ? [MCP_NO_ID_WARNING] : []),
  };
}

// ---------------------------------------------------------------------------------------------
// Windows process preflight (warn-only)
// ---------------------------------------------------------------------------------------------

const TASKLIST_CSV_ROW = /^"[^"]*"(?:,"[^"]*")+$/;

/**
 * Is node_repl.exe running? On a CLI that predates the Windows Desktop ACL fix,
 * the elevated sandbox's setup refresh could fail with "setup refresh had errors" (os error 32)
 * while it ran; main() skips this check for danger-full-access, a backend resolved to unelevated,
 * and known-fixed versions (see hasWindowsDesktopAclFix). Advisory only:
 * it races with process startup, and "not-running" is no proof of safety. Never kills anything.
 */
export function checkNodeRepl(run = spawnSync) {
  const unavailable = (reason) => ({ status: "unavailable", reason });
  let result;
  try {
    result = run("tasklist.exe", ["/FI", "IMAGENAME eq node_repl.exe", "/FO", "CSV", "/NH"], {
      shell: false,
      windowsHide: true,
      timeout: PREFLIGHT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: PREFLIGHT_MAX_BUFFER,
      encoding: "utf8",
    });
  } catch (error) {
    return unavailable(`tasklist.exe could not run (${error?.code || "error"})`);
  }
  if (!result) return unavailable("tasklist.exe returned nothing");
  if (result.error) {
    return unavailable(result.error.code === "ETIMEDOUT" ? "tasklist.exe timed out" : `tasklist.exe could not run (${result.error.code || "error"})`);
  }
  if (result.signal) return unavailable(`tasklist.exe was killed by ${result.signal}`);
  if (result.status !== 0) return unavailable(`tasklist.exe exited ${result.status}`);
  const rows = String(result.stdout ?? "").split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  // With no match, tasklist prints a single INFO notice instead of rows.
  if (rows.length === 1 && /^INFO(?:RMATION)?:/i.test(rows[0])) return { status: "not-running" };
  if (rows.length === 0 || !rows.every((row) => TASKLIST_CSV_ROW.test(row))) return unavailable("unrecognised tasklist.exe output");
  const running = rows.some((row) => /^"([^"]*)"/.exec(row)[1].toLowerCase() === "node_repl.exe");
  return { status: running ? "running" : "not-running" };
}

// ---------------------------------------------------------------------------------------------
// Run directory, output-directory lock, results
// ---------------------------------------------------------------------------------------------

function readLockMetadata(lockPath) {
  // Bounded read and strict validation: a partial, malformed or oversized lock is reported as
  // "metadata unavailable", never guessed at or echoed.
  let fd;
  try {
    fd = openSync(lockPath, "r");
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > MAX_LOCK_BYTES) return null;
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { pid, startedAt } = parsed;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== "string" || !ISO_TIMESTAMP.test(startedAt) || !Number.isFinite(Date.parse(startedAt))) return null;
    return { pid, startedAt };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Read-only descriptor; nothing to lose.
      }
    }
  }
}

function reportLockConflict(outDir, lockPath) {
  const owner = readLockMetadata(lockPath);
  const lines = [
    `relay: the output directory is in use: ${lockPath} exists.`,
    owner
      ? `  owner: relay pid ${owner.pid}, started ${owner.startedAt}`
      : "  owner: lock metadata unavailable (the lock is incomplete, malformed, or unreadable)",
    `  this invocation has no result: any result.json in ${outDir} belongs to the lock owner, not to this run.`,
    "  recovery: wait for the owner relay to finish, use another output directory (--out-dir), or, only after",
    `  confirming the previous relay is gone, remove the stale lock (${lockPath}) and re-run.`,
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(2);
}

function acquireOutDirLock(outDir, startedAt) {
  // Exclusive creation makes concurrent claimants fail; sequential reuse still works because
  // the owner removes the lock on every controllable exit path.
  const lockPath = join(outDir, LOCK_NAME);
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") reportLockConflict(outDir, lockPath);
    fail(`cannot create the output-directory lock ${lockPath}: ${error?.code || error?.message || error}`);
  }
  // What this acquisition created: the file's identity and, once written, its exact content.
  // Release deletes the lock only while both still match, never a lock someone else put there.
  let identity = null;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.ino !== 0n) identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    // No identity available; the content check below still applies.
  }
  let expected = "";
  let owned = true;
  const release = () => {
    if (!owned) return;
    owned = false;
    if (!lockIsOurs(lockPath, identity, expected)) return;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone; nothing else to release.
    }
  };
  // Registered before the metadata write, so even a failed write releases ownership.
  process.on("exit", release);
  const metadata = JSON.stringify({ pid: process.pid, startedAt });
  try {
    // writeSync may store fewer bytes than asked: finish the write, and give up on a write that
    // makes no progress (each pass writes at least one byte, so the loop is bounded by the length).
    const bytes = Buffer.from(metadata, "utf8");
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      if (!(count > 0)) throw Object.assign(new Error("the write made no progress"), { code: "EIO" });
      written += count;
    }
  } catch (error) {
    expected = null; // a partial write leaves unknown content; rely on identity alone
    try { closeSync(fd); } catch { /* releasing below */ }
    fail(`cannot write the output-directory lock ${lockPath}: ${error?.code || error?.message || error}`);
  }
  expected = metadata;
  closeSync(fd);
}

/**
 * Is the lock at lockPath still the file this relay created? Compares the file identity (when the
 * filesystem reports one) and the exact content this relay wrote (when known). Anything unreadable
 * or unverifiable counts as not ours: leaving a stale lock is recoverable, deleting a live one is not.
 * A replacement in the instant between this check and the unlink is not excluded.
 */
function lockIsOurs(lockPath, identity, expected) {
  if (identity === null && expected === null) return false;
  let fd;
  try {
    fd = openSync(lockPath, "r");
    if (identity !== null) {
      const stat = fstatSync(fd, { bigint: true });
      if (stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
    }
    if (expected === null) return true;
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return buffer.subarray(0, bytesRead).toString("utf8") === expected;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Read-only descriptor; nothing to lose.
      }
    }
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  let outDir;
  if (opts.outDir) {
    outDir = opts.outDir;
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (error) {
      fail(`cannot create --out-dir ${outDir}: ${error?.code || error?.message || error}`);
    }
    acquireOutDirLock(outDir, startedAt);
  } else {
    // Default the run dir to system temp so the repo under review stays pristine —
    // the touched-files report must show only Codex's edits, not relay's artifacts.
    // mkdtemp keeps parallel relays apart even when they start in the same millisecond.
    const parent = join(tmpdir(), "delegate-relay");
    try {
      mkdirSync(parent, { recursive: true });
      outDir = mkdtempSync(join(parent, "run-"));
    } catch (error) {
      fail(`cannot create a run directory under ${parent}: ${error?.code || error?.message || error}`);
    }
  }
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  try {
    // This run owns the directory now: a previous run's result or final message must not leak.
    rmSync(run.resultPath, { force: true });
    rmSync(run.finalPath, { force: true });
    writeFileSync(run.briefPath, brief, "utf8");
    writeFileSync(run.eventsPath, "", "utf8");
    writeFileSync(run.stderrPath, "", "utf8");
  } catch (error) {
    fail(`cannot prepare the run directory ${outDir}: ${error?.code || error?.message || error}`);
  }
  return run;
}

function createWarnings() {
  const list = [];
  return {
    list,
    add(message) {
      const text = String(message).slice(0, MAX_WARNING_CHARS);
      if (list.includes(text) || list.length >= MAX_WARNINGS) return;
      list.push(text);
      process.stderr.write(`relay: warning: ${text}\n`);
    },
  };
}

function isMcpViolation(opts, mcpCalls) {
  if (!mcpCalls || mcpCalls.count === 0) return false;
  // An unqualified, non-isolated resume keeps Codex's own sandbox, which the relay cannot know.
  const resuming = Boolean(opts.resumeLast || opts.session);
  const knownReadOnly = opts.sandbox === "read-only" && (!resuming || opts.sandboxConfigured);
  return Boolean(opts.isolated || knownReadOnly);
}

function makeResultWriter(opts, meta, run, warnings) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary.
  return (extra) => {
    const resuming = Boolean(opts.resumeLast || opts.session);
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      workdir: opts.cd,
      sandbox: !resuming || opts.sandboxConfigured ? opts.sandbox : "(Codex config on resume)",
      model: opts.model,
      effort: opts.effort,
      subagentModel: opts.subagentModel,
      subagentEffort: opts.subagentEffort,
      webSearch: opts.webSearch,
      networkAccess: opts.networkAccess,
      resumeLast: opts.resumeLast,
      session: opts.session,
      cleanEnv: opts.cleanEnv,
      ignoreUserConfig: opts.ignoreUserConfig,
      isolated: opts.isolated,
      disabledFeatures: opts.disabledFeatures,
      windowsSandbox: opts.windowsSandbox,
      keepEnv: opts.keepEnv,
      codexVersion: meta.version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      stderrPath: run.stderrPath,
      warnings: [...warnings.list],
      mcpCalls: { count: 0, names: [] },
      mcpViolation: false,
      sandboxFailureReasons: [],
      childExitCode: null,
      watchdogFired: false,
      abortSignal: null,
      ...extra,
    };
    // Publish atomically so a polling orchestrator never reads a half-written file
    // (same idiom as claude-delegate's writeJsonAtomic and qoder-delegate).
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({ status: "codex_unavailable", exitCode: 127, signal: null, threadId: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `codex` not found on PATH. Install it (npm i -g @openai/codex) and run `codex login`.\n");
  process.exit(127);
}

function sandboxFailureError(reasons, { watchdogFired = false, abortSignal = null, timeout = null } = {}) {
  const also = [
    watchdogFired ? `the --timeout ${timeout} watchdog also fired` : null,
    abortSignal ? `the relay was also killed by ${abortSignal}` : null,
  ].filter(Boolean);
  return `codex's stderr matched sandbox failure signature(s): ${reasons.map((reason) => `"${reason}"`).join(", ")}; ` +
    "its sandbox could not run commands, so this run is not trustworthy whatever codex reported" +
    `${also.length ? `; ${also.join("; ")}` : ""}. Read stderrPath for the context.`;
}

// ponytail: bound the summary to the final 64 KiB; read stderrPath for longer diagnostics.
// Reading the whole log here can exhaust memory before publishing a failure or forwarding an abort.
function stderrTail(stderrPath) {
  let fd;
  try {
    fd = openSync(stderrPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_STDERR_TAIL_BYTES);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - readStart);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let offset = start - readStart;
    // The preceding byte distinguishes a cut line from a line starting at the window boundary.
    const partialLine = offset > 0 && buffer[0] !== 0x0a;
    while (partialLine && offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset += 1;
    const lines = buffer.subarray(offset, bytesRead).toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trimEnd());
    if (partialLine && lines[0]?.trim()) lines[0] = `[truncated; read stderrPath] ${lines[0]}`;
    return lines.filter((line) => line.trim()).slice(-20);
  } catch {
    // A missing or unreadable diagnostic must not prevent the run result from being published.
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs, scanner) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) {
    writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
    scanner.write(stderr);
  }
  const reasons = scanner.reasons();
  const status = Number.isInteger(error?.status) && error.status !== 0 ? error.status : null;
  const outcome = reasons.length
    ? mapOutcome({ sandboxFailureReasons: reasons })
    : timedOut ? { status: "timeout", exitCode: 124 } : mapOutcome({ code: status });
  // How the probe ended, stated even when a signature reclassifies the run as sandbox_failed.
  const how = timedOut
    ? `timed out after ${probeTimeoutMs}ms`
    : `failed${status !== null ? ` with exit ${status}` : ""}${error?.signal ? ` (killed by ${error.signal})` : ""}`;
  const message = reasons.length
    ? `codex --version preflight ${how}; ${sandboxFailureError(reasons)} Codex was not dispatched`
    : `codex --version preflight ${how}; Codex was not dispatched`;
  const result = writeResult({
    ...outcome,
    signal: null,
    threadId: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderrTail(run.stderrPath),
    sandboxFailureReasons: reasons,
    error: message,
  });
  printSummary(result, run.resultPath, opts.resumeFlags);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function spawnShellLaunch(binary, argv, options, useShell) {
  if (!useShell) return spawn(binary, argv, options);
  // Node 24 warns when shell:true is paired with an args array. The args here
  // are already token-validated or quoted for cmd.exe, so serialize them once.
  return spawn([binary, ...argv].join(" "), { ...options, shell: true });
}

function readFinalMessage(run) {
  return existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8").trim() : "";
}

function dispatchToCodex(opts, brief, run, writeResult, env, warnings, scanner) {
  const argv = buildArgv(opts, run.finalPath);
  // shell:true on Windows so the codex.cmd shim resolves (see codexVersion). Safe:
  // the brief is fed via child.stdin below — never argv — and argv holds only
  // sandbox enums, model names (including subagents), feature names, pattern-checked
  // efforts and web search modes, the fixed network override, the allowlisted Windows
  // backend, and file paths.
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree
  const child = spawnShellLaunch("codex", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env }, process.platform === "win32");

  // Every stdout line is persisted to events.jsonl as it is accounted; a newline-less final
  // line is flushed by events.end() before any terminal result is published.
  const events = createEventAccumulator({ onLine: (line) => appendFileSync(run.eventsPath, `${line}\n`, "utf8") });

  child.stdout.on("data", (chunk) => events.write(chunk));

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Codex progress live for the orchestrator
    appendFileSync(run.stderrPath, chunk);
    scanner.write(chunk); // the whole stream, not just the tail summarized later
  });

  // Diagnostics shared by every terminal snapshot.
  const diagnostics = () => {
    for (const warning of events.warnings()) warnings.add(warning);
    const mcpCalls = events.mcpCalls();
    return { mcpCalls, mcpViolation: isMcpViolation(opts, mcpCalls), sandboxFailureReasons: scanner.reasons() };
  };

  let settled = false;
  let watchdogFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  if (timeoutMs !== null) {
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      child.once("exit", () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      killChild(child);
      sigkillTimer = setTimeout(() => {
        if (!settled) killChild(child, "SIGKILL");
      }, 10_000);
    }, timeoutMs);
  }

  const clearWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the codex child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = () => {
        const diag = diagnostics();
        const outcome = mapOutcome({ abortSignal: sig, watchdogFired, sandboxFailureReasons: diag.sandboxFailureReasons });
        return {
          ...outcome,
          signal: sig,
          threadId: events.threadId(),
          finalMessage: readFinalMessage(run),
          touchedFiles: gitTouchedFiles(opts.cd),
          stderrTail: stderrTail(run.stderrPath),
          ...diag,
          childExitCode: child.exitCode ?? null,
          watchdogFired,
          abortSignal: sig,
          error: outcome.status === "sandbox_failed"
            ? sandboxFailureError(diag.sandboxFailureReasons, { watchdogFired, abortSignal: sig, timeout: opts.timeout })
            : `the relay was killed by ${sig}; codex was terminated with it — inspect the working tree before re-dispatching`,
        };
      };
      const result = writeResult(abortedFields());
      printSummary(result, run.resultPath, opts.resumeFlags);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files, events and stderr during the grace window; refresh the
        // snapshot so the artifact matches the tree the orchestrator will actually find
        events.end();
        const refreshed = writeResult(abortedFields());
        // Print again: the last summary on stdout must match the result.json it points to.
        printSummary(refreshed, run.resultPath, opts.resumeFlags);
        process.exit(refreshed.exitCode);
      }, 2000);
    });
  }

  // A grandchild that outlives codex and inherited the pipes keeps stdout/stderr open, so
  // "close" never fires and the relay waits forever, writing no result. Once codex itself is
  // gone the pipes hold nothing we still need — finalMessage is read from the -o file, and the
  // stderr log is appended synchronously as it arrives — so drop them after a short drain
  // grace and let "close" run. This is the normal-exit twin of the stream teardown the
  // watchdog already does on the timeout path.
  child.once("exit", () => {
    // The implementer already exited. Leaving the watchdog armed lets a drain that
    // overlaps the remaining budget fire, set watchdogFired, and report timeout.
    if (!watchdogFired) clearWatchdog();
    const drain = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
    if (typeof drain.unref === "function") drain.unref();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    events.end();
    const diag = diagnostics();
    const outcome = mapOutcome({ launchError: true, watchdogFired, sandboxFailureReasons: diag.sandboxFailureReasons });
    const result = writeResult({
      ...outcome,
      signal: null,
      threadId: events.threadId(),
      finalMessage: "",
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail(run.stderrPath),
      ...diag,
      watchdogFired,
      error: outcome.status === "sandbox_failed"
        ? sandboxFailureError(diag.sandboxFailureReasons, { watchdogFired, timeout: opts.timeout })
        : String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath, opts.resumeFlags);
    process.exit(result.exitCode);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    events.end();
    const diag = diagnostics();
    const outcome = mapOutcome({ code, signal, watchdogFired, sandboxFailureReasons: diag.sandboxFailureReasons });
    const succeeded = outcome.status === "completed";
    let error = null;
    if (outcome.status === "sandbox_failed") error = sandboxFailureError(diag.sandboxFailureReasons, { watchdogFired, timeout: opts.timeout });
    else if (outcome.status === "timeout") error = `codex did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`;
    const result = writeResult({
      ...outcome,
      signal: signal ?? null,
      threadId: events.threadId(),
      finalMessage: readFinalMessage(run),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail(run.stderrPath) }),
      ...diag,
      childExitCode: code ?? null,
      watchdogFired,
      ...(error ? { error } : {}),
    });
    printSummary(result, run.resultPath, opts.resumeFlags);
    process.exit(result.exitCode);
  });

  // If the child failed to launch, writing to its stdin can emit a stray 'error'
  // on the pipe; the 'error' handler above owns that outcome, so swallow it here.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

/**
 * Entry point. `deps` is the narrow injection boundary for tests:
 *   deps.preflight()  -> { status: "running" | "not-running" | "unavailable", reason? } (default: tasklist.exe)
 *   deps.configIo     -> fs-compatible object the Windows sandbox-setting reader uses (default: node:fs)
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const configIo = deps.configIo ?? fs;
  const preflight = deps.preflight ?? (() => checkNodeRepl());
  const opts = parseArgs(argv);
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  const warnings = createWarnings();
  const scanner = createSandboxSignatureScanner();
  const meta = { version: null };
  const writeResult = makeResultWriter(opts, meta, run, warnings);

  if (opts.resumeLast) warnings.add(RESUME_LAST_WARNING);
  if (opts.isolated && !opts.model) warnings.add(NO_MODEL_WARNING);

  const checks = windowsRuntimeChecks(process.platform, opts);
  if (checks.readSandboxSetting) {
    // CODEX_HOME is inherited unchanged by the child (--clean-env keeps it too); a relative
    // value is resolved against the child's cwd, as the child would.
    const configPath = resolve(opts.cd, resolveCodexConfigPath(process.env, homedir()));
    const setting = readWindowsSandboxSetting(configPath, configIo);
    if (setting.status === "found") {
      opts.windowsSandbox = setting.value;
    } else if (setting.status === "missing-file") {
      warnings.add(`Codex config not found at ${configPath}: no Windows sandbox backend to preserve, so Codex uses its built-in default.`);
    } else if (setting.status === "missing-key") {
      warnings.add(`no [windows] sandbox setting in ${configPath}: no backend override is passed, so Codex uses its built-in default.`);
    } else {
      const message = `invalid isolation configuration in ${configPath}: ${setting.reason}. Codex was not dispatched; ` +
        "fix the [windows] sandbox setting (\"elevated\" or \"unelevated\") or run without isolation; an ambiguous setting: see the codex-delegate troubleshooting entry for invalid isolation configuration.";
      const result = writeResult({ status: "failed", exitCode: 2, signal: null, threadId: null, finalMessage: "", touchedFiles: gitTouchedFiles(opts.cd), error: message });
      printSummary(result, run.resultPath, opts.resumeFlags);
      process.stderr.write(`relay: ${message}\n`);
      process.exit(2);
    }
  }

  const probeTimeoutMs = versionProbeTimeout(opts);
  const env = codexEnv(opts);
  const probe = codexVersion(probeTimeoutMs, env);
  meta.version = probe.version;
  if (probe.stderr) process.stderr.write(probe.stderr); // as the probe's own stderr always was
  if (probe.version && probe.stderr) {
    // A successful probe's stderr is part of this run's Codex stderr: persist it and match it, so a
    // signature printed by `codex --version` still classifies the run (reportVersionFailure does
    // the same for a failed probe).
    appendFileSync(run.stderrPath, probe.stderr);
    scanner.write(probe.stderr);
  }

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs, scanner);
    return;
  }

  // Recomputed now that the backend is resolved and the version is known: a known-fixed CLI or an
  // unelevated backend skips the process preflight entirely.
  if (windowsRuntimeChecks(process.platform, opts, probe.version).preflight) {
    let state;
    try {
      state = preflight();
    } catch {
      state = { status: "unavailable", reason: "the check crashed" };
    }
    if (state?.status === "running") {
      warnings.add("node_repl.exe is running: this CLI may predate the Windows Desktop ACL fix. " +
        "Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH. " +
        "If upgrading is unavailable, quit Codex Desktop fully (from the tray) and stop other runs using node_repl.exe.");
    } else if (state?.status !== "not-running") {
      const reason = typeof state?.reason === "string" ? state.reason.slice(0, 200) : "unknown";
      warnings.add(`process preflight unavailable (${reason}): could not check node_repl.exe. ` +
        "Upgrade with codex update (stable 0.163.0+) or reinstall a current stable CLI, then check codex --version on PATH.");
    }
  }

  dispatchToCodex(opts, brief, run, writeResult, env, warnings, scanner);
}

/**
 * The stdout hint for a sandbox_failed result. Pure: derives the advice from the result's existing
 * version, backend and sandbox fields and the given platform.
 */
export function sandboxFailureHint(result, platform) {
  const head = `hint: codex's sandbox could not run commands (matched: ${result.sandboxFailureReasons.join(", ")}) — codex may still exit 0, so do not trust this run.`;
  if (platform !== "win32") return `${head} Read stderrPath and investigate the sandbox failure before re-dispatching.`;
  if (result.windowsSandbox === "unelevated" || hasWindowsDesktopAclFix(result.codexVersion) || result.sandbox === "danger-full-access") {
    return `${head} The Desktop node_repl.exe ACL conflict is not the likely cause for this version or backend. ` +
      "Read stderrPath for other sandbox causes; if failures coincide with parallel elevated dispatches, " +
      "try staggering or serializing them before re-dispatching.";
  }
  return `${head} This CLI may predate the Windows Desktop ACL fix: run codex update (stable 0.163.0+) or reinstall ` +
    "a current stable CLI, check codex --version on PATH, or quit Codex Desktop fully if upgrading is unavailable; " +
    "then read stderrPath.";
}

function printSummary(result, resultPath, resumeFlags = []) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  codex ${result.codexVersion ?? "?"}`);
  if (result.status === "sandbox_failed") lines.push(sandboxFailureHint(result, process.platform));
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a codex error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated codex (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.resumeLast) lines.push("mode: resumed most recent session");
  if (result.session) lines.push(`mode: resumed session ${result.session}`);
  if (result.isolated) lines.push(`isolation: user config ignored; disabled features: ${result.disabledFeatures.join(", ")}${result.windowsSandbox ? `; windows.sandbox=${result.windowsSandbox}` : ""}`);
  if (result.threadId) {
    lines.push(`thread id (resume with: ${["--session", result.threadId, ...resumeFlags].join(" ")}): ${result.threadId}`);
  }
  const mcp = result.mcpCalls;
  if (mcp && mcp.count > 0) {
    const names = mcp.names.map((name) => `${name.server}/${name.tool}`).join(", ");
    if (result.mcpViolation) lines.push(`MCP VIOLATION: ${mcp.count} MCP tool call(s) in an isolated or read-only run (${names}) — reject this result.`);
    else lines.push(`MCP calls: ${mcp.count} (${names})`);
  }
  if (result.warnings && result.warnings.length) lines.push(`warnings: ${result.warnings.length} (see result.json)`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- codex final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

// realpath BOTH sides, not resolve: mirrors delegate-setup's lane.mjs — symlinked install
// paths otherwise make this silently no-op (including under --preserve-symlinks-main, where
// the module URL keeps the symlink path). Importing this module must never run main().
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
