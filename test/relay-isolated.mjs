#!/usr/bin/env node
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RELAYS = ["claude", "cline", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "omp", "aider", "copilot", "warp", "zcode", "commandcode"];
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${name}`);
  if (!condition) failed += 1;
};

for (const relay of RELAYS) {
  const temp = mkdtempSync(join(tmpdir(), `delegate-skills-${relay}-`));
  try {
    // The filter is not filtering. It forces cpSync down its JavaScript copy path
    // instead of the native fsBinding.cpSyncCopyDir, which kills the process on Windows
    // - exit 0xC0000409, nothing thrown, nothing printed - when the source path contains
    // any non-ASCII character. The source here is the checkout path, so without this a
    // contributor whose clone sits under an accented or non-Latin directory sees this
    // suite exit non-zero having printed nothing at all. Measured on Node v22.23.2 and
    // v24.14.1, Windows 10.
    cpSync(join(here, "..", "skills", `${relay}-delegate`), join(temp, `${relay}-delegate`), { recursive: true, filter: () => true });
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
