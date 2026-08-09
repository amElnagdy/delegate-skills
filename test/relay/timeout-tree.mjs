import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runTimeoutTree(h) {
const TIMEOUT_CASES = [
  { skill: "claude", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "codex", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "opencode", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "grok", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "kimi", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "qoder", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "pi", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "cursor", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "vibe", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
  { skill: "agy", flags: ["--timeout", "6s"], exitDeadline: 45_000 },
];
async function driveTimeout({ skill, flags, exitDeadline }, mode, extraEnv, tag) {
  const outDir = join(h.scratch, `out-${tag}-${skill}`);
  const pidFile = join(h.scratch, `pid-${tag}-${skill}`);
  const grandPidFile = join(h.scratch, `grandpid-${tag}-${skill}`);
  const workDir = h.freshRepo(`work-${tag}-${skill}`);
  const child = h.runRelay(skill, workDir, outDir, [...flags, ...h.EXTRA_ARGS[skill]], { SMOKE_PID_FILE: pidFile, SMOKE_GRAND_PID_FILE: grandPidFile, SMOKE_MODE: mode, ...extraEnv });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  h.check(`${skill} ${tag}: the fake implementer came up`, await h.until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), exitDeadline);
    child.on("close", () => { clearTimeout(t); res(true); });
  });
  h.check(`${skill} ${tag}: the relay exited on its own`, exited);
  h.check(`${skill} ${tag}: result.json exists`, existsSync(join(outDir, "result.json")));
  if (existsSync(join(outDir, "result.json"))) {
    const r = h.result(outDir);
    h.check(`${skill} ${tag}: status is "timeout" (got ${r.status})`, r.status === "timeout");
    h.check(`${skill} ${tag}: relay exit code is non-zero`, r.exitCode !== 0);
    if (skill === "agy") {
      const timeoutIndex = flags.indexOf("--timeout");
      const expectedLimit = timeoutIndex === -1
        ? `--print-timeout ${flags[flags.indexOf("--print-timeout") + 1]} plus 60s grace`
        : `--timeout ${flags[timeoutIndex + 1]}`;
      h.check(`agy ${tag}: selected limit is named in the result`, r.error?.includes(expectedLimit));
    }
  }
  h.check(`${skill} ${tag}: the implementer process is dead`,
    implementerPid !== null && await h.until(() => !h.alive(implementerPid), 20_000));
  h.check(`${skill} ${tag}: the implementer's own subprocess is dead (whole tree felled)`,
    grandPid !== null && await h.until(() => !h.alive(grandPid), 20_000));
  if (h.failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
}

for (const tc of TIMEOUT_CASES) {
  await driveTimeout(tc, "timeout", {}, "timeout");
}
await driveTimeout(
  { skill: "agy", flags: ["--print-timeout", "1s", "--timeout", "4s"], exitDeadline: 45_000 },
  "timeout",
  {},
  "timeout-precedence",
);

// A compliant parent must not shield a defiant descendant: the parent exits on the group
// SIGTERM, its grandchild ignores it, and the sweep at close must still fell the grandchild
// before the relay reports. POSIX only — the Windows kill is a single unconditional
// taskkill /t /f with no SIGTERM/escalation phase to defeat.
if (!h.WIN) {
  for (const tc of TIMEOUT_CASES) {
    await driveTimeout(tc, "timeout-yield", { SMOKE_GRAND_IGNORES_SIGTERM: "1" }, "timeout-yield");
  }
}
}
