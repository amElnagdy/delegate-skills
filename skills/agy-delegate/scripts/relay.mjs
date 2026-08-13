#!/usr/bin/env node
/**
 * delegate-skills · agy-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Google Antigravity CLI (`agy --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON -
 * every Antigravity-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `agy` and `git`. The `agy` process it launches
 * does authenticate - exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `agy --print` takes the prompt as a command-line argument, so the brief is
 * visible in the host process list (`ps`, /proc). On a shared machine keep secrets
 * out of the brief - reference them by a path or env var the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job -
 * after it reviews the diff and re-runs the project gates.
 *
 * Antigravity owns its own permission policy. This helper does not pass
 * --dangerously-skip-permissions by default; opt into that flag only when the
 * human explicitly accepts it. Pass --sandbox to enable Antigravity's terminal
 * sandbox for the run. Combining both flags must be treated as full access because
 * permission requests to act outside the sandbox may be auto-approved.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Antigravity (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Antigravity model label (default: agy's configured default).
 *   --effort <level>        Reasoning effort: low, medium, or high (passed as agy's own --effort).
 *   --project <id>          Use an existing Antigravity project.
 *   --new-project           Force a fresh Antigravity project (default for fresh runs).
 *   --resume-last           Continue the most recent Antigravity conversation; send only the delta brief.
 *   --conversation <id>     Continue a specific Antigravity conversation; send only the delta brief.
 *   --sandbox               Enable Antigravity's terminal sandbox for this run.
 *   --read-only             Run in plan mode (`--mode plan`), removing write and edit paths.
 *                           Mutually exclusive with --dangerously-skip-permissions.
 *   --dangerously-skip-permissions
 *                           Auto-approve Antigravity tool permission requests. Use only with human approval.
 *                           Mutually exclusive with --read-only.
 *   --preflight-usage       Before dispatching, ask agy for the account's quota with
 *                           `agy -p "/usage" --output-format json` - a headless read that
 *                           starts no agent turn, spends no quota, and leaves no
 *                           conversation behind. When EVERY quota bucket reads exhausted the
 *                           brief is not dispatched; otherwise the snapshot is recorded on
 *                           result.json and the run proceeds unchanged. A probe that fails,
 *                           times out, or returns an unexpected shape never blocks dispatch.
 *   --print-timeout <dur>   Timeout agy itself applies to print mode (default: 30m).
 *   --timeout <dur>         Relay-side watchdog, h/m/s like 30m (default: --print-timeout
 *                           plus a 60s grace). On expiry the agy process tree is killed and
 *                           result.json gets status "timeout". Set it explicitly when agy
 *                           may hang past its own print timeout.
 *   --add-dir <dir>         Add an extra workspace directory. Repeatable.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, agyVersion, projectId, conversationId, finalMessage
 *   (Antigravity's own report), touchedFiles (git porcelain, null if git can't report),
 *   readOnlyViolation (on --read-only), usagePreflight (null unless --preflight-usage), and
 *   the paths to brief.txt, final.txt, agy.log, and stderr.txt.
 *
 * Usage limits: this relay ships NO terminal-error matcher, deliberately. agy's quota
 * message is produced by Google's Antigravity backend, not by the CLI - no such literal
 * ships in the 1.1.12 binary - so there is no version-pinnable signature to match and any
 * classification from the error text would be a guess. What agy does have is a headless,
 * side-effect-free quota query, so classification here is opt-in and happens BEFORE
 * dispatch. With --preflight-usage, and only when every quota bucket reads exhausted, the
 * relay refuses to dispatch and writes:
 *   status: "failed"                      (the status set is a closed enum; this is additive)
 *   failureClass: "usage_limit"
 *   limit: { kind: "quota_exhausted", retryAt, resetsAt, evidence: { source, code, excerpt, artifactLine } }
 * resetsAt is the soonest bucket reset agy stated; retryAt stays null because agy states no
 * retry time and a guessed one is worse than silence. Otherwise the snapshot (bucket id,
 * remaining fraction, reset time) is recorded on the result and the run proceeds. The relay
 * never judges whether the REMAINING quota is "enough" for this brief - that is unknowable
 * before the run. It reports the provider's own numbers and blocks only on true exhaustion.
 * A usage limit is not a task failure: do not rework the brief; wait for the reset or
 * re-dispatch on another lane.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `agy` binary exits 127;
 * otherwise the exit code mirrors Antigravity's own, except that an exit-zero
 * permission denial or silent write-dispatch no-op is forced to exit 1. A
 * --preflight-usage refusal never dispatches at all and exits 1.
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome -
 * completed, failed, timeout (the relay watchdog fired after explicit --timeout,
 * or after --print-timeout plus 60s grace), aborted (the relay itself was killed
 * and forwarded the kill to agy), or agy_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, readlinkSync, lstatSync, existsSync, appendFileSync, realpathSync, rmSync } from "node:fs";
import {join, resolve, basename, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_PRINT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TIMER_DURATION = "596h31m23s";
const VERSION_PROBE_TIMEOUT_MS = 10_000;

// agy's headless quota query, live-captured on agy 1.1.12. It answers from cached account
// state: the response carries conversation_id "", num_turns 0 and every token counter 0, so
// it starts no agent turn, spends no quota, and leaves no conversation behind that a later
// --resume-last could latch onto. That is the whole reason it qualifies as a preflight -
// a canary dispatch would fail all three tests.
const USAGE_PREFLIGHT_ARGS = ["-p", "/usage", "--output-format", "json"];
const USAGE_PREFLIGHT_COMMAND = 'agy -p "/usage" --output-format json';
// agy only answers /usage without starting an agent turn from 1.1.12 onward. Older builds
// treated it as an ordinary prompt and spent the very quota this probe exists to protect
// (antigravity-cli issues #234 on 1.0.3 and #543 on 1.0.16), so the probe is version-gated.
const USAGE_PREFLIGHT_MIN_VERSION = [1, 1, 12];

const IMPLEMENTER_KEY = "agy";

// Bound the evidence excerpt: a provider response can carry a very long body, and the
// orchestrator only needs enough to audit the match. The full raw response stays in
// usage-preflight.json, which evidence.source/artifactLine point at.
const MAX_EVIDENCE_CHARS = 400;

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function boundedExcerpt(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS)}…` : flat;
}

function parseResetTimestamp(value, mode) {
  // Only a zoned absolute timestamp or a well-defined duration becomes a time. Anything
  // ambiguous or localized ("resets 3pm") yields null — a guessed reset time would send
  // the orchestrator back at the wrong moment, which is worse than reporting nothing.
  if (value === null || value === undefined) return null;
  if (mode === "absolute") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
    const parsed = new Date(value.trim().replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (mode === "duration") {
    const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30 * 24 * 3600) return null;
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

function usageLimitFields(match) {
  // The additive half of the result contract: status stays "failed" so orchestrators that
  // switch on the closed status enum keep working; failureClass/limit carry the detail.
  if (!match) return {};
  return {
    failureClass: "usage_limit",
    limit: {
      kind: match.kind,
      retryAt: match.retryAt ?? null,
      resetsAt: match.resetsAt ?? null,
      evidence: {
        source: match.source,
        code: match.code ?? null,
        excerpt: boundedExcerpt(match.excerpt),
        artifactLine: match.artifactLine ?? null,
      },
    },
  };
}

function usagePreflightSupported(version) {
  // A version we cannot read as a dotted number (a custom build, a `agy changelog` that
  // printed something unexpected) is NOT treated as old: every documented regression
  // reports a parseable version, and refusing to probe on an unreadable one would make the
  // flag silently inert on installs where it is the whole point of the run.
  const parts = String(version ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!parts) return true;
  const found = parts.slice(1, 4).map(Number);
  for (let i = 0; i < USAGE_PREFLIGHT_MIN_VERSION.length; i += 1) {
    if (found[i] !== USAGE_PREFLIGHT_MIN_VERSION[i]) return found[i] > USAGE_PREFLIGHT_MIN_VERSION[i];
  }
  return true;
}

function queryUsage(opts, run, timeoutMs, version) {
  // Never throws and never blocks: every failure mode returns a note-bearing snapshot the
  // caller records and then dispatches anyway. A broken probe must not cost a real run.
  const checkedAt = new Date().toISOString();
  const snapshot = (fields) => ({
    command: USAGE_PREFLIGHT_COMMAND,
    checkedAt,
    exhausted: null,
    buckets: [],
    artifactPath: null,
    note: null,
    ...fields,
  });
  if (!usagePreflightSupported(version)) {
    return snapshot({
      status: "skipped",
      note: `agy ${version} predates ${USAGE_PREFLIGHT_MIN_VERSION.join(".")}, where /usage began answering in print mode without starting an agent turn; probing an older build would spend quota, so it was skipped`,
    });
  }
  // Bounded exactly like the version preflight above: the relay watchdog is only armed once
  // agy is dispatched, so a probe that never returns would wedge the relay here, before any
  // dispatch and before --timeout could reach it.
  const bounded = Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
  let raw;
  try {
    raw = execFileSync("agy", USAGE_PREFLIGHT_ARGS, {
      cwd: opts.cd,
      encoding: "utf8",
      timeout: bounded,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split("\n").slice(-1)[0] || "no detail";
    return error?.code === "ETIMEDOUT"
      ? snapshot({ status: "timeout", note: `the usage query did not answer within ${bounded}ms; agy was dispatched anyway` })
      : snapshot({ status: "unavailable", note: `the usage query failed (${boundedExcerpt(detail)}); agy was dispatched anyway` });
  }
  writeFileSync(run.usagePath, raw, "utf8");
  const groups = safeJson(raw)?.command?.data?.groups;
  const buckets = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      buckets.push({
        group: typeof group?.name === "string" ? group.name : null,
        id: typeof bucket?.id === "string" ? bucket.id : null,
        name: typeof bucket?.name === "string" ? bucket.name : null,
        window: typeof bucket?.window === "string" ? bucket.window : null,
        // Report the provider's own number, unrounded and uninterpreted.
        remainingFraction: Number.isFinite(bucket?.remaining_fraction) ? bucket.remaining_fraction : null,
        resetTime: parseResetTimestamp(bucket?.reset_time, "absolute"),
      });
    }
  }
  if (!buckets.length) {
    return snapshot({
      status: "unparseable",
      artifactPath: run.usagePath,
      note: `the usage query returned no command.data.groups[].buckets[]; agy was dispatched anyway`,
    });
  }
  return snapshot({
    status: "ok",
    artifactPath: run.usagePath,
    // Only true exhaustion blocks a dispatch. A bucket whose remaining fraction is missing
    // or unreadable cannot prove exhaustion, so it keeps the verdict at "dispatch".
    exhausted: buckets.every((bucket) => bucket.remainingFraction !== null && bucket.remainingFraction <= 0),
    buckets,
  });
}

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
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("dangerouslySkipPermissions"))) continue;
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
    effort: null,
    project: null,
    newProject: false,
    resumeLast: false,
    conversation: null,
    sandbox: false,
    readOnly: false,
    dangerouslySkipPermissions: false,
    preflightUsage: false,
    printTimeout: DEFAULT_PRINT_TIMEOUT,
    timeout: null,
    addDirs: [],
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
      case "--project": opts.project = next(); break;
      case "--new-project": opts.newProject = true; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--conversation": opts.conversation = next(); break;
      case "--sandbox": opts.sandbox = true; flagged.add("sandbox"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--dangerously-skip-permissions":
        opts.dangerouslySkipPermissions = true;
        flagged.add("dangerouslySkipPermissions");
        break;
      case "--preflight-usage": opts.preflightUsage = true; flagged.add("preflightUsage"); break;
      case "--print-timeout": opts.printTimeout = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.effort !== null && !["low", "medium", "high"].includes(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: low, medium, high)`);
  }
  if (opts.readOnly && opts.dangerouslySkipPermissions) {
    fail("--read-only and --dangerously-skip-permissions are mutually exclusive; pass only one");
  }
  if (opts.resumeLast && opts.conversation) {
    fail("--resume-last and --conversation are mutually exclusive; pass only one");
  }
  // A malformed --timeout must fail loudly: parseDuration returns null for it, and a null
  // delay makes setTimeout fire on the next tick - a silent instant "timeout", the worst
  // failure mode a watchdog has. Zero is rejected for the same reason.
  if (opts.timeout !== null) {
    const milliseconds = parseDuration(opts.timeout);
    if (milliseconds === null || milliseconds <= 0 || milliseconds > MAX_TIMER_MS) {
      fail(`--timeout "${opts.timeout}" must be an h/m/s duration from 1s through ${MAX_TIMER_DURATION}`);
    }
  }
  const printTimeoutMs = parseDuration(opts.printTimeout);
  if (printTimeoutMs === null || printTimeoutMs <= 0 || printTimeoutMs + 60_000 > MAX_TIMER_MS) {
    fail(`--print-timeout "${opts.printTimeout}" must be an h/m/s duration from 1s through 596h30m23s so its 60s grace fits the relay watchdog limit`);
  }
  if (opts.project && (opts.resumeLast || opts.conversation)) {
    fail("--project cannot be combined with --resume-last or --conversation");
  }
  if (opts.project && opts.newProject) {
    fail("--project and --new-project are mutually exclusive");
  }
  if (opts.newProject && (opts.resumeLast || opts.conversation)) {
    fail("--new-project cannot be combined with --resume-last or --conversation");
  }
  // agy requires absolute --add-dir paths; resolve a relative one against --cd
  // (not the relay's own cwd) - and only after the loop, since --add-dir may
  // appear before --cd on the command line. resolve() passes absolutes through.
  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to agy --print\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
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

function agyVersion(timeoutMs) {
  try {
    const out = execFileSync("agy", ["changelog"], {
      encoding: "utf8",
      timeout: Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS),
      killSignal: "SIGKILL",
    }).trim();
    const firstLine = out.split("\n").find(Boolean) || "";
    const match = firstLine.match(/^([^:\s]+):/);
    return match ? match[1] : firstLine || null;
  } catch (err) {
    // Only a missing binary means "unavailable"; any other changelog failure
    // (permissions, a broken subcommand) must not masquerade as exit 127.
    if (err && err.code === "ENOENT") return null;
    if (err && err.code === "ETIMEDOUT") throw err;
    return "unknown";
  }
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

function gitWorktreeFingerprint(cwd, excludedPaths = []) {
  try {
    const git = (args) => execFileSync("git", args, {
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const root = realpathSync.native(git(["rev-parse", "--show-toplevel"]).toString("utf8").replace(/\r?\n$/, ""));
    const exclusions = excludedPaths
      .map((path) => {
        const absolute = resolve(path);
        try { return relative(root, realpathSync.native(absolute)); }
        catch { return relative(root, join(realpathSync.native(dirname(absolute)), basename(absolute))); }
      })
      .filter((path) => path && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path))
      .map((path) => `:(exclude,top,literal)${path.replaceAll("\\", "/")}`);
    const pathspec = [":(top)", ...exclusions];
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...pathspec]);
    const fingerprint = createHash("sha256").update("status\0").update(status);
    fingerprint.update("\0index\0").update(git(["diff", "--cached", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));
    fingerprint.update("\0worktree\0").update(git(["diff", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));

    const paths = [...new Set(status.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3)))].sort();
    for (const path of paths) {
      const fullPath = join(cwd, path);
      fingerprint.update("\0path\0").update(path).update("\0");
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        fingerprint.update("missing");
        continue;
      }
      fingerprint.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) fingerprint.update(readlinkSync(fullPath));
      else if (stat.isFile()) fingerprint.update(git(["hash-object", "--no-filters", "--", path]));
      else if (stat.isDirectory()) {
        const nestedState = gitWorktreeFingerprint(fullPath, excludedPaths);
        if (nestedState === null) return null;
        let headState;
        try {
          headState = git(["-C", fullPath, "rev-parse", "--verify", "HEAD"]);
        } catch {
          const symbolicHead = git(["-C", fullPath, "symbolic-ref", "--quiet", "HEAD"]).toString("utf8").trim();
          const target = spawnSync("git", ["-C", fullPath, "show-ref", "--verify", "--quiet", symbolicHead], { cwd, timeout: 10_000, killSignal: "SIGKILL", stdio: "ignore" });
          if (target.status !== 1) return null;
          headState = Buffer.from(`unborn\0${symbolicHead}`);
        }
        fingerprint.update("submodule\0").update(headState).update(nestedState);
      } else return null;
    }
    return fingerprint.digest("hex");
  } catch {
    return null;
  }
}

function readOnlyVerdict(opts, beforeState, afterState) {
  // Three-valued on purpose: true when fingerprints prove a change, false when coverage
  // is complete and proves none, null when the fingerprint could not be taken or the run
  // was not read-only.
  if (!opts.readOnly) return null;
  if (beforeState === null || afterState === null) return null;
  return beforeState !== afterState;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    logPath: join(outDir, "agy.log"),
    stderrPath: join(outDir, "stderr.txt"),
    usagePath: join(outDir, "usage-preflight.json"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not advertise the previous run: a poller that races the
  // dispatch would read the old result.json as if it were this run's, and a run with no
  // report of its own would publish a finalPath holding someone else's. agy.log matters
  // most — parseIdsFromLog mines it for the project and conversation ids this run
  // reports, so a stale log would hand back the PREVIOUS conversation as the resume
  // handle and point a follow-up brief at the wrong thread. usage-preflight.json is the
  // evidence a usage_limit classification points at, so a stale one would let this run's
  // result cite the PREVIOUS run's quota reading.
  rmSync(run.finalPath, { force: true });
  rmSync(run.logPath, { force: true });
  rmSync(run.usagePath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function buildArgv(opts, brief, run) {
  const argv = [];
  if (opts.project) {
    argv.push("--project", opts.project);
  } else if (opts.conversation) {
    argv.push("--conversation", opts.conversation);
  } else if (opts.resumeLast) {
    argv.push("--continue");
  } else {
    argv.push("--new-project");
  }

  if (!opts.resumeLast && !opts.conversation) {
    // The disposable smoke showed that relying on cwd alone can produce a false
    // "I created the file" response, so pin the workspace explicitly. agy requires
    // an absolute path here (it rejects "." as non-absolute); opts.cd is already
    // resolve()d, and an argv-array element carries spaces fine without a shell.
    argv.push("--add-dir", opts.cd);
    for (const dir of opts.addDirs) argv.push("--add-dir", dir);
  }
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.readOnly) argv.push("--mode", "plan");
  if (opts.sandbox) argv.push("--sandbox");
  if (opts.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (opts.printTimeout) argv.push("--print-timeout", opts.printTimeout);
  argv.push("--log-file", run.logPath);
  // Use the --print=<brief> form, not a separate ["--print", brief] pair: agy's flag
  // parser intercepts a value that is exactly a bare flag (a brief consisting only of
  // "--help" or "-h" prints usage instead of running). The = form always binds the value.
  argv.push(`--print=${brief}`);
  return argv;
}

function parseIdsFromLog(logPath) {
  if (!existsSync(logPath)) return { projectId: null, conversationId: null };
  const text = readFileSync(logPath, "utf8");
  const projectMatches = [
    /project: created project "[^"]*" \(id=([0-9a-f-]+)\)/i,
    /Conversation using project ID: ([0-9a-f-]+)/i,
    /Backend project ID updated dynamically to: ([0-9a-f-]+)/i,
  ];
  const conversationMatches = [
    /Print mode: conversation=([0-9a-f-]+)/i,
    /Created conversation ([0-9a-f-]+)/i,
  ];
  const firstMatch = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  };
  return {
    projectId: firstMatch(projectMatches),
    conversationId: firstMatch(conversationMatches),
  };
}

function makeResultWriter(opts, version, run, preflight) {
  // preflight is a holder the caller fills after the probe runs, so every outcome written
  // from that point on - including the refusal below - carries the same snapshot.
  return (extra) => {
    const ids = parseIdsFromLog(run.logPath);
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "agy",
      workdir: opts.cd,
      model: opts.model,
      effort: opts.effort,
      project: opts.project,
      sandbox: opts.sandbox,
      readOnly: opts.readOnly,
      readOnlyViolation: null,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      resumed: Boolean(opts.resumeLast || opts.conversation),
      usagePreflight: preflight.usage,
      agyVersion: version,
      projectId: ids.projectId,
      conversationId: ids.conversationId,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      logPath: existsSync(run.logPath) ? run.logPath : null,
      stderrPath: run.stderrPath,
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
  const result = writeResult({ status: "agy_unavailable", exitCode: 127, signal: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `agy` not found on PATH. Install the Antigravity CLI and complete first-launch setup.\n");
  process.exit(127);
}

function reportVersionTimeout(writeResult, run, timeoutMs, error) {
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = `agy changelog version preflight timed out after ${Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS)}ms; agy was not dispatched`;
  const result = writeResult({
    status: "timeout",
    exitCode: 124,
    signal: null,
    finalMessage: "",
    touchedFiles: null,
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function reportUsageExhausted(opts, writeResult, run, usage) {
  // Every bucket the provider reported is at zero, so there is nothing to dispatch INTO.
  // This is the only condition that may stop a run: "is the remaining quota enough for this
  // brief" is unknowable before the run and is never asked here.
  const resets = usage.buckets.map((bucket) => bucket.resetTime).filter(Boolean).sort();
  const detail = usage.buckets
    .map((bucket) => `${bucket.group ?? "?"}/${bucket.id ?? "?"} remaining_fraction ${bucket.remainingFraction}${bucket.resetTime ? ` (resets ${bucket.resetTime})` : ""}`)
    .join("; ");
  const message = `${USAGE_PREFLIGHT_COMMAND} reports every quota bucket exhausted; agy was not dispatched`;
  const result = writeResult({
    status: "failed",
    exitCode: 1,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    error: message,
    ...usageLimitFields({
      kind: "quota_exhausted",
      code: null,
      source: "usage-preflight.json",
      // The artifact holds exactly one record - the probe's own response - so the pointer
      // is its first line; the excerpt names the query that produced it.
      artifactLine: 1,
      excerpt: `${message}: ${detail}`,
      resetsAt: resets[0] ?? null,
      retryAt: null,
    }),
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToAgy(opts, brief, run, writeResult, watchdogMs) {
  const relayArtifacts = [run.briefPath, run.finalPath, run.logPath, run.stderrPath, run.resultPath];
  const beforeState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
  const argv = buildArgv(opts, brief, run);
  // Antigravity's installer provides a native `agy` binary. Launch directly so
  // multi-line briefs and paths with spaces are passed as argv, not shell text.
  const child = spawn("agy", argv, {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let stdout = "";
  const stderrTail = [];
  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, 10_000);
  }, watchdogMs);

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the agy child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const finalMessage = stdout.trim();
      if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        finalMessage,
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; agy was terminated with it — inspect the working tree before re-dispatching`,
      };
      let finalized = false;
      const finalizeAbort = () => {
        if (finalized) return;
        finalized = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
        const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
        const result = writeResult({
          ...abortedFields,
          touchedFiles: gitTouchedFiles(opts.cd),
          readOnlyViolation: readOnlyVerdict(opts, beforeState, afterState),
        });
        printSummary(result, run.resultPath);
        process.exit(result.exitCode);
      };
      child.once("close", finalizeAbort);
      killChild(child);
      sigkillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 2000);
    });
  }

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += stdoutDecoder.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const finalMessage = stdout.trim();
    if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
    const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
    const readOnlyViolation = readOnlyVerdict(opts, beforeState, afterState);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      readOnlyViolation,
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    const finalMessage = stdout.trim();
    if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
    const touchedFiles = gitTouchedFiles(opts.cd);
    const stderr = readFileSync(run.stderrPath, "utf8");
    const diagnostics = stderr.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-20);
    const permissionDenied = /no output produced\s+[—-]\s+a tool required the "([^"]+)" permission that headless\s+mode cannot prompt for, so it was auto-denied/i.exec(stderr);
    // A clean read-only run still owes the caller a plan. With neither a final message
    // nor observable worktree changes, exit 0 cannot confirm any dispatch completed.
    const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
    const worktreeChanged = beforeState !== null && afterState !== null && beforeState !== afterState;
    const readOnlyViolation = readOnlyVerdict(opts, beforeState, afterState);
    const silentNoop = code === 0 && !finalMessage && !worktreeChanged;
    // A timed-out run is failed even if agy handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired && !permissionDenied && !silentNoop;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      finalMessage,
      touchedFiles,
      readOnlyViolation,
      ...(!succeeded || !finalMessage ? { stderrTail: diagnostics } : {}),
      ...(watchdogFired
        ? {
            error: opts.timeout !== null
              ? `agy did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`
              : `agy did not exit within --print-timeout ${opts.printTimeout} plus 60s grace; killed by the relay watchdog`,
          }
        : permissionDenied
          ? { error: `Antigravity auto-denied the ${permissionDenied[1]} permission because headless --print cannot prompt; ask the human whether to re-dispatch with --dangerously-skip-permissions and treat that run as full access` }
          : silentNoop
            ? { error: "agy exited 0 without a final message or observable working-tree changes; the relay cannot confirm this dispatch completed" }
            : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // agy --print takes the prompt as a CLI argument, so the brief rides argv. The OS caps a
  // single argument (~128KB on Linux via MAX_ARG_STRLEN), so a huge brief would fail to spawn
  // with an opaque E2BIG. Reject it early with a clear message instead of a generic failure.
  const briefBytes = Buffer.byteLength(brief, "utf8");
  const MAX_BRIEF_BYTES = 120 * 1024;
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; agy passes the prompt as a CLI argument, which the OS caps (~128KB on Linux). Trim it, or have agy read large context from the workspace instead of inlining it.`);
  }

  const printTimeoutMs = parseDuration(opts.printTimeout);
  // An explicit --timeout wins over the default print-timeout-plus-grace: agy can hang well
  // past its own print timeout, which is exactly the case the grace window cannot cover.
  const watchdogMs = opts.timeout !== null ? parseDuration(opts.timeout) : printTimeoutMs + 60_000;
  const run = prepareRunDir(opts, brief);
  const preflight = { usage: null };
  let version;
  try {
    version = agyVersion(watchdogMs);
  } catch (error) {
    const writeResult = makeResultWriter(opts, "unknown", run, preflight);
    reportVersionTimeout(writeResult, run, watchdogMs, error);
    return;
  }
  const writeResult = makeResultWriter(opts, version, run, preflight);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  if (opts.preflightUsage) {
    // Runs only after agy is known to exist, and only ever stops the run on exhaustion.
    // Anything else the probe reports - skipped, failed, timed out, unrecognized shape -
    // is recorded on the result and dispatch continues: a broken probe must never cost a
    // real run, and the orchestrator can still see that the check did not answer.
    preflight.usage = queryUsage(opts, run, watchdogMs, version);
    if (preflight.usage.exhausted === true) {
      reportUsageExhausted(opts, writeResult, run, preflight.usage);
      return;
    }
  }

  dispatchToAgy(opts, brief, run, writeResult, watchdogMs);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  agy ${result.agyVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not an agy error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated agy (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.failureClass === "usage_limit") {
    const when = result.limit?.retryAt || result.limit?.resetsAt;
    lines.push(`hint: the provider refused on usage limits (${result.limit?.kind ?? "unknown"})${when ? `, earliest reset ${when}` : ""} — this is not a task failure and the brief was never dispatched. Do NOT rework the brief: wait for the reset, or re-dispatch the same brief on another lane.`);
    if (result.limit?.evidence?.excerpt) lines.push(`  evidence (${result.limit.evidence.source}:${result.limit.evidence.artifactLine ?? "?"}): ${result.limit.evidence.excerpt}`);
  }
  if (result.usagePreflight) {
    const usage = result.usagePreflight;
    lines.push(`usage preflight (${usage.command}): ${usage.status}`);
    for (const bucket of usage.buckets ?? []) {
      lines.push(`  ${bucket.group ?? "?"} · ${bucket.id ?? "?"} (${bucket.window ?? "?"}): remaining_fraction ${bucket.remainingFraction ?? "?"}${bucket.resetTime ? `, resets ${bucket.resetTime}` : ""}`);
    }
    if (usage.note) lines.push(`  ${usage.note}`);
  }
  if (result.resumed) lines.push("mode: resumed an existing conversation");
  if (result.projectId) lines.push(`project id: ${result.projectId}`);
  if (result.conversationId) lines.push(`conversation id (resume with: --conversation ${result.conversationId}): ${result.conversationId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- agy final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
