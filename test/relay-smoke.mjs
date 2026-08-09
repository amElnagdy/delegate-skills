#!/usr/bin/env node
/**
 * delegate-skills · relay smoke.
 *
 * Drives the relays, unmodified and end to end, against a fake implementer CLI
 * planted on PATH, and asserts the two guarantees they make about runs that do
 * not complete:
 *
 *   1. timeout  — the watchdog kills the implementer's WHOLE process tree and
 *                 result.json reports status "timeout". Driven for all ten
 *                 relays on both platforms. On Windows, claude and cursor
 *                 launch a .cmd shim through a serialized cmd.exe invocation,
 *                 while codex/opencode/grok/pi use shell:true. These are exactly the
 *                 cases a plain child.kill would miss; agy, kimi, qoder, and vibe spawn a
 *                 native binary directly — a .cmd stand-in cannot represent them,
 *                 so the smoke compiles a real fake .exe with the C# compiler
 *                 that ships in-box with Windows (no install, no network) and
 *                 puts it on PATH under their names. A POSIX variant repeats
 *                 each run with a parent that complies with
 *                 SIGTERM while its grandchild ignores it — the sweep at close
 *                 must fell the survivor even though the parent's exit
 *                 cancelled the pending escalation timer.
 *   2. aborted  — killing the relay itself still produces result.json with
 *                 status "aborted", and files the implementer flushes during
 *                 the shutdown grace window appear in the refreshed
 *                 touchedFiles. Driven for all ten relays on POSIX; Windows
 *                 delivers no catchable SIGTERM, so the scenario cannot be
 *                 driven there (the skill docs carry the same caveat).
 *
 * Every fake answers each relay's version preflight (--version, `version`,
 * `changelog`), and can be told to hang or fail that probe by mode name, so a
 * relay whose preflight is unbounded — wedging before any result.json exists —
 * or which reports a broken CLI as a missing one is caught here.
 * A shared matrix also drives all ten through the --timeout values no
 * watchdog can honour — malformed, zero, and past Node's timer ceiling — each of
 * which would otherwise fire on the next tick as a silent instant "timeout".
 * Quick Claude, Cursor, Qoder, Vibe, and Pi success cases verify brief
 * delivery, launch arguments, environment handling, and result-event parsing. The
 * timeout/abort cases otherwise run until killed and spawn a subprocess of
 * their own; both assert that this grandchild dies with the implementer.
 * Node built-ins only.
 *
 * Run one module locally: node test/relay-smoke.mjs --only codex
 */
import { createHarness } from "./harness/create-harness.mjs";
import { installShim } from "./harness/install-shim.mjs";
import { runners } from "./relay/index.mjs";

function parseOnly(argv) {
  const flag = argv.find((arg) => arg === "--only" || arg.startsWith("--only="));
  if (!flag) return null;
  const value = flag === "--only"
    ? argv[argv.indexOf("--only") + 1]
    : flag.slice("--only=".length);
  if (!value || value.startsWith("-")) {
    console.error("relay smoke: --only requires a comma-separated module list");
    process.exit(2);
  }
  const names = new Set(value.split(",").map((part) => part.trim()).filter(Boolean));
  const known = new Set(runners.map(([name]) => name));
  const unknown = [...names].filter((name) => !known.has(name));
  // An unselected registry runs zero checks and would otherwise report "all green".
  if (names.size === 0 || unknown.length > 0) {
    console.error(`relay smoke: unknown --only module(s): ${unknown.join(", ") || "(empty selection)"}`);
    console.error(`relay smoke: modules: ${[...known].join(", ")}`);
    process.exit(2);
  }
  return names;
}

const only = parseOnly(process.argv.slice(2));
const h = createHarness();
const shimless = new Set(["package-shape", "syntax"]);
const needsShim = !only || [...only].some((name) => !shimless.has(name));
if (needsShim) installShim(h);

try {
  for (const [name, run] of runners) {
    if (only && !only.has(name)) continue;
    await run(h);
  }
} finally {
  h.cleanup();
}
console.log(h.failed ? `\n${h.failed} FAILED` : "\nrelay smoke: all green");
process.exit(h.failed ? 1 : 0);
