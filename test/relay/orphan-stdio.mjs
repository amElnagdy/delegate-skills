import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A relay must settle when the implementer exits normally but leaves behind a detached
// grandchild that inherited the stdio pipes. "exit" fires; "close" does not, because the
// orphan still holds the pipes. A relay that settles only on "close" waits forever and
// writes no result.json, so the orchestrator sees a run that neither completed nor failed.
//
// The watchdog is not a backstop: a run without --timeout has none, and one with a timeout
// mislabels a successful run as "timeout".
export async function runOrphanStdio(h) {
for (const skill of h.SKILLS) {
  const outDir = join(h.scratch, `out-orphanmx-${skill}`);
  const grandPidFile = join(h.scratch, `grandpid-orphanmx-${skill}`);
  const run = spawnSync(process.execPath,
    [h.relayPath(skill), "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-orphanmx-${skill}`), "--out-dir", outDir, ...h.EXTRA_ARGS[skill]],
    {
      env: { ...h.baseEnv, SMOKE_MODE: "orphan-holds-stdio", SMOKE_GRAND_PID_FILE: grandPidFile },
      encoding: "utf8",
      timeout: 25_000,
    });
  h.check(`${skill} orphan: the relay exits instead of waiting on the held pipes`,
    run.signal === null);
  h.check(`${skill} orphan: result.json exists`, existsSync(join(outDir, "result.json")));
  // The relay does not own a detached orphan on the normal-exit path; do not leak it.
  if (existsSync(grandPidFile)) {
    try { process.kill(Number(readFileSync(grandPidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
}

// If the implementer exits inside the last 500 ms of --timeout while an orphan holds
// the pipes, the drain grace overlaps the remaining watchdog budget. The watchdog then
// fires, sets watchdogFired, and close reports timeout for a run that already succeeded.
for (const skill of h.SKILLS) {
  const outDir = join(h.scratch, `out-orphan-watchdog-${skill}`);
  const grandPidFile = join(h.scratch, `grandpid-orphan-watchdog-${skill}`);
  const run = spawnSync(process.execPath,
    [h.relayPath(skill), "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-orphan-watchdog-${skill}`), "--out-dir", outDir,
      "--timeout", "1s", ...h.EXTRA_ARGS[skill]],
    {
      env: {
        ...h.baseEnv,
        SMOKE_MODE: "orphan-holds-stdio",
        SMOKE_GRAND_PID_FILE: grandPidFile,
        SMOKE_ORPHAN_EXIT_DELAY_MS: "800",
      },
      encoding: "utf8",
      timeout: 25_000,
    });
  const result = existsSync(join(outDir, "result.json")) ? h.result(outDir) : null;
  h.check(`${skill} orphan-near-timeout: the relay exits`, run.signal === null);
  if (skill === "claude" || skill === "cline") {
    // These relays treat a missing result event as failed even on a 0 child exit.
    h.check(`${skill} orphan-near-timeout: the watchdog does not relabel the run as timeout (got ${result?.status})`,
      result != null && result.status !== "timeout");
  } else {
    h.check(`${skill} orphan-near-timeout: a successful run is completed, not timeout (got ${result?.status}, exit ${result?.exitCode})`,
      result?.status === "completed" && result.exitCode === 0);
  }
  if (existsSync(grandPidFile)) {
    try { process.kill(Number(readFileSync(grandPidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
}
}
