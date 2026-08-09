#!/usr/bin/env node
/**
 * delegate-skills · claude-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to a separate Claude Code CLI process
 * (`claude -p`), capture the structured stream, and write a stable result the
 * orchestrator can review.
 *
 * Trust posture: this relay makes no network calls of its own, reads or writes
 * no credentials, sends no telemetry, and has no dependencies (Node built-ins
 * only). It launches `claude` and uses `git status --porcelain`; on Windows it
 * may also use cmd.exe for an npm .cmd shim and taskkill to terminate a process
 * tree. Claude authenticates and makes its own network calls exactly as it does
 * at the terminal.
 *
 * The relay never commits. Its write-capable profiles use string rules to deny
 * common direct forms of `git commit`, `git push`, and nested `claude`, plus
 * any command containing `claude-delegate`. Aliases, scripts, and wrappers can
 * bypass those speed bumps; the brief's no-commit instruction and orchestrator
 * review remain the boundary. The orchestrator re-runs the project gates and
 * lands the work.
 *
 * Normal runs use Claude's `acceptEdits` permission mode with an explicit tool
 * surface (Read, Glob, Grep, Edit, Write, and the platform shell). On macOS,
 * Linux, and WSL2, an inline settings file requires Claude's shell sandbox,
 * disables its unsandboxed escape hatch, and auto-approves commands that stay
 * sandboxed so non-interactive gates can run. That sandbox covers shell
 * processes and their children only; merged local or managed settings can
 * affect its effective boundary, and it is not a universal boundary around
 * Claude Code. Native Windows has no Claude shell sandbox, so the relay
 * pre-approves PowerShell there and documents that it is not OS-isolated.
 *
 * `--read-only` uses plan mode and exposes only Read, Glob, and Grep: no edit,
 * write, shell, MCP, skill, command, or Agent tool. The relay also compares git
 * porcelain before and after, and also fingerprints working-tree and index state for paths
 * that were already dirty, and emits `readOnlyViolation`. This is a tripwire,
 * not an OS boundary: it reports detected Git-visible changes, it does not prevent them. It is
 * three-valued - `null` means coverage was incomplete (git unavailable, a
 * submodule, an unreadable path), never "nothing happened". Git-ignored paths
 * are outside it.
 *
 * Every profile disables configured MCP discovery and Claude.ai connectors,
 * denies all MCP tools, and disables skills and commands for the child while
 * preserving normal authentication, CLAUDE.md discovery, hooks, and the rest of
 * the inherited environment. Hooks are outside the tool restriction and can
 * mutate a read-only run; readOnlyViolation is the tripwire. When nested under
 * Claude Code, the child environment removes only CLAUDECODE;
 * CLAUDE_CODE_CHILD_SESSION and credential variables are preserved. The same
 * environment is used for version preflight.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>                    Brief path. Omit to read the brief from stdin.
 *   --cd <dir>                        Child cwd (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --out-dir <dir>                   Artifact directory (default: system temp).
 *   --timeout <dur>                   Relay watchdog; off by default. Use h/m/s,
 *                                     such as 30m, 90s, or 1h30m.
 *   --model <name>                    Claude model alias or full name.
 *   --effort <level>                  low | medium | high | xhigh | max | ultracode
 *   --max-turns <n>                   Positive agentic-turn limit.
 *   --max-budget-usd <amount>         Positive decimal spend limit.
 *   --resume-last                     Map to Claude's --continue.
 *   --session <id>                    Map to Claude's --resume <id>.
 *                                     Mutually exclusive with --resume-last.
 *   --read-only                       Plan mode with Read, Glob, and Grep only.
 *   --dangerously-skip-permissions    Opt into Claude's bypassPermissions mode.
 *                                     Mutually exclusive with --read-only.
 *   -h, --help                        Show this help.
 *
 * Claude is always launched with:
 *   -p --output-format stream-json --verbose
 * The brief is sent through stdin, never argv. `--bg` and `--bare` are not used.
 *
 * Artifacts:
 *   brief.txt       exact brief sent on stdin
 *   events.jsonl    raw Claude stdout stream
 *   final.txt       final result event's text
 *   stderr.txt      complete Claude stderr
 *   profile.json    inspectable per-run settings passed with --settings
 *   result.json     delegate-relay.result.v1
 *
 * Exit codes: usage errors exit 2 before result.json; a missing `claude` exits
 * 127 with status "claude_unavailable"; otherwise the exit mirrors Claude, with
 * a forced non-zero code for timeout or a terminal error result. Once the brief
 * and artifact directory validate, result.json is written for completed,
 * failed, timeout, aborted, and claude_unavailable outcomes.
 *
 * Native Windows launch behavior supports a directly spawned claude.exe and an
 * npm claude.cmd shim through cmd.exe with strictly serialized arguments. It
 * remains pending native-Windows verification.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import {basename, delimiter, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as osConstants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

const MAX_BUFFERED_CHARS = 1_048_576;

const SCHEMA = "delegate-relay.result.v1";
const MAX_BRIEF_BYTES = 10_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const IMPLEMENTER_KEY = "claude";

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
    if (
      field === "readOnly" &&
      (flagged.has("readOnly") || flagged.has("dangerouslySkipPermissions"))
    ) {
      continue;
    }
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
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

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    outDir: null,
    timeout: null,
    model: null,
    effort: null,
    maxTurns: null,
    maxBudgetUsd: null,
    resumeLast: false,
    session: null,
    readOnly: false,
    dangerouslySkipPermissions: false,
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
      case "--out-dir": opts.outDir = resolve(next()); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--max-turns": opts.maxTurns = next(); break;
      case "--max-budget-usd": opts.maxBudgetUsd = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--session": opts.session = next(); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--dangerously-skip-permissions":
        opts.dangerouslySkipPermissions = true;
        flagged.add("dangerouslySkipPermissions");
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  applyFleetLane(opts, flagged);

  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.readOnly && opts.dangerouslySkipPermissions) {
    fail("--read-only and --dangerously-skip-permissions are mutually exclusive");
  }
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ / [ ] -)");
  }
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
    fail("--session contains unsupported characters (allowed: letters, digits, . _ : -)");
  }
  if (opts.effort !== null && !EFFORT_LEVELS.has(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: ${[...EFFORT_LEVELS].join(", ")})`);
  }
  if (opts.maxTurns !== null) {
    const turns = Number(opts.maxTurns);
    if (!/^[1-9]\d*$/.test(opts.maxTurns) || !Number.isSafeInteger(turns)) {
      fail("--max-turns must be a positive safe integer");
    }
  }
  if (opts.maxBudgetUsd !== null) {
    const budget = Number(opts.maxBudgetUsd);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(opts.maxBudgetUsd) || !Number.isFinite(budget) || budget <= 0) {
      fail("--max-budget-usd must be a positive decimal number");
    }
  }
  try {
    if (!statSync(opts.cd).isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  } catch {
    fail(`--cd directory not found: ${opts.cd}`);
  }
  if (opts.outDir && existsSync(opts.outDir)) {
    try {
      if (!statSync(opts.outDir).isDirectory()) fail(`--out-dir is not a directory: ${opts.outDir}`);
    } catch {
      fail(`cannot inspect --out-dir: ${opts.outDir}`);
    }
  }
  return opts;
}

function headerComment() {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to a separate claude -p session\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    try {
      return readFileSync(opts.brief, "utf8");
    } catch (error) {
      fail(`cannot read brief file: ${error && error.message ? error.message : String(error)}`);
    }
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function childEnvironment() {
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "CLAUDECODE") delete env[key];
    }
  } else {
    delete env.CLAUDECODE;
  }
  return env;
}

function environmentValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function resolveClaudeLauncher(env, cwd) {
  const pathValue = environmentValue(env, "PATH");
  if (!pathValue) return null;
  const pathEntries = pathValue.split(delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1"));

  if (process.platform === "win32") {
    const pathExt = (environmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    for (const entry of pathEntries) {
      const directory = resolve(cwd, entry || ".");
      for (const extension of pathExt) {
        const candidate = join(directory, `claude${extension}`);
        try {
          if (!statSync(candidate).isFile()) continue;
          const kind = extension === ".cmd" || extension === ".bat" ? "cmd" : "direct";
          return { path: candidate, kind };
        } catch {
          // Keep searching PATH.
        }
      }
    }
    return null;
  }

  for (const entry of pathEntries) {
    const candidate = join(resolve(cwd, entry || "."), "claude");
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return { path: candidate, kind: "direct" };
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function quoteCmdArgument(value) {
  // cmd expands %VAR% even inside quotes, and embedded quotes/newlines can break
  // the /c command boundary. Reject those rare path characters instead of
  // pretending an npm .cmd launch is safe. All user-selectable token values are
  // independently restricted by parseArgs.
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error("the npm claude.cmd launch cannot safely serialize an argument containing %, !, a quote, or a newline; use the native claude.exe or a safe artifact path");
  }
  return `"${value}"`;
}

function launchSpec(launcher, argv, env) {
  if (launcher.kind === "direct") {
    return { command: launcher.path, argv, windowsVerbatimArguments: false };
  }
  const commandLine = [launcher.path, ...argv].map(quoteCmdArgument).join(" ");
  const commandProcessor = environmentValue(env, "COMSPEC") || "cmd.exe";
  return {
    command: commandProcessor,
    argv: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    // The final argv element is an intentionally serialized cmd /c program.
    // Letting libuv quote it again would change cmd's nested-quote boundary.
    windowsVerbatimArguments: true,
  };
}

function preflightVersion(launcher, env, cwd) {
  try {
    const spec = launchSpec(launcher, ["--version"], env);
    const probe = spawnSync(spec.command, spec.argv, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    if (probe.error && probe.error.code === "ENOENT") return null;
    if (probe.status !== 0) return "unknown";
    return String(probe.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function shellTool() {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

function selectedPermissionMode(opts) {
  if (opts.readOnly) return "plan";
  if (opts.dangerouslySkipPermissions) return "bypassPermissions";
  return "acceptEdits";
}

function toolSurface(opts) {
  if (opts.readOnly) return "Read,Glob,Grep";
  return `Read,Glob,Grep,Edit,Write,${shellTool()}`;
}

function profileSettings(opts) {
  const shell = shellTool();
  const shellSandboxEnabled = !opts.readOnly && process.platform !== "win32";
  return {
    disableClaudeAiConnectors: true,
    ...(process.platform === "win32"
      ? { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" } }
      : {}),
    permissions: {
      deny: opts.readOnly
        ? []
        : [
            // Two-wildcard git forms require text after the subcommand, so the
            // single-wildcard forms also catch `git -C <dir> push`; they also
            // deny reads like `git log --grep push`. Anchor `claude` at command
            // position so reads mentioning it remain allowed. Keep
            // `claude-delegate` as a substring rule to stop recursive relay
            // invocation; any command containing it is denied.
            `${shell}(git commit *)`,
            `${shell}(git * commit *)`,
            `${shell}(git * commit)`,
            `${shell}(git push *)`,
            `${shell}(git * push *)`,
            `${shell}(git * push)`,
            `${shell}(claude *)`,
            `${shell}(*claude-delegate*)`,
          ],
    },
    ...(shellSandboxEnabled
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            excludedCommands: [],
            filesystem: {
              disabled: false,
            },
          },
        }
      : {}),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRun(opts, brief) {
  const outDir =
    opts.outDir ||
    join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt: new Date().toISOString(),
    outDir,
    briefPath: join(outDir, "brief.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    stderrPath: join(outDir, "stderr.txt"),
    settingsPath: join(outDir, "profile.json"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.finalPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  writeFileSync(run.settingsPath, `${JSON.stringify(profileSettings(opts), null, 2)}\n`, "utf8");
  return run;
}

function buildArgv(opts, run) {
  const argv = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--tools", toolSurface(opts),
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--disable-slash-commands",
    "--settings", run.settingsPath,
  ];

  if (opts.readOnly) {
    argv.push("--permission-mode", "plan");
  } else if (opts.dangerouslySkipPermissions) {
    argv.push("--dangerously-skip-permissions");
  } else {
    argv.push("--permission-mode", "acceptEdits");
    // Supported platforms auto-approve only commands that remain inside
    // Claude's sandbox. Native Windows has no shell sandbox, so approving its
    // selected shell is the explicit tradeoff that keeps print mode headless.
    if (process.platform === "win32") argv.push("--allowedTools", "PowerShell");
  }

  // The selected permission profile is passed on every invocation, including
  // --continue/--resume, rather than assuming a session remembers it.
  if (opts.resumeLast) argv.push("--continue");
  else if (opts.session) argv.push("--resume", opts.session);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.maxTurns) argv.push("--max-turns", opts.maxTurns);
  if (opts.maxBudgetUsd) argv.push("--max-budget-usd", opts.maxBudgetUsd);
  return argv;
}

function eventSessionId(event) {
  return (
    event.session_id ??
    event.sessionId ??
    (event.session && (event.session.id ?? event.session.session_id)) ??
    null
  );
}

function handleEvent(event, state, run) {
  if (!event || typeof event !== "object") return;
  const sessionId = eventSessionId(event);
  if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;

  if (event.type === "system" && event.subtype === "init") {
    const mode = event.permissionMode ?? event.permission_mode;
    if (typeof mode === "string" && mode) state.permissionMode = mode;
  }

  if (event.type !== "result") return;
  state.sawResult = true;
  state.resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
  state.resultIsError =
    event.is_error === true ||
    (state.resultSubtype !== null && /^error(?:_|$)/i.test(state.resultSubtype));
  state.finalMessage = typeof event.result === "string" ? event.result : "";
  state.usage = event.usage && typeof event.usage === "object" ? event.usage : null;

  const cost = event.total_cost_usd ?? event.cost_usd;
  state.totalCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  const turns = event.num_turns ?? event.numTurns;
  state.numTurns = typeof turns === "number" && Number.isFinite(turns) ? turns : null;
  writeFileSync(run.finalPath, state.finalMessage, "utf8");
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

function stderrTail(stderrPath) {
  try {
    return readFileSync(stderrPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-20);
  } catch {
    return [];
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function makeResultWriter(opts, version, run, state, beforeTree, beforeFingerprints) {
  return (extra) => {
    const result = {
      schema: SCHEMA,
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "claude",
      workdir: opts.cd,
      model: opts.model,
      effort: opts.effort,
      maxTurns: opts.maxTurns === null ? null : Number(opts.maxTurns),
      maxBudgetUsd: opts.maxBudgetUsd === null ? null : Number(opts.maxBudgetUsd),
      timeout: opts.timeout,
      readOnly: opts.readOnly,
      resumed: Boolean(opts.resumeLast || opts.session),
      resumeLast: opts.resumeLast,
      permissionMode: state.permissionMode || selectedPermissionMode(opts),
      toolSurface: toolSurface(opts).split(","),
      shellSandbox: opts.readOnly
        ? "not-applicable"
        : process.platform === "win32"
          ? "unsupported-on-native-windows"
          : "strict",
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      claudeVersion: version,
      sessionId: state.sessionId,
      resultSubtype: state.resultSubtype,
      numTurns: state.numTurns,
      usage: state.usage,
      totalCostUsd: state.totalCostUsd,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      eventsPath: run.eventsPath,
      finalPath: run.finalPath,
      stderrPath: run.stderrPath,
      settingsPath: run.settingsPath,
      ...extra,
    };
    if (opts.readOnly) {
      result.readOnlyViolation = readOnlyVerdict(
        beforeTree,
        gitTripwireState(opts.cd, [run.briefPath, run.eventsPath, run.finalPath, run.stderrPath, run.settingsPath, run.resultPath]),
        beforeFingerprints,
      );
    }
    writeJsonAtomic(run.resultPath, result);
    return result;
  };
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

function reportUnavailable(writeResult, opts, run) {
  const result = writeResult({
    status: "claude_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: gitTouchedFiles(opts.cd),
  });
  printSummary(result, run.resultPath);
  process.stderr.write("relay: `claude` not found on PATH. Install Claude Code and run `claude auth login`.\n");
  process.exit(127);
}

function dispatch(opts, brief, launcher, env, run, state, writeResult) {
  let child;
  try {
    const spec = launchSpec(launcher, buildArgv(opts, run), env);
    child = spawn(spec.command, spec.argv, {
      cwd: opts.cd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (error) {
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage: state.finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      error: error && error.message ? error.message : String(error),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
    return;
  }

  const stdoutDecoder = new StringDecoder("utf8");
  const scan = makeEventScanner((event) => handleEvent(event, state, run));
  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
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

  for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signalName, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      child.once("exit", () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      killChild(child);
      const exitCode = 128 + (osConstants.signals[signalName] || 15);
      const fields = () => ({
        status: "aborted",
        exitCode,
        signal: signalName,
        finalMessage: state.finalMessage,
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail(run.stderrPath),
        error: `the relay was killed by ${signalName}; claude was terminated with it — inspect the working tree before re-dispatching`,
      });
      const result = writeResult(fields());
      printSummary(result, run.resultPath);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // Claude may flush files and terminal metadata while handling SIGTERM.
        // Rebuild every dynamic field, especially touchedFiles/readOnlyViolation.
        writeResult(fields());
        process.exit(exitCode);
      }, 2000);
    });
  }

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const unavailable = error && error.code === "ENOENT";
    const result = writeResult({
      status: unavailable ? "claude_unavailable" : "failed",
      exitCode: unavailable ? 127 : 1,
      signal: null,
      finalMessage: state.finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(unavailable ? {} : { stderrTail: stderrTail(run.stderrPath) }),
      error: error && error.message ? error.message : String(error),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  child.on("close", (code, signalName) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    scan(stdoutDecoder.end());
    if (watchdogFired) killChild(child, "SIGKILL");

    const missingResult = !state.sawResult;
    const terminalError = state.resultIsError || missingResult;
    const succeeded = code === 0 && !watchdogFired && !terminalError;
    const mapped =
      code ??
      (signalName && osConstants.signals[signalName]
        ? 128 + osConstants.signals[signalName]
        : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const status = succeeded ? "completed" : watchdogFired ? "timeout" : "failed";
    let error = null;
    if (watchdogFired) {
      error = `claude did not finish within --timeout ${opts.timeout}; killed by the relay watchdog`;
    } else if (missingResult) {
      error = "claude exited without a terminal result event; inspect events.jsonl and stderr.txt";
    } else if (state.resultIsError) {
      error = `claude returned an error result${state.resultSubtype ? ` (${state.resultSubtype})` : ""}`;
    }
    const result = writeResult({
      status,
      exitCode,
      signal: signalName ?? null,
      finalMessage: state.finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail(run.stderrPath) }),
      ...(error ? { error } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });

  // A launch failure can surface on child and on its stdin. The child error
  // handler owns the outcome, so the pipe error is intentionally swallowed.
  child.stdin.on("error", () => {});
  child.stdin.end(brief);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  claude ${result.claudeVersion ?? "?"}`,
  );
  lines.push(`permission mode: ${result.permissionMode}  ·  shell sandbox: ${result.shellSandbox}`);
  if (result.dangerouslySkipPermissions) {
    lines.push("warning: bypassPermissions was explicitly enabled; direct file tools can reach beyond normal permission boundaries.");
  }
  if (result.readOnlyViolation === true) {
    lines.push("warning: a git-visible change was detected during this --read-only run; inspect the working tree immediately.");
  } else if (result.readOnlyViolation === null) {
    lines.push("warning: this --read-only tripwire had incomplete coverage; inspect the working tree directly.");
  }
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push("hint: the host killed claude (commonly an OOM killer or supervisor timeout); inspect the tree and host resources.");
  }
  if (result.resumed) lines.push("mode: resumed an existing Claude session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  if (result.resultSubtype) lines.push(`result subtype: ${result.resultSubtype}`);
  if (typeof result.numTurns === "number") lines.push(`turns: ${result.numTurns}`);
  if (typeof result.totalCostUsd === "number") lines.push(`cost: $${result.totalCostUsd}`);
  if (result.usage) {
    const input = result.usage.input_tokens ?? result.usage.inputTokens ?? "?";
    const output = result.usage.output_tokens ?? result.usage.outputTokens ?? "?";
    lines.push(`tokens: in ${input}, out ${output}`);
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
  lines.push("--- claude final report ---");
  lines.push(result.finalMessage || "(no final result text captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then land it from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  const briefBytes = Buffer.byteLength(brief, "utf8");
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.ceil(briefBytes / 1_000_000)}MB; Claude Code caps piped stdin at 10MB. Put large context in the workspace and reference it from a smaller brief.`);
  }

  const env = childEnvironment();
  const launcher = resolveClaudeLauncher(env, opts.cd);
  let run;
  try {
    run = prepareRun(opts, brief);
  } catch (error) {
    fail(`cannot prepare run artifacts: ${error && error.message ? error.message : String(error)}`);
  }
  // Capture after relay artifacts exist so an --out-dir inside the worktree does
  // not make the relay itself look like a read-only violation.
  const relayArtifacts = [run.briefPath, run.eventsPath, run.finalPath, run.stderrPath, run.settingsPath, run.resultPath];
  const beforeTree = opts.readOnly ? gitTripwireState(opts.cd, relayArtifacts) : null;
  // Working-tree and index state for paths that are ALREADY dirty. Their porcelain lines will not
  // move if the run edits them, so the line comparison above cannot see those writes on its own.
  const beforeFingerprints = opts.readOnly ? fingerprintDirtyPaths(opts.cd, relayArtifacts) : null;
  const version = launcher ? preflightVersion(launcher, env, opts.cd) : null;
  const state = {
    sessionId: opts.session,
    permissionMode: selectedPermissionMode(opts),
    sawResult: false,
    resultSubtype: null,
    resultIsError: false,
    finalMessage: "",
    numTurns: null,
    usage: null,
    totalCostUsd: null,
  };
  const writeResult = makeResultWriter(opts, version, run, state, beforeTree, beforeFingerprints);

  if (!launcher || version === null) {
    reportUnavailable(writeResult, opts, run);
    return;
  }
  dispatch(opts, brief, launcher, env, run, state, writeResult);
}

main();
