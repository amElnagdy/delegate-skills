#!/usr/bin/env node
/**
 * lane.mjs — resolve a fleet lane for a relay (or print help).
 *
 * Usage:
 *   node lane.mjs resolve --cwd <dir> --lane <name> --implementer <key>
 *   node lane.mjs --help
 *
 * On success, prints JSON:
 *   { "lane", "source", "implementer", "skill", "dials": { ...relay-native fields } }
 *
 * `dials` uses field names the target relay understands (e.g. grok gets `autonomy`,
 * opencode gets `agent` for read-only). Relays apply dials only where a CLI flag
 * did not already set the field.
 *
 * Node built-ins only.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  IMPLEMENTER_BY_KEY,
  LANE_NAME,
} from "./implementers.mjs";
import { loadEffective } from "./config.mjs";

const HELP = `lane.mjs — resolve a delegate-fleet.v1 lane for a relay

Usage:
  node lane.mjs resolve --cwd <dir> --lane <name> --implementer <key>
  node lane.mjs --help
`;

function fail(message) {
  process.stderr.write(`lane.mjs: ${message}\n`);
  process.exit(2);
}

/**
 * Map a stored lane onto dials the named relay can apply directly.
 * @returns {{ lane: string, source: string, implementer: string, skill: string, dials: Record<string, unknown> }}
 */
export function resolveLaneForRelay(cwd, laneName, implementerKey) {
  if (!LANE_NAME.test(laneName)) {
    throw new Error(`invalid lane name ${JSON.stringify(laneName)}`);
  }
  if (IMPLEMENTER_BY_KEY[implementerKey] == null) {
    throw new Error(`unknown implementer ${JSON.stringify(implementerKey)}`);
  }
  const effective = loadEffective(cwd);
  const entry = effective.lanes[laneName];
  if (!entry) {
    throw new Error(`fleet lane not found: ${laneName}`);
  }
  const { source, implementer, ...rest } = entry;
  if (source === "project" && !effective.projectTrusted) {
    throw new Error(
      "project fleet config is not trusted; review and approve it with delegate-setup before dispatch",
    );
  }
  if (implementer !== implementerKey) {
    const bound = IMPLEMENTER_BY_KEY[implementer];
    throw new Error(
      `fleet lane "${laneName}" → ${implementer} (use ${bound.skill}); this relay is ${implementerKey}`,
    );
  }
  const dials = normalizeDials(implementerKey, rest);
  return {
    lane: laneName,
    source,
    implementer,
    skill: IMPLEMENTER_BY_KEY[implementer].skill,
    dials,
  };
}

function normalizeDials(implementerKey, raw) {
  const dials = { ...raw };
  if (implementerKey === "grok") {
    if (typeof dials.sandbox === "string") {
      const map = {
        workspace: "workspace-write",
        "read-only": "read-only",
        off: "full-access",
      };
      dials.autonomy = map[dials.sandbox] ?? dials.sandbox;
      delete dials.sandbox;
    }
    // Grok relay consumes autonomy, not readOnly.
    if (dials.readOnly === true) {
      if (dials.autonomy === undefined) dials.autonomy = "read-only";
      delete dials.readOnly;
    }
  }
  if (implementerKey === "codex" && dials.readOnly === true) {
    if (dials.sandbox === undefined) dials.sandbox = "read-only";
    delete dials.readOnly;
  }
  if (implementerKey === "opencode" && dials.readOnly === true) {
    dials.agent = "plan";
    delete dials.readOnly;
  }
  if (implementerKey === "qoder" && dials.readOnly === true) {
    if (dials.permissionMode === undefined) dials.permissionMode = "plan";
    delete dials.readOnly;
  }
  if (implementerKey === "vibe" && dials.readOnly === true) {
    dials.planOnly = true;
    delete dials.readOnly;
  }
  // agy / claude / cursor / pi keep readOnly as a boolean on opts
  return dials;
}

/**
 * Apply resolved dials onto relay opts. `flagged` lists fields set by CLI flags.
 */
export function mergeDials(opts, dials, flagged) {
  for (const [field, value] of Object.entries(dials)) {
    if (flagged.has(field)) continue;
    // read-only / sandbox / agent / autonomy often share a flag surface
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) {
      continue;
    }
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (
      field === "planOnly" &&
      (flagged.has("planOnly") || flagged.has("readOnly") || flagged.has("fullAccess"))
    ) {
      continue;
    }
    if (
      field === "readOnly" &&
      (flagged.has("readOnly") ||
        flagged.has("dangerouslySkipPermissions") ||
        flagged.has("fullAccess"))
    ) {
      continue;
    }
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
  }
}

function parseResolveArgs(argv) {
  let cwd = process.cwd();
  let lane = null;
  let implementer = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      return value;
    };
    if (arg === "--cwd") cwd = resolvePath(next());
    else if (arg === "--lane") lane = next();
    else if (arg === "--implementer") implementer = next();
    else fail(`unknown option: ${arg}`);
  }
  if (!lane) fail("resolve requires --lane");
  if (!implementer) fail("resolve requires --implementer");
  return { cwd, lane, implementer };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const cmd = argv[0];
  if (cmd !== "resolve") fail(`unknown command ${JSON.stringify(cmd)}`);
  try {
    const { cwd, lane, implementer } = parseResolveArgs(argv.slice(1));
    const result = resolveLaneForRelay(cwd, lane, implementer);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    fail(error.message || String(error));
  }
}

// realpath BOTH sides, not resolve: mirrors config.mjs — symlinked install paths
// otherwise make this silently no-op (including under --preserve-symlinks-main,
// where the module URL keeps the symlink path), and relays call it for every
// --lane dispatch.
const isMain = (() => {
  if (!process.argv[1]) return false;
  const toReal = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolvePath(path);
    }
  };
  return toReal(process.argv[1]) === toReal(fileURLToPath(import.meta.url));
})();
if (isMain) main(process.argv.slice(2));
