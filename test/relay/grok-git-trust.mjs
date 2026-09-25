import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

export async function runGrokGitTrust(h) {
  const config = join(h.scratch, "grok-trust.gitconfig");
  const originalConfig = "[safe]\n\tdirectory =\n";
  writeFileSync(config, originalConfig);
  const env = {
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "",
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", SMOKE_MODE: "grok-read-only",
  };
  const git = (cwd, args) => {
    const r = spawnSync("git", ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, ...args],
      { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture Git failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  let counter = 0;
  const run = async (cwd, flags = [], overrides = {}) => {
    const out = join(h.scratch, `grok-trust-out-${counter++}`);
    const child = h.runRelay("grok", cwd, out, ["--read-only", "--timeout", "10s", ...flags], { ...env, ...overrides });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const result = existsSync(join(out, "result.json")) ? h.result(out) : null;
    return { code, result, stderr };
  };
  const completed = (name, run, touched, violation) => {
    // Surface the relay's fail() cause in CI logs when a case dies pre-dispatch.
    if (run.code !== 0 || !run.result) {
      console.error(`  relay stderr for ${name}: ${run.stderr.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    }
    h.check(`${name}: completed result contract`, run.code === 0 &&
      run.result?.schema === "delegate-relay.result.v1" && run.result.status === "completed" &&
      run.result.exitCode === 0 && run.result.signal === null && run.result.autonomy === "read-only");
    h.check(`${name}: exact touchedFiles`, JSON.stringify(run.result?.touchedFiles) === JSON.stringify(touched));
    h.check(`${name}: readOnlyViolation`, run.result?.readOnlyViolation === violation);
  };
  const root = h.freshRepo("grok-trust root");
  git(root, ["config", "core.autocrlf", "false"]);
  const flags = ["--trust-git-root", root];
  const untrusted = await run(root);
  completed("grok untrusted ownership", untrusted, null, null);
  h.check("grok trust defaults off", untrusted.result?.trustedGitRoot === null);
  const clean = await run(root, flags);
  completed("grok explicit root", clean, [], false);
  h.check("grok records canonical trust", clean.result?.trustedGitRoot === realpathSync(root).replaceAll("\\", "/"));

  // Regression guard for canonical divergence: this symlink case guards the
  // as-given vs realpath divergence via symlinks, while the case-divergent
  // root case below covers git-vs-Node spelling divergence portably.
  const alias = join(h.scratch, "grok-trust-alias");
  let aliased = false;
  try {
    symlinkSync(root, alias, "dir");
    aliased = true;
  } catch {
    console.log("  skip  grok trust path alias: host cannot create directory symlinks");
  }
  if (aliased) {
    const aliasRun = await run(alias, ["--trust-git-root", alias]);
    completed("grok symlinked root", aliasRun, [], false);
    h.check("grok symlinked root records canonical trust", aliasRun.result?.trustedGitRoot === realpathSync(alias).replaceAll("\\", "/"));
  }

  writeFileSync(join(root, "dirty.txt"), "before\n");
  completed("grok pre-dirty unchanged", await run(root, flags), ["?? dirty.txt"], false);
  completed("grok same dirty path changed", await run(root, flags, { SMOKE_APPEND_FILE: "dirty.txt" }), ["?? dirty.txt"], true);
  const nested = join(root, "nested");
  mkdirSync(nested);
  completed("grok nested cwd", await run(nested, flags), ["?? dirty.txt"], false);

  // Windows CI's 8.3 temp path makes git's toplevel spelling differ from Node's
  // realpath of the same directory. A case-insensitive filesystem reproduces that
  // divergence portably — git reports on-disk case, Node keeps the given case — so
  // this case red/greens the guard bug locally instead of needing Windows.
  const upperRoot = join(dirname(root), basename(root).toUpperCase());
  if (upperRoot !== root && existsSync(upperRoot)) {
    completed("grok case-divergent root", await run(upperRoot, ["--trust-git-root", upperRoot]),
      ["?? dirty.txt"], false);
  } else {
    console.log("  skip  grok case-divergent root: case-sensitive filesystem");
  }

  git(root, ["add", "dirty.txt"]);
  git(root, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
  const linked = join(h.scratch, "grok-linked-worktree");
  git(root, ["worktree", "add", "--detach", linked]);
  completed("grok linked worktree", await run(linked, ["--trust-git-root", linked]), [], false);

  const sub = join(root, "submodule");
  mkdirSync(sub);
  git(sub, ["init", "-q"]);
  writeFileSync(join(sub, "tracked.txt"), "submodule\n");
  git(sub, ["add", "tracked.txt"]);
  git(sub, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${git(sub, ["rev-parse", "HEAD"])},submodule`]);
  const subResult = await run(root, flags);
  h.check("grok dirty submodule remains incomplete", subResult.code === 0 && subResult.result?.readOnlyViolation === null &&
    subResult.result?.touchedFiles?.some(line => line.endsWith("submodule")));
  completed("grok nested repo not implicitly trusted", await run(sub, flags), null, null);

  for (const [name, cwd, trusted] of [
    ["unrelated root", linked, root], ["subdirectory as root", nested, nested],
    ["wildcard", root, "*"], ["missing root", root, join(root, "missing")],
  ]) {
    const rejected = await run(cwd, ["--trust-git-root", trusted]);
    h.check(`grok rejects ${name} before dispatch`, rejected.code === 2 && rejected.result === null && rejected.stderr.includes("--trust-git-root"));
  }
  const missingGitPath = [join(h.scratch, "shim"), dirname(process.execPath),
    ...(h.WIN ? [join(process.env.SystemRoot, "System32")] : [])].join(delimiter);
  completed("grok Git unavailable", await run(root, [], { PATH: missingGitPath }), null, null);
  const missingGit = await run(root, flags, { PATH: missingGitPath });
  h.check("grok explicit trust requires Git", missingGit.code === 2 && missingGit.result === null);
  h.check("grok leaves global Git config unchanged", readFileSync(config, "utf8") === originalConfig);
}
