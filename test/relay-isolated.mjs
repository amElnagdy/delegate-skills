#!/usr/bin/env node
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RELAYS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi"];
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${name}`);
  if (!condition) failed += 1;
};

for (const relay of RELAYS) {
  const temp = mkdtempSync(join(tmpdir(), `delegate-skills-${relay}-`));
  try {
    cpSync(join(here, "..", "skills", `${relay}-delegate`), join(temp, `${relay}-delegate`), { recursive: true });
    const result = spawnSync(process.execPath, ["scripts/relay.mjs", "--help"], {
      cwd: join(temp, `${relay}-delegate`),
      encoding: "utf8",
    });
    check(`${relay}: isolated --help`, result.status === 0 && Boolean(result.stdout.trim()));
    if (result.status !== 0 || !result.stdout.trim()) {
      console.log(`        exit ${result.status}; ${(result.stderr || result.error?.message || "no output").trim()}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(`relay isolated install: ${failed} failure(s)`);
  process.exit(1);
}
console.log("relay isolated install: all checks passed");
