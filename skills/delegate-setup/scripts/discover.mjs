#!/usr/bin/env node
/**
 * discover.mjs — probe PATH for installed implementer CLIs.
 *
 * Usage:
 *   node discover.mjs           JSON report on stdout
 *   node discover.mjs --usage   same report, plus a `usage` field per discovered CLI:
 *                               { sessions, lastUsed } counted from that CLI's local
 *                               session store, or null where no probe is wired.
 *                               Metadata only — session entries are listed and stat'd,
 *                               never opened, because they hold the user's conversations.
 *   node discover.mjs --help
 *
 * Exit 0 even when nothing is installed. Exit 2 on usage errors.
 * Node built-ins only. Probed CLIs may contact their own services.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { IMPLEMENTERS } from "./implementers.mjs";

const PROBE_TIMEOUT_MS = 10_000;

const HELP = `discover.mjs — probe PATH for installed implementer CLIs

Usage:
  node discover.mjs
  node discover.mjs --usage
  node discover.mjs --help

Prints JSON:
  {
    "version": "delegate-discover.v1",
    "discovered": [ { key, skill, binary, version, path, authenticated, supports, models } ],
    "missing": [ { key, binary, skill } ]
  }

authenticated is true | false | null (null = unknown / no probe).
models.status is reported | aliases | unsupported | failed
(aliases = curated aliases from the registry, not a live listing).

--usage adds "usage" to each discovered entry:
  { "sessions": <int>, "lastUsed": <ISO-8601 | null> }, or null when no usage probe
  is wired or the CLI has no local state directory (null = unknown, not zero).
It counts session entries and reads their mtimes; it never opens a session file.
`;

function resolveBinary(binary) {
  const pathValue = process.env.PATH ?? process.env.Path;
  // A set-but-empty PATH is one empty component — the current directory — in
  // POSIX lookup, so spawn still resolves there and discovery must agree. Only
  // an absent PATH (spawn falls back to the system default path, never the
  // current directory) or an empty one on Windows reports nothing.
  if (pathValue === undefined || (pathValue === "" && process.platform === "win32")) return null;
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    // An empty component means the current directory in POSIX lookup, which is
    // where a relay's own spawn would find the binary. Dropping it made
    // discovery report a CLI as missing that dispatch can actually run.
    .map((entry) => (entry.length === 0 && process.platform !== "win32" ? "." : entry))
    .filter((entry) => entry.length > 0);

  if (process.platform === "win32") {
    const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
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

/** Expand ~ and %VAR% in a registry `locate` candidate, then normalize separators. */
function expandCandidate(raw) {
  const expanded = raw
    .replace(/^~(?=\/)/, homedir())
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] || "");
  return expanded.split("/").join(sep);
}

/**
 * Resolve one implementer to a launch descriptor: PATH first, exactly as every
 * sibling behaves, then the registry's `locate` candidates. The fallback exists
 * for CLIs that ship inside a desktop app instead of on PATH (ZCode), and is
 * consulted only when the binary is genuinely absent, so no existing
 * implementer's behaviour changes. `prefixArgs` is empty for a plain binary and
 * carries the bundle path when a launcher (node) runs it.
 */
function resolveLaunch(impl) {
  if (impl.key === "commandcode" && process.env.COMMANDCODE_BIN) {
    const configured = process.env.COMMANDCODE_BIN;
    if (process.platform === "win32" && !isAbsolute(configured)) return null;
    const command = /[\\/]/.test(configured) ? resolve(configured) : resolveBinary(configured);
    if (!command) return null;
    try {
      const comspec = process.env.ComSpec || process.env.COMSPEC;
      if (
        process.platform === "win32" &&
        comspec &&
        realpathSync.native(command).toLowerCase() === realpathSync.native(comspec).toLowerCase()
      ) return null;
      if (statSync(command).isFile()) return { path: command, command, prefixArgs: [] };
    } catch {
      // report it missing below
    }
    return null;
  }
  if (process.platform === "win32" && impl.key === "commandcode") {
    const command = resolveBinary("cmdc");
    return command ? { path: command, command, prefixArgs: [] } : null;
  }
  const onPath = resolveBinary(impl.binary);
  if (onPath) return { path: onPath, command: onPath, prefixArgs: [] };
  const candidates = impl.locate?.candidates?.[process.platform] ?? [];
  for (const raw of candidates) {
    const file = expandCandidate(raw);
    try {
      if (statSync(file).isFile()) {
        return { path: file, command: process.execPath, prefixArgs: [file] };
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

function needsWindowsShell(impl, launch) {
  // A node-launched bundle is a real executable and never needs the shell, even
  // for an implementer whose PATH binary would.
  if (launch.prefixArgs.length > 0) return false;
  return process.platform === "win32" && (impl.winShell || /\.(?:cmd|bat)$/i.test(launch.command));
}

/** Quote a path for cmd.exe when shell:true; reject metacharacters. */
function quoteForCmd(value) {
  if (/[\r\n%!]/.test(value) || value.includes('"')) {
    throw new Error(`unsafe path for Windows shell probe: ${value}`);
  }
  return `"${value}"`;
}

function runProbe(launch, args, useShell) {
  const command = useShell ? quoteForCmd(launch.command) : launch.command;
  return execFileSync(command, [...launch.prefixArgs, ...args], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
  });
}

/** Probe output is colorized (opencode); patterns match the plain text. */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** spawnSync, not runProbe: success-path stderr matters (codex prints login status there). */
function captureProbe(launch, args, useShell) {
  try {
    const command = useShell ? quoteForCmd(launch.command) : launch.command;
    const result = spawnSync(command, [...launch.prefixArgs, ...args], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });
    const stdout = result.stdout || "";
    return {
      ok: !result.error && result.status === 0,
      stdout,
      output: stripAnsi(`${stdout}${result.stderr || ""}`),
    };
  } catch {
    return { ok: false, stdout: "", output: "" };
  }
}

function probeVersion(impl, launch) {
  const useShell = needsWindowsShell(impl, launch);
  const tryArgs = (versionArgs) => {
    try {
      const raw = runProbe(launch, versionArgs, useShell);
      const firstLine = raw.trim().split(/\r?\n/, 1)[0].trim();
      if (!firstLine) return null;
      if (impl.versionFormat !== "colon-prefix") return firstLine;
      return /^([^:\s]+):/.exec(firstLine)?.[1] ?? firstLine;
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

function readAuthField(raw, jsonField) {
  try {
    const field = JSON.parse(raw)[jsonField];
    return typeof field === "boolean" ? field : null;
  } catch {
    return null;
  }
}

function probeAuth(impl, launch, captured = null) {
  if (!impl.authProbe) return null;
  const { args, jsonField, successPattern, failPattern, missMeansFalse } = impl.authProbe;
  const useShell = needsWindowsShell(impl, launch);

  if (jsonField) {
    try {
      return readAuthField(runProbe(launch, args, useShell), jsonField);
    } catch (error) {
      const combined = `${error.stdout || ""}${error.stderr || ""}`;
      if (combined.trim()) {
        const parsed = readAuthField(combined, jsonField);
        if (parsed !== null) return parsed;
      }
      return null;
    }
  }

  const { ok, output } = captured || captureProbe(launch, args, useShell);
  // failPattern first: "not logged in" also contains "logged in".
  if (failPattern && failPattern.test(output)) return false;
  if (successPattern) {
    if (successPattern.test(output)) return true;
    // Only a clean run can mean logged out, and only where the probe says absence is proof;
    // elsewhere a reworded CLI would read as a confident false.
    return ok && missMeansFalse ? false : null;
  }
  return ok ? true : null;
}

function modelResult(identifiers, status = "reported") {
  const unique = [...new Set(identifiers)].filter(Boolean);
  return {
    status,
    values: unique.slice(0, 200),
    truncated: unique.length > 200,
  };
}

function failedModels() {
  return { status: "failed", values: [], truncated: false };
}

function parseModelLines(raw, format) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let identifiers;
  if (format === "cursor") {
    identifiers = lines
      .filter((line) => line !== "Available models" && !line.startsWith("Tip:"))
      .map((line) => line.split(/\s+-\s+/, 1)[0]);
  } else if (format === "grok") {
    identifiers = lines
      .filter((line) => line.startsWith("* "))
      .map((line) => line.slice(2).replace(/\s*\(default\)$/, "").trim());
  } else if (format === "commandcode") {
    // "vendor/name  description" rows, grouped under plain-text section headers and a
    // count line. A slash in the first column is what separates a model row from those.
    identifiers = lines
      .map((line) => line.split(/\s+/, 1)[0])
      .filter((first) => first.includes("/"));
  } else if (format === "table") {
    identifiers = lines
      .slice(1)
      .map((line) => line.split(/\s+/))
      .filter((columns) => columns.length >= 2)
      .map((columns) => `${columns[0]}/${columns[1]}`);
  } else {
    identifiers = lines;
  }
  return modelResult(identifiers);
}

/** Parses the "codex-cache" file shape; only the slugs leave the parser. */
function parseModelCache(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failedModels();
  }
  if (!Array.isArray(parsed?.models)) return failedModels();
  return modelResult(
    parsed.models.map((entry) => (typeof entry?.slug === "string" ? entry.slug : "")),
  );
}

/** $CODEX_HOME-style override, else the subdirectory under the user's home. */
function modelFilePath(probe) {
  const base = process.env[probe.envDir] || join(homedir(), probe.homeSubdir);
  return join(base, probe.file);
}

function probeModels(impl, launch, captured = null) {
  const probe = impl.modelProbe;
  if (!probe) {
    return { status: "unsupported", values: [], truncated: false };
  }
  if (probe.static) {
    return modelResult(probe.static, "aliases");
  }
  if (probe.file) {
    try {
      return parseModelCache(readFileSync(modelFilePath(probe), "utf8"));
    } catch {
      // No cache until the CLI has run once; that is not a discovery failure worth throwing on.
      return failedModels();
    }
  }
  if (captured) {
    return captured.ok ? parseModelLines(captured.stdout, probe.format) : failedModels();
  }
  try {
    const raw = runProbe(launch, probe.args, needsWindowsShell(impl, launch));
    return parseModelLines(raw, probe.format);
  } catch {
    return failedModels();
  }
}

/** Session containers under `base`; "*" matches any directory at that level. */
function usageContainers(base, path) {
  let dirs = [base];
  for (const segment of path) {
    const next = [];
    for (const dir of dirs) {
      for (const entry of readEntries(dir)) {
        if (!entry.isDirectory()) continue;
        if (segment !== "*" && entry.name !== segment) continue;
        next.push(join(dir, entry.name));
      }
    }
    dirs = next;
  }
  return dirs;
}

function readEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * How much the user works in this CLI, from directory listings and mtimes only.
 * Session files hold the user's conversations; none of them is ever opened.
 */
function probeUsage(impl) {
  const probe = impl.usageProbe;
  if (!probe) return null;
  const base = (probe.envDir && process.env[probe.envDir]) || join(homedir(), probe.homeSubdir);
  try {
    if (!statSync(base).isDirectory()) return null;
  } catch {
    // No state directory at all: unknown, not zero.
    return null;
  }

  let sessions = 0;
  let lastUsed = 0;
  for (const dir of usageContainers(base, probe.path)) {
    for (const entry of readEntries(dir)) {
      if (probe.entry !== "any" && entry.isDirectory() !== (probe.entry === "dir")) continue;
      if (!probe.match.test(entry.name)) continue;
      sessions += 1;
      const entryPath = join(dir, entry.name);
      try {
        lastUsed = Math.max(lastUsed, statSync(entryPath).mtimeMs);
        if (entry.isDirectory()) {
          // A directory's mtime does not advance when a file inside it grows, so a
          // resumed session would read as abandoned; stat the children too (never open them).
          for (const child of readEntries(entryPath)) {
            lastUsed = Math.max(lastUsed, statSync(join(entryPath, child.name)).mtimeMs);
          }
        }
      } catch {
        // Entry vanished mid-scan; the count still holds.
      }
    }
  }
  return { sessions, lastUsed: lastUsed > 0 ? new Date(lastUsed).toISOString() : null };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const withUsage = argv.includes("--usage");
  if (argv.some((arg) => arg !== "--usage")) {
    process.stderr.write("discover.mjs: unexpected arguments. Use --help.\n");
    process.exit(2);
  }

  const discovered = [];
  const missing = [];

  for (const impl of IMPLEMENTERS) {
    const launch = resolveLaunch(impl);
    if (!launch) {
      missing.push({ key: impl.key, binary: impl.binary, skill: impl.skill });
      continue;
    }
    const version = probeVersion(impl, launch);
    const authArgs = impl.authProbe && !impl.authProbe.jsonField ? impl.authProbe.args : null;
    const modelArgs = impl.modelProbe?.args;
    const sharedCapture =
      authArgs &&
      modelArgs &&
      authArgs.length === modelArgs.length &&
      authArgs.every((arg, index) => arg === modelArgs[index])
        ? captureProbe(launch, authArgs, needsWindowsShell(impl, launch))
        : null;
    const entry = {
      key: impl.key,
      skill: impl.skill,
      binary: impl.binary,
      version,
      path: launch.path,
      authenticated: probeAuth(impl, launch, sharedCapture),
      supports: [...impl.supports],
      models: probeModels(impl, launch, sharedCapture),
    };
    if (withUsage) entry.usage = probeUsage(impl);
    discovered.push(entry);
  }

  process.stdout.write(
    `${JSON.stringify({ version: "delegate-discover.v1", discovered, missing }, null, 2)}\n`,
  );
}

main(process.argv.slice(2));
