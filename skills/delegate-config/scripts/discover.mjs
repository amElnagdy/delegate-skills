#!/usr/bin/env node

/**
 * discover.mjs — probes PATH for installed implementer CLIs.
 *
 * Outputs a JSON report listing every installed implementer CLI with its
 * version, path, authentication status, and supported config fields.
 *
 * Usage:
 *   node discover.mjs              JSON report to stdout
 *   node discover.mjs --help       Show this help
 *
 * Exit codes:
 *   0   Report written (even if nothing is installed)
 *   2   Usage error
 *
 * Node built-ins only — no dependencies, direct network calls, credential
 * access, or telemetry. Probed CLIs may contact their own services.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";

// ── CLI table ──────────────────────────────────────────────────────────────────
//
// Each entry maps a human-facing implementer name to the binary the relay
// resolves on PATH, the version probe command, an optional auth probe, and the
// config fields the relay can consume.

const IMPLEMENTERS = [
  {
    name: "claude",
    binary: "claude",
    versionArgs: ["--version"],
    authProbe: { args: ["auth", "status"], jsonField: "loggedIn" },
    supports: ["model", "effort", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: null,
    shell: false,  // native binary (launcher resolves .cmd on win32)
  },
  {
    name: "codex",
    binary: "codex",
    versionArgs: ["--version"],
    authProbe: null,  // no headless auth check
    supports: ["model", "sandbox", "effort", "timeout", "readOnly"],
    modelFlag: "-m",
    modelProbe: null,
    shell: true,  // needs shell:true on win32 for .cmd shim
  },
  {
    name: "opencode",
    binary: "opencode",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["model", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: { args: ["models"], format: "lines" },
    shell: true,
  },
  {
    name: "agy",
    binary: "agy",
    versionArgs: ["changelog"],
    authProbe: null,
    supports: ["model", "timeout"],
    modelFlag: "--model",
    modelProbe: { args: ["models"], format: "lines" },
    shell: false,
  },
  {
    name: "grok",
    binary: "grok",
    versionArgs: ["version"],
    versionFallbackArgs: ["--version"],
    authProbe: null,
    supports: ["model", "sandbox", "effort", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: null,
    shell: true,
  },
  {
    name: "kimi",
    binary: "kimi",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["model", "timeout"],
    modelFlag: "-m",
    modelProbe: null,
    shell: false,
  },
  {
    name: "qodercli",
    binary: "qodercli",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["model", "permissionMode", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: null,
    shell: false,
  },
  {
    name: "vibe",
    binary: "vibe",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["timeout", "readOnly"],  // vibe relay does not pass --model
    modelFlag: null,
    modelProbe: null,
    shell: false,
  },
  {
    name: "cursor-agent",
    binary: "cursor-agent",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["model", "sandbox", "force", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: { args: ["--list-models"], format: "cursor" },
    shell: true,  // win32 uses shell:true + execSync
  },
  {
    name: "pi",
    binary: "pi",
    versionArgs: ["--version"],
    authProbe: null,
    supports: ["provider", "model", "timeout", "readOnly"],
    modelFlag: "--model",
    modelProbe: null,
    shell: true,
  },
];

// ── Help ───────────────────────────────────────────────────────────────────────

const HELP = `\
discover.mjs — probe PATH for installed implementer CLIs

Usage:
  node discover.mjs              JSON report to stdout
  node discover.mjs --help       Show this help

Output shape (JSON):
  {
    "discovered": [
      {
        "name":          "<implementer name>",
        "binary":        "<CLI binary name>",
        "version":       "<version string or null>",
        "path":          "<resolved binary path or null>",
        "authenticated": <true | false | null>,
        "supports":      ["model", "sandbox", ...],
        "modelFlag":     "<flag the relay uses, or null>",
        "models":        {"status":"reported|unsupported|failed","values":[],"truncated":false}
      }
    ],
    "missing": ["<binary>", ...]
  }
`;

// ── Argument parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.length > 0) {
  process.stderr.write("discover.mjs: unexpected arguments. Use --help for usage.\n");
  process.exit(2);
}

// ── Binary resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a binary name to its absolute path on PATH. Mirrors the approach
 * used by the relay scripts: walk PATH entries, check file existence and
 * executability. On win32, also check PATHEXT extensions (.cmd, .bat, .exe).
 *
 * @param {string} binary  The binary name to search for.
 * @returns {string|null}  Absolute path to the binary, or null if not found.
 */
function resolveBinary(binary) {
  const pathValue = process.env.PATH || process.env.Path || "";
  if (!pathValue) return null;

  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"));

  if (process.platform === "win32") {
    const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);

    for (const entry of pathEntries) {
      const dir = resolve(entry || ".");
      for (const ext of pathExt) {
        const candidate = join(dir, `${binary}${ext}`);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // Not here — keep looking.
        }
      }
    }
    return null;
  }

  // POSIX
  for (const entry of pathEntries) {
    const candidate = join(resolve(entry || "."), binary);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here — keep looking.
    }
  }
  return null;
}

// ── Version probing ────────────────────────────────────────────────────────────

const PROBE_TIMEOUT = 10_000; // 10 seconds

/**
 * Run the version command for an implementer and return the version string.
 *
 * @param {object} impl  An entry from IMPLEMENTERS.
 * @returns {string|null}  Version string, or null if the probe failed.
 */
function needsWindowsShell(impl, binaryPath) {
  return process.platform === "win32" &&
    (impl.shell || /\.(?:cmd|bat)$/i.test(binaryPath));
}

function probeVersion(impl, binaryPath) {
  const useShell = needsWindowsShell(impl, binaryPath);

  const tryArgs = (versionArgs) => {
    try {
      const raw = execFileSync(binaryPath, versionArgs, {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
      });
      return raw.trim().split("\n")[0].trim() || null;
    } catch {
      return null;
    }
  };

  let version = tryArgs(impl.versionArgs);
  if (version === null && impl.versionFallbackArgs) {
    version = tryArgs(impl.versionFallbackArgs);
  }
  return version;
}

// ── Auth probing ───────────────────────────────────────────────────────────────

/**
 * Check authentication status for an implementer CLI.
 *
 * @param {object} impl  An entry from IMPLEMENTERS.
 * @returns {boolean|null}  true if authenticated, false if not, null if
 *                          the CLI has no auth probe or the check failed.
 */
function probeAuth(impl, binaryPath) {
  if (!impl.authProbe) return null;

  const useShell = needsWindowsShell(impl, binaryPath);
  try {
    const raw = execFileSync(binaryPath, impl.authProbe.args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });
    if (impl.authProbe.jsonField) {
      return JSON.parse(raw)[impl.authProbe.jsonField] === true;
    }
    return impl.authProbe.successPattern.test(raw);
  } catch (err) {
    // Some CLIs exit non-zero when not authenticated but still print a
    // message. Check stderr and stdout from the error.
    const combined = `${err.stdout || ""}${err.stderr || ""}`;
    if (combined && impl.authProbe.successPattern?.test(combined)) return true;
    return false;
  }
}

function parseModelLines(raw, format) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const identifiers = format === "cursor"
    ? lines
        .filter((line) => line !== "Available models" && !line.startsWith("Tip:"))
        .map((line) => line.split(/\s+-\s+/, 1)[0])
    : lines;
  const unique = [...new Set(identifiers)].filter(Boolean);
  return {
    status: "reported",
    values: unique.slice(0, 200),
    truncated: unique.length > 200,
  };
}

function probeModels(impl, binaryPath) {
  if (!impl.modelProbe) return { status: "unsupported", values: [], truncated: false };
  try {
    const raw = execFileSync(binaryPath, impl.modelProbe.args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsWindowsShell(impl, binaryPath),
    });
    return parseModelLines(raw, impl.modelProbe.format);
  } catch {
    return { status: "failed", values: [], truncated: false };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

const discovered = [];
const missing = [];

for (const impl of IMPLEMENTERS) {
  const binaryPath = resolveBinary(impl.binary);

  if (!binaryPath) {
    missing.push(impl.binary);
    continue;
  }

  const version = probeVersion(impl, binaryPath);
  const authenticated = probeAuth(impl, binaryPath);
  const models = probeModels(impl, binaryPath);

  discovered.push({
    name: impl.name,
    binary: impl.binary,
    version,
    path: binaryPath,
    authenticated,
    supports: impl.supports,
    modelFlag: impl.modelFlag,
    models,
  });
}

const report = { discovered, missing };
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
