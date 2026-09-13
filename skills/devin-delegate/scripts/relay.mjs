#!/usr/bin/env node
/**
 * delegate-skills · devin-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the local Devin CLI (`devin --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Devin-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. This is the local `devin` binary, not Devin Cloud.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `devin` and `git`. The `devin` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Devin's default permission mode is `normal` (alias `auto`): read-only tools
 * auto-run, everything else prompts. Under `--print`, a tool that needs approval
 * is REJECTED, not hung — so `accept-edits` cannot finish an implementation (its
 * first gate command is rejected). The relay always sets `--permission-mode`:
 *   default        — `--permission-mode smart` (workspace edits auto; clearly-safe
 *                     shell/fetch auto; package installs, mutating git, rm/sudo
 *                     still prompt — and under `--print` a prompt is a rejection)
 *   --read-only    — `--permission-mode normal` (headless rejects writes AND exec)
 *   --full-access  — `--permission-mode dangerous` (unrestricted; opt-in)
 *
 * `--read-only` is enforced at Devin's tool boundary (headless `normal` rejects
 * writes and exec). The relay still reports `readOnlyViolation` as true when git
 * porcelain or an already-dirty Git-visible path proves a change, false when
 * coverage is complete and detects none, and null when coverage is incomplete. It
 * cannot attribute a concurrent change to Devin and does not cover ignored paths.
 *
 * `--sandbox` is never passed: it forces `autonomous` mode, and in autonomous
 * sessions the edit/write tools still prompt — broken headlessly. `--print` also
 * refuses untrusted workspaces; the relay always passes
 * `--respect-workspace-trust false`.
 *
 * The child environment removes only inherited WINDSURF_API_KEY (injected by
 * Windsurf terminals; Devin's ACP agent prefers it over the stored `devin auth`
 * login and fails with `failed to start ACP agent session`). Every other entry
 * is preserved. Version preflight uses the same environment.
 *
 * The brief is handed to Devin via `--prompt-file`, never argv and never as a
 * positional: bare positionals are `[PATH]...` and conflict with `--print`'s
 * optional PROMPT arg. `--prompt-file` keeps the brief out of the host process
 * list and clear of the OS arg-length cap.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Devin (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Devin model (default: Devin's own configured default).
 *   --permission-mode <m>  normal | accept-edits | smart | dangerous
 *                           (canonical names only; default follows autonomy).
 *   --read-only             Review/diagnosis (`--permission-mode normal`).
 *   --full-access           Unrestricted auto-approve (`--permission-mode dangerous`); opt-in.
 *   --resume-last           Continue the most recent Devin session for this cwd
 *                           (`devin --continue`); send only the delta brief.
 *   --session <id>          Continue a specific session id (`devin --resume`); send
 *                           only the delta brief. Mutually exclusive with --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the devin child is killed
 *                           and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, devinVersion, sessionId (from the ATIF export, for a later
 *   resume), finalMessage (Devin's own --print report), touchedFiles (git porcelain,
 *   null if git can't report), and the paths to final.txt, stderr.txt, and
 *   session.atif.json.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `devin` binary exits 127;
 * otherwise the exit code mirrors Devin's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to devin), or devin_unavailable. An
 * orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, appendFileSync, lstatSync, readlinkSync, openSync, readSync, closeSync, realpathSync, rmSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const AUTONOMY_MODES = new Set(["workspace-write", "read-only", "full-access"]);
const PERMISSION_MODES = new Set(["normal", "accept-edits", "smart", "dangerous"]);
const REJECTED_PERMISSION = {
  autonomous: "--permission-mode autonomous requires --sandbox, under which edit/write tools still prompt; a --print run cannot answer, so this relay never uses autonomous. Use smart (default) or dangerous.",
  auto: `--permission-mode auto is an alias of normal; pass --permission-mode normal`,
  yolo: `--permission-mode yolo is an alias of dangerous; pass --permission-mode dangerous`,
  bypass: `--permission-mode bypass is an alias of dangerous; pass --permission-mode dangerous`,
};

const IMPLEMENTER_KEY = "devin";

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
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (field === "planOnly" && (flagged.has("planOnly") || flagged.has("readOnly"))) continue;
    if (field === "readOnly" && flagged.has("readOnly")) continue;
    if (field === "force" && flagged.has("force")) continue;
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
    permissionMode: null,
    autonomy: "workspace-write",
    resumeLast: false,
    session: null,
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
      case "--permission-mode": opts.permissionMode = next(); flagged.add("permissionMode"); break;
      case "--read-only": opts.autonomy = "read-only"; flagged.add("autonomy"); flagged.add("readOnly"); break;
      // permissionMode is flagged too: an explicit --full-access must override a lane's
      // permissionMode dial the same way --read-only does, not conflict with it.
      case "--full-access": opts.autonomy = "full-access"; flagged.add("autonomy"); flagged.add("permissionMode"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  // The watchdog is relay-only (the Devin launch has no timeout flag), so a malformed
  // --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (!AUTONOMY_MODES.has(opts.autonomy)) {
    fail(`invalid autonomy "${opts.autonomy}"`);
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive");
  }
  if (opts.permissionMode !== null) {
    if (Object.hasOwn(REJECTED_PERMISSION, opts.permissionMode)) {
      fail(REJECTED_PERMISSION[opts.permissionMode]);
    }
    if (!PERMISSION_MODES.has(opts.permissionMode)) {
      fail(`unsupported --permission-mode: ${opts.permissionMode} (expected: ${[...PERMISSION_MODES].join(", ")})`);
    }
  }
  if (opts.autonomy === "read-only") {
    if (opts.permissionMode !== null && opts.permissionMode !== "normal") {
      fail(`--read-only conflicts with --permission-mode ${opts.permissionMode}; read-only runs use Devin's normal mode`);
    }
    opts.permissionMode = "normal";
  } else if (opts.autonomy === "full-access") {
    if (opts.permissionMode !== null && opts.permissionMode !== "dangerous") {
      fail(`--full-access conflicts with --permission-mode ${opts.permissionMode}; full-access runs use Devin's dangerous mode`);
    }
    opts.permissionMode = "dangerous";
  } else if (opts.permissionMode === null) {
    opts.permissionMode = "smart";
  }
  // Headless normal is real read-only at the tool boundary; keep the git tripwire.
  if (opts.permissionMode === "normal") opts.autonomy = "read-only";
  else if (opts.permissionMode === "dangerous") opts.autonomy = "full-access";
  // These values reach argv only (native binary, no win32 shell), but keep the same
  // token shape siblings use so a brief cannot inject flag-like junk.
  const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
  for (const flag of ["model", "session"]) {
    if (opts[flag] !== null && !safeToken.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  return opts;
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
  if (!match) return "relay.mjs — dispatch a brief to devin --print --prompt-file\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function versionProbeTimeout(opts) {
  // The watchdog is only armed once Devin is running, so the preflight needs a bound of its
  // own: a version probe that never returns would wedge the relay here, before any
  // result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function childEnvironment() {
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "WINDSURF_API_KEY") delete env[key];
    }
  } else {
    delete env.WINDSURF_API_KEY;
  }
  return env;
}

function devinVersion(probeTimeoutMs) {
  // Native binary on every documented platform (macOS/Linux; Windows native is unverified
  // and docs route it through WSL). Launch without a shell: there is no `.cmd` shim to
  // resolve, and a shell would reinterpret `--prompt-file` contents if it ever leaked.
  const probe = (argv, timeout = probeTimeoutMs) => {
    try {
      const version = execFileSync("devin", argv, {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        env: childEnvironment(),
      }).trim();
      return { version: version || "unknown", error: null };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: null, error: null };
      // Anything else — a hung probe we killed, or a real non-zero exit — means Devin is
      // installed but not usable. Reporting that as "unavailable" would send the caller
      // off to reinstall a binary that is already there.
      return { version: null, error };
    }
  };
  // Prefer `devin version` (documented subcommand); fall back to `--version` for builds that
  // only answer the flag. A missing binary and a hung probe are both conclusive, though:
  // retrying either would only spend the bound a second time.
  const startedAt = performance.now();
  const documented = probe(["version"]);
  if (documented.version || !documented.error || documented.error.code === "ETIMEDOUT") return documented;
  const remainingMs = Math.floor(probeTimeoutMs - (performance.now() - startedAt));
  if (remainingMs <= 0) return { version: null, error: { code: "ETIMEDOUT" } };
  return probe(["--version"], remainingMs);
}

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

function timestamp() {
  // Local script (not a workflow): Date is available and fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function autonomyFlags(permissionMode) {
  // Maps the relay's three autonomy modes (and a --permission-mode passthrough)
  // onto Devin's native --permission-mode. Devin's default is `normal`, which
  // rejects writes and exec under --print — so every path sets the mode
  // explicitly. Canonical values only; autonomous is rejected at parse time.
  return ["--permission-mode", permissionMode];
}

function buildArgv(opts, run) {
  // Native binary: paths with spaces ride argv. Never a positional prompt:
  // `--print [<PROMPT>]` cannot be combined with `[PATH]...`.
  const argv = [
    "--print",
    "--respect-workspace-trust", "false",
  ];

  if (opts.resumeLast) argv.push("-c");
  else if (opts.session) argv.push("-r", opts.session);

  // Re-pass autonomy on resume too — headless permission mode may not inherit.
  argv.push(...autonomyFlags(opts.permissionMode));

  if (opts.model) argv.push("--model", opts.model);

  // Deliver the brief via a file, not argv: keeps it out of the host process
  // list, isn't bounded by the OS arg-length cap, and a brief that begins with
  // "-" can't be misread as a flag. prepareRunDir already wrote run.briefPath.
  argv.push("--export", run.exportPath);
  argv.push("--prompt-file", run.briefPath);
  return argv;
}

function parseExportSessionId(exportPath) {
  try {
    const doc = JSON.parse(readFileSync(exportPath, "utf8"));
    if (typeof doc.session_id === "string" && doc.session_id.trim()) return doc.session_id;
  } catch {
    // missing or unparseable export → caller keeps the --session id or null
  }
  return null;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Devin's edits, not relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    finalPath: join(outDir, "final.txt"),
    stderrPath: join(outDir, "stderr.txt"),
    exportPath: join(outDir, "session.atif.json"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not advertise the previous run: a poller that races the
  // dispatch would read the old result.json as if it were this run's, and a preflight
  // failure or a run with no stdout would publish a finalPath for someone else's report.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  rmSync(run.exportPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary.
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "devin",
      workdir: opts.cd,
      autonomy: opts.autonomy,
      permissionMode: opts.permissionMode,
      model: opts.model,
      resumeLast: opts.resumeLast,
      devinVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      stderrPath: run.stderrPath,
      exportPath: existsSync(run.exportPath) ? run.exportPath : null,
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
  const result = writeResult({ status: "devin_unavailable", exitCode: 127, signal: null, sessionId: null, finalMessage: "", usage: null, touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `devin` not found on PATH. Install via the Devin CLI installer (https://devin.ai/docs) and run `devin auth login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `devin version preflight timed out after ${probeTimeoutMs}ms; Devin was not dispatched`
    : `devin version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Devin was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    usage: null,
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToDevin(opts, run, writeResult) {
  // Headless `normal` rejects writes and exec at the tool boundary; the tripwire
  // still snapshots the tree so a run that reported clean while the tree moved
  // cannot hide behind that enforcement.
  const relayArtifacts = [run.briefPath, run.finalPath, run.resultPath, run.stderrPath, run.exportPath];
  const beforeTree = opts.autonomy === "read-only" ? gitTripwireState(opts.cd, relayArtifacts) : null;
  // Working-tree and index state for paths that are ALREADY dirty. Their porcelain lines will not
  // move if the run edits them, so the line comparison alone cannot see those writes.
  const beforeFingerprints = opts.autonomy === "read-only" ? fingerprintDirtyPaths(opts.cd, relayArtifacts) : null;
  // every dispatched result that reports touchedFiles carries the verdict, aborted runs included -
  // an aborted --read-only review can still have modified the tree
  const readOnlyFlag = () =>
    opts.autonomy === "read-only"
      ? { readOnlyViolation: readOnlyVerdict(beforeTree, gitTripwireState(opts.cd, relayArtifacts), beforeFingerprints) }
      : {};
  const argv = buildArgv(opts, run);
  // Native binary: no shell. The brief is delivered via --prompt-file (never argv).
  const child = spawn("devin", argv, {
    cwd: opts.cd,
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let sessionId = opts.session || null;
  let stdout = "";
  const stderrTail = [];
  let stderrRemainder = "";

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += stdoutDecoder.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Devin progress live for the orchestrator
    appendFileSync(run.stderrPath, chunk);
    const text = stderrRemainder + stderrDecoder.write(chunk);
    const lines = text.split("\n");
    stderrRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const flushStreams = () => {
    stdout += stdoutDecoder.end();
    const tail = stderrRemainder + stderrDecoder.end();
    stderrRemainder = "";
    if (tail.trim()) stderrTail.push(tail.trimEnd());
    while (stderrTail.length > 20) stderrTail.shift();
  };

  const assembleFinal = () => {
    const message = stdout.trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  const resolvedSessionId = () => parseExportSessionId(run.exportPath) || sessionId;

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
  // no result.json and leaves the Devin child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      flushStreams();
      const touchedAtAbort = gitTouchedFiles(opts.cd);
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId: resolvedSessionId(),
        finalMessage: assembleFinal(),
        usage: null,
        touchedFiles: touchedAtAbort,
        ...readOnlyFlag(),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; Devin was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        const touchedAfterGrace = gitTouchedFiles(opts.cd);
        // Re-assemble the report: stdout flushed during the grace window must reach
        // the final write — with no event stream, this is the only copy.
        writeResult({ ...abortedFields, sessionId: resolvedSessionId(), finalMessage: assembleFinal(), touchedFiles: touchedAfterGrace, ...readOnlyFlag() });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    flushStreams();
    const touchedFiles = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId: resolvedSessionId(),
      finalMessage: assembleFinal(),
      usage: null,
      touchedFiles,
      ...readOnlyFlag(),
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
    flushStreams();
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    // A timed-out run is never a success even if Devin handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      sessionId: resolvedSessionId(),
      finalMessage,
      usage: null,
      touchedFiles,
      ...readOnlyFlag(),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `Devin did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const probe = devinVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  dispatchToDevin(opts, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  Devin ${result.devinVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a Devin error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated Devin (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.readOnlyViolation === null) lines.push("warning: this --read-only run could not be verified - git could not report, or a submodule or unreadable path left coverage incomplete; inspect the working tree directly.");
  if (result.readOnlyViolation === true) lines.push("warning: a git-visible change was detected during this --read-only run — headless --permission-mode normal rejects writes and exec, so inspect the diff before trusting the run.");
  lines.push(`autonomy: ${result.autonomy}  ·  permission mode: ${result.permissionMode}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session (--continue)");
  else if (result.sessionId && result.status !== "devin_unavailable") {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
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
  lines.push("--- Devin final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
