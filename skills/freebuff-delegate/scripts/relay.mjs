#!/usr/bin/env node
/**
 * delegate-skills · freebuff-delegate · relay.mjs
 *
 * Human-supervised bridge to the Freebuff interactive CLI.
 *
 * Freebuff does not expose a documented headless prompt flag. This relay therefore
 * never pastes or types the brief into the TUI. It saves the brief as handoff.md,
 * prints the handoff instructions, launches Freebuff with inherited terminal I/O,
 * and records the resulting Git worktree state after the user exits Freebuff.
 *
 * Trust posture: Node built-ins only. No network calls, credentials, telemetry,
 * prompt injection, private conversation scraping, or commits.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RESULT_VERSION = "delegate-relay.result.v1";
const MAX_TIMER_MS = 2_147_483_647;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DUR_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

function usage() {
  return `Usage: node relay.mjs --brief <file> [options]

Options:
  --brief <file>       Self-contained task brief; stdin is accepted when omitted.
  --cd <dir>           Target Git working tree (default: current directory).
  --lane <name>        Fleet lane name; Freebuff currently has no documented lane dials.
  --resume-last        Start Freebuff with --continue.
  --session <id>       Start Freebuff with --continue <id>.
  --timeout <dur>      Relay watchdog: 30m, 2h, 90s, etc.
  --confirm-human      Explicitly confirm a human will stay present and operate Freebuff.
  --skip-git-repo-check  Allow a non-Git directory (not recommended).
  --out-dir <dir>      Output directory for handoff.md and result.json.
  -h, --help           Show this help.

Important: Freebuff is interactive. This relay never injects the brief into Freebuff or provides a headless mode.
`;
}

function fail(message, code = 2) {
  process.stderr.write(`freebuff relay: ${message}\n`);
  process.exit(code);
}

function parseDuration(value) {
  const m = DUR_RE.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const seconds = BigInt(m[1] || 0) * 3600n + BigInt(m[2] || 0) * 60n + BigInt(m[3] || 0);
  const ms = seconds * 1000n;
  if (ms <= 0n || ms > BigInt(MAX_TIMER_MS)) return null;
  return Number(ms);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    lane: null,
    resumeLast: false,
    session: null,
    timeout: null,
    confirmHuman: false,
    skipGitRepoCheck: false,
    outDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) fail(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
        break;
      case "--brief":
        opts.brief = next();
        break;
      case "--cd":
        opts.cd = resolve(next());
        break;
      case "--lane":
        opts.lane = next();
        break;
      case "--resume-last":
        opts.resumeLast = true;
        break;
      case "--session":
        opts.session = next();
        break;
      case "--timeout":
        opts.timeout = next();
        break;
      case "--confirm-human":
        opts.confirmHuman = true;
        break;
      case "--skip-git-repo-check":
        opts.skipGitRepoCheck = true;
        break;
      case "--out-dir":
        opts.outDir = resolve(next());
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (opts.resumeLast && opts.session) fail("--resume-last and --session are mutually exclusive");
  if (opts.session && !SAFE_SESSION.test(opts.session)) fail("--session contains unsupported characters");
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`invalid --timeout ${opts.timeout}`);
  }
  if (!opts.confirmHuman) {
    fail("Freebuff is interactive; pass --confirm-human to explicitly confirm human supervision");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Freebuff requires an interactive TTY; piped/headless execution is intentionally unsupported");
  }
  return opts;
}

function readBrief(file) {
  if (file) {
    if (!existsSync(file)) fail(`brief file not found: ${file}`);
    return readFileSync(file, "utf8");
  }
  if (process.stdin.isTTY) fail("no --brief given; pass --brief <file> (stdin is reserved for Freebuff's TUI)");
  const value = readFileSync(0, "utf8");
  if (!value.trim()) fail("brief is empty");
  return value;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepo(cwd) {
  try {
    git(cwd, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}

function touchedFiles(cwd) {
  try {
    const raw = git(cwd, ["status", "--porcelain=v1", "-z"]);
    if (!raw) return [];
    const fields = raw.split("\0").filter(Boolean);
    return fields.map((field) => {
      const value = field.slice(3);
      if (value.includes(" -> ")) return value.split(" -> ")[1];
      return value;
    });
  } catch {
    return null;
  }
}

function freebuffVersion(env) {
  try {
    const result = spawnSync("freebuff", ["--version"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 10_000,
    });
    if (result.status === 0) return (result.stdout || result.stderr || "").trim() || null;
    return null;
  } catch {
    return null;
  }
}

function outputDir(requested) {
  const dir = requested || join(tmpdir(), `delegate-freebuff-${Date.now()}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeResult(dir, result) {
  const target = join(dir, "result.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

function killChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts.brief);
  if (!brief.trim()) fail("brief is empty");

  if (!existsSync(opts.cd)) fail(`working directory not found: ${opts.cd}`);
  if (!opts.skipGitRepoCheck && !isGitRepo(opts.cd)) fail(`not a Git working tree: ${opts.cd}`);

  const outDir = outputDir(opts.outDir);
  const handoff = join(outDir, "handoff.md");
  writeFileSync(handoff, brief, "utf8");

  const env = process.env;
  const version = freebuffVersion(env);
  if (!version) {
    const unavailable = {
      schema: RESULT_VERSION,
      status: "freebuff_unavailable",
      exitCode: 127,
      signal: null,
      freebuffVersion: null,
      sessionId: opts.session || null,
      finalMessage: "Freebuff was not found or did not answer `freebuff --version`.",
      touchedFiles: touchedFiles(opts.cd),
      handoffFile: handoff,
    };
    writeResult(outDir, unavailable);
    process.stderr.write(`freebuff relay: Freebuff unavailable. See ${handoff}\n`);
    process.exit(127);
  }

  if (opts.lane) {
    process.stderr.write(`freebuff relay: lane ${opts.lane} selected; Freebuff currently exposes no documented lane dials.\n`);
  }

  process.stdout.write(`\n=== Freebuff handoff ===\n`);
  process.stdout.write(`Brief saved to: ${handoff}\n`);
  process.stdout.write(`Before continuing, read/copy that brief into the Freebuff TUI yourself.\n`);
  process.stdout.write(`Human supervision is required for the entire Freebuff session.\n`);
  process.stdout.write(`Do not ask Freebuff to commit; the reviewer owns the commit.\n`);
  process.stdout.write(`========================\n\n`);

  const args = ["--cwd", opts.cd];
  if (opts.resumeLast) args.push("--continue");
  if (opts.session) args.push("--continue", opts.session);

  const child = spawn("freebuff", args, {
    cwd: opts.cd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  let timedOut = false;
  let abortSignal = null;
  let timer = null;
  if (opts.timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, parseDuration(opts.timeout));
  }

  const finish = (code, signal) => {
    if (timer) clearTimeout(timer);
    const status = timedOut ? "timeout" : (code === 0 ? "completed" : "failed");
    const result = {
      schema: RESULT_VERSION,
      status,
      exitCode: code,
      signal: signal || abortSignal || null,
      freebuffVersion: version,
      sessionId: opts.session || null,
      finalMessage: status === "completed"
        ? "Freebuff interactive session exited successfully. Review the Git diff; no machine-readable Freebuff final report was available to the relay."
        : `Freebuff interactive session exited with code ${code ?? "null"}. Review the Git diff and terminal output.`,
      touchedFiles: touchedFiles(opts.cd),
      handoffFile: handoff,
    };
    writeResult(outDir, result);
    process.stdout.write(`\nFreebuff relay result: ${join(outDir, "result.json")}\n`);
    process.exit(code ?? (signal ? 1 : 0));
  };

  process.on("SIGINT", () => {
    abortSignal = "SIGINT";
    killChild(child);
  });
  process.on("SIGTERM", () => {
    abortSignal = "SIGTERM";
    killChild(child);
  });
  child.on("exit", finish);
  child.on("error", (error) => {
    if (timer) clearTimeout(timer);
    const result = {
      schema: RESULT_VERSION,
      status: "freebuff_unavailable",
      exitCode: 127,
      signal: null,
      freebuffVersion: version,
      sessionId: opts.session || null,
      finalMessage: `Failed to launch Freebuff: ${error.message}`,
      touchedFiles: touchedFiles(opts.cd),
      handoffFile: handoff,
    };
    writeResult(outDir, result);
    process.exit(127);
  });
}

main();
