#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RELAYS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi"];
const SYMBOLS = [
  ["MAX_TIMER_MS", "const"],
  ["parseDuration", "function"],
  ["killChild", "function"],
  ["gitTouchedFiles", "function"],
];
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${name}`);
  if (!condition) failed += 1;
};

function extract(source, symbol, kind, relay) {
  const anchor = kind === "const"
    ? new RegExp(`^const ${symbol} =.*$`, "gm")
    : new RegExp(`^function ${symbol}\\(`, "gm");
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) {
    throw new Error(`${relay}: expected one top-level ${kind} ${symbol}, found ${matches.length}`);
  }
  const start = matches[0].index;
  if (kind === "const") return source.slice(start, source.indexOf("\n", start));
  const next = /^(?:async )?function /gm;
  next.lastIndex = start + 1;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(start, end);
}

for (const [symbol, kind] of SYMBOLS) {
  try {
    const copies = RELAYS.map((relay) => [
      relay,
      extract(readFileSync(join(here, "..", "skills", `${relay}-delegate`, "scripts", "relay.mjs"), "utf8"), symbol, kind, relay),
    ]);
    const groups = new Map();
    for (const [relay, source] of copies) groups.set(source, [...(groups.get(source) || []), relay]);
    const majority = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    const divergent = copies.filter(([, source]) => source !== copies.find(([relay]) => majority.includes(relay))[1]).map(([relay]) => relay);
    check(`${symbol}: byte-identical across relays`, divergent.length === 0);
    if (divergent.length) {
      console.log(`        diverges from majority (${majority.join(", ")}): ${divergent.join(", ")}`);
    }
  } catch (error) {
    check(`${symbol}: extract shared source`, false);
    console.log(`        ${error.message}`);
  }
}

if (failed) {
  console.error(`relay parity: ${failed} failure(s)`);
  process.exit(1);
}
console.log("relay parity: all checks passed");
