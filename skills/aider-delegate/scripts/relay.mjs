#!/usr/bin/env node
/**
 * delegate-skills · aider-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Aider (`aider --message-file`), capture the
 * run, and write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON - every
 * Aider-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. What was actually run, and on what, is recorded in the
 * README's Verification status list rather than pinned here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `aider` and `git`. The `aider` process it
 * launches does reach its configured model endpoint - exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * The brief is delivered with `--message-file`, so it never rides argv: it is
 * not visible in the host process list and is not subject to the OS argument
 * size cap.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * - after it reviews the diff and re-runs the project gates. Aider is the one
 * implementer here that commits by default, so the relay always passes:
 *   --no-auto-commits    Aider's `--auto-commits` defaults to True and would
 *                        otherwise commit its own edits.
 *   --no-dirty-commits   Aider's `--dirty-commits` defaults to True and would
 *                        otherwise commit YOUR pre-existing uncommitted work
 *                        before it starts editing.
 * Neither flag is configurable through this relay. A run that committed would
 * destroy the reviewable diff this skill exists to produce.
 *
 * The relay also pins the following, none of them configurable, so a headless
 * run stays quiet and leaves no artifacts of its own in the tree:
 *   --yes-always         Aider's own autonomy term; headless runs cannot answer
 *                        a confirmation prompt.
 *   --no-suggest-shell-commands
 *                        The other half of --yes-always: Aider's
 *                        --suggest-shell-commands defaults to True, and under
 *                        --yes-always a suggestion runs on the host unread.
 *   --no-gitignore       Aider otherwise writes `.aider*` into .gitignore on
 *                        startup, dirtying the tree the reviewer is about to read.
 *   --no-analytics       No telemetry from the dispatched run. Aider's own
 *                        --analytics default is "random", which opts some
 *                        sessions in on its own.
 *   --no-check-update    No version check on a dispatch path.
 *   --no-detect-urls     Aider's --detect-urls defaults to True and offers to
 *                        scrape any URL in the message. Under --yes-always that
 *                        offer is auto-accepted, so a URL in the brief becomes an
 *                        unannounced outbound fetch - and, without Playwright
 *                        installed, a run that hangs until the watchdog fires.
 *   --no-pretty          Plain output; colour codes would corrupt the captured report.
 *   --no-stream          Whole responses; the relay captures text, not a live view.
 *
 * Autonomy, in Aider's own terms: `--yes-always` auto-confirms every prompt, and
 * Aider has no sandbox and no permission modes. Within its file scope it edits
 * freely. `--read-only` here maps to Aider's `--dry-run`, which performs the run
 * without modifying files; the relay does not independently verify that claim, so
 * `touchedFiles` remains the evidence of what changed.
 *
 * Aider has no session ids. Its resume unit is the chat history file in the
 * repo (`.aider.chat.history.md`), so `--resume-last` maps to Aider's
 * `--restore-chat-history` and `--history-file` pins a specific one.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Aider (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Aider model name (default: Aider's own configured model).
 *   --api-base <url>        OpenAI-compatible base URL (Aider's --openai-api-base).
 *   --edit-format <fmt>     Aider edit format (its --edit-format, e.g. diff, whole, udiff).
 *   --architect             Use Aider's architect edit format.
 *   --file <path>           Add a file to Aider's editing scope. Repeatable.
 *   --read <path>           Add a read-only context file. Repeatable.
 *   --subtree-only          Restrict Aider to the current subtree of the repo.
 *   --read-only             Dispatch as a dry run (Aider's --dry-run): no files modified.
 *   --resume-last           Restore Aider's chat history for this repo; send only the delta brief.
 *   --history-file <path>   Pin a specific chat history file (Aider's --chat-history-file).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, aiderVersion, finalMessage (Aider's own report),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `aider` binary exits 127
 * with one; otherwise the exit code mirrors Aider's own (0 success, non-zero
 * failure), except an exit-0 model/endpoint failure detected in the report exits
 * 1. If the child dies on a signal, the exit code is 128 plus the signal
 * number and `result.json` records the signal. Once the brief validates,
 * `result.json` is written on every outcome - completed, failed, timeout (the
 * --timeout watchdog fired), aborted (the relay itself was killed and forwarded
 * the kill to aider), or aider_unavailable.
 */

import {spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import {join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

const IMPLEMENTER_KEY = "aider";

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
    apiBase: null,
    editFormat: null,
    architect: false,
    files: [],
    reads: [],
    subtreeOnly: false,
    readOnly: false,
    resumeLast: false,
    historyFile: null,
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
      case "--api-base": opts.apiBase = next(); break;
      case "--edit-format": opts.editFormat = next(); flagged.add("editFormat"); break;
      case "--architect": opts.architect = true; flagged.add("editFormat"); break;
      case "--file": opts.files.push(next()); break;
      case "--read": opts.reads.push(next()); break;
      case "--subtree-only": opts.subtreeOnly = true; break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--history-file": opts.historyFile = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.architect && opts.editFormat) {
    fail("--architect and --edit-format are mutually exclusive; pass only one");
  }
  // aider resolves a relative --file/--read/--chat-history-file against ITS cwd, so
  // resolve against --cd (not the relay's own cwd) - and only after the loop, since
  // they may appear before --cd on the command line. resolve() passes absolutes through.
  opts.files = opts.files.map((path) => resolve(opts.cd, path));
  opts.reads = opts.reads.map((path) => resolve(opts.cd, path));
  if (opts.historyFile) opts.historyFile = resolve(opts.cd, opts.historyFile);
  // The watchdog is relay-only (aider's own --timeout bounds a single API call, not
  // the run), so a malformed --timeout must fail loudly here - a silent 30m fallback
  // would be wrong.
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to aider --message-file\n";
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
  // The watchdog is only armed once aider is running, so the preflight needs a bound of its
  // own: an `aider --version` that never returns would wedge the relay here, before any
  // result.json exists, and --timeout could not reach it.
  return Math.min(parseDuration(opts.timeout), VERSION_PROBE_TIMEOUT_MS);
}

function aiderVersion(probeTimeoutMs) {
  try {
    const out = execFileSync("aider", ["--version"], {
      encoding: "utf8",
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
    }).trim();
    return { version: out || "unknown", error: null };
  } catch (err) {
    // Only a missing binary means "unavailable"; any other version-probe
    // failure must not masquerade as exit 127.
    if (err && err.code === "ENOENT") return { version: null, error: null };
    // A hung probe we killed, or a real non-zero exit, means aider is installed but not
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

// Aider writes its own bookkeeping into the repo and keeps doing so under --dry-run.
// These stay in touchedFiles, which reports git verbatim, but they must not trip the
// read-only warning: a dry run that touched nothing else is exactly what was asked for.
// The list is exhaustive on purpose. A blanket `.aider*` match would also swallow
// user-managed settings - .aider.conf.yml, .aider.model.settings.yml,
// .aider.model.metadata.json, .aiderignore - and those changing during a dry run is
// precisely what the warning exists to report.
const AIDER_GENERATED_FILE = /^\.aider\.(?:chat\.history\.md|input\.history|llm\.history)$/;
const AIDER_GENERATED_DIR = /^\.aider\.tags\.cache\.v\d+$/;

function isAiderGenerated(path) {
  const segments = path.split("/");
  // the tags cache is a directory; git may report it or anything beneath it
  if (segments.some((segment) => AIDER_GENERATED_DIR.test(segment))) return true;
  return AIDER_GENERATED_FILE.test(segments[segments.length - 1]);
}

function withoutAiderArtifacts(touchedFiles) {
  if (!Array.isArray(touchedFiles)) return [];
  return touchedFiles.filter((line) => {
    // git porcelain v1: two status columns, a space, then the path. A rename reports
    // `old -> new`; judge the destination, which is what the run actually wrote.
    const entry = line.slice(3).trim();
    const target = entry.includes(" -> ") ? entry.slice(entry.lastIndexOf(" -> ") + 4) : entry;
    return !isAiderGenerated(target.replace(/^"|"$/g, ""));
  });
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
  return run;
}

function buildArgv(opts, run) {
  // Non-negotiable posture. --no-auto-commits and --no-dirty-commits keep the diff
  // reviewable (both default to True in aider); --no-gitignore stops aider writing
  // `.aider*` into .gitignore and dirtying the tree; the rest keep headless output
  // clean and side-effect free.
  //
  // --no-suggest-shell-commands is the other half of --yes-always. Aider's
  // --suggest-shell-commands defaults to True, and a suggestion under --yes-always is
  // accepted with nobody there to read it: the model's proposed command runs on the
  // host. Turning the suggestions off is not a sandbox - see SKILL.md - but it removes
  // the one path where a dispatched run executes a command the brief never named.
  const argv = [
    "--yes-always",
    "--no-suggest-shell-commands",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-gitignore",
    "--no-analytics",
    "--no-check-update",
    "--no-detect-urls",
    "--no-pretty",
    "--no-stream",
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.apiBase) argv.push("--openai-api-base", opts.apiBase);
  if (opts.architect) argv.push("--architect");
  else if (opts.editFormat) argv.push("--edit-format", opts.editFormat);
  if (opts.subtreeOnly) argv.push("--subtree-only");
  if (opts.readOnly) argv.push("--dry-run");
  if (opts.resumeLast) argv.push("--restore-chat-history");
  if (opts.historyFile) argv.push("--chat-history-file", opts.historyFile);
  for (const path of opts.reads) argv.push("--read", path);
  for (const path of opts.files) argv.push("--file", path);
  // Deliver the brief by file, never by argv: it keeps the brief out of the host
  // process list and clear of the OS argument size cap, and it binds a brief that
  // starts with "-" instead of letting it parse as a flag.
  argv.push("--message-file", run.briefPath);
  return argv;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "aider",
      workdir: opts.cd,
      model: opts.model,
      editFormat: opts.architect ? "architect" : opts.editFormat,
      readOnly: opts.readOnly,
      resumed: Boolean(opts.resumeLast),
      aiderVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
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

function reportUnavailable(opts, writeResult, resultPath) {
  const result = writeResult({
    status: "aider_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    // git can still report here, and the contract reserves null for when it cannot.
    // The tree is whatever it already was; say so rather than claiming ignorance.
    touchedFiles: gitTouchedFiles(opts.cd),
    error: "`aider` was not found on PATH; nothing was dispatched",
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `aider` not found on PATH. Install Aider (https://aider.chat/docs/install.html) and configure a model.\n");
  // Set the code and return rather than process.exit(): printSummary writes aider's whole
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
    ? `aider --version preflight timed out after ${probeTimeoutMs}ms; Aider was not dispatched`
    : `aider --version preflight failed${Number.isInteger(error?.status) ? ` with exit ${error.status}` : ""}; Aider was not dispatched`;
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

// Aider exits 0 after reporting a model or endpoint failure, so exit status alone
// cannot separate "did the work" from "never reached a model". These are aider's
// own end-of-run error lines; matching them turns that silent success into a
// failed status the orchestrator can act on.
// Every pattern is line-anchored. An earlier revision matched a bare `OPENAI_API_KEY`
// anywhere in the report, so a successful run whose report merely *mentioned* the
// variable ("Updated the docs to explain OPENAI_API_KEY setup") was published as an
// authentication failure. A diagnostic is a line aider emits, not a word it says.
const MODEL_FAILURE_PATTERNS = [
  // litellm surfaces the provider error class at the head of its own line; allow a
  // short prefix ("Error: ", a retry counter) but not a sentence of prose.
  /^.{0,60}?litellm\.(?:APIConnectionError|AuthenticationError|BadRequestError|RateLimitError|NotFoundError|InternalServerError|Timeout)\b/im,
  /^\s*(?:Error|Warning) connecting to /im,
  /^\s*(?:Error|Warning):?\s*(?:\w+_API_KEY|API key)\b.*\b(?:not set|not found|missing|invalid)\b/im,
  /^\s*The API provider is not able to authenticate you\b/im,
  // Needs an endpoint-shaped object: "Unable to connect" on its own is ordinary prose
  // a report could easily contain while describing the very thing it just documented.
  /^\s*Unable to (?:connect|reach)\s+(?:the\s+)?(?:model|endpoint|server|host|API|provider|https?:)/im,
];

function detectModelFailure(text) {
  for (const pattern of MODEL_FAILURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return null;
}

function dispatchToAider(opts, run, writeResult) {
  // Aider's pip install provides a native `aider` executable on every platform
  // (including the `aider.exe` shim on Windows), so launch it directly: multi-line
  // values and paths with spaces ride argv rather than shell text.
  const child = spawn("aider", buildArgv(opts, run), {
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
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // Both decoders hold any trailing bytes of a split multibyte character until they
  // are flushed, and stderr holds a final line that never got its newline. Drain both
  // before assembling a result, or the last thing aider said is the thing that is lost.
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

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the aider child running or dying mid-edit with nothing
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
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; aider was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd) });
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
    const modelFailure = watchdogFired
      ? null
      : detectModelFailure(`${finalMessage}\n${readFileSync(run.stderrPath, "utf8")}`);
    // A timed-out run is failed even if aider handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired && !modelFailure;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      // Every non-clean outcome carries an `error`. A plain nonzero exit used to fall
      // through this chain with none, leaving the consumer to infer the cause from
      // exitCode alone - which the result contract says it should never have to do.
      ...(succeeded
        ? {}
        : watchdogFired
          ? { error: `aider did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
          : modelFailure
            ? { error: `aider reported a model or endpoint failure and exited ${code}: ${modelFailure}` }
            : signal
              ? { error: `aider was killed by ${signal} — inspect the working tree before re-dispatching` }
              : { error: `aider exited ${code} without reporting a model or endpoint failure; see stderrTail and final.txt` }),
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
  // brief.txt, which is the file aider reads with --message-file.
  const run = prepareRunDir(opts, brief);
  const probeTimeoutMs = versionProbeTimeout(opts);
  const probe = aiderVersion(probeTimeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    reportUnavailable(opts, writeResult, run.resultPath);
    return;
  }
  if (probe.error) {
    reportVersionFailure(opts, writeResult, run, probe.error, probeTimeoutMs);
    return;
  }
  dispatchToAider(opts, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  ${result.aiderVersion ?? "aider ?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not an aider error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated aider (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.readOnly) lines.push("mode: dry run (aider --dry-run) - no files should be modified");
  if (result.resumed) lines.push("mode: restored aider's chat history");
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  const unexpected = result.readOnly ? withoutAiderArtifacts(touched) : [];
  if (unexpected.length) {
    lines.push(`warning: --read-only dispatched aider --dry-run, yet ${unexpected.length} path(s) outside aider's own generated history and cache changed. Inspect the diff before trusting this run.`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- aider final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
