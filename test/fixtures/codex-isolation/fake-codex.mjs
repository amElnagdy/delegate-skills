#!/usr/bin/env node
/**
 * Synthetic `codex` for the relay tests (plan §7.1).
 *
 * It never reads user configuration, never authenticates, and never touches the network. It
 * exists only so the relay has a deterministic child to launch. The test copies it beside a
 * `codex.cmd` (Windows) or `codex` (POSIX) shim inside a private bin directory; everything it
 * does is read from `scenario.json` in that same directory, so no behaviour depends on
 * environment variables surviving the relay's own environment handling (e.g. --clean-env).
 *
 * Every invocation appends one JSON line to `invocations.jsonl` in that directory:
 *   { kind: "version" | "exec" | "other", pid, argv, cwd, env, stdin? }
 *
 * scenario.json:
 *   {
 *     "version": { "stdout"?, "stderr"?, "stderrFirst"?, "exitCode"?, "sleepMs"?, "signal"?, "unlinkShim"? },
 *     "exec":    { "steps": [ ...ops ], "exitCode"? }
 *   }
 *
 * ops (run in order):
 *   { op: "stdout" | "stderr", text | base64, repeat? }   write bytes (repeat = write n times)
 *   { op: "sleep", ms }
 *   { op: "final", text }                                 write the `-o <file>` final message
 *   { op: "marker", name }                                create <bin>/<name> (the pid inside)
 *   { op: "replaceLock", text }                           atomically replace the run's .relay.lock (next to
 *                                                         the `-o` file) with a different owner's lock
 *   { op: "removeLock" }                                  delete the run's .relay.lock
 *   { op: "wait", name, maxMs? }                          block until <bin>/<name> exists
 *   { op: "hang", maxMs? }                                same as wait for "release"
 *   { op: "signal", name }                                kill this process with a signal (POSIX)
 *   { op: "exit", code }                                  stop processing and exit with code
 *
 * `wait`/`hang` poll a file instead of sleeping forever, so an orphaned instance (for example
 * after the relay was force-killed) ends as soon as the test releases it, and never lives
 * longer than maxMs (default 60 s).
 */

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION_MARKER = "codex-cli 0.0.0-fake-relay-test";
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (stream, data) => new Promise((resolve) => stream.write(data, () => resolve()));

function record(kind, extra = {}) {
  const env = process.env;
  const entry = {
    kind,
    pid: process.pid,
    argv: args,
    cwd: process.cwd(),
    env: {
      CODEX_HOME: env.CODEX_HOME ?? null,
      HOME: env.HOME ?? null,
      USERPROFILE: env.USERPROFILE ?? null,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? null,
      PATH: env.PATH ?? env.Path ?? null,
      keys: Object.keys(env).sort(),
    },
    ...extra,
  };
  appendFileSync(join(here, "invocations.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function emit(stream, step) {
  const unit = step.base64 !== undefined
    ? Buffer.from(step.base64, "base64")
    : Buffer.from(step.text ?? "", "utf8");
  const repeats = step.repeat ?? 1;
  let batch = [];
  let size = 0;
  for (let i = 0; i < repeats; i += 1) {
    batch.push(unit);
    size += unit.length;
    if (size >= 32 * 1024 || i === repeats - 1) {
      await write(stream, Buffer.concat(batch));
      batch = [];
      size = 0;
    }
  }
}

async function waitForFile(name, maxMs = 60_000) {
  const path = join(here, name);
  const deadline = Date.now() + maxMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

/** The run's lock sits beside the `-o <file>` argument the relay passed. */
function lockPathFromArgv() {
  const at = args.indexOf("-o");
  if (at === -1 || args[at + 1] === undefined) throw new Error("fake-codex: no -o <file> in argv");
  return join(dirname(args[at + 1]), ".relay.lock");
}

async function runVersion() {
  const spec = scenario.version ?? {};
  record("version");
  if (spec.unlinkShim) {
    // Lets a test make the *dispatch* launch fail after the version preflight succeeded (POSIX).
    try { unlinkSync(join(here, "codex")); } catch { /* best effort */ }
  }
  // stderrFirst prints stderr before sleeping, so a probe that is then killed by the relay's
  // timeout has already said its piece.
  if (spec.stderr && spec.stderrFirst) await write(process.stderr, spec.stderr);
  if (spec.sleepMs) await sleep(spec.sleepMs);
  if (spec.stderr && !spec.stderrFirst) await write(process.stderr, spec.stderr);
  if (spec.signal) {
    // The probe dies by a real signal (POSIX; on Windows this is an unconditional termination).
    process.kill(process.pid, spec.signal);
    await sleep(5000);
  }
  await write(process.stdout, spec.stdout ?? `${VERSION_MARKER}\n`);
  process.exitCode = spec.exitCode ?? 0;
}

async function runExec() {
  const stdin = await readStdin();
  record("exec", { stdin });
  const spec = scenario.exec ?? {};
  for (const step of spec.steps ?? []) {
    switch (step.op) {
      case "stdout": await emit(process.stdout, step); break;
      case "stderr": await emit(process.stderr, step); break;
      case "sleep": await sleep(step.ms); break;
      case "final": {
        const at = args.indexOf("-o");
        if (at === -1 || args[at + 1] === undefined) throw new Error("fake-codex: no -o <file> in argv");
        writeFileSync(args[at + 1], step.text, "utf8");
        break;
      }
      case "marker": writeFileSync(join(here, step.name), String(process.pid)); break;
      case "replaceLock": {
        // Stage first, then rename over the lock: the new file is created while the old one still
        // exists, so it can never share the old file's identity, and no instant has "no lock".
        const lock = lockPathFromArgv();
        const staged = `${lock}.other`;
        writeFileSync(staged, step.text, "utf8");
        renameSync(staged, lock);
        break;
      }
      case "removeLock": unlinkSync(lockPathFromArgv()); break;
      case "wait":
        if (!(await waitForFile(step.name, step.maxMs))) { process.exitCode = 98; return; }
        break;
      case "hang":
        if (!(await waitForFile("release", step.maxMs))) { process.exitCode = 98; return; }
        break;
      case "signal":
        process.kill(process.pid, step.name);
        await sleep(5000);
        break;
      case "exit": process.exitCode = step.code; return;
      default: throw new Error(`fake-codex: unknown op ${step.op}`);
    }
  }
  process.exitCode = spec.exitCode ?? 0;
}

if (args[0] === "--version") {
  await runVersion();
} else if (args[0] === "exec") {
  await runExec();
} else {
  record("other");
  process.exitCode = 0;
}
