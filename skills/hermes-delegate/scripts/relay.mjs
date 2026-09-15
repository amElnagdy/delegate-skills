#!/usr/bin/env node
/**
 * delegate-skills · hermes-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Hermes Agent CLI (`hermes chat` headless),
 * capture the run, and write a structured result the orchestrating agent can review.
 * The orchestrator runs this one command and reads the result JSON - every
 * Hermes-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. What was actually run, and on what, is recorded in the
 * README's Verification status list rather than pinned here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `hermes` and `git`. The `hermes` process it
 * launches reaches its configured inference provider - exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * The brief is delivered with `chat --query-file`, so it never rides argv: it is
 * not visible in the host process list and is not subject to the OS argument
 * size cap.
 *
 * Autonomy, in Hermes's own terms: Hermes has no sandbox and no permission modes -
 * none may be invented. Headless `chat --query-file <brief> -Q` ran an unattended file-write ask on
 * the platform the README's Verification entry describes, and `-z/--oneshot`'s own
 * help states approvals are auto-bypassed there. Write runs pass `--yolo`
 * explicitly so the bypass never depends on user config; `--read-only` restricts
 * `--toolsets` (best-effort - there is no read-only toolset, `file` writes by
 * design) and omits `--yolo`; `touchedFiles` remains the evidence of what changed.
 *
 * Never pass `--worktree`: measured, Hermes creates `<repo>/.worktrees/hermes-<hex>`,
 * works inside it correctly, then DELETES the tree at session end - destroying every
 * uncommitted edit. This relay refuses the idea entirely; work lands in the dispatch
 * tree, where the diff is reviewable and committable.
 *
 * Anchoring: headless Hermes resolves RELATIVE paths against its default workspace
 * (the user's home directory), not against `--in <dir>` - measured repeatedly, with
 * and without `--in`. Briefs must therefore spell every file target as an absolute
 * path under the dispatch root. The relay passes `--in <cd>` anyway (it scopes
 * resume lookups), re-verifies through `touchedFiles`, and warns loudly when an
 * apparently-clean run's report names absolute paths under the home directory
 * outside the dispatch root - the silent home-pollution failure mode.
 *
 * The relay pins these on every dispatched run, none of them configurable:
 *   -Q                    Quiet mode: suppresses banner, spinner, and tool previews
 *                         so stdout carries only the final response.
 *   --query-file          Brief delivery (see above).
 *   --in <cd>             Scopes `--resume latest`/`--continue` lookups to the
 *                         dispatch root. Does NOT anchor relative paths (see above).
 *   --source <tag>        A unique per-run tag; the fallback session-id lookup
 *                         finds this exact dispatch with it.
 * plus, per mode: `--yolo` on write runs; restricted `--toolsets` and no `--yolo`
 * on `--read-only` runs. `--model`, `--provider`, `--max-turns`, and the resume
 * flags pass through only when asked for; left alone, Hermes uses its own
 * configuration, exactly as at the terminal.
 *
 * Session ids: primary capture parses the `session_id:` line Hermes writes to its
 * own stderr on quiet-mode runs; the fallback resolves this run's unique `--source`
 * tag through `hermes sessions list --source <tag>`. Either may fail; a null
 * sessionId is legal and just means resume-by-id is unavailable for that run.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for the run (default: current directory).
 *                           Remember: briefs still need ABSOLUTE file paths under
 *                           this root - see SKILL.md.
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Model for this run (chat -m, e.g. anthropic/claude-sonnet-4).
 *                           Default: Hermes's own configured model.
 *   --provider <name>       Inference provider for this run (--provider). Default:
 *                           Hermes's own configured provider.
 *   --max-turns <n>         Cap on agent turns for this run (chat --max-turns).
 *                           Last-resort watchdog: tripping it mid-task leaves a
 *                           partial edit, not a clean failure.
 *   --read-only             Review/diagnosis intent: restricted --toolsets, no
 *                           --yolo. BEST-EFFORT, NOT enforcement - Hermes has no
 *                           read-only toolset; verify touchedFiles afterward.
 *   --resume-last           Continue the most recent session for this workspace
 *                           (chat --continue); send only the delta brief.
 *   --resume <id>           Continue a specific session id (chat --resume);
 *                           mutually exclusive with --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Environment:
 *   HERMES_DELEGATE_BIN     Absolute path or name of the hermes binary to launch
 *                           (default: `hermes` from PATH). For tests and wrappers.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, hermesVersion, sessionId, reportCaptured,
 *   finalMessage (the implementer's own report), touchedFiles (git porcelain,
 *   null if git cannot report), readOnly, resumed, and paths to brief.txt,
 *   final.txt, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `hermes` binary exits 127
 * with one; otherwise the exit code mirrors Hermes's own (0 success, non-zero
 * failure), except an exit-0 provider/billing failure detected in the captured
 * report exits 1. If the child dies on a signal, the exit code is 128 plus the
 * signal number and `result.json` records the signal. Once the brief validates,
 * `result.json` is written on every outcome - completed, failed, timeout (the
 * --timeout watchdog fired), aborted (the relay itself was killed and forwarded
 * the kill to hermes), or hermes_unavailable.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import {join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir, homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

const IMPLEMENTER_KEY = "hermes";

// `hermes` is Command Code's `cmd` equivalent here: HERMES_DELEGATE_BIN overrides it
// (for tests and wrappers); a value containing a separator is resolved to an
// absolute path, anything else launches from PATH as-is.
const CONFIGURED_BIN = process.env.HERMES_DELEGATE_BIN || "hermes";
const BIN = CONFIGURED_BIN && /[\\/]/.test(CONFIGURED_BIN)
  ? resolve(CONFIGURED_BIN)
  : CONFIGURED_BIN;

// --model/--provider values ride argv; they are restricted to safe tokens so a
// crafted value can never reshape the launched command line, whatever shell or
// launcher sits between this relay and the binary.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Read-only-leaning runs keep the tools a reviewer may use and drop the ones that
// exist chiefly to mutate the machine or act beyond the repo. There is NO
// read-only toolset - `file` performs writes by design - so this expresses intent;
// it does not enforce anything (see SKILL.md).
// Valid names for hermes 0.20.x: memory and search resolve; `docs` was removed
// from the registry (58 named toolsets, no `docs`) and made every read-only
// dispatch print "Warning: Unknown toolsets: docs". Measured live on macOS,
// 2026-08-26: this set exposes zero file/terminal tools - the write probe was
// refused for lack of any file tool.
const READ_ONLY_TOOLSETS = "memory,search";

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
    provider: null,
    maxTurns: null,
    readOnly: false,
    resumeLast: false,
    resumeId: null,
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
      case "--model": {
        const value = next();
        if (!SAFE_TOKEN.test(value)) fail(`--model "${value}" must be a plain token (letters, digits, . _ : / -)`);
        opts.model = value;
        flagged.add("model");
        break;
      }
      case "--provider": {
        const value = next();
        if (!SAFE_TOKEN.test(value)) fail(`--provider "${value}" must be a plain token (letters, digits, . _ : / -)`);
        opts.provider = value;
        flagged.add("provider");
        break;
      }
      case "--max-turns": {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0) fail("--max-turns requires a positive integer");
        opts.maxTurns = value;
        break;
      }
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--resume": {
        const value = next();
        if (!SAFE_TOKEN.test(value)) fail(`--resume "${value}" must be a plain session-id token`);
        opts.resumeId = value;
        break;
      }
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.resumeLast && opts.resumeId) {
    fail("--resume-last and --resume <id> are mutually exclusive; pass only one");
  }
  // The watchdog is relay-only (Hermes has no portable whole-run budget flag on the
  // chat channel; --run-budget bounds the model conversation, not the process), so
  // a malformed --timeout must fail loudly here - a silent 30m fallback would be wrong.
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to hermes chat --query-file\n";
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

function versionProbeTimeout(opts) {
  // The watchdog is only armed once hermes is running, so the preflight needs a bound of its
  // own: a `hermes --version` that never returns would wedge the relay here, before any
  // result.json exists, and --timeout could not reach it.
  return Math.min(parseDuration(opts.timeout), VERSION_PROBE_TIMEOUT_MS);
}

function hermesVersion(probeTimeoutMs) {
  try {
    const out = execFileSync(BIN, ["--version"], {
      encoding: "utf8",
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
    }).trim();
    // `hermes --version` prints several lines; the first carries
    // "Hermes Agent v0.20.5 (...)", which is the identity worth recording.
    const match = /(\d+\.\d+\.\d+(?:[-+][^\s)]*)?)/.exec(out);
    return { version: match ? match[1] : out.split("\n")[0] || "unknown", error: null };
  } catch (err) {
    // Only a missing binary means "unavailable"; any other version-probe
    // failure must not masquerade as exit 127.
    if (err && err.code === "ENOENT") return { version: null, error: null };
    // A hung probe we killed, or a real non-zero exit, means hermes is installed but not
    // usable. Dispatching anyway would send the brief to a CLI already known to be broken.
    return { version: null, error: err };
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

// Provider and credential failures surface as PROSE ON STDOUT while hermes still exits
// nonzero or even 0 depending on where the pipeline gives up, so exit codes alone cannot
// separate "did the work" from "never reached a model". These are failure lines the
// provider layer emits; matching them turns a silent or ambiguous outcome into a failed
// status the orchestrator can act on.
//
// Every pattern is line-anchored. A diagnostic is a line hermes emits, not a word it
// says: a successful run whose report merely MENTIONS "OPENAI_API_KEY" or "billing"
// (say, documenting setup steps) must still publish as completed.
const PROVIDER_FAILURE_PATTERNS = [
  // OpenRouter-style class errors, optionally behind a short "Error ..." prefix and
  // emoji/status decoration - but not behind a sentence of prose.
  /^.{0,60}?\b(?:Billing or credits exhausted|Insufficient credits?|Quota exceeded|Rate limit exceeded)\b/im,
  /^\s*(?:Error|ERROR):?\s*[45]\d\d\b.{0,80}?\b(?:auth|credential|api[_ ]?key|billing|credit|quota)\b/im,
  /^\s*(?:Error|ERROR):?\s*(?:\w+_API_KEY|API key)\b.*\b(?:not set|not found|missing|invalid|incorrect)\b/im,
  /^\s*(?:Authentication|Authorization) error\b/im,
  /^\s*No credentials configured\b/im,
];

function detectProviderFailure(text) {
  for (const pattern of PROVIDER_FAILURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return null;
}

// Quiet-mode runs print the session id on their own stderr as `session_id: <id>`;
// every probed run carried it. The fallback resolves this run's unique --source tag
// through `hermes sessions list --source <tag>` (single row; id is the last token).
const SESSION_ID_LINE = /^\s*session_id:\s*(\S+)\s*$/im;

function extractSessionIds(text) {
  const ids = [];
  for (const match of text.matchAll(new RegExp(SESSION_ID_LINE.source, "gim"))) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

function lookupSessionIdBySource(sourceTag, budgetMs) {
  try {
    const out = execFileSync(BIN, ["sessions", "list", "--source", sourceTag, "--limit", "5"], {
      encoding: "utf8",
      timeout: Math.max(1000, Math.min(budgetMs, 10_000)),
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const rows = out.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      // Drop box-drawing rule-offs and a header row whose last column is the word "id".
      .filter((line) => !/^[|+=-]+$/.test(line))
      .filter((line) => !/^id\b/i.test(line) && !/\bid\s*\|?\s*$/i.test(line));
    if (!rows.length) return null;
    const token = rows[rows.length - 1].split(/\s+/).pop();
    return token && token !== "-" ? token : null;
  } catch {
    return null;
  }
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  // A reused --out-dir must not advertise the previous run: a poller that races the
  // dispatch would read the old result.json as if it were this run's, and a preflight
  // failure or a run with no stdout would publish a finalPath for someone else's report.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  // Unique per-run tag for the fallback session-id lookup: `hermes sessions list
  // --source <tag>` matches exactly this dispatch, never an earlier or concurrent one.
  run.sourceTag = `delegate-relay-${process.pid}-${Date.now().toString(36)}`;
  return run;
}

function buildArgv(opts, run) {
  // Fixed posture, then dials. Write runs pass --yolo explicitly so unattended
  // writes never depend on user config; read-only-leaning runs swap it for a
  // restricted toolset and say so in the docs rather than pretending either is a
  // sandbox. The brief rides --query-file, never argv: out of the host process
  // list, clear of the OS argument cap, and immune to a leading "-".
  const argv = ["chat", "--query-file", run.briefPath, "-Q"];
  if (opts.readOnly) argv.push("-t", READ_ONLY_TOOLSETS);
  else argv.push("--yolo");
  if (opts.model) argv.push("-m", opts.model);
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.maxTurns !== null) argv.push("--max-turns", String(opts.maxTurns));
  if (opts.resumeLast) argv.push("--continue");
  else if (opts.resumeId) argv.push("--resume", opts.resumeId);
  // Scopes --resume latest / --continue lookups to this dispatch root. It does NOT
  // anchor relative paths (measured: those land in the home workspace regardless) -
  // hence the absolute-path rule in writing-the-brief.md and the drift guard below.
  argv.push("--in", opts.cd);
  argv.push("--source", run.sourceTag);
  return argv;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "hermes",
      workdir: opts.cd,
      model: opts.model,
      provider: opts.provider,
      readOnly: opts.readOnly,
      resumed: Boolean(opts.resumeLast || opts.resumeId),
      hermesVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      stderrPath: run.stderrPath,
      // null = the question never got that far (preflight paths); dispatched runs
      // replace it with "complete" or "empty".
      reportCaptured: null,
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

function reportUnavailable(opts, writeResult, resultPath) {
  const result = writeResult({
    status: "hermes_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    // git can still report here, and the contract reserves null for when it cannot.
    // The tree is whatever it already was; say so rather than claiming ignorance.
    touchedFiles: gitTouchedFiles(opts.cd),
    error: "`hermes` was not found on PATH; nothing was dispatched",
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `hermes` not found on PATH. Install the Hermes Agent CLI and authenticate it the way you would at the terminal.\n");
  // Set the code and return rather than process.exit(): printSummary writes hermes's whole
  // final report in one stdout write, and stdout to a pipe is asynchronous on macOS - which
  // is exactly how an orchestrator captures this. Forcing exit can truncate that write.
  // Every caller of this helper already returns, so falling through dispatches nothing.
  process.exitCode = 127;
}

function reportVersionFailure(opts, writeResult, run, error, probeTimeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  const stderr = String(error?.stderr || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `hermes --version preflight timed out after ${probeTimeoutMs}ms; Hermes was not dispatched`
    : `hermes --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Hermes was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
    stderrTail: stderr ? stderr.split("\n").slice(-20) : [],
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exitCode = result.exitCode;
}

function dispatchToHermes(opts, run, writeResult) {
  // The installer puts a native `hermes` executable on PATH on every supported
  // platform, so launch it directly: multi-line briefs ride --query-file and paths
  // with spaces stay spawn options rather than shell text. Stdin is closed on
  // purpose: a dispatched run must never wait on a prompt that has no answerer
  // (measured: an unattended write run completes with closed stdin).
  const child = spawn(BIN, buildArgv(opts, run), {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let stdout = "";
  const stderrTail = [];
  let stderrRemainder = "";
  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const sessionIds = [];
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
    // Carry the un-newlined tail forward. A chunk that ends mid-line would otherwise
    // publish half a line in stderrTail as though it were whole, and the rest of that
    // line would arrive as a second, equally broken entry.
    const text = stderrRemainder + stderrDecoder.write(chunk);
    const lines = text.split("\n");
    stderrRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) stderrTail.push(line.trimEnd());
      for (const id of extractSessionIds(line)) sessionIds.push(id);
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // Both decoders hold any trailing bytes of a split multibyte character until they
  // are flushed, and stderr holds a final line that never got its newline. Drain both
  // before assembling a result, or the last thing hermes said is the thing that is lost.
  const flushStreams = () => {
    stdout += stdoutDecoder.end();
    const tail = stderrRemainder + stderrDecoder.end();
    stderrRemainder = "";
    if (tail.trim()) {
      stderrTail.push(tail.trimEnd());
      for (const id of extractSessionIds(tail)) sessionIds.push(id);
    }
    while (stderrTail.length > 20) stderrTail.shift();
  };

  const assembleFinal = () => {
    const message = stdout.trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  // Primary session-id capture happens at settle time from the collected stderr
  // lines; this fallback only runs when stderr carried no id at all. Bounded, and
  // skipped entirely when the relay itself is dying (the abort path has no time
  // budget for a subprocess).
  const resolveSessionId = () => {
    if (sessionIds.length) return sessionIds[sessionIds.length - 1];
    const looked = lookupSessionIdBySource(run.sourceTag, VERSION_PROBE_TIMEOUT_MS);
    return looked || null;
  };

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the hermes child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      flushStreams();
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        reportCaptured: stdout.trim() ? "complete" : "empty",
        sessionId: sessionIds.length ? sessionIds[sessionIds.length - 1] : null,
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; hermes was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, finishedAt: new Date().toISOString(), touchedFiles: gitTouchedFiles(opts.cd) });
        // The one forced exit the relay keeps. The other paths set process.exitCode so the
        // summary can drain, but here a child that refused to die would keep the loop alive
        // and hang the relay; after the grace window, leaving is the point.
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    flushStreams();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    flushStreams();
    const finalMessage = assembleFinal();
    const providerFailure = watchdogFired
      ? null
      : detectProviderFailure(`${finalMessage}\n${readFileSync(run.stderrPath, "utf8")}`);
    // A timed-out run is failed even if hermes handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired && !providerFailure;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      reportCaptured: finalMessage ? "complete" : "empty",
      // After a watchdog kill, publish immediately - a half-dead run's session id is
      // not worth a subprocess, and the timeout report must not queue behind one.
      sessionId: watchdogFired
        ? (sessionIds.length ? sessionIds[sessionIds.length - 1] : null)
        : resolveSessionId(),
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      // Every non-clean outcome carries an `error`. A plain nonzero exit used to fall
      // through this chain with none, leaving the consumer to infer the cause from
      // exitCode alone - which the result contract says it should never have to do.
      ...(succeeded
        ? {}
        : watchdogFired
          ? { error: `hermes did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
          : providerFailure
            ? { error: `hermes reported a provider or credential failure${code === 0 ? " and exited 0" : ` and exited ${code}`}: ${providerFailure}` }
            : signal
              ? { error: `hermes was killed by ${signal} — inspect the working tree before re-dispatching` }
              : { error: `hermes exited ${code} without reporting a provider failure; see stderrTail and final.txt` }),
    });
    printSummary(result, run.resultPath);
    process.exitCode = result.exitCode;
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // Prepare the run dir before probing, so a preflight that times out or fails still has
  // somewhere to publish result.json rather than exiting silently. It also writes
  // brief.txt, which is the file hermes reads with --query-file.
  const run = prepareRunDir(opts, brief);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const probe = hermesVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    reportUnavailable(opts, writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }
  dispatchToHermes(opts, run, writeResult);
}

// The silent home-pollution guard. Headless Hermes anchors RELATIVE paths at its default
// workspace ($HOME), not the dispatch root - measured repeatedly - so a brief that said
// "lib.js" can succeed loudly (exit 0, cheerful report) while writing into the user's
// home directory, leaving the dispatch tree untouched and touchedFiles empty. When the
// tree came out clean AND the captured report names absolute paths under $HOME outside
// the dispatch root, say so on stdout. Schema unchanged: this is a warning, not a verdict
// - the report may legitimately discuss home-dir paths without having written any.
function homeDriftCandidates(result) {
  if (!result.finalMessage) return [];
  if (Array.isArray(result.touchedFiles) && result.touchedFiles.length) return [];
  const root = resolve(result.workdir).replaceAll("\\", "/");
  const home = homedir().replaceAll("\\", "/");
  const hits = new Set();
  const posix = /(?:\/[\w@%+~-]+(?:\/[\w@%+.~-]+)+)/g;
  const windows = /([A-Za-z]):\\(?:[\w@%+.-]+\\)+[\w@%+.-]+/g;
  const candidates = [
    ...(result.finalMessage.matchAll(posix)).map((m) => m[0]),
    ...(result.finalMessage.matchAll(windows)).map((m) => m[0].replaceAll("\\", "/")),
  ];
  for (const candidate of candidates) {
    const path = candidate.replaceAll("\\", "/").replace(/[/]+$/, "");
    if (path === home || path === root) continue;
    if (!path.startsWith(`${home}/`) || path.startsWith(`${root}/`)) continue;
    hits.add(candidate);
    if (hits.size >= 8) break;
  }
  return [...hits];
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  hermes ${result.hermesVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a hermes error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated hermes (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.readOnly) lines.push("mode: read-only-leaning (restricted --toolsets, no --yolo) - best-effort, NOT enforcement; verify touchedFiles");
  if (result.resumed) lines.push("mode: resumed hermes session");
  if (result.reportCaptured === "empty") lines.push("warning: no report text was captured - hermes exited without a final response. Inspect the tree and stderr before trusting this run.");
  if (result.sessionId) lines.push(`session: ${result.sessionId} (feed back through --resume <id>)`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  const drift = homeDriftCandidates(result);
  if (drift.length) {
    lines.push(`warning: the tree is clean but the report names ${drift.length} path(s) under your home directory outside the dispatch root. Relative brief paths anchor at the HOME workspace headlessly - check these before assuming nothing happened:`);
    for (const path of drift) lines.push(`  ${path}`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- hermes final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
