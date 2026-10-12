#!/usr/bin/env node
/**
 * CodeBuddy Delegate Relay
 * Wraps `codebuddy -p`, captures the run, and writes a structured result.json
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, accessSync, constants as fsConstants, statSync } from 'node:fs';
import { join, resolve, dirname, delimiter, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, '..');

// Result schema version
const RESULT_SCHEMA = 'delegate-relay.result.v1';

/** Resolve a binary on PATH, handling Windows extensions. */
function resolveBinary(binary) {
  const pathValue = process.env.PATH ?? process.env.Path;
  if (pathValue === undefined || (pathValue === '' && process.platform === 'win32')) return null;
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, '$1'))
    .map((entry) => (entry.length === 0 && process.platform !== 'win32' ? '.' : entry))
    .filter((entry) => entry.length > 0);

  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);
    for (const entry of pathEntries) {
      const dir = resolve(entry);
      for (const ext of pathExt) {
        const candidate = join(dir, `${binary}${ext}`);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }
    return null;
  }

  for (const entry of pathEntries) {
    const candidate = join(resolve(entry), binary);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    brief: null,
    model: null,
    cd: process.cwd(),
    lane: null,
    readOnly: false,
    resumeLast: false,
    session: null,
    timeout: null,
    outDir: null,
    noAuto: false,
    effort: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--brief' && i + 1 < args.length) {
      opts.brief = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      opts.model = args[++i];
    } else if (arg === '--effort' && i + 1 < args.length) {
      opts.effort = args[++i];
    } else if (arg === '--cd' && i + 1 < args.length) {
      opts.cd = resolve(args[++i]);
    } else if (arg === '--lane' && i + 1 < args.length) {
      opts.lane = args[++i];
    } else if (arg === '--read-only') {
      opts.readOnly = true;
    } else if (arg === '--resume-last') {
      opts.resumeLast = true;
    } else if (arg === '--session' && i + 1 < args.length) {
      opts.session = args[++i];
    } else if (arg === '--timeout' && i + 1 < args.length) {
      opts.timeout = args[++i];
    } else if (arg === '--out-dir' && i + 1 < args.length) {
      opts.outDir = resolve(args[++i]);
    } else if (arg === '--no-auto') {
      opts.noAuto = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (!arg.startsWith('-')) {
      // Positional brief file (stdin fallback handled later)
      if (!opts.brief) opts.brief = arg;
    }
  }
  if (opts.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:@~\/#-]*$/.test(opts.model)) {
    fail('--model contains unsupported characters');
  }
  if (opts.effort !== null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) {
    fail(`invalid --effort "${opts.effort}"`);
  }
  if (opts.readOnly && opts.noAuto) fail('--read-only cannot be combined with --no-auto');
  return opts;
}

function printHelp() {
  console.log(`
CodeBuddy Delegate Relay

Usage:
  node relay.mjs --brief <file> --model <model> [options]

Required (fresh run):
  --brief <file>     Brief file (or '-' for stdin)
  --model <name>     Model name (e.g., gpt-5, gpt-4o-mini)
  --cd <dir>         Working directory (default: cwd)

Optional:
  --lane <name>           Fleet lane from delegate-setup config
  --read-only             Read-only/review mode (CodeBuddy plan permission mode)
  --effort <level>        Reasoning effort (minimal, low, medium, high, xhigh, max)
  --resume-last           Continue most recent session
  --session <id>          Continue specific session ID
  --timeout <dur>         Watchdog timeout (e.g., 30m, 2h)
  --out-dir <dir>         Artifact output directory (default: temp dir)
  --no-auto               Don't auto-approve file operations (-y)
  --help                  Show this help
`);
}

/** Resolve a fleet lane and return its dials. */
async function resolveLane(opts) {
  if (!opts.lane) return opts;
  try {
    const { stdout } = await runCommand('node', [
      join(dirname(SKILL_DIR), 'delegate-setup', 'scripts', 'lane.mjs'),
      'resolve',
      '--cwd', opts.cd,
      '--lane', opts.lane,
      '--implementer', 'workbuddy',
    ]);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const resolved = JSON.parse(lines[lines.length - 1]);
    // Apply lane dials if not explicitly overridden
    if (resolved.dials) {
      if (!opts.model && resolved.dials.model) opts.model = resolved.dials.model;
      if (!opts.effort && resolved.dials.effort) opts.effort = resolved.dials.effort;
      if (!opts.timeout && resolved.dials.timeout) opts.timeout = resolved.dials.timeout;
      if (!opts.readOnly && resolved.dials.readOnly) opts.readOnly = resolved.dials.readOnly;
    }
    return opts;
  } catch (e) {
    console.error(`Failed to resolve lane '${opts.lane}':`, e.message);
    process.exit(2);
  }
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return null;
  const total = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
  return total > 0 && total <= 2_147_483_647 ? total : null;
}

function readBrief(path) {
  if (!path || path === '-') {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data));
    });
  }
  return Promise.resolve(readFileSync(path, 'utf8'));
}

async function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(cmd, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows, // Use shell on Windows to handle .cmd files
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function killChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* CodeBuddy may prefix diagnostics. */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function gitStatus(cwd) {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

async function getCodebuddyVersion() {
  const codebuddyPath = resolveBinary('codebuddy');
  if (!codebuddyPath) return null;
  try {
    const { stdout } = await runCommand(codebuddyPath, ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

function buildCodebuddyArgs(opts, isResume) {
  const args = [];

  // Model is required on fresh run
  if (!isResume && opts.model) {
    args.push('--model', opts.model);
  }

  // Print mode (non-interactive)
  args.push('-p', '--output-format', 'json');

  // Auto-approve file operations unless --no-auto or read-only
  if (!opts.noAuto && !opts.readOnly) {
    args.push('-y');
  }

  // CodeBuddy's native plan permission mode is the read-only mapping.
  if (opts.readOnly) args.push('--permission-mode', 'plan');
  if (opts.effort) args.push('--effort', opts.effort);

  // Resume flags
  if (opts.resumeLast) {
    args.push('-c');
  } else if (opts.session) {
    args.push('-r', opts.session);
  }

  // Sandbox, additional dirs, etc. could be added here via lane config

  return args;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve fleet lane if specified
  await resolveLane(opts);
  if (!opts.model && !opts.resumeLast && !opts.session) {
    console.error('Error: --model is required on a fresh run (or configure it on --lane)');
    process.exit(2);
  }

  // Read brief early to validate
  const briefContent = await readBrief(opts.brief);
  if (!briefContent || !briefContent.trim()) {
    console.error('Error: Brief is empty');
    process.exit(2);
  }

  const outDir = opts.outDir || join(tmpdir(), `codebuddy-delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(outDir, { recursive: true });
  const briefPath = join(outDir, 'brief.txt');
  const eventsPath = join(outDir, 'events.jsonl');
  const finalPath = join(outDir, 'final.txt');
  writeFileSync(briefPath, briefContent);
  writeFileSync(eventsPath, '');
  const startedAt = new Date().toISOString();
  const beforeGitStatus = gitStatus(opts.cd);

  // Resolve codebuddy binary path
  const codebuddyPath = resolveBinary('codebuddy');
  if (!codebuddyPath) {
    const result = {
      schema: RESULT_SCHEMA,
      tool: 'workbuddy',
      status: 'codebuddy_unavailable',
      exitCode: 127,
      signal: null,
      codebuddyVersion: null,
      agent: null,
      sessionId: null,
      finalMessage: '',
      touchedFiles: null,
      cost: null,
      briefPath,
      eventsPath,
      finalPath,
      workdir: opts.cd,
      model: opts.model || null,
      effort: opts.effort || null,
      auto: !opts.noAuto && !opts.readOnly,
      readOnly: opts.readOnly,
      readOnlyViolation: null,
      resumed: opts.resumeLast || !!opts.session,
      resumeLast: opts.resumeLast,
      startedAt,
      finishedAt: new Date().toISOString(),
      stderrTail: 'codebuddy not found on PATH',
      error: 'codebuddy binary not found. Install it and run `codebuddy` to authenticate.',
    };
    writeResult(outDir, result);
    process.exit(127);
  }

  // Get version for reporting
  const codebuddyVersion = await getCodebuddyVersion();
  let watchdogTimer = null;
  let timedOut = false;

  // Build codebuddy command
  const isResume = opts.resumeLast || !!opts.session;
  const cbArgs = buildCodebuddyArgs(opts, isResume);

  // For multi-line briefs, use stdin
  // Launch codebuddy
  let child;
  try {
    const isWindows = process.platform === 'win32';
    const spawnOptions = {
      cwd: opts.cd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }, // Disable color for cleaner parsing
      shell: isWindows, // Use shell on Windows to handle .cmd files
    };
    child = spawn(codebuddyPath, cbArgs, spawnOptions);
  } catch (e) {
    const result = buildResult({
      status: 'failed',
      exitCode: 1,
      codebuddyVersion,
      error: `Failed to spawn codebuddy: ${e.message}`,
      startedAt: new Date().toISOString(),
    }, opts, outDir, briefPath, eventsPath, finalPath);
    writeResult(outDir, result);
    process.exit(1);
  }

  // Text input is the documented non-interactive input channel. Always use it so
  // short briefs cannot be accidentally dropped from the command line.
  child.stdin.write(briefContent);
  child.stdin.end();

  // Watchdog
  const timeoutMs = parseDuration(opts.timeout);
  if (timeoutMs) {
    watchdogTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, 'SIGTERM');
    }, timeoutMs);
  }

  // Capture output
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());

  // Wait for completion
  const exitCode = await new Promise(resolve => child.on('close', resolve));

  if (watchdogTimer) clearTimeout(watchdogTimer);

  const finishedAt = new Date().toISOString();

  const parsed = parseJsonOutput(stdout);
  const sessionId = parsed?.session_id || parsed?.sessionId || parsed?.metadata?.session_id || parsed?.metadata?.sessionId || null;
  const finalMessage = parsed?.result || parsed?.response || parsed?.message || parsed?.finalMessage || stdout.trim();

  // Get touched files via git status
  const afterGitStatus = gitStatus(opts.cd);
  const touchedFiles = afterGitStatus === null
    ? null
    : afterGitStatus.trim() ? afterGitStatus.trim().split('\n') : [];
  const readOnlyViolation = opts.readOnly && beforeGitStatus !== null && afterGitStatus !== null
    ? beforeGitStatus !== afterGitStatus
    : null;

  // Preserve the raw response for debugging and review.
  writeFileSync(eventsPath, stdout);

  // Write final message
  writeFileSync(finalPath, typeof finalMessage === 'string' ? finalMessage : JSON.stringify(finalMessage, null, 2));

  // Determine status
  let status = 'completed';
  let signal = null;
  let error = null;

  if (timedOut) {
    status = 'timeout';
    error = `Watchdog timeout after ${opts.timeout}`;
  } else if (exitCode === 0) {
    status = 'completed';
  } else if (exitCode === 127) {
    status = 'codebuddy_unavailable';
  } else if (exitCode < 0) {
    status = 'aborted';
    signal = `SIG${(-exitCode).toString()}`;
  } else {
    status = 'failed';
    error = stderr.slice(-2000) || 'codebuddy exited with non-zero code';
  }

  const result = buildResult({
    status,
    exitCode: exitCode < 0 ? 128 + (-exitCode) : exitCode,
    signal,
    codebuddyVersion,
    sessionId,
    finalMessage: typeof finalMessage === 'string' ? finalMessage : JSON.stringify(finalMessage),
    touchedFiles,
    readOnlyViolation,
    effort: opts.effort || null,
    startedAt,
    finishedAt,
    stderrTail: stderr ? stderr.slice(-2000) : undefined,
    error,
  }, opts, outDir, briefPath, eventsPath, finalPath);

  writeResult(outDir, result);

  // Print summary
  console.log(`\n=== CodeBuddy Delegate Result ===`);
  console.log(`Status: ${result.status}`);
  console.log(`Exit code: ${result.exitCode}`);
  console.log(`Version: ${result.codebuddyVersion}`);
  console.log(`Session: ${result.sessionId || 'N/A'}`);
  console.log(`Model: ${result.model || 'N/A'}`);
  console.log(`Duration: ${Math.round((new Date(result.finishedAt) - new Date(result.startedAt)) / 1000)}s`);
  if (result.touchedFiles && result.touchedFiles.length > 0) {
    console.log(`Touched files: ${result.touchedFiles.length}`);
  }
  console.log(`Artifacts: ${outDir}`);
  console.log(`================================\n`);

  // Print final message
  if (result.finalMessage) {
    console.log('--- FINAL MESSAGE ---');
    console.log(result.finalMessage);
    console.log('--- END FINAL MESSAGE ---\n');
  }

  // Exit with codebuddy's exit code for wrapper scripts
  process.exit(result.exitCode);
}

function buildResult(core, opts, outDir, briefPath, eventsPath, finalPath) {
  return {
    schema: RESULT_SCHEMA,
    tool: 'workbuddy',
    ...core,
    agent: opts.readOnly ? 'review' : 'implement',
    model: opts.model || null,
    effort: opts.effort || null,
    readOnly: opts.readOnly,
    auto: !opts.noAuto && !opts.readOnly,
    resumed: opts.resumeLast || !!opts.session,
    resumeLast: opts.resumeLast,
    workdir: opts.cd,
    briefPath,
    eventsPath,
    finalPath,
    cost: null, // CodeBuddy doesn't report cost in CLI output
  };
}

function writeResult(outDir, result) {
  const resultPath = join(outDir, 'result.json');
  mkdirSync(outDir, { recursive: true });
  const tempPath = `${resultPath}.tmp-${process.pid}`;
  const serialized = JSON.stringify(result, null, 2);
  writeFileSync(tempPath, serialized);
  try {
    renameSync(tempPath, resultPath);
  } catch (error) {
    // Windows can reject replace-style renames when a scanner briefly holds the
    // destination. Keep the result contract intact with a direct fallback.
    if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
    try { unlinkSync(resultPath); } catch { /* destination may not exist */ }
    writeFileSync(resultPath, serialized);
    try { unlinkSync(tempPath); } catch { /* best effort cleanup */ }
  }
}

main().catch(err => {
  console.error('Relay error:', err);
  process.exit(1);
});
