#!/usr/bin/env node
/**
 * delegate-skills · mcode-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the MiniMax Code CLI (`mcode exec`), capture
 * the run, and write a structured result the orchestrating agent can review.
 * The orchestrator runs this one command and reads the result JSON — every
 * MiniMax Code-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Shell-capable agents use the same file contract.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `mcode` and `git`. The `mcode` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Autonomy, in MiniMax Code's own terms: `mcode exec` takes a permission policy
 * of `smart`, `full`, or `off` (`ask` needs the TUI or ACP). There is no sandbox
 * and no read-only or plan setting for a headless run. `smart` (TUI Auto) is the
 * default here, and it already approves file writes and deletions headlessly
 * (observed: an `rm` ran without asking), so the brief and a clean tree are the
 * real scope. `--permission full` is an explicit opt-in; `off` is refused, since
 * its meaning is undocumented.
 *
 * `--read-only` is advisory: it appends a system prompt that forbids edits, keeps
 * `smart`, and then checks the claim with a Git-visible change tripwire reported
 * as `readOnlyViolation`. A change is detected after the fact, never prevented;
 * ignored and outside-repository paths remain outside the check.
 *
 * It deliberately does NOT commit. Committing belongs to the reviewer, after it
 * reads the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for MiniMax Code (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <ref>           Model for this run, as provider/model or provider/model#variant
 *                           (default: MiniMax Code's own configured model).
 *   --effort <level>        Reasoning effort for this run. Levels are model-specific; mcode
 *                           rejects one the model does not offer and names the valid set.
 *   --permission <policy>   smart (default) | full. `off` is refused.
 *   --read-only             Advisory read-only: an appended system prompt forbids edits, and a
 *                           Git-visible readOnlyViolation tripwire checks afterwards. Detects a
 *                           change; does not prevent one. Not combinable with --permission full.
 *   --session <id>          Continue a specific session by id (the sessionId from a prior
 *                           result.json); send only the delta brief.
 *   --mcode-path <file>     The mcode executable to launch (overrides PATH; MCODE_CLI does
 *                           the same). Use it when mcode is installed but not on PATH.
 *   --clean-env             Launch MiniMax Code and its version preflight with only runtime basics.
 *                           Changes inherited variables only; does not protect files or other
 *                           same-user secrets.
 *   --keep-env <name>       Keep one additional variable under --clean-env (repeatable).
 *                           Required for MCODE_PROVIDER_API_KEY, proxies, and other stripped variables.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the mcode child is killed
 *                           and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, outside the target repository).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, mcodeVersion, sessionId (for a later --session),
 *   runId, execStatus and execError from mcode's own exec.completed event,
 *   resolvedModel, usage, durationMs, finalMessage (its report), touchedFiles
 *   (git porcelain, null if git can't report), readOnlyViolation, and the paths
 *   to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `mcode` binary exits 127;
 * otherwise the relay preserves mcode's non-zero exit code (observed: 2 for an
 * argument it rejects, 4 for a failed run, 7 at the step limit). A run that
 * exits 0 without an `exec.completed` event whose status is "succeeded" is
 * reported failed with exit 1.
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to mcode), or mcode_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

const MAX_BUFFERED_CHARS = 1_048_576;
// Batch size for the event log; small enough to bound memory, large enough that the
// stdout pipe keeps draining while we write.
const EVENT_FLUSH_CHARS = 262_144;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// MiniMax Code model refs are provider/model#variant. Keep in lockstep
// with delegate-setup MODEL_TOKEN.mcode.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/#-]*$/;
const PERMISSIONS = ["smart", "full"];
// The read-only prompt file's path reaches cmd.exe on Windows, quoted; these
// characters would still be interpreted inside the quotes.
const WIN_SHELL_UNSAFE_PATH = /["%!^&|<>]/;
const PRIVATE_FILE_MODE = 0o600;

const IMPLEMENTER_KEY = "mcode";
const DEFAULT_BIN = "mcode";

const READ_ONLY_PROMPT = [
  "This run is read-only. Do not create, edit, move, or delete any file, and do not run",
  "commands that change the working tree, the Git index, or anything outside it.",
  "Read, search, and run read-only commands only, then put your whole answer in your",
  "final message.",
].join(" ");

// mcode's exit codes as observed on 0.6.13, for a summary hint that points at the
// actual cause instead of a bare number.
const EXIT_HINTS = new Map([
  [2, "mcode rejected an argument (for example an --effort level this model does not offer) — read stderr"],
  [4, "the run failed — execError and stderr name the cause (an unavailable model, an unknown session, a provider error)"],
  [7, "hit the step limit — split the brief into smaller tasks"],
]);
const AUTH_STDERR = /\blog ?in\b|sign(?:ed)?[ -]?in|unauthori[sz]ed|not authenticated/i;

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
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (flagged.has(field)) continue;
    if (field === "readOnly" && flagged.has("readOnly")) continue;
    opts[field] = value;
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
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    permission: "smart",
    readOnly: false,
    session: null,
    mcodePath: null,
    cleanEnv: false,
    keepEnv: [],
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
      case "--permission": opts.permission = next(); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--session": opts.session = next(); break;
      case "--mcode-path": opts.mcodePath = next(); break;
      case "--clean-env": opts.cleanEnv = true; break;
      case "--keep-env": opts.keepEnv.push(next()); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.effort !== null && !/^[a-z][a-z0-9-]*$/i.test(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected a non-empty bare token)`);
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / # -)");
  }
  if (!PERMISSIONS.includes(opts.permission)) {
    fail(`invalid --permission "${opts.permission}" (expected one of: ${PERMISSIONS.join(", ")}; "off" is refused)`);
  }
  if (opts.readOnly && opts.permission === "full") {
    fail("--read-only cannot be combined with --permission full");
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
  // A malformed --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session must be a session id (letters, digits, . _ : -)");
  }
  opts.launcher = resolveLauncher(opts.mcodePath || process.env.MCODE_CLI || null);
  return opts;
}

/**
 * --mcode-path / MCODE_CLI → PATH. No home-directory guessing: the official
 * installer puts mcode in a directory only a shell profile adds to PATH, and
 * naming it explicitly is the honest fix when that profile is not loaded.
 * On Windows the npm install is a .cmd shim, which needs cmd.exe to launch.
 */
function resolveLauncher(configured) {
  if (configured !== null && !configured.trim()) configured = null;
  const bin = configured && /[\\/]/.test(configured) ? resolve(configured) : configured || DEFAULT_BIN;
  if (process.platform === "win32" && configured && !isAbsolute(configured)) {
    fail("on Windows --mcode-path / MCODE_CLI must be an absolute path");
  }
  const winShell = process.platform === "win32" && (!configured || /\.(?:cmd|bat)$/i.test(bin));
  if (winShell && WIN_SHELL_UNSAFE_PATH.test(bin)) {
    fail("the mcode path contains characters cmd.exe would interpret; move it or use a path without them");
  }
  return { bin, winShell, launchBin: winShell && /[\\/]/.test(bin) ? `"${bin}"` : bin };
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

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to mcode exec\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
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
  // The watchdog is only armed once mcode is running, so the preflight needs a bound of
  // its own: an `mcode --version` that never returns would wedge the relay here, before
  // any result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function spawnShellLaunch(binary, argv, options, useShell) {
  if (!useShell) return spawn(binary, argv, options);
  // Node 24 warns when shell:true is paired with an args array. The args here
  // are already token-validated or quoted for cmd.exe, so serialize them once.
  return spawn([binary, ...argv].join(" "), { ...options, shell: true });
}

function mcodeEnv(opts) {
  if (!opts.cleanEnv) return process.env;
  // MINIMAX_DATA_DIR (and its MAVIS_DATA_DIR fallback) locate mcode's sign-in state.
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "MCODE_CLI", "MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "SystemRoot", "SystemDrive",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "COMSPEC", ...opts.keepEnv];
  return Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

async function mcodeVersion(launcher, probeTimeoutMs, env, onChild) {
  const probe = await new Promise((resolveProbe) => {
    const child = spawnShellLaunch(launcher.launchBin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env,
    }, launcher.winShell);
    onChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe({ stdout, stderr, ...result });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, error, timedOut: false }));
    child.on("close", (code) => finish({ code, error: null, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    }, probeTimeoutMs);
  });
  if (probe.timedOut) {
    return { version: null, error: Object.assign(new Error(`${launcher.bin} --version timed out`), { code: "ETIMEDOUT", stderr: probe.stderr }) };
  }
  if (probe.error?.code === "ENOENT") return { version: null, error: null };
  if (probe.error) return { version: null, error: probe.error };
  if (launcher.winShell && /not recognized as an internal or external command/i.test(probe.stderr)) {
    return { version: null, error: null };
  }
  if (probe.code !== 0) {
    return { version: null, error: Object.assign(new Error(`${launcher.bin} --version failed`), { status: probe.code, stderr: probe.stderr }) };
  }
  return { version: probe.stdout.trim() || "unknown", error: null };
}

// MiniMax Code has no read-only setting for a headless run, so --read-only is a prompt,
// and the claim gets checked rather than trusted — the same tripwire claude-delegate and
// grok-delegate carry, and byte-identical to theirs by contract.
// Porcelain status alone cannot see every write. A path that is " M file" before a run and
// " M file" after it produces an identical line, so comparing status lines proves nothing about
// its contents — which is why the read-only tripwire below fingerprints the already-dirty paths
// as well. Two sentinels stand for "could not fingerprint"; they are never treated as unchanged.
const FINGERPRINT_UNREADABLE = "<unreadable>";
const FINGERPRINT_DIRECTORY = "<directory>";

function gitRepoRoot(cwd) {
  // Porcelain paths are relative to the repository ROOT, not to the directory git ran in
  // (--porcelain forces status.relativePaths off). Joining them against a --cd that is a
  // subdirectory would look for <repo>/src/src/file and find nothing at either end.
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\n$/, "") || null;
  } catch {
    return null;
  }
}

function gitStatusEntries(cwd) {
  // -z so a path containing a space, a quote, or a newline stays one field rather than being
  // quoted and escaped; -uall so an untracked directory is expanded into its files, because a
  // collapsed "?? dir/" line never changes when a file inside it does.
  try {
    const output = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const fields = new TextDecoder("utf-8", { fatal: true }).decode(output)
      .split("\0").filter((field) => field.length > 0);
    const entries = [];
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      // R and C can sit in EITHER status column, and under -z such an entry is followed by its
      // origin path as its own unprefixed field. Consume that field in both cases. A rename
      // origin belongs in the dirty set (the file moved away from it); a copy origin does not,
      // since a copy source can be a perfectly clean file.
      const renamed = status.includes("R");
      const copied = status.includes("C");
      let origin = null;
      if (renamed || copied) {
        i += 1;
        origin = fields[i] ?? null;
      }
      entries.push({ status, path, origin });
    }
    return entries;
  } catch {
    return null;
  }
}

function dirtyPaths(cwd) {
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const paths = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.status.includes("R") && entry.origin !== null) paths.push(entry.origin);
  }
  return paths;
}

function asciiFold(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function canonicalFilePath(path) {
  const absolute = resolve(path);
  let parent;
  try { parent = realpathSync.native(dirname(absolute)); } catch { return absolute; }
  const leaf = basename(absolute);
  const canonical = join(parent, leaf);
  try { lstatSync(canonical); } catch { return canonical; }
  try {
    const entries = readdirSync(parent);
    if (entries.includes(leaf)) return canonical;
    const matches = entries.filter((entry) => asciiFold(entry) === asciiFold(leaf));
    return join(parent, matches.length === 1 ? matches[0] : leaf);
  } catch {
    return canonical;
  }
}

function gitPathKey(root, path) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(root); } catch { canonicalRoot = resolve(root); }
  const key = relative(canonicalRoot, canonicalFilePath(path));
  return process.platform === "win32" ? key.replaceAll("\\", "/") : key;
}

function gitPathIsExcluded(root, path, excluded, foldedExcluded) {
  return excluded.has(path) ||
    (foldedExcluded.has(asciiFold(path)) && excluded.has(gitPathKey(root, join(root, path))));
}

function gitTripwireState(cwd, excludedPaths) {
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return entries.flatMap((entry) => [
    [entry.status, "path", entry.path],
    ...(entry.origin === null ? [] : [[entry.status.replace(/[^RC]/g, " "), "origin", entry.origin]]),
  ]
    .filter(([, , path]) => !gitPathIsExcluded(root, path, excluded, foldedExcluded)));
}

function pathFingerprint(absolutePath) {
  // Identity, not just bytes: a retargeted symlink, a flipped mode bit, or a file replaced by a
  // directory are all writes, and none of them change file contents.
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    // Absence is a state, not a failure - it differs from every real fingerprint, so a deletion
    // or a re-creation still registers. Any other errno means we genuinely cannot tell.
    return error && error.code === "ENOENT" ? "absent" : FINGERPRINT_UNREADABLE;
  }
  if (stats.isSymbolicLink()) {
    try {
      return `symlink:${readlinkSync(absolutePath, { encoding: "buffer" }).toString("hex")}`;
    } catch {
      return FINGERPRINT_UNREADABLE;
    }
  }
  // A directory in the dirty set is a submodule, whose contents belong to another repository.
  // Reported as unknown coverage rather than silently passed off as unchanged.
  if (stats.isDirectory()) return FINGERPRINT_DIRECTORY;
  if (!stats.isFile()) return FINGERPRINT_UNREADABLE;
  let fd;
  try {
    // Streamed rather than read whole: an unignored multi-gigabyte artifact must not be pulled
    // into memory just to answer whether it changed.
    const hash = createHash("sha256");
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return `file:${(stats.mode & 0o7777).toString(8)}:${hash.digest("hex")}`;
  } catch {
    return FINGERPRINT_UNREADABLE;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function gitIndexFingerprints(root, paths) {
  if (paths.length === 0) return new Map();
  try {
    const output = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const wanted = new Set(paths);
    const prints = new Map(paths.map((path) => [path, []]));
    for (const field of new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0")) {
      if (!field) continue;
      const separator = field.indexOf("\t");
      if (separator === -1) return null;
      const path = field.slice(separator + 1);
      if (wanted.has(path)) prints.get(path).push(field.slice(0, separator));
    }
    return prints;
  } catch {
    return null;
  }
}

function fingerprintPaths(root, paths) {
  // `complete` goes false the moment one path cannot be fingerprinted, so the caller reports
  // "unknown" instead of an unearned clean bill of health.
  const indexPrints = gitIndexFingerprints(root, paths);
  const prints = new Map();
  let complete = indexPrints !== null;
  for (const path of paths) {
    const file = pathFingerprint(join(root, path));
    if (file === FINGERPRINT_UNREADABLE || file === FINGERPRINT_DIRECTORY) complete = false;
    prints.set(path, { file, index: indexPrints?.get(path) ?? null });
  }
  return { prints, complete };
}

function fingerprintDirtyPaths(cwd, excludedPaths) {
  // Only the already-dirty set is covered. A path that is clean at dispatch and gets written
  // surfaces as a brand-new porcelain line anyway, and fingerprinting a whole repository per run
  // would cost far more than the case it covers.
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const paths = dirtyPaths(cwd);
  if (paths === null) return null;
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return {
    root,
    ...fingerprintPaths(root, paths.filter((path) => !gitPathIsExcluded(root, path, excluded, foldedExcluded))),
  };
}

function changedDirtyPaths(before) {
  // Re-fingerprint exactly the baseline paths, not whatever happens to be dirty now: a path the
  // run newly dirtied is already reported by the porcelain comparison, and letting an unreadable
  // one of those blind this signal would be a regression, not caution.
  if (!before) return { changed: [], complete: false };
  const now = fingerprintPaths(before.root, [...before.prints.keys()]);
  const changed = [];
  for (const [path, print] of before.prints) {
    const current = now.prints.get(path);
    const fileKnown = print.file !== FINGERPRINT_UNREADABLE && current.file !== FINGERPRINT_UNREADABLE;
    const fileChanged = fileKnown &&
      !(print.file === FINGERPRINT_DIRECTORY && current.file === FINGERPRINT_DIRECTORY) &&
      current.file !== print.file;
    const indexChanged = print.index !== null && current.index !== null &&
      JSON.stringify(current.index) !== JSON.stringify(print.index);
    if (fileChanged || indexChanged) changed.push(path);
  }
  return { changed: changed.sort(), complete: before.complete && now.complete };
}

function readOnlyVerdict(beforeTree, afterTree, beforeFingerprints) {
  // Three-valued on purpose. Proof of a write settles it even when the other signal is unknown;
  // only when nothing is proven AND coverage is incomplete is the answer genuinely unknown.
  // Collapsing that last case to false is the false assurance a tripwire must never give.
  const changed = changedDirtyPaths(beforeFingerprints);
  const porcelainMoved =
    beforeTree !== null && afterTree !== null && JSON.stringify(beforeTree) !== JSON.stringify(afterTree);
  if (porcelainMoved || changed.changed.length > 0) return true;
  if (beforeTree === null || afterTree === null || !changed.complete) return null;
  return false;
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

function buildArgv(opts, run) {
  // The brief goes in on stdin (--input -), never in argv, so the win32 cmd.exe launch
  // only ever sees fixed words and token-validated values. The workspace is the child's
  // cwd rather than --cwd, which keeps paths out of that command line too.
  const argv = ["exec", "--input", "-", "--output-format", "stream-json", "--permission", opts.permission];
  if (opts.readOnly) {
    const path = opts.launcher.winShell ? `"${run.readOnlyPromptPath}"` : run.readOnlyPromptPath;
    argv.push("--append-system-prompt-file", path);
  }
  if (opts.session) argv.push("--session", opts.session);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort !== null) argv.push("--effort", opts.effort);
  return argv;
}

/**
 * mcode streams versioned JSONL (`schemaVersion: 1`): every event carries runId and
 * sessionId; `item.completed` with an `agent_message` item carries a message's full
 * text; and the run ends with one `exec.completed` whose `result` holds status
 * (succeeded | failed | limit_exceeded | timeout), output, error, model, usage, and
 * durationMs. That event is the only proof of success.
 */
function scanEventLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return; // progress noise, or a partial line; events.jsonl keeps it either way
  }
  if (typeof event?.sessionId === "string" && event.sessionId) state.sessionId = event.sessionId;
  if (typeof event?.runId === "string" && event.runId) state.runId = event.runId;
  const item = event?.item;
  if (event?.type === "item.completed" && item?.type === "agent_message" &&
    typeof item.content === "string" && item.content.trim()) {
    state.lastText = item.content.trim();
  }
  if (event?.type !== "exec.completed" || typeof event.result !== "object" || event.result === null) return;
  const result = event.result;
  const model = result.model && typeof result.model === "object" ? result.model : null;
  state.exec = {
    status: typeof result.status === "string" ? result.status : null,
    output: typeof result.output === "string" ? result.output : "",
    error: typeof result.error?.message === "string" ? result.error.message
      : typeof result.error === "string" ? result.error : null,
    resolvedModel: model && model.providerId && model.modelId
      ? `${model.providerId}/${model.modelId}${model.variant ? `#${model.variant}` : ""}`
      : null,
    usage: result.usage ?? null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
  };
}

/**
 * Buffer the event log instead of appending per line: a relay that blocks on a
 * synchronous write for every line drains the stdout pipe slowly. Lines are parsed
 * in memory as they arrive and flushed in batches.
 */
function recordEventLine(run, line, state) {
  state.pending.push(line, "\n");
  state.pendingChars += line.length + 1;
  if (state.pendingChars >= EVENT_FLUSH_CHARS) flushEvents(run, state);
  scanEventLine(line, state);
}

function flushEvents(run, state) {
  if (state.pending.length === 0) return;
  const batch = state.pending.join("");
  state.pending = [];
  state.pendingChars = 0;
  try {
    appendFileSync(run.eventsPath, batch, "utf8");
  } catch {
    // The log is a diagnostic aid; losing it must not lose the run's result.
  }
}

/** The relay's own files, excluded from the read-only tripwire: --out-dir may sit inside the repo. */
function relayArtifacts(run) {
  return [run.briefPath, run.eventsPath, run.finalPath, run.resultPath, run.readOnlyPromptPath];
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Keep relay artifacts outside the target repository so touchedFiles reports
  // MiniMax Code's Git-visible edits without the helper's own files.
  const outDir = opts.outDir || mkdtempSync(join(tmpdir(), "delegate-relay-"));
  if (opts.outDir) mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
    readOnlyPromptPath: join(outDir, "read-only-prompt.txt"),
  };
  if (opts.readOnly && opts.launcher.winShell && WIN_SHELL_UNSAFE_PATH.test(run.readOnlyPromptPath)) {
    fail("--out-dir contains characters cmd.exe would interpret; pass an --out-dir without them");
  }
  const paths = [run.finalPath, run.resultPath, run.briefPath, run.eventsPath, run.readOnlyPromptPath];
  if (basename(canonicalFilePath(run.resultPath)) !== basename(run.resultPath)) {
    fail("--out-dir contains a case-aliased result.json artifact");
  }
  let entries = [];
  try { entries = readdirSync(outDir); } catch { /* the writers report an unusable output directory */ }
  const collides = paths.some((path) => entries.includes(basename(path)));
  if (collides) {
    let priorRun = false;
    try {
      priorRun = lstatSync(run.resultPath).isFile() &&
        JSON.parse(readFileSync(run.resultPath, "utf8")).schema === "delegate-relay.result.v1";
    } catch { /* an absent, malformed, or linked marker is not reusable */ }
    if (!priorRun) fail("--out-dir contains relay artifacts without a prior delegate-relay.result.v1 result");
  }
  // Exact relay files may be reused, but no stale artifact endpoint may survive:
  // final.txt is written after dispatch and would otherwise follow its symlink.
  for (const path of paths) {
    if (!entries.includes(basename(path))) continue;
    try {
      const artifact = lstatSync(path);
      if (artifact.isFile() || artifact.isSymbolicLink()) {
        rmSync(path, { force: true });
      }
    } catch { /* the writer will report an unusable artifact path */ }
  }
  // Exclusive creation closes the cleanup-to-write race and refuses a
  // differently cased endpoint on case-insensitive filesystems.
  writeFileSync(run.briefPath, brief, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  writeFileSync(run.eventsPath, "", { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  if (opts.readOnly) {
    writeFileSync(run.readOnlyPromptPath, `${READ_ONLY_PROMPT}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  }
  return run;
}

function makeResultWriter(opts, version, run, beforeTree, beforeFingerprints) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary. It also owns the
  // read-only verdict, so every outcome path — completed, failed, timeout,
  // aborted — gets a freshly measured one without threading it through.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      workdir: opts.cd,
      readOnly: opts.readOnly,
      permission: opts.permission,
      autonomy: opts.readOnly
        ? "--permission smart + read-only system prompt (advisory; changes detected, not prevented)"
        : `--permission ${opts.permission} (no sandbox; writes and deletes are approved headlessly)`,
      model: opts.model,
      effort: opts.effort,
      session: opts.session,
      cleanEnv: opts.cleanEnv,
      keepEnv: opts.keepEnv,
      mcodeVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      runId: null,
      execStatus: null,
      execError: null,
      resolvedModel: null,
      usage: null,
      durationMs: null,
      // Absent on write-capable runs would read as "not checked"; null says the
      // question does not apply, and only --read-only replaces it with a verdict.
      readOnlyViolation: null,
      ...extra,
    };
    if (opts.readOnly) {
      result.readOnlyViolation = readOnlyVerdict(
        beforeTree,
        gitTripwireState(opts.cd, relayArtifacts(run)),
        beforeFingerprints,
      );
    }
    // Publish atomically so a polling orchestrator never reads a half-written file
    // (same idiom as claude-delegate's writeJsonAtomic and qoder-delegate).
    const resultContents = `${JSON.stringify(result, null, 2)}\n`;
    let resultTemporary = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const resultCandidate = `${run.resultPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
      try {
        writeFileSync(resultCandidate, resultContents, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
        resultTemporary = resultCandidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (resultTemporary === null) throw new Error("could not reserve a result.json temporary file");
    try {
      renameSync(resultTemporary, run.resultPath);
    } catch (error) {
      rmSync(resultTemporary, { force: true });
      throw error;
    }
    return result;
  };
}

function reportUnavailable(opts, writeResult, resultPath) {
  const result = writeResult({
    status: "mcode_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write(`relay: \`${opts.launcher.bin}\` not found. Install MiniMax Code (\`npm install -g @minimax-ai/code\`), run \`mcode login\`, or point --mcode-path / MCODE_CLI at the binary (the official installer puts it in a directory only your shell profile adds to PATH).\n`);
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `${opts.launcher.bin} --version preflight timed out after ${probeTimeoutMs}ms; MiniMax Code was not dispatched`
    : `${opts.launcher.bin} --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; MiniMax Code was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function installPreflightSignalHandlers(opts, run, writeResult, getChild) {
  let active = true;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (!active) return;
      active = false;
      const child = getChild();
      if (child) killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId: null,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the mcode version preflight; MiniMax Code was not dispatched`,
      });
      printSummary(result, run.resultPath);
      process.exit(result.exitCode);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return () => {
    active = false;
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
  };
}

function execFields(state) {
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    execStatus: state.exec?.status ?? null,
    execError: state.exec?.error ?? null,
    resolvedModel: state.exec?.resolvedModel ?? null,
    usage: state.exec?.usage ?? null,
    durationMs: state.exec?.durationMs ?? null,
  };
}

function dispatchToMcode(opts, brief, run, writeResult, env) {
  const argv = buildArgv(opts, run);
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree.
  const child = spawnShellLaunch(opts.launcher.launchBin, argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env }, opts.launcher.winShell);

  const state = { sessionId: null, runId: null, exec: null, lastText: null, pending: [], pendingChars: 0 };
  let stdoutBuf = "";
  const stderrTail = [];

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuf += stdoutDecoder.write(chunk);
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      recordEventLine(run, line, state);
    }
    // Flush an oversized line as a fragment rather than growing the buffer without bound;
    // the fragment cannot be parsed, and events.jsonl still keeps it.
    if (stdoutBuf.length > MAX_BUFFERED_CHARS) {
      recordEventLine(run, stdoutBuf, state);
      stdoutBuf = "";
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface mcode progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // The relay writes final.txt itself from the event stream, preferring exec.completed's
  // output and falling back to the last agent message — the same report, delivered earlier.
  const persistFinal = () => {
    const text = (state.exec?.output || state.lastText || "").trim();
    if (!text) return { text: "", error: null };
    try {
      // final.txt is deliberately created only once. This refuses a symlink or
      // case-aliased endpoint introduced after prepareRunDir completed.
      writeFileSync(run.finalPath, `${text}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
      return { text, error: null };
    } catch (error) {
      return { text, error: `could not safely create final.txt: ${error.code || error.message}` };
    }
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
  // no result.json and leaves the mcode child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      killChild(child);
      try {
        const touched = gitTouchedFiles(opts.cd);
        flushEvents(run, state);
        const final = persistFinal();
        const abortedFields = {
          status: "aborted",
          exitCode: 128 + (constants.signals[sig] || 15),
          signal: sig,
          ...execFields(state),
          finalMessage: final.text,
          touchedFiles: touched,
          stderrTail: stderrTail.slice(-20),
          error: final.error || `the relay was killed by ${sig}; mcode was terminated with it — inspect the working tree before re-dispatching`,
        };
        const result = writeResult(abortedFields);
        printSummary(result, run.resultPath);
        setTimeout(() => {
          killChild(child, "SIGKILL");
          // the child may flush files during the grace window; refresh the snapshot so the
          // artifact matches the tree the orchestrator will actually find
          const late = gitTouchedFiles(opts.cd);
          writeResult({ ...abortedFields, touchedFiles: late });
          process.exit(result.exitCode);
        }, 2000);
      } catch (error) {
        killChild(child, "SIGKILL");
        throw error;
      }
    });
  }

  // A grandchild that outlives mcode and inherited the pipes keeps stdout/stderr open, so
  // "close" never fires and the relay waits forever, writing no result. Once mcode itself is
  // gone the pipes hold nothing we still need, so drop them after a short drain grace and let
  // "close" run. This is the normal-exit twin of the stream teardown the watchdog already
  // does on the timeout path.
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
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      ...execFields(state),
      finalMessage: "",
      touchedFiles: touched,
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    if (stdoutBuf.trim()) recordEventLine(run, stdoutBuf, state);
    flushEvents(run, state);
    const final = persistFinal();
    // exec.completed with status "succeeded" is the only proof of a finished task: a
    // missing event means the stream was cut, and any other status is unfinished work.
    const cliOk = code === 0 && state.exec?.status === "succeeded";
    const succeeded = cliOk && !watchdogFired && final.error === null;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const touched = gitTouchedFiles(opts.cd);
    const cliError = state.exec && state.exec.status !== "succeeded"
      ? `mcode reported ${state.exec.status ?? "an unknown status"}${state.exec.error ? `: ${state.exec.error}` : ""}`
      : !state.exec
        ? `mcode exited ${code ?? signal} without an exec.completed event`
        : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      ...execFields(state),
      finalMessage: final.text,
      touchedFiles: touched,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(final.error
        ? { error: final.error }
        : watchdogFired
        ? { error: `mcode did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
        : cliError
          ? { error: cliError }
          : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  // If the child failed to launch, writing to its stdin can emit a stray 'error'
  // on the pipe; the 'error' handler above owns that outcome, so swallow it here.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  // Keep the preflight handler live while synchronous Git snapshots run. Node queues
  // signals during those calls, so yield before publishing a completed baseline; an
  // abort in that window must honestly report the read-only verdict as unknown.
  let resultWriter = makeResultWriter(opts, null, run, null, null);
  const writeResult = (extra) => resultWriter(extra);
  let preflightChild = null;
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult, () => preflightChild);
  const beforeTree = opts.readOnly ? gitTripwireState(opts.cd, relayArtifacts(run)) : null;
  const beforeFingerprints = opts.readOnly ? fingerprintDirtyPaths(opts.cd, relayArtifacts(run)) : null;
  await new Promise((resolveYield) => setImmediate(resolveYield));
  resultWriter = makeResultWriter(opts, null, run, beforeTree, beforeFingerprints);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const env = mcodeEnv(opts);
  const probe = await mcodeVersion(opts.launcher, probeTimeoutMs, env, (child) => { preflightChild = child; });
  resultWriter = makeResultWriter(opts, probe.version, run, beforeTree, beforeFingerprints);

  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    reportUnavailable(opts, writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    clearPreflightSignals();
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  clearPreflightSignals();
  dispatchToMcode(opts, brief, run, writeResult, env);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  mcode ${result.mcodeVersion ?? "?"}`);
  const hint = EXIT_HINTS.get(result.exitCode);
  if (hint && result.status === "failed") lines.push(`hint: ${hint}`);
  if (result.status === "failed" && [result.execError, ...(result.stderrTail ?? [])].some((line) => line && AUTH_STDERR.test(line))) {
    lines.push("hint: this looks like a sign-in problem — run `mcode login` (or `mcode login --region global`) at a terminal, then re-dispatch");
  }
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a MiniMax Code error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated mcode (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.session) lines.push(`mode: resumed session ${result.session}`);
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId})`);
  if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}`);
  if (result.execStatus && result.execStatus !== "succeeded") {
    lines.push(`MiniMax Code result: ${result.execStatus}${result.execError ? ` — ${result.execError}` : ""}`);
  }
  if (result.readOnly) {
    lines.push(result.readOnlyViolation === null
      ? "read-only check: not verifiable (git could not report) — inspect the working tree directly"
      : result.readOnlyViolation
        ? "read-only check: FAILED — the tree changed beyond this relay's artifacts; treat the run as write-capable and review the diff"
        : "read-only check: no Git-visible change detected (ignored or outside-repository paths are not covered)");
  }
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
  lines.push("--- MiniMax Code final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
