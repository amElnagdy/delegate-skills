#!/usr/bin/env node
/**
 * delegate-skills · dsh-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the DeepSeek Harness CLI (`dsh --profile
 * headless`), capture the run, and write a structured result the orchestrating
 * agent can review. The orchestrator runs this one command and reads the result
 * JSON — every dsh-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `dsh` and `git`. After the run it reads back the
 * session record dsh itself just wrote under `$DSH_HOME/sessions` — a local
 * file, read locally, reported locally — to recover the session id, the
 * provider/model that actually served the run, token usage, and the recorded
 * permission preset. The `dsh` process it launches does authenticate — exactly
 * as you do at the terminal. Read this file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job — after it reviews the diff and re-runs the project gates.
 *
 * Brief delivery: `dsh --profile headless` takes the task ONLY as a positional
 * argv value — no stdin (measured: a piped task with no positional exits 1,
 * "a task is required"), no message-file flag. A multi-line brief cannot ride
 * argv (`[task...]` is space-joined, and cmd.exe would mangle it besides), so
 * the brief is written verbatim to <out-dir>/brief.md and the positional
 * carries a short single-line pointer naming that absolute path. The
 * workspace-write sandbox confines mutations, not reads, and leaves the
 * platform temp roots writable, so the implementer can read the pointer file.
 *
 * Sessions: the headless surface prints no session id and offers no resume
 * flag (`--resume` is rejected as an unknown option), so this relay ships no
 * --resume-last and no --session — rework is a fresh, self-contained brief.
 * But dsh's session-persistence-jsonl plugin persists every run to
 * `$DSH_HOME/sessions/<workspace>/session-<uuid>/session.jsonl.zstd`, and the
 * relay harvests that record after the run: sessionId, the request header's
 * provider/model/reasoning effort (the configuration that actually served the
 * run — not merely what was requested), summed token usage, the turn-end
 * reason, and the recorded permission preset. Each field is null when the
 * record cannot be read; `sessionHarvest` says why. The record is a series of
 * independent zstd frames (one per append); zlib gained zstd in Node 22.15 /
 * 23.8, so on an older runtime the harvest reports "unsupported-node".
 *
 * Autonomy, in dsh's own terms: DSH_PERMISSION_MODE (read-only /
 * workspace-write / danger-full-access) in the child's environment, mapped to
 * the sandbox-policy row's mode with workspaceRoot bound to process.cwd(). The
 * approval seam fails closed when no answerer is composed — the headless case —
 * so an escalation beyond the sandbox is rejected rather than left hanging on
 * a prompt nobody can answer. A DSH_PERMISSION_MODE already exported in the
 * relay's own environment is honored and reported (source "environment"), never
 * silently stripped; --permission-mode and lane dials override it.
 *
 * Model selection has no flag on this surface. The deployment default lives in
 * the composition row agent-default-model (provider + model); a per-run request
 * is a generated --patch overlay replacing that row's whole config. A stored
 * selection in $DSH_HOME/settings.yaml outranks the overlay (measured), so the
 * overlay is a request, not a guarantee — and that is why the harvest reports
 * actualProvider/actualModel from the session record instead of assuming.
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
 *   --model <name>          Model for the generated agent-default-model patch overlay.
 *                           A stored selection in $DSH_HOME/settings.yaml outranks it;
 *                           compare result.json's modelOverlay (requested) with
 *                           actualModel (served, from the session record).
 *   --provider <name>       Provider for that overlay (default: deepseek-official, the
 *                           harness's own default provider id). Requires --model.
 *   --permission-mode <m>   DSH_PERMISSION_MODE for the child: read-only |
 *                           workspace-write | danger-full-access. Default: an already
 *                           exported DSH_PERMISSION_MODE is honored; otherwise the
 *                           variable stays unset and the harness's composed default
 *                           (workspace-write) applies.
 *   --read-only             Sugar for --permission-mode read-only, and arms the tripwire.
 *   --patch <file>          Extra --patch overlay, repeatable, passed straight through.
 *                           An overlay can define a whole provider — including a local
 *                           OpenAI-compatible endpoint — see dispatch-and-poll.md.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the dsh child is killed
 *                           and result.json gets status "timeout". dsh has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, dshVersion, permissionMode (+ its source),
 *   modelOverlay (the requested {provider, model} or null), sessionId,
 *   actualProvider / actualModel / reasoningEffort (from the session record's
 *   request header), usage (summed input/output tokens), turnEndReason,
 *   recordedPermissionMode / recordedSandboxMode / recordedApprovalPolicy,
 *   sessionHarvest (why any of those are null), finalMessage (dsh's own final
 *   stdout text), touchedFiles (git porcelain, null if git can't report),
 *   readOnlyViolation, and the paths to the brief, final.txt, and output.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a rejected
 * --permission-mode) exits 2 before any run and writes no result file; a dsh
 * CLI that cannot be found exits 127 and DOES write one; otherwise the exit
 * code mirrors dsh's own (0 success, non-zero failure). dsh catches SIGTERM,
 * drains gracefully, and exits 0 (measured), so timeout and aborted are
 * classified from the relay's own state, never from the child's exit code. If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * result.json records the signal. Once the brief validates, result.json is
 * written on every outcome — completed, failed, timeout, aborted, or
 * dsh_unavailable. An orchestrator that polls for the file must therefore also
 * treat a non-zero exit with no file as a usage error.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync, statSync, readlinkSync, lstatSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import {join, resolve, basename, dirname, sep, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir, homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
// Namespace import, not a named one: a named zstdDecompressSync import would
// crash at module load on a Node without it (zstd landed in zlib in 22.15 /
// 23.8), and this relay must still run the dispatch there — only the
// session-record harvest degrades.
import * as zlib from "node:zlib";

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_CHARS = 1_048_576;
const MAX_TIMER_MS = 2_147_483_647;
const SCHEMA = "delegate-relay.result.v1";
const DEFAULT_PROVIDER = "deepseek-official";
const PERMISSION_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
// --model/--provider ride a generated overlay file, but their values also appear
// in result.json and the overlay YAML, so keep them to safe token shapes.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const STDERR_REMAINDER_LIMIT = 64 * 1024;
const STDERR_TRUNCATION_MARKER = "[truncated] ";
// Session-record harvest bounds: candidate session directories inspected per
// run, and decompressed bytes retained per record.
const HARVEST_MAX_CANDIDATES = 512;
const HARVEST_MAX_BYTES = 512 * 1024 * 1024;
// Session directories created this many ms before the relay's own start
// timestamp still count, absorbing coarse filesystem timestamps.
const HARVEST_CLOCK_SLACK_MS = 2_000;

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
    if (field === "permissionMode") opts.permissionModeSource = "lane";
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
    permissionModeSource: null,
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
      case "--permission-mode": opts.permissionMode = next(); opts.permissionModeSource = "flag"; flagged.add("permissionMode"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--patch": { const patch = resolve(next()); assertShellSafePath("--patch", patch); opts.patches.push(patch); flagged.add("patch"); break; }
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); assertShellSafePath("--out-dir", opts.outDir); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  // An already exported DSH_PERMISSION_MODE is the user's own standing posture.
  // Adopt it when no flag or lane chose one, so the run honors it AND
  // result.json reports the mode that actually applied — stripping it silently
  // would loosen a read-only environment to workspace-write.
  const ambient = (process.env.DSH_PERMISSION_MODE || "").trim();
  if (opts.permissionMode === null && ambient) {
    opts.permissionMode = ambient;
    opts.permissionModeSource = "environment";
  }
  if (opts.readOnly && opts.permissionMode !== null && opts.permissionMode !== "read-only" && opts.permissionModeSource !== "environment") {
    fail(`--read-only conflicts with --permission-mode ${opts.permissionMode}; read-only runs use permission mode read-only`);
  }
  if (opts.readOnly) {
    opts.permissionMode = "read-only";
    opts.permissionModeSource = flagged.has("readOnly") ? "flag" : "lane";
  }
  if (opts.permissionMode !== null && !PERMISSION_MODES.has(opts.permissionMode)) {
    fail(`invalid ${opts.permissionModeSource === "environment" ? "DSH_PERMISSION_MODE" : "--permission-mode"} "${opts.permissionMode}" (expected: ${[...PERMISSION_MODES].join(", ")})`);
  }
  opts.readOnly = opts.permissionMode === "read-only";
  if (opts.model !== null && !SAFE_TOKEN.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.provider !== null && !SAFE_TOKEN.test(opts.provider)) {
    fail("--provider contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  if (opts.provider !== null && opts.model === null) {
    fail("--provider requires --model; pass both or neither for the agent-default-model overlay");
  }
  // The watchdog is relay-only (dsh has no timeout flag), so a malformed
  // --timeout must fail loudly here - a silent no-watchdog fallback would be wrong.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  for (const patch of opts.patches) {
    if (!existsSync(patch)) fail(`--patch file not found: ${patch}`);
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) {
    fail(`working directory not found: ${opts.cd}`);
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

// ---------------------------------------------------------------------------
// Session-record harvest
//
// dsh's session-persistence-jsonl plugin appends every run to
// $DSH_HOME/sessions/<escaped-workspace>/session-<uuid>/session.jsonl.zstd.
// The headless surface prints no session id, but the record on disk carries
// it — with the request header naming the provider, model, and reasoning
// effort that actually served the run, per-message token usage, the turn-end
// reason, and the recorded permission preset. The workspace escaping is not
// reversible (a directory name may itself begin with a dash), so candidates
// are matched by the header record's own `cwd` field and creation time, never
// by predicting the escape. Each append is an independent zstd frame; zlib's
// one-shot API stops after the first frame, so frames are walked by parsing
// each frame's block headers to find its end. zlib gained zstd in Node 22.15 /
// 23.8 — on an older runtime the harvest reports "unsupported-node" and only
// then; nothing here can fail the run itself.
// ---------------------------------------------------------------------------

function zstdFrameEnd(buf, off) {
  if (off + 8 > buf.length) return -1;
  const magic = buf.readUInt32LE(off);
  // Skippable frame: magic 0x184D2A50–0x184D2A5F, then a 4-byte little-endian size.
  if (magic >= 0x184D2A50 && magic <= 0x184D2A5F) {
    const end = off + 8 + buf.readUInt32LE(off + 4);
    return end > buf.length ? -1 : end;
  }
  if (magic !== 0xFD2FB528) return -1;
  let p = off + 4;
  const descriptor = buf[p]; p += 1;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksumFlag = (descriptor >> 2) & 1;
  const dictionaryIdFlag = descriptor & 3;
  if (!singleSegment) p += 1; // window descriptor
  p += [0, 1, 2, 4][dictionaryIdFlag];
  p += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [1, 2, 4, 8][contentSizeFlag];
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const blockHeader = buf.readUIntLE(p, 3); p += 3;
    const blockType = (blockHeader >> 1) & 3;
    p += blockType === 1 ? 1 : blockHeader >> 3; // an RLE block stores one byte
    if (blockHeader & 1) break; // last block
  }
  if (checksumFlag) p += 4;
  return p > buf.length ? -1 : p;
}

function readSessionRecords(file, firstFrameOnly) {
  const buf = readFileSync(file);
  const parts = [];
  let off = 0;
  let bytes = 0;
  while (off < buf.length) {
    const end = zstdFrameEnd(buf, off);
    if (end < 0 || end <= off) break;
    const part = zlib.zstdDecompressSync(buf.subarray(off, end));
    bytes += part.length;
    if (bytes > HARVEST_MAX_BYTES) break;
    parts.push(part);
    off = end;
    if (firstFrameOnly) break;
  }
  const lines = [];
  for (const line of Buffer.concat(parts).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* a frame cut mid-line stays unparsed */ }
  }
  return lines;
}

function dshSessionsRoot() {
  const fromEnv = (process.env.DSH_HOME || "").trim();
  if (fromEnv) {
    const root = join(fromEnv, "sessions");
    return existsSync(root) ? root : null;
  }
  const fallback = join(homedir(), ".dsh", "sessions");
  return existsSync(fallback) ? fallback : null;
}

function harvestSessionRecord(cd, startedAtMs) {
  const empty = {
    sessionId: null,
    sessionRecordPath: null,
    actualProvider: null,
    actualModel: null,
    reasoningEffort: null,
    usage: null,
    turnEndReason: null,
    recordedPermissionMode: null,
    recordedSandboxMode: null,
    recordedApprovalPolicy: null,
  };
  if (typeof zlib.zstdDecompressSync !== "function") {
    return { ...empty, sessionHarvest: "unsupported-node (zlib zstd needs Node 22.15+)" };
  }
  try {
    const root = dshSessionsRoot();
    if (!root) return { ...empty, sessionHarvest: "no-dsh-home" };
    let cdReal;
    try { cdReal = realpathSync.native(cd); } catch { cdReal = resolve(cd); }
    const cutoff = startedAtMs - HARVEST_CLOCK_SLACK_MS;
    let best = null;
    let inspected = 0;
    for (const workspace of readdirSync(root)) {
      const workspaceDir = join(root, workspace);
      let workspaceStat;
      try { workspaceStat = statSync(workspaceDir); } catch { continue; }
      // A new session directory bumps its workspace directory's mtime, so an
      // untouched workspace cannot hold this run's record and is skipped whole.
      if (!workspaceStat.isDirectory() || workspaceStat.mtimeMs < cutoff) continue;
      for (const session of readdirSync(workspaceDir)) {
        if (inspected >= HARVEST_MAX_CANDIDATES) break;
        const record = join(workspaceDir, session, "session.jsonl.zstd");
        let recordStat;
        try { recordStat = statSync(record); } catch { continue; }
        if (recordStat.mtimeMs < cutoff) continue;
        inspected += 1;
        let header;
        try { header = readSessionRecords(record, true)[0]; } catch { continue; }
        if (!header || header.type !== "session" || typeof header.id !== "string") continue;
        if (typeof header.createdAt !== "number" || header.createdAt < cutoff) continue;
        if (header.cwd !== cd && header.cwd !== cdReal) continue;
        if (!best || header.createdAt > best.createdAt) best = { record, id: header.id, createdAt: header.createdAt };
      }
    }
    if (!best) return { ...empty, sessionHarvest: "not-found" };
    const lines = readSessionRecords(best.record, false);
    const last = (type) => lines.filter((event) => event.type === type).pop();
    const requestHeader = last("request/header")?.data?.header?.config ?? null;
    const usage = { inputTokens: 0, outputTokens: 0, assistantMessages: 0 };
    for (const event of lines) {
      if (event.type !== "assistant/message" || !event.data?.usage) continue;
      usage.inputTokens += event.data.usage.inputTokens || 0;
      usage.outputTokens += event.data.usage.outputTokens || 0;
      usage.assistantMessages += 1;
    }
    return {
      sessionId: best.id,
      sessionRecordPath: best.record,
      actualProvider: typeof requestHeader?.provider === "string" ? requestHeader.provider : null,
      actualModel: typeof requestHeader?.model === "string" ? requestHeader.model : null,
      reasoningEffort: typeof requestHeader?.reasoningEffort === "string" ? requestHeader.reasoningEffort : null,
      usage: usage.assistantMessages > 0 ? usage : null,
      turnEndReason: last("turn/end")?.data?.reason?.kind ?? null,
      recordedPermissionMode: last("permission/preset")?.data?.preset ?? null,
      recordedSandboxMode: last("sandbox/mode")?.data?.mode ?? null,
      recordedApprovalPolicy: last("approval/policy")?.data?.policy ?? null,
      sessionHarvest: "ok",
    };
  } catch (error) {
    return { ...empty, sessionHarvest: `error: ${String(error?.message || error)}` };
  }
}

function buildArgv(opts, pointerTask, patchOverlayPath) {
  // Spaceable values reach cmd.exe unquoted when the .cmd shim forces shell:true
  // (a temp path under C:\Users\First Last\... would otherwise split — issue #3),
  // so quote exactly those there. The pointer task is a single positional argv
  // value; quoting keeps it intact on win32. POSIX passes argv directly.
  const shellQuoted = process.platform === "win32";
  const quote = (value) => (shellQuoted ? `"${value}"` : value);
  const argv = ["--profile", "headless"];
  if (patchOverlayPath) argv.push("--patch", quote(patchOverlayPath));
  for (const patch of opts.patches) argv.push("--patch", quote(patch));
  argv.push(quote(pointerTask));
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only dsh's edits, not relay's artifacts.
  // The workspace-write sandbox leaves the platform temp roots writable and
  // reads unconfined, which is what makes the pointer-file mechanic workable.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  // The default out-dir borrows basename(--cd), so a repo directory carrying a
  // cmd metacharacter would reach cmd.exe through the generated brief path.
  assertShellSafePath("the run directory", outDir);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    startedAtMs: Date.now(),
    outDir,
    briefPath: join(outDir, "brief.md"),
    finalPath: join(outDir, "final.txt"),
    outputPath: join(outDir, "output.txt"),
    resultPath: join(outDir, "result.json"),
    patchOverlayPath: null,
  };
  // A reused --out-dir must not publish a previous run's artifacts as this one's:
  // makeResultWriter derives finalPath/outputPath from existsSync, and a polling
  // orchestrator reads resultPath (same guard as aider-delegate).
  for (const stale of [run.finalPath, run.outputPath, run.resultPath, join(outDir, "model-overlay.yml")]) {
    rmSync(stale, { force: true });
  }
  writeFileSync(run.briefPath, brief, "utf8");
  // A requested model rides a generated patch overlay replacing the
  // agent-default-model row's whole config (a patch replaces the targeted row's
  // complete config rather than deep-merging keys, so provider and model both
  // belong in the file). A stored selection in $DSH_HOME/settings.yaml layers
  // over the composition and wins — measured — so this is a request; the
  // harvest's actualModel reports what actually served the run.
  if (opts.model !== null) {
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
      permissionModeSource: opts.permissionModeSource,
      readOnly: opts.readOnly,
      patches: opts.patches,
      modelOverlay,
      dshVersion: version,
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

const HARVEST_SKIPPED = {
  sessionId: null,
  sessionRecordPath: null,
  actualProvider: null,
  actualModel: null,
  reasoningEffort: null,
  usage: null,
  turnEndReason: null,
  recordedPermissionMode: null,
  recordedSandboxMode: null,
  recordedApprovalPolicy: null,
  sessionHarvest: "skipped (dsh was not dispatched)",
};

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({ status: "dsh_unavailable", exitCode: 127, signal: null, finalMessage: "", touchedFiles: null, readOnlyViolation: null, ...HARVEST_SKIPPED });
  printSummary(result, resultPath);
  process.stderr.write("relay: `dsh` not found on PATH. Install it with `npm i -g @deepseek-ai/dsh` (or `npx @deepseek-ai/dsh`) and provide a provider credential (DEEPSEEK_API_KEY, or the provider configured in $DSH_HOME/settings.yaml).\n");
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
    ...HARVEST_SKIPPED,
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToDsh(opts, run, writeResult, beforeTree, beforeFingerprints, relayArtifacts) {
  // The pointer task is a single-line, ASCII-only instruction naming the
  // absolute brief path; the brief itself travels as a file because the
  // headless surface reads no stdin. Keep the sentence in lockstep with
  // writing-the-brief.md.
  const pointerTask = `Read the task brief at ${run.briefPath} and execute it fully.`;
  const argv = buildArgv(opts, pointerTask, run.patchOverlayPath);
  // DSH_PERMISSION_MODE is the harness's own autonomy term. The effective mode
  // (flag > lane > already-exported environment) is set explicitly; when none
  // was chosen anywhere the variable is simply absent and the harness's
  // composed default (workspace-write) applies.
  const childEnv = { ...process.env };
  if (opts.permissionMode !== null) childEnv.DSH_PERMISSION_MODE = opts.permissionMode;
  // shell:true only for the .cmd shim on win32 (see dshVersion). Safe either
  // way: the brief travels as a file, and argv holds only launcher flags,
  // metacharacter-checked patch paths, and the single-line pointer task.
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree
  const child = spawn("dsh", argv, {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: childEnv,
  });

  let stdoutBuf = "";
  let stdoutTruncated = false;
  const stderrTail = [];
  // A stderr line can span data chunks; the held fragment keeps the tail one
  // entry per logical line. The fragment itself is bounded, so one enormous
  // unterminated line cannot grow it without limit — a bounded suffix survives,
  // marked as truncated.
  let stderrRemainder = "";

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  // dsh prints exactly the final assistant message on stdout (measured), so
  // stdout is buffered whole. The bound keeps a runaway process from exhausting
  // memory; past it the HEAD is kept and the truncation reported.
  child.stdout.on("data", (chunk) => {
    if (stdoutTruncated) return;
    stdoutBuf += stdoutDecoder.write(chunk);
    if (stdoutBuf.length > MAX_BUFFERED_CHARS) {
      stdoutBuf = stdoutBuf.slice(0, MAX_BUFFERED_CHARS);
      stdoutTruncated = true;
    }
  });

  const pushStderr = (text, flush = false) => {
    const lines = `${stderrRemainder}${text}`.split("\n");
    // On flush the decoder is done, so the trailing fragment is a complete line.
    const remainder = flush ? "" : (lines.pop() ?? "");
    stderrRemainder = remainder.length > STDERR_REMAINDER_LIMIT
      ? `${STDERR_TRUNCATION_MARKER}${remainder.slice(-(STDERR_REMAINDER_LIMIT - STDERR_TRUNCATION_MARKER.length))}`
      : remainder;
    for (const line of lines) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  };

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface dsh progress live for the orchestrator
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

  const flushCapture = () => {
    stdoutBuf += stdoutDecoder.end();
    pushStderr(stderrDecoder.end(), true);
    if (stdoutBuf) writeFileSync(run.outputPath, stdoutBuf, "utf8");
    const finalMessage = stdoutBuf.trim();
    if (finalMessage) writeFileSync(run.finalPath, `${finalMessage}\n`, "utf8");
    return finalMessage;
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
      const finalMessage = flushCapture();
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        finalMessage,
        touchedFiles: gitTouchedFiles(opts.cd),
        readOnlyViolation: null,
        ...harvestSessionRecord(opts.cd, run.startedAtMs),
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
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd), ...harvestSessionRecord(opts.cd, run.startedAtMs) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const finalMessage = flushCapture();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      readOnlyViolation: null,
      ...harvestSessionRecord(opts.cd, run.startedAtMs),
      stderrTail: stderrTail.slice(-20),
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
    const finalMessage = flushCapture();
    // dsh catches SIGTERM, drains gracefully, and exits 0 (measured), so a
    // timed-out or aborted run is classified from the relay's own state —
    // never from the child's exit code.
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
      ...harvestSessionRecord(opts.cd, run.startedAtMs),
      ...(stdoutTruncated ? { outputTruncated: `dsh's stdout exceeded ${MAX_BUFFERED_CHARS} characters; finalMessage is the retained head — read outputPath.` } : {}),
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
  // against. The relay's own artifacts are excluded: --out-dir can point into
  // the repo under review, and the relay must not trip its own tripwire.
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
    lines.push(`permission mode: ${result.permissionMode} (DSH_PERMISSION_MODE, from ${result.permissionModeSource ?? "flag"})`);
  }
  if (result.readOnlyViolation === true) lines.push("READ-ONLY VIOLATION: the tree changed during a read-only run — inspect it before trusting this result.");
  if (result.modelOverlay) lines.push(`model requested: ${result.modelOverlay.provider}/${result.modelOverlay.model} (an overlay request; a stored settings.yaml selection outranks it)`);
  if (result.actualModel) lines.push(`model served: ${result.actualProvider ? `${result.actualProvider}/` : ""}${result.actualModel}${result.reasoningEffort ? ` (reasoning effort ${result.reasoningEffort})` : ""}`);
  if (result.sessionId) lines.push(`session record: ${result.sessionId} (no headless resume; the id names the record under $DSH_HOME/sessions for audit)`);
  if (result.usage) lines.push(`usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out across ${result.usage.assistantMessages} assistant message(s)`);
  if (result.recordedPermissionMode) lines.push(`recorded posture: preset ${result.recordedPermissionMode}, sandbox ${result.recordedSandboxMode ?? "?"}, approval ${result.recordedApprovalPolicy ?? "?"}`);
  if (result.sessionHarvest && result.sessionHarvest !== "ok" && !result.sessionHarvest.startsWith("skipped")) {
    lines.push(`session harvest: ${result.sessionHarvest} — sessionId/actualModel/usage are null, not zero`);
  }
  if (result.outputTruncated) lines.push(`warning: ${result.outputTruncated}`);
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
