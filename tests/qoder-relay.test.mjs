import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const relay = join(repo, "skills/qoder-delegate/scripts/relay.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qoder-relay-test-"));
  const bin = join(root, "bin");
  const work = join(root, "work");
  const out = join(root, "out");
  mkdirSync(bin);
  mkdirSync(work);
  execFileSync("git", ["init", "-q"], { cwd: work });
  writeFileSync(join(work, "brief.txt"), "Make the bounded change.\n");
  return { root, bin, work, out };
}

function run(args, env = process.env) {
  return spawnSync(process.execPath, [relay, ...args], {
    encoding: "utf8",
    env,
    timeout: 3500,
  });
}

function fakeQoder(bin) {
  const path = join(bin, "qodercli");
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("1.0.47");
  process.exit(0);
}
if (["watchdog", "orphan"].includes(process.env.QODER_FAKE_MODE)) {
  const { spawn } = require("node:child_process");
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], {stdio:["ignore","inherit","inherit"]});
  if (process.env.QODER_FAKE_MODE === "orphan") descendant.unref();
  if (process.env.QODER_FAKE_MODE === "watchdog") setInterval(() => {}, 1000);
}
fs.writeFileSync(process.env.QODER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:"system",subtype:"init",qodercli_version:"1.0.47",model:"performance",permissionMode:"acceptEdits",session_id:"session-1"}));
console.log(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"done"}]},session_id:"session-1"}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done",usage:{input_tokens:3,output_tokens:1},session_id:"session-1"}));
`);
  chmodSync(path, 0o755);
}

test("help documents model, context-window, and permission controls", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--model/);
  assert.match(result.stdout, /--context-window/);
  assert.match(result.stdout, /--permission-mode/);
});

test("rejects a non-positive context window before creating artifacts", () => {
  const { work, out } = fixture();
  const result = run([
    "--brief", join(work, "brief.txt"),
    "--cd", work,
    "--context-window", "0",
    "--out-dir", out,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /positive integer/);
  assert.equal(existsSync(out), false);
});

test("writes a structured unavailable result when qodercli is missing", () => {
  const { work, out } = fixture();
  const result = run([
    "--brief", join(work, "brief.txt"),
    "--cd", work,
    "--out-dir", out,
  ], { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });

  assert.equal(result.status, 127, result.stderr);
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(report.status, "qoder_unavailable");
  assert.equal(report.tool, "qoder");
});

test("forwards Qoder options and captures the structured result", () => {
  const { root, bin, work, out } = fixture();
  const argsPath = join(root, "args.json");
  fakeQoder(bin);
  const result = run([
    "--brief", join(work, "brief.txt"),
    "--cd", work,
    "--model", "Performance",
    "--context-window", "32768",
    "--permission-mode", "accept_edits",
    "--out-dir", out,
  ], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    QODER_ARGS_FILE: argsPath,
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(readFileSync(argsPath, "utf8"));
  assert.deepEqual(argv.slice(0, 5), [
    "-p", "--output-format", "stream-json", "--permission-mode", "accept_edits",
  ]);
  assert.deepEqual(argv.slice(5, 9), ["--model", "Performance", "--context-window", "32768"]);
  assert.equal(argv.at(-2), "--");
  assert.equal(argv.at(-1), "Make the bounded change.\n");

  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.tool, "qoder");
  assert.equal(report.qoderVersion, "1.0.47");
  assert.equal(report.sessionId, "session-1");
  assert.equal(report.actualModel, "performance");
  assert.equal(report.finalMessage, "done");
  assert.deepEqual(report.usage, { input_tokens: 3, output_tokens: 1 });
});

test("watchdog finishes when a terminated Qoder child leaves inherited pipes open", () => {
  const { root, bin, work, out } = fixture();
  fakeQoder(bin);
  const result = run([
    "--brief", join(work, "brief.txt"),
    "--cd", work,
    "--timeout", "1s",
    "--out-dir", out,
  ], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    QODER_ARGS_FILE: join(root, "args.json"),
    QODER_FAKE_MODE: "watchdog",
  });

  assert.notEqual(result.status, null, result.error?.message);
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.match(report.error, /relay watchdog/);
});

test("watchdog finishes when Qoder already exited but a descendant kept pipes open", () => {
  const { root, bin, work, out } = fixture();
  fakeQoder(bin);
  const result = run([
    "--brief", join(work, "brief.txt"),
    "--cd", work,
    "--timeout", "1s",
    "--out-dir", out,
  ], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    QODER_ARGS_FILE: join(root, "args.json"),
    QODER_FAKE_MODE: "orphan",
  });

  assert.notEqual(result.status, null, result.error?.message);
  const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.match(report.error, /relay watchdog/);
});
