// delegate-skills · test/event-scanner.mjs
//
// Direct tests for the inlined scanners. Node built-ins only; run with
// `node test/event-scanner.mjs`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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

function loadScanner(relay, symbol, onVisit) {
  const source = readFileSync(join(here, "..", "skills", `${relay}-delegate`, "scripts", "relay.mjs"), "utf8");
  const maxBufferedChars = extract(source, "MAX_BUFFERED_CHARS", "const", relay);
  let scanner = extract(source, symbol, "function", relay);
  if (onVisit) {
    // Issue #51 needs a deterministic work bound; source instrumentation avoids a wall-clock assertion.
    const instrumented = symbol === "makeEventScanner"
      ? scanner.replace(
        /(\s+)(const ch = buf\[[^\]]+\];)/,
        "$1onVisit();$1$2",
      )
      : scanner.includes('const lines = buf.split("\\n");')
        ? scanner.replace(
          /(\s+)(const lines = buf\.split\("\\n"\);)/,
          "$1onVisit(buf.length);$1$2",
        )
        : scanner.replace(
          /(\s+)(const end = chunk\.indexOf\("\\n", start\);)/,
          "$1onVisit(chunk.length - start);$1$2",
        );
    if (instrumented === scanner) throw new Error(`${relay}: could not instrument ${symbol}`);
    scanner = instrumented;
  }
  return new Function("onVisit", `${maxBufferedChars}\n${scanner}\nreturn ${symbol};`)(onVisit);
}

// Parity covers every makeEventScanner copy; Vibe's makeLineScanner is tested directly.
const makeEventScanner = loadScanner("claude", "makeEventScanner");
const makeLineScanner = loadScanner("vibe", "makeLineScanner");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function collectScanner(factory) {
  const events = [];
  const scan = factory((obj) => events.push(obj));
  return { events, scan };
}

test("event scanner: one object per line (NDJSON)", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"a":1}\n{"b":2}\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("event scanner: junk prefix before the object is skipped", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(']777;notify;some-terminal-junk{"a":1}\n');
  assert.deepEqual(events, [{ a: 1 }]);
});

test("event scanner: concatenated objects on the same line", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"a":1}{"b":2}');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("event scanner: object split across chunk boundaries", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"a":1,"b":["x",');
  assert.deepEqual(events, []);
  scan('"y"]}');
  assert.deepEqual(events, [{ a: 1, b: ["x", "y"] }]);
});

test("event scanner: many small chunks examine each character once", () => {
  let visits = 0;
  const factory = loadScanner("claude", "makeEventScanner", () => { visits += 1; });
  const { events, scan } = collectScanner(factory);
  const event = JSON.stringify({ result: "x".repeat(4096) });
  for (let i = 0; i < event.length; i += 16) scan(event.slice(i, i + 16));
  assert.equal(visits, event.length);
  assert.deepEqual(events, [{ result: "x".repeat(4096) }]);
});

test("event scanner: braces inside string values do not close the object", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"s":"a}b{c","n":1}');
  assert.deepEqual(events, [{ s: "a}b{c", n: 1 }]);
});

test("event scanner: escaped quotes inside string values are respected", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"s":"a\\"b"}');
  assert.deepEqual(events, [{ s: 'a"b' }]);
});

test("event scanner: malformed object is skipped, a later valid one parses", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"broken"}\n{"ok":1}\n');
  assert.deepEqual(events, [{ ok: 1 }]);
});

test("event scanner: deeply nested object still parses", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan('{"a":{"b":{"c":1}}}');
  assert.deepEqual(events, [{ a: { b: { c: 1 } } }]);
});

test("event scanner: empty chunks are ignored without emitting", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan("");
  scan("");
  scan('{"a":1}');
  assert.deepEqual(events, [{ a: 1 }]);
});

test("event scanner: oversized unterminated tail is dropped, later event parses", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(`{"broken":"${"x".repeat(1_100_000)}`);
  assert.deepEqual(events, []);
  scan('{"ok":1}');
  assert.deepEqual(events, [{ ok: 1 }]);
});

test("event scanner: oversized tail split across chunks is still dropped", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(`{"broken":"${"x".repeat(600_000)}`);
  scan("x".repeat(600_000));
  assert.deepEqual(events, []);
  scan('{"ok":1}');
  assert.deepEqual(events, [{ ok: 1 }]);
});

test("event scanner: complete same-chunk object may exceed the retention cap", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(JSON.stringify({ result: "x".repeat(1_100_000) }));
  assert.equal(events.length, 1);
  assert.equal(events[0].result.length, 1_100_000);
});

test("event scanner: oversized tail does not hide a later event in the same chunk", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(`{"broken":"${"x".repeat(1_100_000)}{"ok":1}`);
  assert.deepEqual(events, [{ ok: 1 }]);
});

test("event scanner: post-reset partial event continues in the next chunk", () => {
  const { events, scan } = collectScanner(makeEventScanner);
  scan(`{"broken":"${"x".repeat(1_100_000)}{"later":`);
  assert.deepEqual(events, []);
  scan("1");
  assert.deepEqual(events, []);
  scan("}");
  assert.deepEqual(events, [{ later: 1 }]);
});

test("line scanner: one object per line", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan('{"a":1}\n{"b":2}\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("line scanner: blank and non-JSON lines are skipped", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan('{"a":1}\n\nprogress text\n\n{"b":2}\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("line scanner: empty chunks are ignored", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan("");
  scan('{"a":1}\n');
  assert.deepEqual(events, [{ a: 1 }]);
});

test("line scanner: split line parses once the newline arrives", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan('{"a":1,"b":[');
  assert.deepEqual(events, []);
  scan('"x"]}\n{"c":2}\n');
  assert.deepEqual(events, [{ a: 1, b: ["x"] }, { c: 2 }]);
});

test("line scanner: many small chunks search only newly appended data", () => {
  let searched = 0;
  const factory = loadScanner("vibe", "makeLineScanner", (length) => { searched += length; });
  const { events, scan } = collectScanner(factory);
  const partial = "x".repeat(4096);
  for (let i = 0; i < partial.length; i += 16) scan(partial.slice(i, i + 16));
  assert.equal(searched, partial.length);
  assert.deepEqual(events, []);
});

test("line scanner: oversized unterminated line is dropped, later line parses", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan("x".repeat(1_100_000));
  assert.deepEqual(events, []);
  scan('{"ok":1}\n');
  assert.deepEqual(events, [{ ok: 1 }]);
});

test("line scanner: complete line may exceed the retention cap", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan(`${JSON.stringify({ result: "x".repeat(1_100_000) })}\n`);
  assert.equal(events.length, 1);
  assert.equal(events[0].result.length, 1_100_000);
});

test("line scanner: oversized line does not hide a later event in the same chunk", () => {
  const { events, scan } = collectScanner(makeLineScanner);
  scan(`${"x".repeat(1_100_000)}\n{"ok":1}\n`);
  assert.deepEqual(events, [{ ok: 1 }]);
});

console.log(`\nevent-scanner: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
