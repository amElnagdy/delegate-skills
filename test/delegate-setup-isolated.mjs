/**
 * Tests for the Codex-only `isolated` fleet dial (docs/plans/codex-isolated-lanes.md, component B,
 * sections 5 and 7.2):
 * implementers.mjs registry, config.mjs validation, lane.mjs normalization and resolution, and
 * the unchanged overlay / project-trust behaviour.
 *
 * Run by explicit filename:  node --test test/delegate-setup-isolated.mjs
 *
 * Hermetic: HOME, USERPROFILE and XDG_CONFIG_HOME point at a private fixture directory for the
 * whole file, so the user's real ~/.config/delegate-skills/config.json is never read or written.
 * Only `git` (for project-config discovery) and `node` are ever launched; no Codex, no network.
 *
 * Contract pinned beyond today's code:
 *   implementers.mjs  ALL_DIALS includes "isolated"; only Codex's `supports` lists it
 *   config.mjs        `isolated` must be a boolean, and is rejected (true or false) for every
 *                     other implementer by the existing unsupported-dial rule
 *   lane.mjs          export function normalizeDials(implementerKey, rawDials)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as impl from "../skills/delegate-setup/scripts/implementers.mjs";
import * as config from "../skills/delegate-setup/scripts/config.mjs";
import * as lane from "../skills/delegate-setup/scripts/lane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "skills", "delegate-setup", "scripts");
const CONFIG_SCRIPT = join(SCRIPTS, "config.mjs");
const LANE_SCRIPT = join(SCRIPTS, "lane.mjs");
const IS_WIN = process.platform === "win32";
const OWNED_MARKER = ".isolated-test-owned";
const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

// ---------------------------------------------------------------------------------------------
// Fixture: private HOME / XDG / work area, installed into process.env for the whole file
// ---------------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "isolated-test-"));
const token = randomBytes(12).toString("hex");
writeFileSync(join(root, OWNED_MARKER), token);
const dirs = Object.fromEntries(["home", "xdg", "tmp", "work", "repo"].map((name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return [name, dir];
}));
const SAVED_ENV = Object.fromEntries(["HOME", "USERPROFILE", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
process.env.HOME = dirs.home;
process.env.USERPROFILE = dirs.home;
process.env.XDG_CONFIG_HOME = dirs.xdg;

after(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    if (basename(root).startsWith("isolated-test-") && readFileSync(join(root, OWNED_MARKER), "utf8") === token) {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } catch {
    // Leave the directory rather than delete something not verified as ours.
  }
});

const globalFile = () => join(dirs.xdg, "delegate-skills", "config.json");
function writeGlobal(lanes) {
  mkdirSync(dirname(globalFile()), { recursive: true });
  writeFileSync(globalFile(), `${JSON.stringify({ version: "delegate-fleet.v1", lanes }, null, 2)}\n`);
}
function clearGlobal() {
  rmSync(globalFile(), { force: true });
}

const doc = (lanes) => JSON.stringify({ version: "delegate-fleet.v1", lanes });
const validate = (lanes) => config.parseConfigDocument(doc(lanes), "test");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function childEnv() {
  const env = {
    PATH: process.env.PATH,
    HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.xdg,
    TEMP: dirs.tmp, TMP: dirs.tmp, TMPDIR: dirs.tmp,
  };
  if (IS_WIN) {
    for (const key of ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return env;
}
function runNode(script, args, cwd = dirs.work) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: childEnv(), encoding: "utf8", timeout: 30_000 });
}

describe("fixture isolation", () => {
  it("keeps the global config path inside the private fixture, never the real home", () => {
    assert.ok(resolve(config.globalConfigPath()).startsWith(resolve(root)), config.globalConfigPath());
  });
});

// =============================================================================================
// Implementer registry
// =============================================================================================

describe("implementers registry", () => {
  it("lists isolated among the dials", () => {
    assert.ok(impl.ALL_DIALS.includes("isolated"), `ALL_DIALS: ${impl.ALL_DIALS.join(", ")}`);
  });

  it("only Codex supports isolated", () => {
    const supporters = impl.IMPLEMENTERS.filter((entry) => entry.supports.includes("isolated")).map((entry) => entry.key);
    assert.deepEqual(supporters, ["codex"]);
  });

  it("keeps every existing dial and Codex's existing supports", () => {
    for (const dial of ["model", "effort", "variant", "timeout", "readOnly", "sandbox", "permissionMode", "force", "provider"]) {
      assert.ok(impl.ALL_DIALS.includes(dial), dial);
    }
    for (const dial of ["model", "effort", "sandbox", "timeout", "readOnly"]) {
      assert.ok(impl.IMPLEMENTER_BY_KEY.codex.supports.includes(dial), `codex keeps ${dial}`);
    }
  });
});

// =============================================================================================
// Validation
// =============================================================================================

describe("config validation of the isolated dial", () => {
  it("accepts a boolean on a Codex lane, alone and with read-only settings", () => {
    for (const value of [true, false]) {
      assert.equal(validate({ a: { implementer: "codex", isolated: value } }).ok, true, `isolated:${value}`);
      assert.equal(validate({ b: { implementer: "codex", readOnly: true, isolated: value } }).ok, true);
      assert.equal(validate({ c: { implementer: "codex", sandbox: "read-only", model: "model-a", effort: "high", timeout: "30m", isolated: value } }).ok, true);
      assert.equal(validate({ d: { implementer: "codex", sandbox: "workspace-write", isolated: value } }).ok, true);
    }
  });

  it("rejects a non-boolean value on a Codex lane", () => {
    for (const value of ["true", "false", "", 1, 0, null, {}, []]) {
      const result = validate({ a: { implementer: "codex", isolated: value } });
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.match(result.error, /isolated/, JSON.stringify(value));
      assert.match(result.error, /boolean/, JSON.stringify(value));
    }
  });

  it("rejects isolated, true or false, for every other implementer", () => {
    const others = impl.IMPLEMENTERS.filter((entry) => entry.key !== "codex");
    assert.ok(others.length > 5, "sanity: the registry has other implementers");
    for (const entry of others) {
      for (const value of [true, false]) {
        const result = validate({ x: { implementer: entry.key, isolated: value } });
        assert.equal(result.ok, false, `${entry.key} isolated:${value}`);
        assert.match(result.error, new RegExp(`${entry.key} does not support isolated`), `${entry.key}: ${result.error}`);
      }
    }
  });

  it("one non-Codex lane carrying isolated fails the whole document", () => {
    const result = validate({
      plan: { implementer: "codex", readOnly: true, isolated: true },
      "plan-critique": { implementer: "claude", readOnly: true, isolated: true },
      review: { implementer: "codex", sandbox: "read-only" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /plan-critique/);
    assert.match(result.error, /isolated/);
  });

  it("unchanged valid documents are still accepted, including Claude lanes", () => {
    const lanes = {
      plan: { implementer: "codex", readOnly: true, effort: "high" },
      "plan-critique": { implementer: "claude", readOnly: true, model: "opus", effort: "high" },
      review: { implementer: "codex", sandbox: "read-only", effort: "high" },
      "review-sensitive": { implementer: "codex", readOnly: true },
      "pr-draft": { implementer: "claude", model: "sonnet", timeout: "20m" },
      "docs-review": { implementer: "claude", readOnly: true, model: "opus" },
      implement: { implementer: "codex", sandbox: "workspace-write", timeout: "30m" },
      grok: { implementer: "grok", sandbox: "read-only" },
      oc: { implementer: "opencode", model: "opencode/grok", readOnly: true },
    };
    const result = validate(lanes);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.document.lanes, lanes, "validation returns the document unchanged");
  });

  it("the same document stays valid when only its Codex lanes gain isolated", () => {
    const lanes = {
      plan: { implementer: "codex", readOnly: true, isolated: true },
      "plan-critique": { implementer: "claude", readOnly: true, model: "opus" },
      review: { implementer: "codex", sandbox: "read-only", isolated: false },
      "docs-review": { implementer: "claude", readOnly: true, model: "opus" },
    };
    const result = validate(lanes);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.document.lanes, lanes);
  });

  it("autonomy-consistency validation is unchanged", () => {
    const contradiction = validate({ a: { implementer: "codex", readOnly: true, sandbox: "workspace-write" } });
    assert.equal(contradiction.ok, false);
    assert.match(contradiction.error, /readOnly contradicts sandbox/);
    assert.equal(validate({ a: { implementer: "codex", readOnly: true, sandbox: "read-only" } }).ok, true);
  });

  it("autonomy-consistency validation still applies when isolated is present", () => {
    const contradiction = validate({ a: { implementer: "codex", readOnly: true, sandbox: "workspace-write", isolated: true } });
    assert.equal(contradiction.ok, false);
    assert.match(contradiction.error, /readOnly contradicts sandbox/);
    assert.equal(validate({ a: { implementer: "codex", readOnly: true, sandbox: "read-only", isolated: false } }).ok, true);
  });

  it("config.mjs validate (CLI): exit 0 for a Codex lane, exit 2 for a Claude lane", () => {
    const good = join(dirs.work, "good.json");
    const bad = join(dirs.work, "bad.json");
    writeFileSync(good, doc({ plan: { implementer: "codex", readOnly: true, isolated: false } }));
    writeFileSync(bad, doc({ "plan-critique": { implementer: "claude", readOnly: true, isolated: false } }));
    const ok = runNode(CONFIG_SCRIPT, ["validate", good]);
    assert.equal(ok.status, 0, ok.stderr);
    const rejected = runNode(CONFIG_SCRIPT, ["validate", bad]);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /isolated/);
  });
});

// =============================================================================================
// Normalization
// =============================================================================================

describe("lane.normalizeDials", () => {
  const nd = (key, raw) => {
    assert.equal(typeof lane.normalizeDials, "function", "lane.mjs must export normalizeDials");
    return lane.normalizeDials(key, raw);
  };

  it("maps a Codex readOnly lane to sandbox read-only with no readOnly or isolated metadata", () => {
    const result = nd("codex", { readOnly: true });
    assert.deepEqual(result, { sandbox: "read-only" });
    assert.ok(!("readOnly" in result) && !("isolated" in result), "no extra metadata, no manufactured default");
  });

  it("preserves an explicit isolated value unchanged, true or false", () => {
    assert.deepEqual(nd("codex", { readOnly: true, isolated: false }), { sandbox: "read-only", isolated: false });
    assert.deepEqual(nd("codex", { readOnly: true, isolated: true }), { sandbox: "read-only", isolated: true });
    assert.deepEqual(nd("codex", { sandbox: "read-only", isolated: true }), { sandbox: "read-only", isolated: true });
    assert.deepEqual(nd("codex", { sandbox: "workspace-write", isolated: true, model: "model-a" }), { sandbox: "workspace-write", isolated: true, model: "model-a" });
  });

  it("keeps the existing sandbox when readOnly is also present, and other dials untouched", () => {
    assert.deepEqual(nd("codex", { readOnly: true, sandbox: "read-only", model: "m", effort: "high", timeout: "5m" }),
      { sandbox: "read-only", model: "m", effort: "high", timeout: "5m" });
    assert.deepEqual(nd("codex", {}), {});
  });

  it("does not manufacture isolation for any lane shape", () => {
    for (const raw of [{}, { readOnly: true }, { sandbox: "read-only" }, { sandbox: "workspace-write" }, { model: "m" }]) {
      assert.ok(!("isolated" in nd("codex", raw)), JSON.stringify(raw));
    }
  });

  it("does not mutate its input and returns a distinct object", () => {
    const raw = { readOnly: true, isolated: false, model: "m" };
    const before = JSON.stringify(raw);
    const result = nd("codex", raw);
    assert.equal(JSON.stringify(raw), before);
    assert.notEqual(result, raw);
  });

  it("leaves non-Codex implementers unchanged: Claude keeps readOnly and gains nothing", () => {
    assert.deepEqual(nd("claude", { readOnly: true, model: "opus", effort: "high" }), { readOnly: true, model: "opus", effort: "high" });
    assert.ok(!("isolated" in nd("claude", { readOnly: true })));
    assert.ok(!("sandbox" in nd("claude", { readOnly: true })));
  });

  it("existing mappings for other implementers keep working", () => {
    assert.deepEqual(nd("grok", { sandbox: "workspace", model: "g" }), { autonomy: "workspace-write", model: "g" });
    assert.deepEqual(nd("opencode", { readOnly: true, model: "opencode/grok" }), { agent: "plan", model: "opencode/grok" });
  });
});

// =============================================================================================
// Resolution through the fixture global config
// =============================================================================================

describe("lane resolution of stored lanes that never mention isolated", () => {
  before(() => writeGlobal({
    plan: { implementer: "codex", readOnly: true },
    "plan-critique": { implementer: "claude", readOnly: true, model: "opus" },
  }));
  after(() => clearGlobal());

  it("a stored Codex read-only lane resolves without isolated: the relay owns the runtime default", () => {
    const resolved = lane.resolveLaneForRelay(dirs.work, "plan", "codex");
    assert.equal(resolved.implementer, "codex");
    assert.equal(resolved.source, "global");
    assert.equal(resolved.skill, "codex-delegate");
    assert.deepEqual(resolved.dials, { sandbox: "read-only" });
  });

  it("the Claude-bound lane is untouched and still refused by the Codex relay", () => {
    assert.deepEqual(lane.resolveLaneForRelay(dirs.work, "plan-critique", "claude").dials, { readOnly: true, model: "opus" });
    assert.throws(() => lane.resolveLaneForRelay(dirs.work, "plan-critique", "codex"), /claude/);
  });
});

describe("lane resolution of lanes with an explicit isolated value", () => {
  const LANES = {
    "plan-opt-out": { implementer: "codex", readOnly: true, isolated: false },
    "plan-iso": { implementer: "codex", sandbox: "workspace-write", isolated: true },
  };
  before(() => writeGlobal(LANES));
  after(() => clearGlobal());

  it("an explicit isolated value reaches the relay unchanged", () => {
    assert.deepEqual(lane.resolveLaneForRelay(dirs.work, "plan-opt-out", "codex").dials, { sandbox: "read-only", isolated: false });
    assert.deepEqual(lane.resolveLaneForRelay(dirs.work, "plan-iso", "codex").dials, { sandbox: "workspace-write", isolated: true });
  });

  it("lane.mjs resolve (CLI) prints the dials a relay merges, including isolated", () => {
    const result = runNode(LANE_SCRIPT, ["resolve", "--cwd", dirs.work, "--lane", "plan-opt-out", "--implementer", "codex"]);
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(printed.dials, { sandbox: "read-only", isolated: false });
    assert.equal(printed.implementer, "codex");
  });
});

// =============================================================================================
// Overlays, persistence and project trust stay as they were
// =============================================================================================

describe("stored content, overlays and trust", () => {
  it("writeAtomic stores the document as given (isolated preserved, nothing injected) and returns its digest", () => {
    const target = join(dirs.work, "atomic", "config.json");
    const document = { version: "delegate-fleet.v1", lanes: { plan: { implementer: "codex", readOnly: true, isolated: false }, review: { implementer: "codex", readOnly: true } } };
    const digest = config.writeAtomic(target, document);
    const bytes = readFileSync(target);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), document);
    assert.equal(digest, sha(bytes));
    assert.deepEqual(config.readConfigFile(target).document, document);
    assert.ok(!("isolated" in config.readConfigFile(target).document.lanes.review), "the default is never written into stored lanes");
  });

  it("a project lane replaces a global lane wholesale; no field-level merge of isolated", () => {
    const merged = config.effectiveLanes(
      { lanes: { review: { implementer: "codex", readOnly: true, isolated: true }, plan: { implementer: "codex", readOnly: true } } },
      { lanes: { review: { implementer: "codex", readOnly: true } } },
    );
    assert.deepEqual(merged.review, { lane: { implementer: "codex", readOnly: true }, source: "project" });
    assert.deepEqual(merged.plan, { lane: { implementer: "codex", readOnly: true }, source: "global" });
  });

  describe("project configuration and approval", { skip: HAS_GIT ? false : "git not available" }, () => {
    let counter = 0;
    /** A fresh git repository whose project config was written and approved through config.mjs. */
    function approvedProject(stored) {
      counter += 1;
      const repo = join(root, `project-${counter}`);
      mkdirSync(repo, { recursive: true });
      const git = spawnSync("git", ["init", "-q", repo], { env: childEnv(), encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
      const input = join(dirs.work, `project-lanes-${counter}.json`);
      writeFileSync(input, JSON.stringify(stored));
      const written = runNode(CONFIG_SCRIPT, ["write", "--scope", "project", "--cwd", repo, input]);
      assert.equal(written.status, 0, written.stderr);
      assert.equal(JSON.parse(written.stdout).projectTrusted, true);
      return {
        repo,
        projectPath: config.projectConfigPath(repo),
        trustPath: join(repo, ".git", "delegate-skills", "project-config.sha256"),
      };
    }
    const review = { version: "delegate-fleet.v1", lanes: { review: { implementer: "codex", readOnly: true } } };

    it("an approved Codex read-only lane stays byte-identical and resolves with no stored isolation default", () => {
      const { repo, projectPath, trustPath } = approvedProject(review);
      const bytes = readFileSync(projectPath);
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), review, "stored content has no injected defaults");
      assert.equal(readFileSync(trustPath, "utf8").trim(), sha(bytes), "approval hash is the digest of the stored bytes");

      const effective = config.loadEffective(repo);
      assert.equal(effective.projectTrusted, true);
      assert.deepEqual(effective.lanes.review, { implementer: "codex", readOnly: true, source: "project" });

      assert.deepEqual(lane.resolveLaneForRelay(repo, "review", "codex").dials, { sandbox: "read-only" });
      assert.deepEqual(readFileSync(projectPath), bytes, "resolving never rewrites the stored document");
      assert.equal(readFileSync(trustPath, "utf8").trim(), sha(bytes), "and never changes the approval hash");
    });

    it("an unapproved edit still loses trust, exactly as before", () => {
      const { repo, projectPath } = approvedProject(review);
      writeFileSync(projectPath, `${JSON.stringify({ ...review, lanes: { review: { implementer: "codex", readOnly: true, effort: "high" } } }, null, 2)}\n`);
      assert.equal(config.loadEffective(repo).projectTrusted, false);
      assert.throws(() => lane.resolveLaneForRelay(repo, "review", "codex"), /not trusted/);
    });

    it("a global lane's isolated value does not leak into a project lane of the same name", () => {
      const { repo } = approvedProject(review);
      writeGlobal({ review: { implementer: "codex", readOnly: true, isolated: true } });
      try {
        assert.deepEqual(config.loadEffective(repo).lanes.review, { implementer: "codex", readOnly: true, source: "project" });
        assert.deepEqual(lane.resolveLaneForRelay(repo, "review", "codex").dials, { sandbox: "read-only" });
      } finally {
        clearGlobal();
      }
    });

    it("adding isolated to a stored project lane is an ordinary edit: approval is lost until re-approved, then the value persists", () => {
      const { repo, projectPath } = approvedProject(review);
      const edited = { version: "delegate-fleet.v1", lanes: { review: { implementer: "codex", readOnly: true, isolated: false } } };
      writeFileSync(projectPath, `${JSON.stringify(edited, null, 2)}\n`);
      assert.equal(config.loadEffective(repo).projectTrusted, false);
      assert.throws(() => lane.resolveLaneForRelay(repo, "review", "codex"), /not trusted/);

      const input = join(dirs.work, "project-lanes-edited.json");
      writeFileSync(input, JSON.stringify(edited));
      const rewritten = runNode(CONFIG_SCRIPT, ["write", "--scope", "project", "--cwd", repo, input]);
      assert.equal(rewritten.status, 0, rewritten.stderr);
      assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).lanes.review.isolated, false, "isolated persists once approved");
      assert.equal(config.loadEffective(repo).projectTrusted, true);
      assert.deepEqual(lane.resolveLaneForRelay(repo, "review", "codex").dials, { sandbox: "read-only", isolated: false });
    });
  });
});
