import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareAutoGrant } from '../skills/agy-delegate/scripts/auto-grant.mjs';
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'agy-review-'));
  const cd = join(root, 'project # unicode-تجربة'); fs.mkdirSync(cd);
  return { root, cd, env: { AGY_CONFIG_DIR: join(root, 'agy'), DELEGATE_CONFIG_DIR: join(root, 'delegate') } };
}
test('project resources use escaped file URLs and removed extra workspaces are revoked', () => {
  const { root, cd, env } = fixture();
  const extra = join(root, 'extra'); fs.mkdirSync(extra);
  const first = prepareAutoGrant({ cd, addDirs: [extra] }, { env });
  const doc = JSON.parse(fs.readFileSync(first.projectPath));
  assert.ok(doc.projectResources.resources.some(x => x.folderUri === pathToFileURL(cd).href));
  const next = prepareAutoGrant({ cd }, { env });
  const updated = JSON.parse(fs.readFileSync(next.projectPath));
  assert.equal(updated.projectResources.resources.some(x => x.folderUri === pathToFileURL(extra).href), false);
  assert.equal(updated.permissionGrants.permissionGrants.allow.includes(`write_file(${extra})`), false);
});
test('project schemas are validated without replacing malformed user data', () => {
  for (const resources of [null, [], { resources: [null] }, { resources: ['bad'] }]) {
    const { cd, env } = fixture();
    const r = prepareAutoGrant({ cd }, { env });
    const doc = JSON.parse(fs.readFileSync(r.projectPath)); doc.projectResources = resources;
    fs.writeFileSync(r.projectPath, JSON.stringify(doc));
    const raw = fs.readFileSync(r.projectPath, 'utf8');
    assert.throws(() => prepareAutoGrant({ cd }, { env }), /projectResources/);
    assert.equal(fs.readFileSync(r.projectPath, 'utf8'), raw);
  }
});
test('command patterns do not approve a command merely containing the allowed name', () => {
  const { cd, env } = fixture();
  const r = prepareAutoGrant({ cd, allowCommands: ['pytest'] }, { env, dryRun: true });
  const rules = r.allow.filter(x => x.startsWith('command(regex:')).map(x => new RegExp(x.slice(14, -1)));
  assert.ok(rules.some(re => re.test('pytest tests')));
  assert.equal(rules.some(re => re.test('evil-pytest tests')), false);
  assert.equal(rules.some(re => re.test('echoevil')), false);
});
for (const stage of ['project', 'registry-final']) test(`interrupted ${stage} write recovers without losing grant ownership`, t => {
  const { cd, env } = fixture();
  const first = prepareAutoGrant({ cd, allowCommands: ['OldCommand'] }, { env });
  const projectBefore = JSON.parse(fs.readFileSync(first.projectPath));
  projectBefore.permissionGrants.permissionGrants.allow.push('command(regex:user-special .*)');
  fs.writeFileSync(first.projectPath, JSON.stringify(projectBefore));
  const original = fs.renameSync;
  let registryWrites = 0;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === first.registryPath) registryWrites++;
    if ((stage === 'project' && to === first.projectPath) || (stage === 'registry-final' && to === first.registryPath && registryWrites === 2)) {
      const error = new Error('simulated write interruption'); error.code = 'EIO'; throw error;
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => prepareAutoGrant({ cd, allowCommands: ['TemporaryCommand'] }, { env }), /interruption/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const pending = JSON.parse(fs.readFileSync(first.registryPath));
  assert.ok(pending.pending, 'ownership needs a durable pending transaction');
  const next = prepareAutoGrant({ cd, allowCommands: [] }, { env });
  const project = JSON.parse(fs.readFileSync(next.projectPath));
  const allow = project.permissionGrants.permissionGrants.allow;
  assert.ok(allow.includes('command(regex:user-special .*)'));
  assert.equal(allow.some(x => /OldCommand|TemporaryCommand/.test(x)), false);
  assert.equal(JSON.parse(fs.readFileSync(first.registryPath)).pending, undefined);
});

test('pending recovery refuses external edits and dry-run preserves all bytes', t => {
  const { cd, env } = fixture();
  const first = prepareAutoGrant({ cd }, { env });
  const original = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === first.projectPath) throw new Error('simulated interruption');
    return original(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => prepareAutoGrant({ cd, allowCommands: ['TemporaryCommand'] }, { env }), /interruption/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const rawRegistry = fs.readFileSync(first.registryPath, 'utf8');
  assert.throws(() => prepareAutoGrant({ cd }, { env, dryRun: true }), /needs recovery/);
  assert.equal(fs.readFileSync(first.registryPath, 'utf8'), rawRegistry);
  const project = JSON.parse(fs.readFileSync(first.projectPath)); project.externalEdit = 'preserve';
  const rawProject = JSON.stringify(project); fs.writeFileSync(first.projectPath, rawProject);
  assert.throws(() => prepareAutoGrant({ cd }, { env }), /project changed/);
  assert.equal(fs.readFileSync(first.projectPath, 'utf8'), rawProject);
  assert.equal(fs.readFileSync(first.registryPath, 'utf8'), rawRegistry);
});
