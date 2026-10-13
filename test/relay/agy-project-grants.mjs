import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runAgyProjectGrants(h) {
  const tests = spawnSync(process.execPath, ['--test', join(h.testDir, 'auto-grant.test.mjs'), join(h.testDir, 'auto-grant-review.test.mjs')],
    { encoding: 'utf8', timeout: 30000 });
  h.check('agy project grants: schema, preservation, concurrency, interruption recovery and dry-run regressions', tests.status === 0);
  if (tests.status !== 0) console.error(tests.stdout, tests.stderr);
  const cd = h.freshRepo('agy-project-grants');
  const config = join(h.scratch, 'agy-off-config');
  const registry = join(h.scratch, 'agy-off-registry');
  const env = { ...h.baseEnv, AGY_CONFIG_DIR: config, DELEGATE_CONFIG_DIR: registry, SMOKE_MODE: 'agy-analysis' };
  const run = (name, args = []) => {
    const out = join(h.scratch, name);
    const child = spawnSync(process.execPath, [h.relayPath('agy'), '--brief', h.briefPath, '--cd', cd, '--out-dir', out, ...args],
      { env, encoding: 'utf8', timeout: 15000 });
    return { child, value: existsSync(join(out, 'result.json')) ? h.result(out) : null };
  };
  const normal = run('agy-no-opt-in');
  h.check('agy project grants: default dispatch does not mutate permission config', normal.child.status === 0 && !existsSync(config) && !existsSync(registry) && !normal.value.autoGrant.enabled);
  const absent = run('agy-command-without-opt-in', ['--allow-command', 'pytest']);
  h.check('agy project grants: command approvals require opt-in', absent.child.status === 2 && !existsSync(config));
  const lanePath = join(h.scratch, 'agy-grant-lane.json');
  writeFileSync(lanePath, JSON.stringify({ version: 'delegate-fleet.v1', lanes: { implementation: { implementer: 'agy', autoGrant: true, allowCommands: ['pytest'] } } }));
  const validator = join(h.testDir, '../skills/delegate-setup/scripts/config.mjs');
  const laneValid = spawnSync(process.execPath, [validator, 'validate', lanePath], { encoding: 'utf8' });
  h.check('agy project grants: fleet accepts boolean opt-in and command-name array', laneValid.status === 0);
  const optIn = run('agy-with-opt-in', ['--auto-grant']);
  h.check('agy project grants: opt-in prepares project approvals and records the requested UUID', optIn.child.status === 0 && optIn.value.autoGrant.enabled && existsSync(optIn.value.autoGrant.projectPath));
  env.SMOKE_MODE = 'agy-wrong-project';
  const wrong = run('agy-wrong-project', ['--auto-grant']);
  h.check('agy project grants: CLI fallback to another project fails rather than inventing a matching ID', wrong.child.status === 1 && wrong.value.projectId === 'default-cli-project' && wrong.value.error.includes('instead of the managed project'));
  env.SMOKE_MODE = 'agy-analysis';
  const xdg = join(h.scratch, 'agy-lane-config');
  mkdirSync(join(xdg, 'delegate-skills'), { recursive: true });
  writeFileSync(join(xdg, 'delegate-skills/config.json'), JSON.stringify({ version: 'delegate-fleet.v1', lanes: { implementation: { implementer: 'agy', autoGrant: true, allowCommands: ['pytest'] } } }));
  env.XDG_CONFIG_HOME = xdg;
  const lane = run('agy-lane-opt-in', ['--lane', 'implementation']);
  h.check('agy project grants: fleet lane enables approvals and command extras', lane.child.status === 0 && lane.value.autoGrant.enabled && lane.value.autoGrant.allow.some(rule => rule.includes('pytest')));
  const optOut = run('agy-lane-opt-out', ['--lane', 'implementation', '--no-auto-grant']);
  h.check('agy project grants: explicit opt-out wins over fleet opt-in', optOut.child.status === 0 && !optOut.value.autoGrant.enabled);
  if (h.WIN) {
    for (const flags of [['--project', optIn.value.project], ['--resume-last'], ['--conversation', 'existing']]) {
      const blocked = run(`agy-readonly-inherited-${flags[0].slice(2)}`, ['--read-only', ...flags]);
      h.check(`agy project grants: Windows read-only rejects inherited ${flags[0]}`, blocked.child.status === 2 && blocked.value === null);
    }
  }
}
