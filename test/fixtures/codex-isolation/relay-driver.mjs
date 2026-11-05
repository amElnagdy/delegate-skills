#!/usr/bin/env node
/**
 * Test driver for relay.mjs (plan §7.1): runs the real relay through its exported `main`
 * with injected dependencies, so integration tests never reach the real process preflight and
 * can observe and fault the Windows configuration reader.
 *
 *   node relay-driver.mjs <relay arguments...>
 *
 * Contract with relay.mjs:  export function main(argv, deps)
 *   deps.preflight()  -> { status: "running" | "not-running" | "unavailable", reason? }
 *                        (replaces the real tasklist.exe probe; may throw)
 *   deps.configIo     -> an fs-compatible object. The Windows sandbox-setting reader must use
 *                        ONLY this object to read Codex configuration, so every path it touches is
 *                        recorded and its I/O can be made to fail.
 *
 * Environment (all optional):
 *   RELAY_TEST_TRACE         JSON-lines trace file ({event:"preflight"} / {event:"config-*", path})
 *   RELAY_TEST_PREFLIGHT     running | not-running (default) | unavailable | throw | state
 *   RELAY_TEST_PREFLIGHT_STATE
 *                            with RELAY_TEST_PREFLIGHT=state: a JSON value returned verbatim as the
 *                            preflight result (for example an oversized, missing or non-string `reason`)
 *   RELAY_TEST_CONFIG_FAULT  open  -> opening the Codex config fails with EACCES
 *                            read  -> reading it fails with EIO after a successful open
 *   RELAY_TEST_FREEZE_TIME   ISO timestamp; `new Date()` / Date.now() return it, so two relays
 *                            started "at the same instant" can be created deterministically
 *   RELAY_TEST_EMIT_SIGNAL + RELAY_TEST_EMIT_AFTER
 *                            once the file RELAY_TEST_EMIT_AFTER exists, emit that signal on this
 *                            process (process.emit) so the relay's abort path runs on every
 *                            platform, including Windows where real signals terminate abruptly
 *   RELAY_TEST_EMIT_BLOCK_MS (with the two above) after the marker appears, create
 *                            <RELAY_TEST_EMIT_AFTER>.blocking and then hold this thread for that many
 *                            ms *before* emitting the signal. The relay's event loop cannot read its
 *                            pipes meanwhile, so whatever the fake codex writes after seeing the
 *                            ".blocking" file (use a `wait` op) reaches the relay only after the
 *                            abort handler has taken its first snapshot: deterministic "output
 *                            arrives during the abort grace period".
 *   RELAY_TEST_FS_FAULT      Faults on the owner-metadata write into the new .relay.lock (the lock file
 *                            itself is created normally). Only descriptors opened with flag "wx" on a
 *                            file named .relay.lock are affected:
 *                            lock-write           the write throws ENOSPC
 *                            lock-short-write     the first write stores only half of the bytes and
 *                                                 returns that count without throwing; later writes
 *                                                 behave normally (a caller that loops completes it)
 *                            lock-zero-write      every write stores nothing and returns 0
 *                            lock-short-then-zero the first write is short, every later one returns 0
 */

import * as fs from "node:fs";
import fsCjs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = join(here, "../../../skills/codex-delegate/scripts/relay.mjs");

function trace(entry) {
  if (!process.env.RELAY_TEST_TRACE) return;
  fs.appendFileSync(process.env.RELAY_TEST_TRACE, `${JSON.stringify(entry)}\n`);
}

// A relay that still calls main() at import time would run for real (and read stdin) the moment
// this driver imports it. Refuse instead: the plan (§4.9) requires an import-safe entrypoint.
if (/^main\(\);?\s*$/m.test(fs.readFileSync(relayPath, "utf8"))) {
  process.stderr.write("relay-driver: relay.mjs still calls main() unconditionally at import (plan 4.9); refusing to drive it\n");
  process.exit(97);
}

if (process.env.RELAY_TEST_FREEZE_TIME) {
  const RealDate = Date;
  const frozen = RealDate.parse(process.env.RELAY_TEST_FREEZE_TIME);
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...rest) {
      if (rest.length === 0) super(frozen);
      else super(...rest);
    }
    static now() { return frozen; }
  };
}

const relay = await import(pathToFileURL(relayPath).href);
if (typeof relay.main !== "function") {
  process.stderr.write("relay-driver: relay.mjs does not export main(argv, deps)\n");
  process.exit(96);
}

const fault = process.env.RELAY_TEST_CONFIG_FAULT || "";
const configIo = { ...fs };
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "accessSync", "readdirSync", "realpathSync"]) {
  configIo[name] = (path, ...rest) => {
    trace({ event: "config-fs", fn: name, path: String(path) });
    return fs[name](path, ...rest);
  };
}
configIo.openSync = (path, ...rest) => {
  trace({ event: "config-open", path: String(path) });
  if (fault === "open") {
    throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES", syscall: "open" });
  }
  return fs.openSync(path, ...rest);
};
configIo.readSync = (fd, ...rest) => {
  if (fault === "read") {
    throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", syscall: "read" });
  }
  return fs.readSync(fd, ...rest);
};

const deps = {
  configIo,
  preflight() {
    trace({ event: "preflight" });
    const mode = process.env.RELAY_TEST_PREFLIGHT || "not-running";
    if (mode === "throw") throw new Error("simulated preflight crash");
    if (mode === "state") return JSON.parse(process.env.RELAY_TEST_PREFLIGHT_STATE);
    if (mode === "unavailable") return { status: "unavailable", reason: "simulated" };
    return { status: mode };
  },
};

const LOCK_FAULTS = ["lock-write", "lock-short-write", "lock-zero-write", "lock-short-then-zero"];
const lockFault = process.env.RELAY_TEST_FS_FAULT || "";

if (LOCK_FAULTS.includes(lockFault)) {
  // The relay takes its fs functions by name from node:fs, so patch the CommonJS exports object and
  // re-sync the ESM bindings. Only a write to a descriptor opened exclusively on `.relay.lock` is
  // affected.
  const lockFds = new Set();
  let lockWrites = 0;
  const { openSync, writeSync, closeSync } = fsCjs;
  /** Normalise the three writeSync call forms to { buffer, offset, length, position }. */
  const normalise = (data, rest) => {
    if (typeof data === "string") {
      const [position, encoding] = rest;
      const buffer = Buffer.from(data, typeof encoding === "string" ? encoding : "utf8");
      return { buffer, offset: 0, length: buffer.length, position };
    }
    let [offset, length, position] = rest;
    if (offset !== null && typeof offset === "object") ({ offset, length, position } = offset);
    offset ??= 0;
    return { buffer: data, offset, length: length ?? data.byteLength - offset, position };
  };
  fsCjs.openSync = function patchedOpenSync(path, flags, ...rest) {
    const fd = openSync.call(this, path, flags, ...rest);
    if (basename(String(path)) === ".relay.lock" && flags === "wx") lockFds.add(fd);
    return fd;
  };
  fsCjs.writeSync = function patchedWriteSync(fd, data, ...rest) {
    if (!lockFds.has(fd)) return writeSync.call(this, fd, data, ...rest);
    if (lockFault === "lock-write") {
      trace({ event: "fault", fault: lockFault });
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
    }
    const { buffer, offset, length, position } = normalise(data, rest);
    lockWrites += 1;
    const short = lockWrites === 1 && lockFault !== "lock-zero-write";
    if (short) {
      // Store half (at least one byte) and report exactly that, without throwing.
      const stored = Math.max(1, Math.floor(length / 2));
      writeSync.call(this, fd, buffer, offset, stored, position);
      trace({ event: "fault", fault: lockFault, requested: length, returned: stored });
      return stored;
    }
    if (lockFault === "lock-short-write") return writeSync.call(this, fd, buffer, offset, length, position);
    // zero-progress: nothing is stored and nothing is reported
    trace({ event: "fault", fault: lockFault, requested: length, returned: 0 });
    return 0;
  };
  fsCjs.closeSync = function patchedCloseSync(fd, ...rest) {
    lockFds.delete(fd);
    return closeSync.call(this, fd, ...rest);
  };
  syncBuiltinESMExports();
}

if (process.env.RELAY_TEST_EMIT_SIGNAL && process.env.RELAY_TEST_EMIT_AFTER) {
  const signal = process.env.RELAY_TEST_EMIT_SIGNAL;
  const marker = process.env.RELAY_TEST_EMIT_AFTER;
  const blockMs = Number(process.env.RELAY_TEST_EMIT_BLOCK_MS || 0);
  const timer = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(timer);
    if (blockMs > 0) {
      fs.writeFileSync(`${marker}.blocking`, "1");
      trace({ event: "block-start", ms: blockMs });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
      trace({ event: "block-end" });
    }
    trace({ event: "emit-signal", signal });
    process.emit(signal, signal);
  }, 25);
  if (typeof timer.unref === "function") timer.unref();
}

relay.main(process.argv.slice(2), deps);
