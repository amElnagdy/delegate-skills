/**
 * delegate-skills · usage-limit classification behavior matrix.
 *
 * The cross-relay gate for `failureClass: "usage_limit"`. Per-CLI signatures differ by
 * design (each implementer's terminal event and error wording is its own), so the relays
 * cannot be byte-compared the way the shared helpers in relay-parity.mjs are. What must
 * be identical is the BEHAVIOR, so every enrolled relay runs the same scenario set here:
 *
 *   1. a terminal usage-limit failure classifies, preserving the resume handle and
 *      whatever partial work the implementer left behind
 *   2. the same run split across awkward chunk boundaries with no trailing newline
 *      still classifies (transport faithfulness)
 *   3. a stated duration becomes retryAt; an ambiguous human reset time becomes null
 *   4. an unrelated terminal failure stays unclassified
 *   5. trigger words in NON-terminal events plus an unrelated failure stay unclassified
 *   6. a recovered run that completes stays completed
 *   7. a limit with a zero exit code is still normalized to a failure
 *   8. the relay's own kill (watchdog, orchestrator) outranks any classification
 *   9. a reused --out-dir never serves the previous run's artifacts
 *
 * Enrolling a relay is one row in ENROLLED plus a capture bundle under
 * fixtures/usage-limit/. A CLI whose limit signature has not been captured is not
 * enrolled and keeps reporting an unclassified "failed" — that is the fail-closed
 * default the plan requires, not a gap in this suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EXTRA_ARGS } from "../harness/constants.mjs";

// cli:          relay + skill directory name (skills/<cli>-delegate/)
// fixture:      capture bundle under test/fixtures/usage-limit/
// stream:       where that CLI emits the terminal failure the relay parses
// resumeField:  the result field holding that CLI's resume handle — each implementer names
//               its own (Codex threads, everyone else sessions). null when a limit run has
//               no handle to preserve, which must be justified in the comment.
export const ENROLLED = [
  { cli: "codex", fixture: "codex.json", stream: "stdout", resumeField: "threadId" },
  { cli: "cursor", fixture: "cursor.json", stream: "stdout", resumeField: "sessionId" },
  // grok reports its session id only on the `end` line, which a limit run never reaches —
  // partial work there resumes with --resume-last, not a captured handle.
  { cli: "grok", fixture: "grok.json", stream: "stdout", resumeField: null },
  { cli: "qoder", fixture: "qoder.json", stream: "stdout", resumeField: "sessionId" },
  { cli: "opencode", fixture: "opencode.json", stream: "stdout", resumeField: "sessionId" },
];

export async function runUsageLimit(h) {
  h.check("usage-limit: at least one relay is enrolled", ENROLLED.length > 0);
  for (const entry of ENROLLED) await runMatrix(h, entry);
}

async function runMatrix(h, entry) {
  const tag = `usage-limit[${entry.cli}]`;
  const fixturePath = join(h.testDir, "fixtures", "usage-limit", entry.fixture);
  if (!existsSync(fixturePath)) {
    h.check(`${tag}: capture bundle exists`, false);
    return;
  }
  const bundle = JSON.parse(readFileSync(fixturePath, "utf8"));

  const env = (scenario, extra = {}) => ({
    ...h.baseEnv,
    SMOKE_MODE: "usage-limit",
    SMOKE_LIMIT_FIXTURE: fixturePath,
    SMOKE_LIMIT_SCENARIO: scenario,
    SMOKE_LIMIT_STREAM: entry.stream,
    ...extra,
  });

  const run = (scenario, { name, extraArgs = [], extraEnv = {}, writeFile = null }) => {
    const outDir = join(h.scratch, `ul-${entry.cli}-${name}`);
    const workDir = h.freshRepo(`ul-${entry.cli}-${name}-repo`);
    const proc = spawnSync(process.execPath, [
      h.relayPath(entry.cli), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir,
      ...(EXTRA_ARGS[entry.cli] || []), ...extraArgs,
    ], {
      env: env(scenario, writeFile ? { ...extraEnv, SMOKE_WRITE_FILE: join(workDir, writeFile) } : extraEnv),
      encoding: "utf8",
    });
    const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
    return { proc, result, outDir, workDir };
  };

  // ---- 1. a terminal usage-limit failure classifies ----
  const expected = bundle.scenarios.usageLimit.expect;
  const limit = run("usageLimit", { name: "limit", writeFile: "partial.txt" });
  h.check(`${tag}: status stays "failed" — the status enum is not widened`,
    limit.result?.status === "failed");
  h.check(`${tag}: failureClass classifies the run`,
    limit.result?.failureClass === "usage_limit");
  h.check(`${tag}: kind distinguishes the response`,
    limit.result?.limit?.kind === expected.kind);
  h.check(`${tag}: evidence is structured and auditable`, (() => {
    const evidence = limit.result?.limit?.evidence;
    return Boolean(evidence)
      && typeof evidence.source === "string" && evidence.source.length > 0
      && typeof evidence.excerpt === "string" && evidence.excerpt.length > 0
      && Number.isInteger(evidence.artifactLine) && evidence.artifactLine > 0;
  })());
  h.check(`${tag}: evidence excerpt is bounded`,
    (limit.result?.limit?.evidence?.excerpt || "").length <= 401);
  // Bounds alone would pass on any line of a short bundle, so the check is against the
  // bundle's own `artifactLine`: the 1-based events.jsonl line of the terminal event that
  // CLI classifies on. That catches an off-by-one in a relay's object counter — evidence
  // pointing at the wrong record is worse than none, because it reads as auditable.
  // The file is read defensively: a relay that died before writing artifacts must fail
  // this one check, not throw out of the matrix and skip every check after it.
  h.check(`${tag}: evidence.artifactLine points at the terminal event in events.jsonl`, (() => {
    const line = limit.result?.limit?.evidence?.artifactLine;
    const eventsPath = join(limit.outDir, "events.jsonl");
    if (!existsSync(eventsPath)) return false;
    const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
    if (!Number.isInteger(line) || line < 1 || line > events.length) return false;
    return line === expected.artifactLine;
  })());
  if (entry.resumeField) {
    // Partial work must stay resumable after the reset — for implementers that have a
    // handle at all. Aider and friends have no session ids; the diff is their only record.
    h.check(`${tag}: the resume handle (${entry.resumeField}) survives the limit`,
      typeof limit.result?.[entry.resumeField] === "string" && limit.result[entry.resumeField].length > 0);
  }
  h.check(`${tag}: partial work is still reported`,
    Array.isArray(limit.result?.touchedFiles) && limit.result.touchedFiles.some((f) => f.includes("partial.txt")));
  h.check(`${tag}: the relay exits non-zero`, limit.proc.status !== 0);
  h.check(`${tag}: the hint forbids reworking the brief`,
    /do not rework/i.test(limit.proc.stdout || ""));
  if (expected.resetsAt !== undefined) {
    h.check(`${tag}: a zoned reset timestamp is parsed`,
      limit.result?.limit?.resetsAt === expected.resetsAt);
  }

  // ---- 2. transport faithfulness: split chunks, no trailing newline ----
  const split = run("usageLimit", {
    name: "split",
    extraEnv: { SMOKE_LIMIT_SPLIT: "1", SMOKE_LIMIT_NO_TRAILING_NEWLINE: "1" },
  });
  h.check(`${tag}: classifies across split chunks with no trailing newline`,
    split.result?.status === "failed" && split.result?.failureClass === "usage_limit");

  // ---- 3. reset-time parsing, both directions ----
  if (entry.resumeField) {
    h.check(`${tag}: the resume handle survives chunk splitting`,
      typeof split.result?.[entry.resumeField] === "string" && split.result[entry.resumeField].length > 0);
  }

  if (bundle.scenarios.usageLimitRetryAfter) {
    const retryExpect = bundle.scenarios.usageLimitRetryAfter.expect;
    const before = Date.now();
    const retry = run("usageLimitRetryAfter", { name: "retry" });
    const after = Date.now();
    h.check(`${tag}: a stated duration becomes retryAt`,
      typeof retry.result?.limit?.retryAt === "string"
      && !Number.isNaN(Date.parse(retry.result.limit.retryAt)));
    // "It parses as a date" would also pass for a timestamp the relay invented, so pin the
    // value: retryAt must land the bundle's own stated retry_after ahead of the moment the
    // relay read the event, which happened somewhere inside [before, after]. Bounding with
    // that window rather than a fixed tolerance means a slow machine widens the bound
    // instead of flaking. The duration comes from the bundle because each CLI states its
    // own — codex's capture says 120s, OpenCode's says 600s.
    if (Number.isFinite(retryExpect?.retryAfterSeconds)) {
      const offset = retryExpect.retryAfterSeconds * 1000;
      const parsed = Date.parse(retry.result?.limit?.retryAt ?? "");
      h.check(`${tag}: retryAt is the stated ${retryExpect.retryAfterSeconds}s ahead, not a guess`,
        Number.isFinite(parsed) && parsed >= before + offset - 2000 && parsed <= after + offset + 2000);
    }
    // The kind comes from the bundle, not from this file: a CLI that surfaces transient
    // throttling reports "rate_limited" here, while one that only ever exposes hard
    // exhaustion (OpenCode retries a 429 forever and never forwards it) says so instead.
    h.check(`${tag}: the retry-after case reports its documented kind`,
      retry.result?.limit?.kind === bundle.scenarios.usageLimitRetryAfter.expect.kind);
  }
  if (bundle.scenarios.usageLimitAmbiguousReset) {
    const ambiguous = run("usageLimitAmbiguousReset", { name: "ambiguous" });
    h.check(`${tag}: an ambiguous human reset time is never guessed`,
      ambiguous.result?.limit?.retryAt === null && ambiguous.result?.limit?.resetsAt === null);
    h.check(`${tag}: a message-only match still classifies`,
      ambiguous.result?.failureClass === "usage_limit");
  }

  // ---- 4/5. false positives: unrelated failure, and trigger words in prose ----
  const unrelated = run("unrelatedFailure", { name: "unrelated" });
  h.check(`${tag}: an unrelated terminal failure stays unclassified`,
    unrelated.result?.status === "failed" && unrelated.result?.failureClass === undefined);
  h.check(`${tag}: no limit object on an unclassified failure`,
    unrelated.result?.limit === undefined);

  const prose = run("proseThenUnrelatedFailure", { name: "prose" });
  h.check(`${tag}: trigger words in non-terminal events do not classify`,
    prose.result?.status === "failed" && prose.result?.failureClass === undefined);

  // ---- 6. a recovered run that completes is a clean completion ----
  const recovered = run("recoveredThenSuccess", { name: "recovered" });
  h.check(`${tag}: a superseded limit event does not spoil a completed run`,
    recovered.result?.status === "completed" && recovered.result?.failureClass === undefined);
  h.check(`${tag}: a completed run exits zero`, recovered.proc.status === 0);

  // ---- 7. a limit is never a success, even on a zero exit ----
  const exitZero = run("usageLimitExitZero", { name: "exitzero" });
  h.check(`${tag}: a limit with exit 0 is normalized to a failure`,
    exitZero.result?.status === "failed" && exitZero.result?.failureClass === "usage_limit");
  h.check(`${tag}: the normalized failure exits non-zero`,
    exitZero.result?.exitCode !== 0 && exitZero.proc.status !== 0);

  // ---- 8. precedence: a run the relay itself ended is never a classification ----
  const timedOut = run("usageLimit", {
    name: "timeout",
    extraArgs: ["--timeout", "1s"],
    extraEnv: { SMOKE_LIMIT_HANG: "1" },
  });
  h.check(`${tag}: the watchdog outranks the classification`,
    timedOut.result?.status === "timeout" && timedOut.result?.failureClass === undefined);

  // ---- extra: per-CLI hardening cases, asserted straight from the bundle ----
  // A relay may list scenarios in `hardening` whose only contract is the `expect` block:
  // the adversarial shapes that CLI's own transport makes possible. Each is checked
  // field-by-field, so a bundle can pin "classifies but refuses the time" as easily as
  // "must not classify at all".
  for (const name of bundle.hardening || []) {
    const scenario = bundle.scenarios[name];
    if (!scenario) {
      h.check(`${tag}: hardening scenario ${name} exists`, false);
      continue;
    }
    const got = run(name, { name: `hard-${name}` });
    for (const [field, want] of Object.entries(scenario.expect || {})) {
      const actual = field === "status" || field === "failureClass" || field === "exitCode"
        ? got.result?.[field]
        : got.result?.limit?.[field];
      // `null` in a bundle means "this field must not be set to anything" — an absent
      // failureClass and an explicit null are both acceptable there.
      const ok = want === null ? (actual === null || actual === undefined) : actual === want;
      h.check(`${tag}: hardening ${name} — ${field} is ${JSON.stringify(want)}`, ok);
    }
  }

  // ---- 9. a reused --out-dir never serves the previous run's artifacts ----
  const reuseDir = join(h.scratch, `ul-${entry.cli}-reuse`);
  const reuseRepo = h.freshRepo(`ul-${entry.cli}-reuse-repo`);
  mkdirSync(reuseDir, { recursive: true });
  writeFileSync(join(reuseDir, "result.json"),
    JSON.stringify({ schema: "delegate-relay.result.v1", status: "completed", exitCode: 0, finalMessage: "STALE REPORT" }), "utf8");
  writeFileSync(join(reuseDir, "final.txt"), "STALE REPORT", "utf8");
  // Seed a stale event stream too. events.jsonl is the artifact evidence.artifactLine indexes
  // into, so leftover lines at the top would shift every offset by their count: the evidence
  // would point at the wrong record while still looking auditable, which is worse than no
  // evidence at all. The relays truncate it on reuse; nothing pinned that until now.
  writeFileSync(join(reuseDir, "events.jsonl"),
    '{"type":"stale","note":"STALE EVENT"}\n{"type":"stale","note":"STALE EVENT"}\n', "utf8");
  const reuse = spawnSync(process.execPath, [
    h.relayPath(entry.cli), "--brief", h.briefPath, "--cd", reuseRepo, "--out-dir", reuseDir,
    ...(EXTRA_ARGS[entry.cli] || []),
  ], { env: env("usageLimit"), encoding: "utf8" });
  const reuseResult = existsSync(join(reuseDir, "result.json")) ? h.result(reuseDir) : null;
  h.check(`${tag}: a reused out-dir reports this run, not the stale one`,
    reuseResult?.status === "failed" && reuseResult?.failureClass === "usage_limit");
  h.check(`${tag}: a stale final report is not inherited`,
    !JSON.stringify(reuseResult ?? {}).includes("STALE REPORT"));
  h.check(`${tag}: a reused out-dir does not keep the previous run's events`, (() => {
    const reuseEventsPath = join(reuseDir, "events.jsonl");
    if (!existsSync(reuseEventsPath)) return false;
    return !readFileSync(reuseEventsPath, "utf8").includes("STALE EVENT");
  })());
  h.check(`${tag}: evidence.artifactLine still resolves to this run's terminal event`,
    reuseResult?.limit?.evidence?.artifactLine === expected.artifactLine);
  h.check(`${tag}: the reused run still exits non-zero`, reuse.status !== 0);
}
