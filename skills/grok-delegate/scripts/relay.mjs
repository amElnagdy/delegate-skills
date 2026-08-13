#!/usr/bin/env node
/**
 * delegate-skills · grok-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Grok Build CLI (`grok --prompt-file`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Grok-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified end-to-end on macOS against grok 0.2.101;
 * other shell-capable agents (Claude Code, Cursor, …) are designed-for but not
 * yet verified there.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `grok` and `git`. The `grok` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Grok's default permission mode is `ask`, which blocks on approval prompts in
 * a non-interactive pipe. The relay therefore sets autonomy explicitly:
 *   default        — `--always-approve --sandbox workspace` (write in CWD)
 *   --read-only    — `--sandbox read-only --permission-mode plan` (review intent)
 *   --full-access  — `--always-approve --sandbox off` (unrestricted; opt-in)
 *
 * `--read-only` is best-effort, NOT a hard guarantee: on grok 0.2.101 the
 * read-only sandbox governs out-of-workspace filesystem/network access, not the
 * agent's own edit tool, and headless `plan` mode is advisory — a determined run
 * can still write the working tree. Always confirm `touchedFiles` after a
 * read-only run; don't rely on the flag alone.
 * The relay reports `readOnlyViolation` as true when git porcelain or an
 * already-dirty Git-visible path proves a change, false when coverage is
 * complete and detects none, and null when coverage is incomplete. It cannot
 * attribute a concurrent change to Grok and does not cover ignored paths.
 *
 * The brief is handed to grok via `--prompt-file`, never argv: it stays out of
 * the host process list, isn't bounded by the OS arg-length cap, and a brief
 * that starts with "-" can't be misread as a flag.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Grok (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Grok model (default: Grok's own configured default).
 *   --effort <level>        Reasoning effort for this run (passed as `--effort`).
 *   --max-turns <n>         Maximum number of agent turns for this run.
 *   --read-only             Review/diagnosis with no edits (`--sandbox read-only`).
 *   --full-access           Unrestricted auto-approve (`--sandbox off`); opt-in.
 *   --resume-last           Continue the most recent Grok session for this cwd;
 *                           send only the delta brief.
 *   --session <id>          Continue a specific session id; send only the delta brief.
 *                           Mutually exclusive with --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the grok child is killed
 *                           and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, grokVersion, sessionId (for a later resume), finalMessage
 *   (Grok's own report), usage (token counts from the run's end event, null if
 *   none), touchedFiles (git porcelain, null if git can't report), and the paths
 *   to events.jsonl and final.txt.
 *
 * Usage limits: when the run ends on Grok's terminal streaming-json `{"type":"error"}`
 * line carrying a recognized usage-limit message template, the result stays status
 * "failed" (the status set is a closed enum orchestrators switch on) and gains two
 * additive fields:
 *   failureClass: "usage_limit"
 *   limit: { kind, retryAt, resetsAt, evidence: { source, code, excerpt, artifactLine } }
 * kind is quota_exhausted | rate_limited | unknown. Every Grok limit template deliberately
 * states no reset window, so retryAt/resetsAt are null — never guessed. The classification
 * is fail-closed: only the terminal error line is inspected, only against Grok's own exact
 * message templates (its wire carries no error code), and anything ambiguous stays an
 * unclassified "failed". A usage limit is not a task failure — do not rework the brief;
 * inspect touchedFiles, then wait for the reset or re-dispatch on another lane. Grok
 * reports its session id only on the `end` line, which a limit run never reaches, so
 * resume that partial work with --resume-last unless the run was dispatched with an
 * explicit --session.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `grok` binary exits 127;
 * otherwise the exit code mirrors Grok's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to grok), or grok_unavailable. An
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

const MAX_BUFFERED_CHARS = 1_048_576;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const AUTONOMY_MODES = new Set(["workspace-write", "read-only", "full-access"]);

const IMPLEMENTER_KEY = "grok";

// Bound the evidence excerpt: a provider error can carry a very long body, and the
// orchestrator only needs enough to audit the match. The full raw event stays in
// events.jsonl, which evidence.artifactLine points at.
const MAX_EVIDENCE_CHARS = 400;

// Grok's usage-limit signatures. Grok's streaming-json wire carries no error code at all —
// the internal ACP rate-limit code is consumed to pick the user-facing sentence and never
// serialized — so the exact message templates ARE the signature. Each entry below is a
// verbatim user-facing constant from xai-grok-shell's sampling/error.rs at the pinned commit
// recorded in test/fixtures/usage-limit/grok.json; nothing here is inferred, and no template
// for a non-xAI backend is listed because none was verified. Matched case-insensitively as
// whole phrases with typographic apostrophes folded to ASCII — never bare "429", "quota", or
// "rate limit", which appear in ordinary task prose. Grok separates the free-plan paywall
// (quota exhaustion) from a transient throttle, so the kinds differ.
const USAGE_LIMIT_MESSAGES = [
  ["you've reached your free grok build usage limit", "quota_exhausted"],
  ["you've hit your team's api rate limit", "rate_limited"],
  ["you've hit the rate limit for your plan", "rate_limited"],
];

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

function classifyUsageLimit(event, artifactLine) {
  // Grok-specific detector. Only the streaming-json `{"type":"error"}` line is inspected: it is
  // emitted from headless mode's single terminal error arm, which returns immediately after and
  // never emits the `end` line, so it is the naturally terminal failure event. Grok's other
  // error-shaped lines (auto-compact failure, image-compression notice) are separate event types
  // and are deliberately not matched — "an error appeared" is never sufficient.
  if (!event || event.type !== "error") return null;
  const raw = typeof event.message === "string" ? event.message : "";
  if (!raw) return null;

  // Grok flattens a provider envelope into a plain sentence before it reaches this wire, but
  // parse defensively anyway: a build that ever handed the raw body through should still be
  // matched against its own template rather than against escaped JSON text.
  const nested = safeJson(raw);
  const detail = nested && typeof nested === "object" && typeof nested.message === "string" ? nested.message : raw;

  // Grok's templates are typographic — they use U+2019, including mid-word in "team's" — so fold
  // curly apostrophes on both sides. That keeps the phrase table readable and stops a purely
  // typographic change upstream from silently disabling the matcher.
  const haystack = `${detail}\n${raw}`.replace(/[\u2018\u2019]/g, "'").toLowerCase();
  const messageHit = USAGE_LIMIT_MESSAGES.find(([phrase]) => haystack.includes(phrase));
  // A verified full-sentence template is the only accepted signature. Fail closed otherwise and
  // let the run report a plain "failed" — a false classification would tell the orchestrator not
  // to investigate a real bug.
  if (!messageHit) return null;

  return {
    kind: messageHit[1],
    // Grok's error line has no code field: the ACP rate-limit code is dropped on serialization.
    code: null,
    source: "events.jsonl",
    excerpt: detail || raw,
    artifactLine,
    // No Grok limit template states a reset window (the free-usage one promises none on purpose,
    // because the quota window is backend-configured). Run the shared parser over whatever the
    // line does carry rather than hard-coding null, so a field a later build adds is subject to
    // the same never-guess rule as every other relay.
    resetsAt: parseResetTimestamp(event.resets_at ?? event.resetsAt ?? null, "absolute"),
    retryAt: parseResetTimestamp(event.retry_after ?? event.retryAfter ?? null, "duration"),
  };
}

function makeEventScanner(onObject) {
  let buf = "";
  let index = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    for (;;) {
      while (index < buf.length) {
        const ch = buf[index];
        // Only track strings inside an object (depth > 0). At depth 0 we are
        // skipping a junk prefix, and an unmatched `"` there must not swallow the
        // real `{...}` that follows in the same chunk.
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          if (depth > 0) inString = true;
        } else if (ch === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (ch === "}") {
          if (depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
              const slice = buf.slice(start, index + 1);
              try { onObject(JSON.parse(slice)); } catch { /* skip malformed */ }
              start = -1;
            }
          }
        }
        index += 1;
      }
      if (depth === 0 || start === -1 || buf.length - start <= MAX_BUFFERED_CHARS) break;
      // A complete object may exceed the retained-input cap within this chunk.
      // Drop only an oversized partial, then rescan its suffix so a later
      // concatenated event is not lost.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      start = -1;
      depth = 0;
      inString = false;
      escaped = false;
    }
    if (depth > 0 && start !== -1) {
      if (start > 0) {
        buf = buf.slice(start);
        index -= start;
        start = 0;
      }
    } else {
      buf = "";
      index = 0;
      start = -1;
    }
  };
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
    effort: null,
    maxTurns: null,
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
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--max-turns": opts.maxTurns = next(); break;
      case "--read-only": opts.autonomy = "read-only"; flagged.add("autonomy"); flagged.add("readOnly"); break;
      case "--full-access": opts.autonomy = "full-access"; flagged.add("autonomy"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  // The watchdog is relay-only (the grok launch has no timeout flag), so a malformed
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
  // These values reach a shell on win32 (shell:true for the .cmd shim), so restrict them to safe tokens.
  const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
  for (const flag of ["model", "effort", "session"]) {
    if (opts[flag] !== null && !safeToken.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  // Digits-only also keeps the value safe for the win32 shell launch.
  if (opts.maxTurns !== null && !/^[1-9]\d*$/.test(opts.maxTurns)) {
    fail("--max-turns must be a positive integer");
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
  if (!match) return "relay.mjs — dispatch a brief to grok --prompt-file\n";
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
  // The watchdog is only armed once grok is running, so the preflight needs a bound of its
  // own: a version probe that never returns would wedge the relay here, before any
  // result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function grokVersion(probeTimeoutMs) {
  // On Windows, npm installs `grok` as a .cmd shim; Node's CreateProcess only
  // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
  // ENOENTs on a working install. POSIX is unaffected. (git installs a real
  // git.exe and must NOT get this flag — see gitTouchedFiles.)
  const probe = (argv, timeout = probeTimeoutMs) => {
    try {
      const version = execFileSync("grok", argv, {
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout,
        killSignal: "SIGKILL",
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
      // Anything else — a hung probe we killed, or a real non-zero exit — means grok is
      // installed but not usable. Reporting that as "unavailable" would send the caller
      // off to reinstall a binary that is already there.
      return { version: null, error };
    }
  };
  // Prefer `grok version` (documented subcommand); fall back to `--version` for builds that
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

function autonomyFlags(autonomy) {
  // Maps the relay's three autonomy modes onto Grok's native --sandbox /
  // --always-approve / --permission-mode flags. Grok's default permission mode
  // is `ask`, which hangs a headless pipe — so every path sets autonomy
  // explicitly. Sandbox profiles (verified valid on grok 0.2.101):
  //   workspace  — write CWD /tmp ~/.grok/   (workspace-write analog)
  //   read-only  — review intent ONLY; the sandbox restricts out-of-workspace
  //                access, not grok's own edit tool, so a headless run can still
  //                write the tree. Best-effort — verify touchedFiles afterward.
  //   off        — unrestricted              (full-access opt-in)
  switch (autonomy) {
    case "read-only":
      return ["--sandbox", "read-only", "--permission-mode", "plan"];
    case "full-access":
      return ["--always-approve", "--sandbox", "off"];
    case "workspace-write":
    default:
      return ["--always-approve", "--sandbox", "workspace"];
  }
}

function buildArgv(opts, run) {
  // ponytail: shell:true on win32 (needed for the grok.cmd shim) doesn't quote
  // args, so a path with spaces (C:\Users\First Last\...) splits before grok
  // sees it. Quote the two spaceable path args; --model/--effort/--session are
  // already restricted to safe tokens at parse time.
  // Ceiling: if quoting proves too blunt, drop shell:true and resolve the shim.
  const quotePath = (p) => (process.platform === "win32" ? `"${p}"` : p);
  // Always: automation hygiene + structured events + working root.
  const argv = [
    "--no-auto-update",
    "--no-alt-screen",
    "--output-format", "streaming-json",
    "--cwd", quotePath(opts.cd),
  ];

  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push("--resume", opts.session);

  // Re-pass autonomy on resume too — headless permission mode may not inherit.
  argv.push(...autonomyFlags(opts.autonomy));

  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.maxTurns) argv.push("--max-turns", opts.maxTurns);

  // Deliver the brief via a file, not argv: keeps it out of the host process
  // list, isn't bounded by the OS arg-length cap, and a brief that begins with
  // "-" can't be misread as a flag. prepareRunDir already wrote run.briefPath.
  argv.push("--prompt-file", quotePath(run.briefPath));
  return argv;
}

function extractSessionId(event) {
  // grok's streaming-json carries sessionId (camelCase) on the end event; the
  // extra fallbacks tolerate a shape drift across versions.
  return (
    event.sessionId ??
    event.session_id ??
    (event.session && (event.session.id ?? event.session.sessionId)) ??
    null
  );
}

function extractTextChunk(event) {
  // grok streams the assistant reply as {"type":"text","data":"…"}; reasoning
  // arrives as type:"thought" and is deliberately kept out of the report.
  // The type:"text"+event.text fallback covers a possible field rename.
  if (event.type !== "text") return null;
  if (typeof event.data === "string") return event.data;
  if (typeof event.text === "string") return event.text;
  return null;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Grok's edits, not relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    briefPath: join(outDir, "brief.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not advertise the previous run: a poller that races the
  // dispatch would read the old result.json as if it were this run's. The other
  // artifacts are truncated by their own writes below.
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.finalPath, "", "utf8");
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
      tool: "grok",
      workdir: opts.cd,
      autonomy: opts.autonomy,
      model: opts.model,
      effort: opts.effort,
      resumeLast: opts.resumeLast,
      grokVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
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
  const result = writeResult({ status: "grok_unavailable", exitCode: 127, signal: null, sessionId: null, finalMessage: "", usage: null, touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `grok` not found on PATH. Install it with `npm i -g @xai-official/grok` and run `grok login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `grok version preflight timed out after ${probeTimeoutMs}ms; Grok was not dispatched`
    : `grok version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Grok was not dispatched`;
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

function dispatchToGrok(opts, run, writeResult) {
  // grok cannot be prevented from writing headlessly (the read-only sandbox and
  // plan mode are advisory), so a --read-only run snapshots the tree up front
  // and flags a violation in the result instead of pretending to enforce.
  const relayArtifacts = [run.briefPath, run.eventsPath, run.finalPath, run.resultPath];
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
  // shell:true on Windows so the grok.cmd shim resolves (see grokVersion). Safe:
  // the brief is delivered via --prompt-file (never argv), --model/--effort/--session
  // are restricted to safe tokens at parse time, and the two path args are
  // quoted for win32 in buildArgv.
  const child = spawn("grok", argv, {
    cwd: opts.cd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let sessionId = opts.session || null;
  let usage = null;
  let limitMatch = null;
  // 1-based line in events.jsonl that the scanner is currently reading, so a classification can
  // point at its own evidence. It has to be tracked out here: events.jsonl is the raw byte
  // stream and makeEventScanner is brace-depth based, not line based, so neither one knows the
  // line number on its own.
  let eventLine = 1;
  const textChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    const sid = extractSessionId(event);
    if (sid) sessionId = sid;
    const chunk = extractTextChunk(event);
    if (chunk) textChunks.push(chunk);
    if (event.usage && typeof event.usage === "object") usage = event.usage;
    if (event.type === "error") {
      limitMatch = classifyUsageLimit(event, eventLine);
    } else if (event.type === "end") {
      // `end` is grok's success line and is never emitted after the terminal error arm. If one
      // arrives anyway, the run did the work, so it must not be reported as limit-exhausted.
      limitMatch = null;
    }
  });

  // Feed the scanner one line at a time so an object that completes inside a segment belongs to
  // the line being fed. Segments can be fragments (a chunk boundary can land mid-line, mid-escape
  // or mid-multibyte) and the last record can arrive with no trailing newline; the scanner buffers
  // across calls either way, so splitting here changes only the line bookkeeping.
  const feedByLine = (text) => {
    if (!text) return;
    let start = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
      scan(text.slice(start, nl + 1));
      eventLine += 1;
      start = nl + 1;
    }
    if (start < text.length) scan(text.slice(start));
  };

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk); // faithful raw record
    feedByLine(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Grok progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textChunks.join("").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
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
  // no result.json and leaves the grok child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const touchedAtAbort = gitTouchedFiles(opts.cd);
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        finalMessage: assembleFinal(),
        usage,
        touchedFiles: touchedAtAbort,
        ...readOnlyFlag(),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; grok was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        const touchedAfterGrace = gitTouchedFiles(opts.cd);
        writeResult({ ...abortedFields, touchedFiles: touchedAfterGrace, ...readOnlyFlag() });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const touchedFiles = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      usage,
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
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    // Outcome precedence: a run the relay itself ended is a timeout (or, in the signal handler
    // above, aborted) — never a classified provider failure, because the limit may simply be
    // what grok was about to report when we killed it.
    const limit = watchdogFired ? null : limitMatch;
    // A timed-out run is never a success even if grok handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code. A usage limit is likewise never a
    // success: if grok ever exits 0 while its terminal error line carried a limit signature,
    // normalize to a failure (exit 1 below) rather than report a run that did no work as
    // completed.
    const succeeded = code === 0 && !watchdogFired && !limit;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      sessionId,
      finalMessage,
      usage,
      touchedFiles,
      ...readOnlyFlag(),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `grok did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
      ...usageLimitFields(limit),
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
  const probe = grokVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  dispatchToGrok(opts, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  grok ${result.grokVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a grok error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated grok (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.failureClass === "usage_limit") {
    const when = result.limit?.retryAt || result.limit?.resetsAt;
    lines.push(`hint: the provider refused on usage limits (${result.limit?.kind ?? "unknown"})${when ? `, earliest retry ${when}` : ""} — this is not a task failure. Do NOT rework the brief: inspect touched files first, then wait for the reset or re-dispatch the same brief on another lane from a clean tree.`);
    if (result.limit?.evidence?.excerpt) lines.push(`  evidence (${result.limit.evidence.source}:${result.limit.evidence.artifactLine ?? "?"}): ${result.limit.evidence.excerpt}`);
    if (!result.sessionId) lines.push("  note: grok reports its session id only on the end event, which this run never reached — resume the partial work with --resume-last, or re-dispatch from a clean tree.");
  }
  if (result.readOnlyViolation === null) lines.push("warning: this --read-only run could not be verified - git could not report, or a submodule or unreadable path left coverage incomplete; inspect the working tree directly.");
  if (result.readOnlyViolation === true) lines.push("warning: a git-visible change was detected during this --read-only run — grok's read-only is best-effort; review the diff before trusting the run.");
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session (--continue)");
  else if (result.sessionId && result.status !== "grok_unavailable") {
    lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  }
  if (result.usage) {
    const u = result.usage;
    lines.push(`tokens: ${u.total_tokens ?? "?"} total (in ${u.input_tokens ?? "?"}, out ${u.output_tokens ?? "?"})`);
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
  lines.push("--- grok final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
