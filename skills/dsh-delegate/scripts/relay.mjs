#!/usr/bin/env node
/**
 * delegate-skills · dsh-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the DeepSeek Harness CLI (`dsh
 * --profile headless`), capture the run, and write a structured result the
 * orchestrating agent can review. The orchestrator runs this one command and
 * reads the result JSON — every dsh-specific mechanic lives in here, which
 * keeps the skill orchestrator-agnostic. Verified on Claude Code; other
 * shell-capable agents (OpenCode, Cursor, …) are designed-for but not yet
 * verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `dsh` and `git`. The `dsh` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job — after it reviews the diff and re-runs the project gates.
 *
 * Brief delivery: `dsh --profile headless` takes the task ONLY as a positional
 * argv value — no stdin, no --message-file, no prompt flag. `dsh --profile
 * headless --help` documents that positional as `[task...]` — multiple words
 * are joined by spaces — which is a second, independent reason a multi-line
 * brief cannot ride argv: it would be space-joined and mangled. Under
 * shell:true on win32 it would be mangled by cmd.exe as well, so the brief is
 * written verbatim to <out-dir>/brief.md (under the system temp dir, which is
 * a platform temporary root the harness's workspace-write sandbox allows
 * reading and writing — reads are not confined) and the positional carries a
 * short, single-line, ASCII-only pointer that names the absolute path and
 * instructs dsh to read it and execute it fully. The pointer text contains no
 * quotes, newlines, or shell metacharacters beyond the path itself.
 *
 * There is NO session id and NO resume on this surface. The headless app
 * persists the session under $DSH_HOME but prints no id and offers no resume or
 * continue flag, so this relay ships no --resume-last and no --session and
 * reports sessionId: null. Rework is a fresh full brief, not a delta.
 *
 * Autonomy, in dsh's own terms: DSH_PERMISSION_MODE (read-only /
 * workspace-write / danger-full-access) in the child's environment, mapped to
 * the sandbox-policy row's mode with workspaceRoot bound to process.cwd(). The
 * approval seam fails closed when no answerer is composed — the headless case —
 * so an escalation beyond the sandbox is rejected rather than left hanging on a
 * prompt nobody can answer. This is why a headless dsh run does not need an
 * auto-approve flag and cannot hang on a permission prompt.
 *
 * Model selection has no flag on this surface. The deployment default lives in
 * the composition row agent-default-model (provider + model), and a per-run
 * override is a generated --patch overlay that replaces that row's whole config.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for dsh; becomes the child cwd and the
 *                           harness's workspace root (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Model for the generated agent-default-model patch overlay
 *                           that overrides the composed default; a stored selection
 *                           in $DSH_HOME/settings.yaml outranks it, so this is a
 *                           request, not a guarantee, and the effective model is
 *                           not observable from the run.
 *   --provider <name>       Provider for that overlay (default: deepseek-official,
 *                           the harness's own default provider id); same
 *                           precedence as --model.
 *   --permission-mode <m>   DSH_PERMISSION_MODE for the child: read-only |
 *                           workspace-write | danger-full-access. Default: leave the
 *                           variable unset so the harness's composed default applies.
 *   --read-only             Sugar for --permission-mode read-only, and arms the tripwire.
 *   --patch <file>          Extra --patch overlay, repeatable, passed straight through.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the dsh child is killed
 *                           and result.json gets status "timeout". dsh has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, dshVersion, permissionMode, sessionId (always
 *   null — the headless surface exposes none), finalMessage (dsh's own final
 *   stdout text), touchedFiles (git porcelain, null if git can't report),
 *   readOnlyViolation, modelOverlay (the requested {provider, model} or null),
 *   and the paths to the brief and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a rejected
 * --permission-mode) exits 2 before any run and writes no result file; a dsh
 * CLI that cannot be found exits 127 and DOES write one; otherwise the exit
 * code mirrors dsh's own (0 success, non-zero failure). If the child dies on a
 * signal, the exit code is 128 plus the signal number and result.json records
 * the signal. Once the brief validates, result.json is written on every outcome
 * — completed, failed, timeout (the --timeout watchdog fired), aborted (the
 * relay itself was killed and forwarded the kill to dsh), or dsh_unavailable.
 * An orchestrator that polls for the file must therefore also treat a non-zero
 * exit with no file as a usage error.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, statSync, readlinkSync, lstatSync, openSync, readSync, closeSync, realpathSync, readdirSync } from "node:fs";
import {join, resolve, basename, dirname, sep, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir, homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const SCHEMA = "delegate-relay.result.v1";
const DEFAULT_PROVIDER = "deepseek-official";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const PERMISSION_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

const IMPLEMENTER_KEY = "dsh";

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
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("permissionMode"))) continue;
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
    if (field === "sandbox") opts.sandboxConfigured = true;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

// Paths reach cmd.exe on win32, because a .cmd shim cannot be launched without a
// shell and Node offers no shell-free path to one. Double quotes do NOT stop cmd
// from expanding % or, under delayed expansion, !, and & | ^ < > still separate or
// redirect. Quoting alone is therefore not a boundary: reject these outright rather
// than pass a path cmd would rewrite. POSIX spawns argv directly and needs no check.
const WIN32_SHELL_METACHARACTERS = /[%!&|^<>"]/;

function assertShellSafePath(label, value) {
  if (process.platform !== "win32") return;
  const offending = WIN32_SHELL_METACHARACTERS.exec(value);
  if (offending) {
    fail(`${label} contains ${JSON.stringify(offending[0])}, which cmd.exe rewrites on win32: ${value}`);
  }
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    provider: null,
    permissionMode: null,
    readOnly: false,
    patches: [],
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
      case "--provider": opts.provider = next(); flagged.add("provider"); break;
      case "--permission-mode": opts.permissionMode = next(); flagged.add("permissionMode"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--patch": { const patch = next(); assertShellSafePath("--patch", patch); opts.patches.push(patch); flagged.add("patch"); break; }
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); assertShellSafePath("--out-dir", opts.outDir); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  // Normalize lane aliases: delegate-setup may carry the permission mode as
  // `permissionMode` or the readOnly boolean; adopt them before validation.
  if (opts.readOnly && opts.permissionMode === null) opts.permissionMode = "read-only";
  if (opts.readOnly && opts.permissionMode !== "read-only") {
    fail(`--read-only conflicts with --permission-mode ${opts.permissionMode}; read-only runs use permission mode read-only`);
  }
  if (opts.readOnly) opts.permissionMode = "read-only";
  if (opts.permissionMode !== null && !PERMISSION_MODES.has(opts.permissionMode)) {
    fail(`invalid --permission-mode "${opts.permissionMode}" (expected: ${[...PERMISSION_MODES].join(", ")})`);
  }
  if (opts.model !== null && !SAFE_TOKEN.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.provider !== null && !SAFE_TOKEN.test(opts.provider)) {
    fail("--provider contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.provider !== null && opts.model === null) {
    fail("--provider requires --model; pass both or neither for the agent-default-model overlay");
  }
  // --timeout validation: the watchdog is relay-only (dsh has no timeout flag), so a malformed
  // --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  for (const patch of opts.patches) {
    if (!existsSync(patch)) fail(`--patch file not found: ${patch}`);
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
  if (!match) return "relay.mjs — dispatch a brief to dsh --profile headless\n";
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
  // The watchdog is only armed once dsh is running, so the preflight needs a bound of
  // its own: a `dsh --version` that never returns would wedge the relay here, before
  // any result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function dshVersion(probeTimeoutMs) {
  try {
    // On Windows, npm installs `dsh` as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
    // ENOENTs on a working install. POSIX is unaffected.
    const version = execFileSync("dsh", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
      env: process.env,
    }).trim();
    return { version: version || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    // shell:true routes a missing binary through cmd.exe, which reports it as a non-zero
    // exit rather than ENOENT; that is still "not installed", not a broken install.
    if (process.platform === "win32" &&
        /not recognized as an internal or external command/i.test(String(error?.stderr || ""))) {
      return { version: null, error: null };
    }
    // Anything else — a hung probe we killed, or a real non-zero exit — means dsh is
    // installed but not usable. Reporting that as "unavailable" would send the caller
    // off to reinstall a CLI that is already there.
    return { version: null, error };
  }
}

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

function buildArgv(opts, pointerTask, patchOverlayPath) {
  // Spaceable values reach cmd.exe unquoted when a .cmd shim forces shell:true
  // (a temp path under C:\Users\First Last\... would otherwise split — issue #3),
  // so quote exactly those there. The pointer task is a single positional argv
  // value; quoting keeps it intact on win32.
  const shellQuoted = process.platform === "win32";
  const quote = (value) => (shellQuoted ? `"${value.replaceAll('"', '\\"')}"` : value);
  const argv = ["--profile", "headless"];
  if (patchOverlayPath) argv.push("--patch", quote(patchOverlayPath));
  for (const patch of opts.patches) argv.push("--patch", quote(patch));
  argv.push(pointerTask);
  // Quote the pointer task itself on win32 shell path so spaces in the temp
  // brief path survive cmd.exe's tokenization.
  if (shellQuoted) argv[argv.length - 1] = quote(argv[argv.length - 1]);
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only dsh's edits, not relay's artifacts.
  // This temp root is writable and readable under the workspace-write sandbox,
  // which is why the pointer-file mechanic is safe: the implementer can read it.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  // The default out-dir borrows basename(--cd), so a repo directory carrying a cmd
  // metacharacter would reach cmd.exe through the generated brief and overlay paths.
  assertShellSafePath("the run directory", outDir);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    outDir,
    briefPath: join(outDir, "brief.md"),
    finalPath: join(outDir, "final.txt"),
    outputPath: join(outDir, "output.txt"),
    resultPath: join(outDir, "result.json"),
    patchOverlayPath: null,
  };
  // A reused --out-dir must not publish a previous run's artifacts as this one's.
  // makeResultWriter derives finalPath/outputPath from existsSync, and a polling
  // orchestrator reads resultPath, so a run that writes no stdout would otherwise
  // republish the earlier report and outcome (same guard as aider-delegate).
  for (const stale of [run.finalPath, run.outputPath, run.resultPath, join(outDir, "model-overlay.yml")]) {
    try { rmSync(stale, { force: true }); } catch { /* an unclearable path fails loudly at write time */ }
  }
  writeFileSync(run.briefPath, brief, "utf8");
  // If a model (and thus a provider) was requested, generate the patch overlay
  // that replaces the agent-default-model row's whole config. A patch replaces
  // the targeted row's complete config rather than deep-merging keys, so the
  // file must contain both provider and model.
  // Precedence: that composition entry is the base of the agent-default-model
  // Settings section; a stored selection in $DSH_HOME/settings.yaml layers over
  // it and wins (see packages/core/agent-default-model/README.md). The relay
  // deliberately does not read, parse, or modify the user's settings — the
  // overlay is a request, not a guarantee, and the effective model is not
  // observable from the run.
  const needsOverlay = opts.model !== null;
  if (needsOverlay) {
    const provider = opts.provider || DEFAULT_PROVIDER;
    const overlay = `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${opts.model}\n`;
    run.patchOverlayPath = join(outDir, "model-overlay.yml");
    writeFileSync(run.patchOverlayPath, overlay, "utf8");
  }
  return run;
}

function makeResultWriter(opts, version, run) {
  // Returns writeResult(extra): merges the per-outcome fields onto the run's
  // standing metadata, persists result.json, and returns the object it just
  // wrote so the caller can hand it straight to printSummary.
  // sessionId is always null: the headless surface exposes none.
  // modelOverlay is the requested {provider, model} or null — not the
  // effective model, which the relay cannot observe and which a stored
  // $DSH_HOME/settings.yaml selection outranks.
  const modelOverlay = opts.model !== null
    ? { provider: opts.provider || DEFAULT_PROVIDER, model: opts.model }
    : null;
  return (extra) => {
    const result = {
      schema: SCHEMA,
      lane: opts.lane,
      laneSource: opts.laneSource,
      workdir: opts.cd,
      permissionMode: opts.permissionMode,
      readOnly: opts.readOnly,
      patches: opts.patches,
      modelOverlay,
      dshVersion: version,
      // The headless surface exposes no session id; rework is a fresh brief.
      sessionId: null,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      outputPath: existsSync(run.outputPath) ? run.outputPath : null,
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
  const result = writeResult({ status: "dsh_unavailable", exitCode: 127, signal: null, finalMessage: "", touchedFiles: null, readOnlyViolation: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `dsh` not found on PATH. Install it with `npm i -g @deepseek-ai/dsh` (or `npx @deepseek-ai/dsh`) and set DEEPSEEK_API_KEY.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `dsh --version preflight timed out after ${probeTimeoutMs}ms; dsh was not dispatched`
    : `dsh --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; dsh was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    readOnlyViolation: null,
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToDsh(opts, run, writeResult, beforeTree, beforeFingerprints, relayArtifacts) {
  // The pointer task is a single-line, ASCII-only instruction naming the
  // absolute brief path. The brief itself is the file; dsh reads no stdin.
  const pointerTask = `Read the task brief at ${run.briefPath} and execute it fully.`;
  const argv = buildArgv(opts, pointerTask, run.patchOverlayPath);
  // DSH_PERMISSION_MODE is the harness's own autonomy term: read-only |
  // workspace-write | danger-full-access. Leave it unset when the caller did
  // not specify a mode so the harness's composed default (workspace-write)
  // applies; otherwise set it in the child's environment only.
  const childEnv = { ...process.env };
  if (opts.permissionMode !== null) childEnv.DSH_PERMISSION_MODE = opts.permissionMode;
  else delete childEnv.DSH_PERMISSION_MODE;
  // shell:true only for the .cmd shim on win32 (see dshVersion). Safe either
  // way: the brief travels as a file, and argv holds only launcher flags,
  // patch paths, and the single-line pointer task.
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree
  const child = spawn("dsh", argv, {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: childEnv,
  });

  let stdoutBuf = "";
  const stderrTail = [];

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    const text = stdoutDecoder.write(chunk);
    stdoutBuf += text;
  });

  // stderrTail is the only retained stderr: bounded to 20 lines and reported in
  // result.json. The decoder flush goes through the same path, so a trailing
  // partial line still reaches the report.
  const pushStderr = (text) => {
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  };

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    pushStderr(stderrDecoder.write(chunk));
  });

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
  // no result.json and leaves the dsh child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      // stdoutBuf + decoder flush may still hold the final report
      stdoutBuf += stdoutDecoder.end();
      pushStderr(stderrDecoder.end());
      const finalMessage = stdoutBuf.trim();
      if (finalMessage) writeFileSync(run.finalPath, `${finalMessage}\n`, "utf8");
      if (stdoutBuf) writeFileSync(run.outputPath, stdoutBuf, "utf8");
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        finalMessage,
        touchedFiles: gitTouchedFiles(opts.cd),
        readOnlyViolation: null,
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; dsh was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    stdoutBuf += stdoutDecoder.end();
    pushStderr(stderrDecoder.end());
    const finalMessage = stdoutBuf.trim();
    if (finalMessage) writeFileSync(run.finalPath, `${finalMessage}\n`, "utf8");
    if (stdoutBuf) writeFileSync(run.outputPath, stdoutBuf, "utf8");
    const result = writeResult({ status: "failed", exitCode: 1, signal: null, finalMessage, touchedFiles: gitTouchedFiles(opts.cd), readOnlyViolation: null, stderrTail: stderrTail.slice(-20), error: String(err && err.message ? err.message : err) });
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
    stdoutBuf += stdoutDecoder.end();
    pushStderr(stderrDecoder.end());
    if (stdoutBuf) writeFileSync(run.outputPath, stdoutBuf, "utf8");
    const finalMessage = stdoutBuf.trim();
    if (finalMessage) writeFileSync(run.finalPath, `${finalMessage}\n`, "utf8");
    // A timed-out or aborted run is never completed even if dsh handles SIGTERM by
    // exiting 0 — SIGTERM exits 0 on every surface, so the relay must classify
    // timeout and aborted from its own state, never from the child's exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    // Only a read-only run makes a read-only claim worth measuring.
    const readOnlyViolation = opts.readOnly
      ? readOnlyVerdict(beforeTree, gitTripwireState(opts.cd, relayArtifacts), beforeFingerprints)
      : null;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      readOnlyViolation,
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `dsh did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
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
  const probe = dshVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  // Fingerprint before dispatch so a read-only run has something to compare
  // against. The relay's own artifacts are excluded.
  const relayArtifacts = [run.briefPath, run.outputPath, run.finalPath, run.resultPath, run.patchOverlayPath].filter(Boolean);
  const beforeTree = opts.readOnly ? gitTripwireState(opts.cd, relayArtifacts) : null;
  const beforeFingerprints = opts.readOnly ? fingerprintDirtyPaths(opts.cd, relayArtifacts) : null;

  dispatchToDsh(opts, run, writeResult, beforeTree, beforeFingerprints, relayArtifacts);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  dsh ${result.dshVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a dsh error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated dsh (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.permissionMode) {
    if (result.readOnly) lines.push("permission mode: read-only (DSH_PERMISSION_MODE=read-only)");
    else lines.push(`permission mode: ${result.permissionMode}`);
  } else if (result.readOnly) lines.push("permission mode: read-only (DSH_PERMISSION_MODE=read-only)");
  if (result.readOnlyViolation === true) lines.push("READ-ONLY VIOLATION: the tree changed during a read-only run — inspect it before trusting this result.");
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
  lines.push("--- dsh final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
