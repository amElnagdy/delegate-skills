#!/usr/bin/env node
/**
 * delegate-skills · cursor-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cursor Agent CLI (`cursor-agent -p`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Cursor-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against cursor-agent 2026.07.23 on Windows.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cursor-agent` and `git` (plus taskkill on
 * Windows for process-tree termination). The `cursor-agent` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * The brief is fed on the child's stdin, never argv, so it is not visible in
 * the host process list and has no OS argument-size cap.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: a fresh run defaults to write-capable with `--force` (Cursor runs
 * commands without approval unless your Cursor config denies them). Pass
 * `--read-only` to run in Cursor's plan mode (read-only/planning, no edits)
 * instead. The relay always passes `--trust` so a headless run never stalls
 * on the workspace-trust prompt — point --cd only at repositories you trust.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Cursor (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Cursor model (default: your Cursor default, usually
 *                           auto). List names with `cursor-agent models`.
 *   --read-only             Run in Cursor's plan mode: read-only analysis, no
 *                           edits, no --force.
 *   --sandbox <mode>        Explicitly enable or disable Cursor's sandbox for
 *                           this dispatch (enabled | disabled).
 *   --no-force              Withhold --force on a write-capable run; commands
 *                           that require approval are refused instead of run.
 *   --session <id>          Resume a specific Cursor chat (`--resume <id>`);
 *                           send only the delta brief.
 *   --resume-last           Resume the most recent Cursor chat (`--continue`);
 *                           send only the delta brief.
 *   --add-dir <dir>         Add an extra workspace root. Repeatable; requires
 *                           cursor-agent 2026.07.23 or newer.
 *   --timeout <dur>         Relay-side watchdog (default: 30m; h/m/s strings
 *                           like 90s, 45m, 2h). cursor-agent has no timeout flag.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, cursorAgentVersion, sessionId, resolvedModel,
 *   permissionMode, force, sandbox (requested value or null), usage,
 *   finalMessage (Cursor's own report),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Usage limits: when the run ends in cursor-agent's terminal `turn_ended` event with
 * status "error" carrying a recognized usage-limit sentence — or, when the run emitted no
 * successful result event, a bare `ActionRequiredError:` line on stderr carrying one — the
 * result stays status "failed" (the status set is a closed enum orchestrators switch on)
 * and gains two additive fields:
 *   failureClass: "usage_limit"
 *   limit: { kind, retryAt, resetsAt, evidence: { source, code, excerpt, artifactLine } }
 * kind is quota_exhausted | rate_limited | unknown. cursor-agent surfaces no error code and
 * no reset hint in its headless stream, so code is null and retryAt/resetsAt stay null —
 * never guessed. The classification is fail-closed: only the terminal event is inspected,
 * only against message templates verified for this CLI, and anything ambiguous stays an
 * unclassified "failed" — `ActionRequiredError:` on its own is never enough, because the
 * same shape carries Cursor's model-entitlement refusal, which is not a quota stop. A usage
 * limit is not a task failure — do not rework the brief; inspect touchedFiles, then wait
 * for the reset or re-dispatch on another lane.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cursor-agent` binary
 * exits 127 and writes status `cursor_agent_unavailable`; otherwise the exit
 * code mirrors cursor-agent's own (0 success, non-zero failure). If the child
 * dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout
 * watchdog fired), aborted (the relay itself was killed and forwarded the kill
 * to cursor-agent), or cursor_agent_unavailable.
 */

import {spawn, execSync, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import {join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
const MAX_BUFFERED_CHARS = 1_048_576;

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\],=-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SANDBOX_MODES = new Set(["enabled", "disabled"]);

const IMPLEMENTER_KEY = "cursor";

// Bound the evidence excerpt: a provider error can carry a very long body, and the
// orchestrator only needs enough to audit the match. The full raw event stays in
// events.jsonl, which evidence.artifactLine points at.
const MAX_EVIDENCE_CHARS = 400;

// cursor-agent's usage-limit signatures. Cursor surfaces NO error code, no HTTP status, and
// no retry-after in its headless stream — the vendor's own sentence in the terminal event is
// the entire signal — so this table holds exact message templates only. Both were captured
// from real cursor-agent runs under the same flag set this relay uses (--print
// --output-format stream-json --force); see test/fixtures/usage-limit/cursor.json for the
// capture bundle and its provenance. Nothing here is inferred, and deliberately absent are
// the substring needles "quota"/"rate limit"/"429" and the bare "ActionRequiredError:"
// prefix: the first three appear in ordinary task prose, and the last also introduces
// Cursor's model-entitlement refusal ("Named models unavailable ... upgrade plans to
// continue"), which is not a quota stop and must not send an orchestrator away to wait.
const USAGE_LIMIT_MESSAGES = [
  // "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."
  ["you've hit your usage limit", "quota_exhausted"],
  // "Increase limits for faster responses You're out of usage. Switch to Auto, or ask your
  // admin to increase your limit to continue."
  ["you're out of usage", "quota_exhausted"],
];

// cursor-agent's second transport for the same stop: a bare, non-JSON line on stderr. The
// prefix is a structural gate, never a signature on its own (see USAGE_LIMIT_MESSAGES).
const ACTION_REQUIRED_PREFIX = /^ActionRequiredError:\s*/;

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

function classifyUsageLimit(event) {
  // Cursor-specific detector. Only `turn_ended` with status "error" — the event cursor-agent's
  // stream ends on when a run stops, and the only status observed on a stop — is inspected. A
  // usage limit emits no `result` envelope at all, so the terminal event is all there is; a
  // later `turn_ended` or a successful `result` supersedes an earlier match (see the scanner).
  // Assistant text is never inspected: a brief about rate limiting makes the model quote these
  // very sentences mid-run, and Cursor also emits ActionRequiredError for a model-entitlement
  // refusal that is not a quota stop.
  if (!event || event.type !== "turn_ended") return null;
  if (typeof event.status !== "string" || event.status.toLowerCase() !== "error") return null;
  const detail = typeof event.error === "string" ? event.error : "";
  if (!detail) return null;
  const haystack = detail.toLowerCase();
  // Require a verified message template. Cursor ships no error code, so there is no second
  // gate to fall back on — an unrecognized sentence stays an unclassified "failed".
  const messageHit = USAGE_LIMIT_MESSAGES.find(([phrase]) => haystack.includes(phrase));
  if (!messageHit) return null;

  // No captured cursor-agent limit transcript states a reset: no retry-after is surfaced, no
  // reset field exists, and the only reset wording anyone reports comes from the web dashboard,
  // not the CLI. Both stay null rather than guessed. The parse still routes through the shared
  // helper so that if a future cursor-agent does state one, an ambiguous or localized value
  // yields null instead of sending the orchestrator back at the wrong moment.
  const resetsAt = parseResetTimestamp(event.resets_at, "absolute");
  const retryAt = parseResetTimestamp(event.retry_after, "duration");

  return {
    kind: messageHit[1],
    code: null,
    source: "events.jsonl",
    excerpt: detail,
    artifactLine: null,
    resetsAt,
    retryAt,
  };
}

function classifyStderrUsageLimit(lines) {
  // The stderr half of the same stop: `ActionRequiredError: <vendor sentence>`, a bare line
  // with no JSON around it. Consulted only after the run ended without a successful result
  // event, and only on the LAST such line — that is the reason cursor-agent stopped on. An
  // ActionRequiredError that is not a quota sentence ends the search rather than licensing a
  // hunt back through the log for one that is.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!ACTION_REQUIRED_PREFIX.test(line)) continue;
    const detail = line.replace(ACTION_REQUIRED_PREFIX, "").trim();
    const haystack = detail.toLowerCase();
    const messageHit = USAGE_LIMIT_MESSAGES.find(([phrase]) => haystack.includes(phrase));
    if (!messageHit) return null;
    return {
      kind: messageHit[1],
      code: null,
      source: "stderr.txt",
      excerpt: detail,
      artifactLine: null,
      resetsAt: null,
      retryAt: null,
    };
  }
  return null;
}

function locateArtifactLine(path, matches) {
  // evidence.artifactLine must point at the real record in the artifact the match came from,
  // so an orchestrator can audit the classification instead of trusting it. cursor-agent's
  // stream is scanned by brace depth rather than by line (makeEventScanner), so there is no
  // line counter to read during the run — the number is resolved from the written artifact
  // afterwards. Searching backwards finds the terminal record, not an earlier lookalike.
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim() && matches(lines[index])) return index + 1;
    }
  } catch {
    // The artifact is unreadable; the bounded excerpt still stands on its own.
  }
  return null;
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
    readOnly: false,
    force: true,
    sandbox: null,
    session: null,
    resumeLast: false,
    addDirs: [],
    timeout: DEFAULT_TIMEOUT,
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
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--sandbox": opts.sandbox = next(); flagged.add("sandbox"); break;
      case "--no-force": opts.force = false; flagged.add("force"); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.sandbox !== null && !SANDBOX_MODES.has(opts.sandbox)) {
    fail(`--sandbox "${opts.sandbox}" is invalid; expected enabled or disabled`);
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ / [ ] , = -)");
  }
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session contains unsupported characters (allowed: letters, digits, . _ : -)");
  }
  // cursor-agent resolves a relative --add-dir against ITS cwd, so resolve
  // against --cd (not the relay's own cwd) — and only after the loop, since
  // --add-dir may appear before --cd on the command line. resolve() passes
  // absolutes through.
  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  if (process.platform === "win32" && opts.addDirs.some((dir) => /[\0\r\n"%!]/.test(dir))) {
    fail("--add-dir cannot contain %, !, a quote, or a newline when cursor-agent launches through cmd.exe");
  }
  // The watchdog is relay-only (cursor-agent has no timeout flag), so a
  // malformed --timeout must fail loudly here — a silent 30m fallback would be wrong.
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to cursor-agent -p\n";
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

function cursorAgentVersion(timeoutMs) {
  try {
    // On Windows, cursor-agent installs as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs a shell there or it
    // ENOENTs on a working install. A pre-joined string (not shell:true + args)
    // avoids Node's DEP0190 warning. POSIX is unaffected. (git installs a real
    // git.exe and must NOT go through a shell — see gitTouchedFiles.)
    const options = {
      encoding: "utf8",
      timeout: Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS),
      killSignal: "SIGKILL",
    };
    const out = process.platform === "win32"
      ? execSync("cursor-agent --version", options).trim()
      : execFileSync("cursor-agent", ["--version"], options).trim();
    return { version: out || "unknown", error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: null, error: null };
    if (process.platform === "win32" &&
        /not recognized as an internal or external command/i.test(String(error?.stderr || ""))) {
      return { version: null, error: null };
    }
    return { version: null, error };
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function winq(value) {
  // shell:true on win32 (needed for the cursor-agent.cmd shim) doesn't quote
  // args, so a path with spaces (C:\Users\First Last\...) would split, and a
  // parameterized model ("opus[context=1m,effort=high]") would be re-tokenized
  // by the shim's PowerShell hop. Quote the spaceable/parameterized values on
  // Windows only — on POSIX the quotes would become literal characters.
  return process.platform === "win32" ? `"${value}"` : value;
}

function buildArgv(opts) {
  const argv = ["--print", "--output-format", "stream-json", "--trust"];
  if (opts.readOnly) argv.push("--mode", "plan");
  else if (opts.force) argv.push("--force");
  if (opts.sandbox) argv.push("--sandbox", opts.sandbox);
  if (opts.model) argv.push("--model", winq(opts.model));
  if (opts.session) argv.push("--resume", winq(opts.session));
  else if (opts.resumeLast) argv.push("--continue");
  for (const dir of opts.addDirs) argv.push("--add-dir", winq(dir));
  return argv;
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "cursor-agent",
      workdir: opts.cd,
      model: opts.model,
      readOnly: opts.readOnly,
      force: opts.force && !opts.readOnly,
      sandbox: opts.sandbox,
      resumed: Boolean(opts.resumeLast || opts.session),
      cursorAgentVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "cursor_agent_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    resolvedModel: null,
    permissionMode: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `cursor-agent` not found on PATH. Install the Cursor CLI (https://cursor.com/cli) and run `cursor-agent login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `cursor-agent --version preflight timed out after ${Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS)}ms; Cursor was not dispatched`
    : `cursor-agent --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Cursor was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    resolvedModel: null,
    permissionMode: null,
    usage: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function installPreflightSignalHandlers(opts, run, writeResult) {
  let active = true;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (!active) return;
      active = false;
      const result = writeResult({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId: null,
        resolvedModel: null,
        permissionMode: null,
        usage: null,
        finalMessage: "",
        touchedFiles: gitTouchedFiles(opts.cd),
        error: `the relay was killed by ${sig} during the cursor-agent version preflight; Cursor was not dispatched`,
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

function dispatchToCursor(opts, brief, run, writeResult) {
  // A shell launch on Windows so the cursor-agent.cmd shim resolves (see
  // cursorAgentVersion) — as a pre-joined string, which sidesteps Node's
  // DEP0190 warning about shell:true with an args array. Safe: the brief is
  // fed via child.stdin below — never argv — and argv holds only fixed flags
  // plus the win32-quoted model and directory values. detached on POSIX: the
  // child leads a new process group so killChild can fell the whole tree.
  const argv = buildArgv(opts);
  const child = process.platform === "win32"
    ? spawn(["cursor-agent", ...argv].join(" "), { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], shell: true })
    : spawn("cursor-agent", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], detached: true });

  let sessionId = null;
  let resolvedModel = null;
  let permissionMode = null;
  let usage = null;
  let resultMessage = null;
  let resultIsError = false;
  // limitMatch holds the usage-limit classification of the LATEST terminal turn; a later
  // turn or a successful result event clears it, so a run that recovered and finished is
  // never reported as limit-exhausted. sawSuccessfulResult additionally gates the stderr
  // fallback below, which must not second-guess a run that closed cleanly.
  let limitMatch = null;
  let sawSuccessfulResult = false;
  const textChunks = [];
  const stderrTail = [];
  // The tail of a stderr chunk that did not end on a newline, held until the rest arrives.
  let stderrPartial = "";
  const scan = makeEventScanner((event) => {
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") resolvedModel = event.model;
      if (typeof event.permissionMode === "string") permissionMode = event.permissionMode;
    }
    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      for (const part of event.message.content) {
        if (part && part.type === "text" && typeof part.text === "string") textChunks.push(part.text);
      }
    }
    if (event.type === "turn_ended") {
      // The stream ends on turn_ended when cursor-agent stops; a usage limit emits no result
      // envelope at all. Reassigning on every turn_ended is the supersession rule: a turn that
      // ended some other way (or ended cleanly) drops the previous turn's match.
      limitMatch = classifyUsageLimit(event);
    }
    if (event.type === "result") {
      if (typeof event.result === "string") resultMessage = event.result;
      if (event.is_error === true) resultIsError = true;
      else {
        // Cursor reported a clean close: the run did the work, so no earlier limit-looking
        // event may downgrade it.
        sawSuccessfulResult = true;
        limitMatch = null;
      }
      if (event.usage && typeof event.usage === "object") usage = event.usage;
    }
  });

  // The brief rides stdin: no process-list exposure, no OS argv-size cap.
  child.stdin.on("error", () => { /* child exited before reading the brief; its exit code tells the story */ });
  child.stdin.write(brief);
  child.stdin.end();

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    // A single stderr line can arrive split across data events, so hold the unterminated
    // remainder and prepend it to the next chunk. Splitting each chunk on its own would tear
    // `ActionRequiredError: You've hit your usage limit` into `ActionRequiredError: You` and
    // `'ve hit your usage limit`: the fallback classifier reads only lines carrying the
    // prefix, so it would find the prefix without the sentence and the sentence without the
    // prefix, and report a real limit as an unclassified failure.
    const parts = (stderrPartial + stderrDecoder.write(chunk)).split("\n");
    stderrPartial = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // Every reader of stderr must also see the held remainder: cursor-agent can die without a
  // trailing newline, leaving its last — and most diagnostic — line unterminated.
  const stderrLines = () => {
    const held = stderrPartial.trim() ? [stderrPartial.trimEnd()] : [];
    return [...stderrTail, ...held].slice(-20);
  };

  const assembleFinal = () => {
    // Prefer the result event's own report; fall back to the assistant text
    // stream when the run died before emitting one.
    const message = resultMessage && resultMessage.trim() ? resultMessage : textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
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
  }, timeoutMs);

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the cursor-agent child running or dying mid-edit with
  // nothing recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const touched = gitTouchedFiles(opts.cd);
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        resolvedModel,
        permissionMode,
        usage,
        finalMessage: assembleFinal(),
        touchedFiles: touched,
        stderrTail: stderrLines(),
        error: `the relay was killed by ${sig}; cursor-agent was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        const late = gitTouchedFiles(opts.cd);
        writeResult({ ...abortedFields, touchedFiles: late });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      resolvedModel,
      permissionMode,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: touched,
      stderrTail: stderrLines(),
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
    // Outcome precedence: a run the relay itself ended is a timeout (or, in the signal
    // handler above, aborted) — never a classified provider failure, because the limit may
    // simply be what cursor-agent was about to report when we killed it. The stderr shape is
    // consulted only as a fallback: it carries no structure, so it may speak only when the
    // stream produced neither a limit-bearing terminal turn nor a clean close.
    const limit = watchdogFired
      ? null
      : limitMatch ?? (sawSuccessfulResult ? null : classifyStderrUsageLimit(stderrLines()));
    if (limit) {
      limit.artifactLine = limit.source === "stderr.txt"
        ? locateArtifactLine(run.stderrPath, (line) => ACTION_REQUIRED_PREFIX.test(line))
        : locateArtifactLine(run.eventsPath, (line) => safeJson(line)?.type === "turn_ended");
    }
    // A timed-out run is failed even if cursor-agent handles SIGTERM by exiting 0 —
    // orchestrators key off status and the relay exit code. A result event with
    // is_error true is failed even on exit 0. A usage limit is likewise never a success: if
    // cursor-agent ever exits 0 while its terminal turn carried a limit signature, normalize
    // to a failure rather than report a run that did no work as completed.
    const succeeded = code === 0 && !watchdogFired && !resultIsError && !limit;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const touched = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      resolvedModel,
      permissionMode,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: touched,
      ...(succeeded ? {} : { stderrTail: stderrLines() }),
      ...(watchdogFired ? { error: `cursor-agent did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
      ...(resultIsError && !watchdogFired ? { error: "cursor-agent reported an error result (is_error: true in its result event)" } : {}),
      ...usageLimitFields(limit),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const timeoutMs = parseDuration(opts.timeout);
  const run = prepareRunDir(opts, brief);
  let writeResult = makeResultWriter(opts, null, run);
  const clearPreflightSignals = installPreflightSignalHandlers(opts, run, writeResult);
  const probe = cursorAgentVersion(timeoutMs);
  // Synchronous child-process calls defer JavaScript signal handlers. Yield once
  // so a signal received during the bounded probe becomes "aborted" before dispatch.
  await new Promise((resolve) => setImmediate(resolve));
  writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    clearPreflightSignals();
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    clearPreflightSignals();
    reportVersionFailure(opts, writeResult, run, probe.error, timeoutMs);
    return;
  }
  clearPreflightSignals();
  dispatchToCursor(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  cursor-agent ${result.cursorAgentVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a cursor-agent error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated cursor-agent (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.failureClass === "usage_limit") {
    const when = result.limit?.retryAt || result.limit?.resetsAt;
    lines.push(`hint: the provider refused on usage limits (${result.limit?.kind ?? "unknown"})${when ? `, earliest retry ${when}` : ""} — this is not a task failure. Do NOT rework the brief: inspect touched files first, then wait for the reset or re-dispatch the same brief on another lane from a clean tree.`);
    if (result.limit?.evidence?.excerpt) lines.push(`  evidence (${result.limit.evidence.source}:${result.limit.evidence.artifactLine ?? "?"}): ${result.limit.evidence.excerpt}`);
  }
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.readOnly) lines.push("mode: read-only (plan)");
  if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}${result.permissionMode ? `  ·  permission mode: ${result.permissionMode}` : ""}`);
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
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
  lines.push("--- cursor-agent final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
