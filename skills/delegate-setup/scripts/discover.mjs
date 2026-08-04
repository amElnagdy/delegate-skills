#!/usr/bin/env node
/**
 * discover.mjs — probe PATH for installed implementer CLIs.
 *
 * Usage:
 *   node discover.mjs           JSON report on stdout
 *   node discover.mjs --help
 *
 * Exit 0 even when nothing is installed. Exit 2 on usage errors.
 * Node built-ins only. Probed CLIs may contact their own services.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { IMPLEMENTERS } from "./implementers.mjs";

const PROBE_TIMEOUT_MS = 10_000;
/** Generous for a version banner or model list, and bounded for a changelog dump. */
const PROBE_MAX_BUFFER = 8 * 1024 * 1024;

const HELP = `discover.mjs — probe PATH for installed implementer CLIs

Usage:
  node discover.mjs
  node discover.mjs --help

Prints JSON:
  {
    "version": "delegate-discover.v1",
    "discovered": [ { key, skill, binary, version, path, authenticated, supports, models } ],
    "missing": [ { key, binary, skill } ]
  }

authenticated is true | false | null (null = unknown / no probe).
models.status is reported | unsupported | failed.
`;

function resolveBinary(binary) {
  const pathValue = process.env.PATH || process.env.Path || "";
  if (!pathValue) return null;
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
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

function needsWindowsShell(impl, binaryPath) {
  // impl.winShell describes how the RELAYS launch: they spawn a bare name and
  // need the shell to find a .cmd shim. Discovery already resolved a full path,
  // so only a real .cmd/.bat needs cmd.exe here - routing a native .exe through
  // the shell would put every install path through quoteForCmd, which rejects
  // the % and ! that are legal in Windows directory names.
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath);
}

/** Quote a path for cmd.exe when shell:true; reject metacharacters. */
function quoteForCmd(value) {
  if (/[\r\n%!]/.test(value) || value.includes('"')) {
    throw new Error(`unsafe path for Windows shell probe: ${value}`);
  }
  return `"${value}"`;
}

function runProbe(binaryPath, args, useShell) {
  const command = useShell ? quoteForCmd(binaryPath) : binaryPath;
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    // Without this the timeout is advisory: the default SIGTERM never escalates
    // for a CLI that traps it for graceful shutdown, and spawnSync keeps
    // blocking until the child decides to exit.
    killSignal: "SIGKILL",
    // Some version probes are inherently unbounded (agy's is `changelog`), and
    // the 1 MiB default throws ENOBUFS, discarding a version that was on line 1.
    maxBuffer: PROBE_MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
  });
}

function probeVersion(impl, binaryPath) {
  const useShell = needsWindowsShell(impl, binaryPath);
  const firstVersion = (raw) => {
    const firstLine = (raw || "").trim().split(/\r?\n/, 1)[0].trim();
    if (!firstLine) return null;
    if (impl.versionFormat !== "colon-prefix") return firstLine;
    return /^([^:\s]+):/.exec(firstLine)?.[1] ?? firstLine;
  };
  const tryArgs = (versionArgs) => {
    try {
      return firstVersion(runProbe(binaryPath, versionArgs, useShell));
    } catch (error) {
      // An over-large or timed-out probe still wrote the bytes we need: the
      // version is on the first line. Recover it from the partial stdout rather
      // than reporting null, which is indistinguishable from a broken install.
      return typeof error.stdout === "string" ? firstVersion(error.stdout) : null;
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

function probeAuth(impl, binaryPath) {
  if (!impl.authProbe) return null;
  const useShell = needsWindowsShell(impl, binaryPath);
  try {
    const raw = runProbe(binaryPath, impl.authProbe.args, useShell);
    if (impl.authProbe.jsonField) {
      return readAuthField(raw, impl.authProbe.jsonField);
    }
    return true;
  } catch (error) {
    if (impl.authProbe.jsonField) {
      // Parse the streams separately. Concatenating them meant a single line of
      // unrelated stderr - an update notice, a Node warning - made the whole
      // string invalid JSON, degrading a real `false` into "unknown". The
      // logged-out answer arrives on a non-zero exit, so this is the common path.
      for (const stream of [error.stdout, error.stderr]) {
        if (typeof stream !== "string" || !stream.trim()) continue;
        const parsed = readAuthField(stream, impl.authProbe.jsonField);
        if (parsed !== null) return parsed;
      }
      return null;
    }
    return null;
  }
}

function parseModelLines(raw, format) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const identifiers =
    format === "cursor"
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
  if (!impl.modelProbe) {
    return { status: "unsupported", values: [], truncated: false };
  }
  try {
    const raw = runProbe(
      binaryPath,
      impl.modelProbe.args,
      needsWindowsShell(impl, binaryPath),
    );
    return parseModelLines(raw, impl.modelProbe.format);
  } catch {
    return { status: "failed", values: [], truncated: false };
  }
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv.length > 0) {
    process.stderr.write("discover.mjs: unexpected arguments. Use --help.\n");
    process.exit(2);
  }

  const discovered = [];
  const missing = [];

  for (const impl of IMPLEMENTERS) {
    const binaryPath = resolveBinary(impl.binary);
    if (!binaryPath) {
      missing.push({ key: impl.key, binary: impl.binary, skill: impl.skill });
      continue;
    }
    discovered.push({
      key: impl.key,
      skill: impl.skill,
      binary: impl.binary,
      version: probeVersion(impl, binaryPath),
      path: binaryPath,
      authenticated: probeAuth(impl, binaryPath),
      supports: [...impl.supports],
      models: probeModels(impl, binaryPath),
    });
  }

  process.stdout.write(
    `${JSON.stringify({ version: "delegate-discover.v1", discovered, missing }, null, 2)}\n`,
  );
}

main(process.argv.slice(2));
