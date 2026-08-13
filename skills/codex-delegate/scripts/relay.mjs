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
 * only). It shells out only to `codex` and `git`. The `codex` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
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
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           An explicit --sandbox/--read-only override applies to the resumed turn.
 *   --session <id>          Continue a specific Codex session by thread id (from a prior
 *                           result.json). Safer than --resume-last when other Codex runs
 *                           may have happened since - "last" is global, not per-repo.
 *                           Mutually exclusive with --resume-last.
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
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain, null if git can't report), and the paths to
 *   events.jsonl and final.txt.
 *
 * Usage limits: when the run ends in Codex's terminal `turn.failed` event carrying a
 * recognized usage-limit signature, the result stays status "failed" (the status set is a
 * closed enum orchestrators switch on) and gains two additive fields:
 *   failureClass: "usage_limit"
 *   limit: { kind, retryAt, resetsAt, evidence: { source, code, excerpt, artifactLine } }
 * kind is quota_exhausted | rate_limited | unknown. retryAt/resetsAt are null unless the
 * provider stated a zoned absolute time or a well-defined duration — never guessed. The
 * classification is fail-closed: only the terminal event is inspected, only against
 * provider-specific codes and message templates, and anything ambiguous stays an
 * unclassified "failed". A usage limit is not a task failure — do not rework the brief;
 * inspect touchedFiles, then wait for the reset or re-dispatch on another lane.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127;
 * otherwise the exit code mirrors Codex's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to codex), or codex_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import {join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Model reaches cmd.exe on win32 (shell:true for the codex.cmd shim) — same shell-safe
// family as grok/pi. Keep in lockstep with delegate-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const IMPLEMENTER_KEY = "codex";

// Bound the evidence excerpt: a provider error can carry a very long body, and the
// orchestrator only needs enough to audit the match. The full raw event stays in
// events.jsonl, which evidence.artifactLine points at.
const MAX_EVIDENCE_CHARS = 400;

// Codex's usage-limit signatures, pinned to codex-cli 0.147.0. Every entry below was
// read out of the shipped binary's string table (see test/fixtures/usage-limit/codex.json
// for the capture bundle and its provenance); nothing here is inferred. Codes absent from
// that binary — `rate_limit_exceeded`, `insufficient_quota` — are deliberately NOT listed:
// an unverified signature is exactly the false positive this classification must avoid.
// Codex calls its plan quota a "rate limit" internally (hence rate_limit_reached →
// quota_exhausted); rate_limit_error is the transient-throttle case.
const USAGE_LIMIT_CODES = new Map([
  ["usage_limit_exceeded", "quota_exhausted"],
  ["usage_limit_reached", "quota_exhausted"],
  ["rate_limit_reached", "quota_exhausted"],
  ["workspace_owner_usage_limit_reached", "quota_exhausted"],
  ["workspace_member_usage_limit_reached", "quota_exhausted"],
  ["workspace_owner_credits_depleted", "quota_exhausted"],
  ["workspace_member_credits_depleted", "quota_exhausted"],
  ["rate_limit_error", "rate_limited"],
]);

// Exact user-facing templates from the same binary. Matched case-insensitively as whole
// phrases — never bare "quota"/"429"/"rate limit", which appear in ordinary task prose.
const USAGE_LIMIT_MESSAGES = [
  ["you've hit your usage limit", "quota_exhausted"],
  ["you've reached your usage limit", "quota_exhausted"],
  ["usage limit reached", "quota_exhausted"],
  ["you've reached your workspace credit limit", "quota_exhausted"],
  ["you're out of credits", "quota_exhausted"],
  ["your workspace is out of credits", "quota_exhausted"],
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
  // Codex-specific detector. Only `turn.failed` — the naturally terminal failure event —
  // is inspected. Codex also emits `item.completed` items of type "error" mid-run for
  // ordinary warnings (model-metadata fallback, shortened skill descriptions) and keeps
  // going, so matching on "an error event" would classify healthy runs. Verified against
  // codex-cli 0.147.0.
  if (!event || event.type !== "turn.failed") return null;
  const raw = typeof event.error?.message === "string" ? event.error.message : "";
  if (!raw) return null;

  // error.message is either a plain string or the provider's HTTP envelope serialized as
  // JSON: {"type":"error","status":429,"error":{"type":"...","message":"..."}}
  let code = null;
  let detail = raw;
  let resetsAt = null;
  let retryAt = null;
  const nested = safeJson(raw);
  if (nested && typeof nested === "object") {
    const inner = nested.error && typeof nested.error === "object" ? nested.error : nested;
    if (typeof inner.type === "string") code = inner.type;
    else if (typeof inner.code === "string") code = inner.code;
    if (typeof inner.message === "string") detail = inner.message;
    resetsAt = parseResetTimestamp(inner.resets_at ?? nested.resets_at, "absolute");
    retryAt = parseResetTimestamp(inner.retry_after ?? nested.retry_after, "duration");
  }

  const codeKind = code ? USAGE_LIMIT_CODES.get(code.toLowerCase()) : undefined;
  const haystack = `${detail}\n${raw}`.toLowerCase();
  const messageHit = USAGE_LIMIT_MESSAGES.find(([phrase]) => haystack.includes(phrase));
  // Require a verified code or a verified message template. A bare 429 status is not
  // enough on its own — fail closed and let the run report a plain "failed".
  if (!codeKind && !messageHit) return null;

  return {
    kind: codeKind ?? messageHit?.[1] ?? "unknown",
    code: code ?? null,
    source: "events.jsonl",
    excerpt: detail || raw,
    artifactLine,
    resetsAt,
    retryAt,
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
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    sandbox: "workspace-write",
    sandboxConfigured: false,
    resumeLast: false,
    session: null,
    cleanEnv: false,
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
      case "--sandbox": opts.sandbox = next(); opts.sandboxConfigured = true; flagged.add("sandbox"); break;
      case "--read-only": opts.sandbox = "read-only"; opts.sandboxConfigured = true; flagged.add("sandbox"); flagged.add("readOnly"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--clean-env": opts.cleanEnv = true; break;
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
  if (opts.effort !== null && !/^[a-z][a-z0-9-]*$/i.test(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected a non-empty bare token)`);
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
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
  if (!match) return "relay.mjs — dispatch a brief to codex exec\n";
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
  // The watchdog is only armed once codex is running, so the preflight needs a bound of
  // its own: a `codex --version` that never returns would wedge the relay here, before
  // any result.json exists, and --timeout could not reach it.
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  return timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
}

function codexEnv(opts) {
  if (!opts.cleanEnv) return process.env;
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "CODEX_HOME", "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "PATHEXT", "COMSPEC", ...opts.keepEnv];
  return Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function codexVersion(probeTimeoutMs, env) {
  try {
    // On Windows, npm installs `codex` as a .cmd shim; Node's CreateProcess only
    // auto-appends .exe, never .cmd, so launching it needs shell:true there or it
    // ENOENTs on a working install. POSIX is unaffected. (git installs a real
    // git.exe and must NOT get this flag — see gitTouchedFiles.)
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
      env,
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
    // Anything else — a hung probe we killed, or a real non-zero exit — means codex is
    // installed but not usable. Reporting that as "unavailable" would send the caller
    // off to reinstall a binary that is already there.
    return { version: null, error };
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
  // Local script (not a workflow): Date is available and fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts, finalPath) {
  const argv = ["exec"];
  const resuming = Boolean(opts.session || opts.resumeLast);
  // Codex accepts shared exec options before the resume subcommand. Reapply only
  // an explicitly selected sandbox; otherwise leave the active Codex config alone.
  if (resuming && opts.sandboxConfigured) argv.push("-s", opts.sandbox);
  if (opts.session) argv.push("resume", opts.session);
  else if (opts.resumeLast) argv.push("resume", "--last");
  // ponytail: shell:true on win32 (needed for the codex.cmd shim) doesn't quote
  // args, so a temp path with spaces (C:\Users\First Last\...) splits and the
  // trailing "-" misparses (issue #3). Quote the only spaceable arg in argv.
  // Ceiling: if quoting proves too blunt, drop shell:true and resolve the shim.
  const outPath = process.platform === "win32" ? `"${finalPath}"` : finalPath;
  argv.push("--json", "-o", outPath);
  if (!resuming) {
    argv.push("-s", opts.sandbox);
  }
  if (opts.model) argv.push("-m", opts.model);
  // `-c` is accepted by the resume subcommand, so the effort override applies to
  // fresh and resumed runs alike.
  if (opts.effort !== null) argv.push("-c", `model_reasoning_effort=${opts.effort}`);
  if (opts.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  argv.push("-"); // read the prompt from stdin
  return argv;
}

function extractThreadId(event) {
  return (
    event.thread_id ??
    event.threadId ??
    (event.thread && (event.thread.thread_id ?? event.thread.id)) ??
    null
  );
}

function recordEventLine(eventsPath, line, scan) {
  // Append one stdout line to the event log and pull a thread id from it when the
  // line is a JSON event. Non-JSON progress lines (and a newline-less final line)
  // are preserved in events.jsonl regardless; they just carry no thread id.
  // scan carries the run's accumulated state: the events.jsonl line number (so a
  // classification can point at its own evidence), the latest thread id, and the
  // usage-limit match from the terminal failure event.
  appendFileSync(eventsPath, `${line}\n`, "utf8");
  scan.lineCount += 1;
  const event = safeJson(line);
  if (!event || typeof event !== "object") return;
  const tid = extractThreadId(event);
  if (tid) scan.threadId = tid;
  if (event.type === "turn.failed") {
    scan.limitMatch = classifyUsageLimit(event, scan.lineCount);
  } else if (event.type === "turn.completed") {
    // A turn that recovered and completed supersedes an earlier failure: the run did the
    // work, so it must not be reported as limit-exhausted.
    scan.limitMatch = null;
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Codex's edits, not relay's artifacts.
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
  // dispatch would read the old result.json as if it were this run's, and a preflight
  // failure or a run with no stdout would publish a finalPath for someone else's report.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
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
      resumeLast: opts.resumeLast,
      session: opts.session,
      cleanEnv: opts.cleanEnv,
      keepEnv: opts.keepEnv,
      codexVersion: version,
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
  const result = writeResult({ status: "codex_unavailable", exitCode: 127, signal: null, threadId: null, finalMessage: "", touchedFiles: null });
  printSummary(result, resultPath);
  process.stderr.write("relay: `codex` not found on PATH. Install it (npm i -g @openai/codex) and run `codex login`.\n");
  process.exit(127);
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  const message = timedOut
    ? `codex --version preflight timed out after ${probeTimeoutMs}ms; Codex was not dispatched`
    : `codex --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Codex was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    threadId: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToCodex(opts, brief, run, writeResult, env) {
  const argv = buildArgv(opts, run.finalPath);
  // shell:true on Windows so the codex.cmd shim resolves (see codexVersion). Safe:
  // the brief is fed via child.stdin below — never argv — and argv holds only
  // sandbox enums, model names, the pattern-checked effort, and file paths.
  // detached on POSIX: the child leads a new process group so killChild can fell the whole tree
  const child = spawn("codex", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", detached: process.platform !== "win32", env });

  const scan = { lineCount: 0, threadId: null, limitMatch: null };
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
      recordEventLine(run.eventsPath, line, scan);
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Codex progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
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
  // no result.json and leaves the codex child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const finalMessage = existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8").trim() : "";
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        threadId: scan.threadId,
        finalMessage,
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; codex was terminated with it — inspect the working tree before re-dispatching`,
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
    const result = writeResult({ status: "failed", exitCode: 1, signal: null, threadId: scan.threadId, finalMessage: "", touchedFiles: gitTouchedFiles(opts.cd), error: String(err && err.message ? err.message : err) });
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
    if (stdoutBuf.trim()) {
      // The terminal event can arrive without a trailing newline; scan it before the
      // outcome is decided so a final-line turn.failed still classifies.
      recordEventLine(run.eventsPath, stdoutBuf, scan);
    }
    const finalMessage = existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8").trim() : "";
    // Outcome precedence: a run the relay itself ended is a timeout (or, in the signal
    // handler above, aborted) — never a classified provider failure, because the limit
    // may simply be what codex was about to report when we killed it.
    const limitMatch = watchdogFired ? null : scan.limitMatch;
    // A timed-out run is never a success even if codex handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code. A usage limit is likewise
    // never a success: if codex ever exits 0 while its terminal turn.failed carried a
    // limit signature, normalize to a failure (exit 1 below) rather than report a run
    // that did no work as completed.
    const succeeded = code === 0 && !watchdogFired && !limitMatch;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      threadId: scan.threadId,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `codex did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
      ...usageLimitFields(limitMatch),
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently.
  const run = prepareRunDir(opts, brief);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const env = codexEnv(opts);
  const probe = codexVersion(probeTimeoutMs, env);
  const writeResult = makeResultWriter(opts, probe.version, run);

  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }

  dispatchToCodex(opts, brief, run, writeResult, env);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  codex ${result.codexVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a codex error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated codex (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.failureClass === "usage_limit") {
    const when = result.limit?.retryAt || result.limit?.resetsAt;
    lines.push(`hint: the provider refused on usage limits (${result.limit?.kind ?? "unknown"})${when ? `, earliest retry ${when}` : ""} — this is not a task failure. Do NOT rework the brief: inspect touched files first, then wait for the reset or re-dispatch the same brief on another lane from a clean tree.`);
    if (result.limit?.evidence?.excerpt) lines.push(`  evidence (${result.limit.evidence.source}:${result.limit.evidence.artifactLine ?? "?"}): ${result.limit.evidence.excerpt}`);
  }
  if (result.resumeLast) lines.push("mode: resumed most recent session");
  if (result.session) lines.push(`mode: resumed session ${result.session}`);
  if (result.threadId) lines.push(`thread id (resume with: --session ${result.threadId}): ${result.threadId}`);
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

main();
