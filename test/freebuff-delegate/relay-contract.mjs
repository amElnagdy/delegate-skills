#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const relay = join(root, "skills/freebuff-delegate/scripts/relay.mjs");

function run(args, input = "") {
  return spawnSync(process.execPath, [relay, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env },
  });
}

const missing = run(["--confirm-human", "--brief", "/definitely/missing/brief.txt"]);
if (missing.status !== 2) {
  throw new Error(`expected validation/TTY fail-closed exit 2, got ${missing.status}`);
}

const temp = mkdtempSync(join(tmpdir(), "freebuff-relay-test-"));
const brief = join(temp, "brief.txt");
writeFileSync(brief, "test brief\n", "utf8");
const noTty = run(["--confirm-human", "--brief", brief, "--cd", temp]);
if (noTty.status !== 2) {
  throw new Error(`expected non-TTY execution to fail closed with 2, got ${noTty.status}`);
}

console.log("freebuff-delegate relay contract checks passed");
