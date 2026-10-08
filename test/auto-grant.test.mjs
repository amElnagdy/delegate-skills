import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('../skills/agy-delegate/scripts/relay.mjs', import.meta.url));
test('dry-run describes project grants without needing a brief, running agy, or writing config', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-grant-test-'));
  const cd = join(root, 'repo with spaces'); mkdirSync(cd);
  const env = { ...process.env, AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  const run = spawnSync(process.execPath, [relay, '--cd', cd, '--auto-grant-dry-run', '--allow-command', 'Get-Date'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.enabled, true);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.allow.includes(`write_file(${cd})`));
  assert.ok(plan.allow.some(x => x.includes('Get-Date')));
  assert.equal(existsSync(env.AGY_CONFIG_DIR), false);
  assert.equal(existsSync(env.DELEGATE_CONFIG_DIR), false);
});

test('project registry reuses ids, writes nested BOM-free grants, and preserves user data', async () => {
  const { prepareAutoGrant } = await import('../skills/agy-delegate/scripts/auto-grant.mjs');
  const root = mkdtempSync(join(tmpdir(), 'agy-grant-test-'));
  const cd = join(root, 'repo'); mkdirSync(cd);
  const env = { AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  const opts = { cd, addDirs: [], allowCommands: ['Get-Date'], autoGrant: true };
  const first = prepareAutoGrant(opts, { env });
  const raw = readFileSync(first.projectPath);
  assert.notEqual(raw.subarray(0, 3).toString('hex'), 'efbbbf');
  const doc = JSON.parse(raw);
  assert.ok(doc.permissionGrants.permissionGrants.allow.includes(`write_file(${cd})`));
  doc.custom = 'keep';
  doc.permissionGrants.permissionGrants.allow.push('command(regex:user-special .*)');
  doc.permissionGrants.permissionGrants.deny.push('command(regex:user-deny .*)');
  writeFileSync(first.projectPath, JSON.stringify(doc));
  const next = prepareAutoGrant({ ...opts, allowCommands: [] }, { env });
  assert.equal(next.projectId, first.projectId);
  const updated = JSON.parse(readFileSync(next.projectPath, 'utf8'));
  assert.equal(updated.custom, 'keep');
  assert.ok(updated.permissionGrants.permissionGrants.allow.includes('command(regex:user-special .*)'));
  assert.ok(updated.permissionGrants.permissionGrants.deny.includes('command(regex:user-deny .*)'));
  assert.equal(updated.permissionGrants.permissionGrants.allow.some(x => x.includes('Get-Date')), false);
  const fresh = prepareAutoGrant({ ...opts, newProject: true }, { env });
  assert.notEqual(fresh.projectId, first.projectId);
});

test('read-only, bypass, opt-out, and resumes create no project grants', async () => {
  const { prepareAutoGrant } = await import('../skills/agy-delegate/scripts/auto-grant.mjs');
  const root = mkdtempSync(join(tmpdir(), 'agy-grant-test-'));
  const env = { AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  for (const flags of [{ readOnly: true }, { dangerouslySkipPermissions: true }, { autoGrant: false }, { resumeLast: true }, { conversation: 'abc' }]) {
    const r = prepareAutoGrant({ cd: root, autoGrant: true, ...flags }, { env });
    assert.equal(r.enabled, false);
  }
  assert.equal(existsSync(env.AGY_CONFIG_DIR), false);
});

test('malformed registry fails without replacing it or creating a project', async () => {
  const { prepareAutoGrant } = await import('../skills/agy-delegate/scripts/auto-grant.mjs');
  const root = mkdtempSync(join(tmpdir(), 'agy-grant-test-'));
  const env = { AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  mkdirSync(env.DELEGATE_CONFIG_DIR);
  const path = join(env.DELEGATE_CONFIG_DIR, 'agy-projects.json');
  writeFileSync(path, '{invalid');
  assert.throws(() => prepareAutoGrant({ cd: root, autoGrant: true }, { env }), /invalid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{invalid');
  assert.equal(existsSync(env.AGY_CONFIG_DIR), false);
});

test('concurrent project preparation preserves every workspace registry entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-concurrent-test-'));
  const env = { ...process.env, AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  const moduleURL = new URL('../skills/agy-delegate/scripts/auto-grant.mjs', import.meta.url).href;
  const dirs = Array.from({ length: 4 }, (_, i) => join(root, `repo-${i}`));
  dirs.forEach(cd => mkdirSync(cd));
  await Promise.all(dirs.map(cd => new Promise((resolve, reject) => {
    const code = `import { prepareAutoGrant } from ${JSON.stringify(moduleURL)}; prepareAutoGrant({ cd: ${JSON.stringify(cd)}, autoGrant: true });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', d => { error += d; });
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve() : reject(new Error(error)));
  })));
  const registry = JSON.parse(readFileSync(join(env.DELEGATE_CONFIG_DIR, 'agy-projects.json')));
  assert.equal(Object.keys(registry.projects).length, dirs.length);
  assert.equal(new Set(Object.values(registry.projects).map(x => x.projectId)).size, dirs.length);
});

test('explicit projects keep user grants and reject missing ids, names, and unsafe command values', async () => {
  const { prepareAutoGrant } = await import('../skills/agy-delegate/scripts/auto-grant.mjs');
  const root = mkdtempSync(join(tmpdir(), 'agy-explicit-test-'));
  const env = { AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') };
  const r = prepareAutoGrant({ cd: root }, { env });
  const opts = { cd: root, project: r.projectId, allowCommands: [] };
  assert.equal(prepareAutoGrant(opts, { env }).projectId, r.projectId);
  assert.throws(() => prepareAutoGrant({ ...opts, project: '../escape' }, { env }), /UUID/);
  assert.throws(() => prepareAutoGrant({ ...opts, project: '00000000-0000-0000-0000-000000000000' }, { env }), /not found/);
  assert.throws(() => prepareAutoGrant({ ...opts, allowCommands: ['node; whoami'] }, { env }), /invalid allow-command/);
});
