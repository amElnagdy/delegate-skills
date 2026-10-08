import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBootstrap, checkBootstrap, editConfigToml, parseArgs, planBootstrap, readManaged, run } from './bootstrap.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const BEGIN = '# BEGIN codex-background';
const edit = (text, extra = {}) => editConfigToml(text, { command: 'C:/node/node.exe', serverPath: 'C:/skills/codex-background/scripts/server.mjs', timeoutSeconds: 7200, registryPath: 'C:/codex/codex-background/registry.json', ...extra });
const count = (text, needle) => text.split(needle).length - 1;

function sandbox(keys = ['agy', 'codex']) {
  const root = mkdtempSync(join(tmpdir(), 'cb-bootstrap-')); roots.push(root);
  const s = { root, home: join(root, 'home'), codexHome: join(root, 'codex'), skills: join(root, 'skills'), ws: join(root, 'work') };
  mkdirSync(s.home); mkdirSync(s.ws);
  s.addRelay = key => { const dir = join(s.skills, `${key}-delegate`, 'scripts'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'relay.mjs'), '// stub relay\n'); };
  keys.forEach(s.addRelay);
  s.common = { codexHome: s.codexHome, skillsDir: s.skills, homeDir: s.home };
  s.config = join(s.codexHome, 'config.toml'); s.registry = join(s.codexHome, 'codex-background', 'registry.json');
  s.boot = (extra = {}) => { const plan = planBootstrap({ ...s.common, ...extra }); return { plan, applied: applyBootstrap(plan) }; };
  s.cli = async args => { const out = [], err = []; const code = await run(['--codex-home', s.codexHome, '--skills-dir', s.skills, ...args], { homeDir: s.home, out: l => out.push(l), err: l => err.push(l) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  s.backups = () => existsSync(s.codexHome) ? readdirSync(s.codexHome).filter(f => f.includes('.bak-')) : [];
  return s;
}

test('fresh install creates registry and config, and the server lists its tools', async () => {
  const s = sandbox();
  const { plan } = s.boot();
  assert.deepEqual([plan.registry.status, plan.config.status], ['create', 'create']);
  const registry = JSON.parse(readFileSync(s.registry, 'utf8'));
  assert.equal(registry.schema, 'codex-background.registry.v1');
  assert.equal(registry.hostToolTimeoutSeconds, 7200);
  assert.deepEqual(Object.keys(registry.relays), ['agy', 'codex']);
  assert.deepEqual(registry.workspaceRoots, [s.home.replaceAll('\\', '/')]);
  assert.equal(registry.artifactRoots[0], join(s.codexHome, 'codex-background').replaceAll('\\', '/'));
  for (const dir of ['state', 'briefs', 'runs']) assert.ok(existsSync(join(s.codexHome, 'codex-background', dir)));
  const managed = readManaged(readFileSync(s.config, 'utf8'));
  assert.equal(managed.values.required, true); assert.equal(managed.values.tool_timeout_sec, 7200);
  assert.deepEqual(managed.namespaces, ['mcp__codex_background']);
  assert.deepEqual(s.backups(), []);
  const check = await checkBootstrap(s.common);
  assert.ok(check.ok, JSON.stringify(check.items));
  assert.ok(check.items.some(item => item.name.includes('tools/list') && item.ok));
  assert.ok(check.items.some(item => item.name.includes('implementer enum') && item.ok));
});

test('unrelated config bytes (CRLF, comments, other tables) are preserved and a backup is written', () => {
  const s = sandbox();
  const original = ['# my codex config', 'model = "gpt" # inline', '', '[features]', 'foo = true', '', '[mcp_servers.other]', 'command = "npx"', 'args = ["a", "b"]', '', '[profiles.fast]', 'model = "y"', ''].join('\r\n');
  mkdirSync(s.codexHome); writeFileSync(s.config, original);
  s.boot();
  const result = readFileSync(s.config, 'utf8');
  assert.ok(result.startsWith(original));
  assert.ok(result.slice(original.length).startsWith(`\r\n${BEGIN}`));
  assert.ok(!/(?<!\r)\n/.test(result), 'every added line uses CRLF');
  assert.equal(count(result, '[features.code_mode]'), 1);
  assert.equal(count(result, '[features]'), 1);
  const backups = s.backups().filter(f => f.startsWith('config.toml.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(s.codexHome, backups[0]), 'utf8'), original);
});

test('migrates the hand-written setup without duplicating tables or the namespace', () => {
  const s = sandbox();
  const original = ['# top', 'model = "x"', '', '[mcp_servers.codex_background]', 'command = "C:/Program Files/nodejs/node.exe"', 'args = ["C:/old/codex-background/scripts/server.mjs"]', 'tool_timeout_sec = 7200', 'required = true', 'startup_timeout_sec = 60', '', '[mcp_servers.codex_background.env]', 'CODEX_BACKGROUND_REGISTRY = "C:/old/registry.json"', '', '[features.code_mode]', 'direct_only_tool_namespaces = ["mcp__codex_background"]', '', '[projects.foo]', 'trust_level = "trusted"', ''].join('\n');
  mkdirSync(s.codexHome); writeFileSync(s.config, original);
  const { plan } = s.boot();
  assert.deepEqual(plan.config.dropped, ['startup_timeout_sec']);
  const result = readFileSync(s.config, 'utf8');
  assert.equal(count(result, '[mcp_servers.codex_background]'), 1);
  assert.equal(count(result, '[mcp_servers.codex_background.env]'), 1);
  assert.equal(count(result, '[features.code_mode]'), 1);
  assert.equal(count(result, 'mcp__codex_background'), 1);
  assert.ok(result.startsWith(`# top\nmodel = "x"\n\n${BEGIN}`));
  assert.ok(result.endsWith('[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__codex_background"]\n\n[projects.foo]\ntrust_level = "trusted"\n'));
  const managed = readManaged(result);
  assert.equal(managed.values.args[0].endsWith('/codex-background/scripts/server.mjs'), true);
  assert.notEqual(managed.values.args[0], 'C:/old/codex-background/scripts/server.mjs');
  assert.equal(managed.envValues.CODEX_BACKGROUND_REGISTRY, join(s.codexHome, 'codex-background', 'registry.json').replaceAll('\\', '/'));
  assert.equal(managed.values.startup_timeout_sec, undefined);
  assert.equal(s.backups().length, 1);
});

test('existing [features.code_mode] gets the namespace appended in place', () => {
  const cases = [
    ['single line', '[features.code_mode]\nother = 1\ndirect_only_tool_namespaces = ["mcp__x"]\nmore = "y"\n', '[features.code_mode]\nother = 1\ndirect_only_tool_namespaces = ["mcp__x", "mcp__codex_background"]\nmore = "y"\n', ['mcp__x', 'mcp__codex_background']],
    ['multi-line with trailing comma', '[features.code_mode]\ndirect_only_tool_namespaces = [\n  "mcp__x", # keep\n  \'mcp__y\',\n]\nother = 1\n', '[features.code_mode]\ndirect_only_tool_namespaces = [\n  "mcp__x", # keep\n  \'mcp__y\',\n  "mcp__codex_background",\n]\nother = 1\n', ['mcp__x', 'mcp__y', 'mcp__codex_background']],
    ['multi-line without trailing comma', '[features.code_mode]\ndirect_only_tool_namespaces = [\n    "mcp__x", # keep\n    "mcp__y" # last\n]\n', '[features.code_mode]\ndirect_only_tool_namespaces = [\n    "mcp__x", # keep\n    "mcp__y", # last\n    "mcp__codex_background",\n]\n', ['mcp__x', 'mcp__y', 'mcp__codex_background']],
    ['empty array', '[features.code_mode]\ndirect_only_tool_namespaces = []\n', '[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__codex_background"]\n', ['mcp__codex_background']],
    ['closing bracket shares the last line', '[features.code_mode]\ndirect_only_tool_namespaces = [\n  "mcp__x",\n  "mcp__y"]\n', '[features.code_mode]\ndirect_only_tool_namespaces = [\n  "mcp__x",\n  "mcp__y", "mcp__codex_background"]\n', ['mcp__x', 'mcp__y', 'mcp__codex_background']],
    ['key absent', '[features.code_mode]\nother = 1\n', '[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__codex_background"]\nother = 1\n', ['mcp__codex_background']],
    ['namespace already present', '[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__codex_background", "mcp__x"]\n', '[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__codex_background", "mcp__x"]\n', ['mcp__codex_background', 'mcp__x']],
  ];
  for (const [name, before, after, namespaces] of cases) {
    const result = edit(before).text;
    assert.equal(result, `${after}\n${result.slice(after.length + 1)}`, name);
    assert.ok(result.slice(after.length + 1).startsWith(BEGIN), name);
    assert.equal(count(result, '[features.code_mode]'), 1, name);
    assert.deepEqual(readManaged(result).namespaces, namespaces, name);
  }
});

test('code_mode edits keep CRLF line endings', () => {
  const result = edit('[features.code_mode]\r\ndirect_only_tool_namespaces = [\r\n  "mcp__x",\r\n]\r\n').text;
  assert.ok(result.startsWith('[features.code_mode]\r\ndirect_only_tool_namespaces = [\r\n  "mcp__x",\r\n  "mcp__codex_background",\r\n]\r\n'));
  assert.ok(!/(?<!\r)\n/.test(result));
});

test('strings in managed values are escaped and read back', () => {
  const command = 'C:\\odd "dir"\\node\ttab.exe';
  const result = edit('', { command, registryPath: 'C:/a b/registry.json' }).text;
  assert.equal(readManaged(result).values.command, command);
  assert.equal(readManaged(result).envValues.CODEX_BACKGROUND_REGISTRY, 'C:/a b/registry.json');
});

test('second run is byte-identical, reports unchanged and adds no backup', () => {
  const s = sandbox();
  mkdirSync(s.codexHome); writeFileSync(s.config, 'model = "x"\n');
  s.boot();
  const files = [readFileSync(s.config, 'utf8'), readFileSync(s.registry, 'utf8')], backups = s.backups();
  assert.equal(backups.length, 1);
  const { plan, applied } = s.boot();
  assert.deepEqual([plan.registry.status, plan.config.status, applied.config.backup, applied.registry.backup], ['unchanged', 'unchanged', null, null]);
  assert.deepEqual([readFileSync(s.config, 'utf8'), readFileSync(s.registry, 'utf8')], files);
  assert.deepEqual(s.backups(), backups);
});

test('--dry-run and --check write nothing', async () => {
  const s = sandbox();
  const dry = await s.cli(['--dry-run', '--workspace-root', s.ws]);
  assert.equal(dry.code, 0, dry.err); assert.match(dry.out, /would create/); assert.match(dry.out, /nothing was written/);
  assert.ok(!existsSync(s.codexHome), 'dry run creates no codex home');
  assert.equal((await s.cli(['--check'])).code, 1);
  assert.ok(!existsSync(s.codexHome), 'check creates no codex home');

  mkdirSync(s.codexHome); writeFileSync(s.config, '# keep\n');
  const dryExisting = await s.cli(['--dry-run']);
  assert.equal(dryExisting.code, 0, dryExisting.err);
  assert.equal(readFileSync(s.config, 'utf8'), '# keep\n'); assert.deepEqual(readdirSync(s.codexHome), ['config.toml']);

  s.boot();
  const snapshot = [readFileSync(s.config, 'utf8'), readFileSync(s.registry, 'utf8'), readdirSync(s.codexHome).sort().join()];
  const check = await s.cli(['--check', '--json']);
  assert.equal(check.code, 0, check.out); assert.equal(JSON.parse(check.out).ok, true);
  assert.deepEqual([readFileSync(s.config, 'utf8'), readFileSync(s.registry, 'utf8'), readdirSync(s.codexHome).sort().join()], snapshot);
});

test('--check fails when the config no longer matches', async () => {
  const s = sandbox();
  s.boot();
  writeFileSync(s.config, readFileSync(s.config, 'utf8').replace('required = true', 'required = false'));
  const result = await s.cli(['--check']);
  assert.equal(result.code, 1); assert.match(result.out, /FAIL.*mcp_servers\.codex_background/);
});

test('conflicting or malformed code_mode/managed config is refused and left untouched', async () => {
  const bad = {
    'boolean code_mode': '[features]\ncode_mode = true\n',
    'inline code_mode': '[features]\ncode_mode = { direct_only_tool_namespaces = [] }\n',
    'dotted at root': 'features.code_mode.direct_only_tool_namespaces = ["x"]\n',
    'array of tables': '[[features.code_mode]]\nx = 1\n',
    'inline features': 'features = { code_mode = true }\n',
    'non-string array items': '[features.code_mode]\ndirect_only_tool_namespaces = [1, 2]\n',
    'unterminated array': '[features.code_mode]\ndirect_only_tool_namespaces = ["a",\n',
    'unterminated string': 'model = """abc\n',
    'duplicate managed tables': '[mcp_servers.codex_background]\ncommand = "a"\n[mcp_servers.codex_background]\ncommand = "b"\n',
    'managed table beside the block': `${BEGIN} (managed by x)\n[mcp_servers.codex_background]\ncommand = "a"\n# END codex-background\n[mcp_servers.codex_background]\ncommand = "b"\n`,
    'dotted managed key': 'mcp_servers.codex_background.command = "a"\n',
    'unbalanced markers': `${BEGIN} (managed by x)\nmodel = "x"\n`,
  };
  for (const [name, original] of Object.entries(bad)) {
    const s = sandbox();
    mkdirSync(s.codexHome); writeFileSync(s.config, original);
    assert.throws(() => edit(original), error => error.constructor.name === 'ConfigError', name);
    const plan = planBootstrap(s.common);
    assert.equal(plan.config.status, 'refused', name);
    applyBootstrap(plan);
    assert.equal(readFileSync(s.config, 'utf8'), original, name);
    assert.deepEqual(s.backups(), [], name);
    assert.ok(existsSync(s.registry), `${name}: registry may still be written`);
  }
  const s = sandbox();
  mkdirSync(s.codexHome); writeFileSync(s.config, '[features]\ncode_mode = true\n');
  const result = await s.cli([]);
  assert.equal(result.code, 1); assert.match(result.out, /NOT modified/); assert.match(result.out, /direct_only_tool_namespaces/);
});

test('unsupported platform is refused before anything is written', async () => {
  const s = sandbox();
  assert.throws(() => planBootstrap({ ...s.common, platform: 'darwin' }), /Unsupported host \(darwin\)/);
  assert.ok(!existsSync(s.codexHome));
  const out = [], err = [];
  const code = await run(['--codex-home', s.codexHome, '--skills-dir', s.skills], { platform: 'darwin', homeDir: s.home, out: l => out.push(l), err: l => err.push(l) });
  assert.equal(code, 1); assert.match(err.join('\n'), /Unsupported host/);
  assert.ok(!existsSync(s.codexHome));
});

test('zero relays is a clear error and writes nothing', async () => {
  const s = sandbox([]);
  mkdirSync(join(s.skills, 'delegate-setup', 'scripts'), { recursive: true }); mkdirSync(join(s.skills, 'empty-delegate'), { recursive: true });
  assert.throws(() => planBootstrap(s.common), /No \*-delegate skills .*Install at least one/);
  const result = await s.cli([]);
  assert.equal(result.code, 1); assert.match(result.err, /Install at least one/);
  assert.ok(!existsSync(s.codexHome));
});

test('re-run keeps customized roots and timeout, and refreshes relays', () => {
  const s = sandbox();
  const extra = join(s.root, 'extra'); mkdirSync(extra);
  s.boot({ workspaceRoots: [s.ws, extra], hostTimeout: 3600 });
  let registry = JSON.parse(readFileSync(s.registry, 'utf8'));
  assert.deepEqual(registry.workspaceRoots, [s.ws.replaceAll('\\', '/'), extra.replaceAll('\\', '/')]);
  s.addRelay('kimi');
  const { plan } = s.boot();
  registry = JSON.parse(readFileSync(s.registry, 'utf8'));
  assert.equal(plan.registry.status, 'update');
  assert.deepEqual(Object.keys(registry.relays), ['agy', 'codex', 'kimi']);
  assert.deepEqual(registry.workspaceRoots, [s.ws.replaceAll('\\', '/'), extra.replaceAll('\\', '/')]);
  assert.equal(registry.hostToolTimeoutSeconds, 3600);
  assert.equal(readManaged(readFileSync(s.config, 'utf8')).values.tool_timeout_sec, 3600);
  s.boot({ hostTimeout: 5000, workspaceRoots: [s.ws] });
  registry = JSON.parse(readFileSync(s.registry, 'utf8'));
  assert.equal(registry.hostToolTimeoutSeconds, 5000); assert.deepEqual(registry.workspaceRoots, [s.ws.replaceAll('\\', '/')]);
  assert.equal(readManaged(readFileSync(s.config, 'utf8')).values.tool_timeout_sec, 5000);
});

test('nested workspace roots collapse and defaults include the home directory', () => {
  const s = sandbox();
  const nested = join(s.ws, 'nested'); mkdirSync(nested);
  assert.deepEqual(planBootstrap({ ...s.common, workspaceRoots: [nested, s.ws, s.ws] }).registry.registry.workspaceRoots, [s.ws.replaceAll('\\', '/')]);
  mkdirSync(join(s.codexHome, 'worktrees'), { recursive: true });
  assert.deepEqual(planBootstrap(s.common).registry.registry.workspaceRoots, [s.home.replaceAll('\\', '/'), join(s.codexHome, 'worktrees').replaceAll('\\', '/')]);
  assert.throws(() => planBootstrap({ ...s.common, workspaceRoots: [join(s.root, 'missing')] }), /not an existing directory/);
});

test('an unparsable or foreign registry is backed up before replacement', () => {
  for (const content of ['{ not json', JSON.stringify({ schema: 'other.v9' }), JSON.stringify({ schema: 'codex-background.registry.v1', stateDirectory: '/elsewhere/state', artifactRoots: ['/elsewhere'] })]) {
    const s = sandbox();
    mkdirSync(join(s.codexHome, 'codex-background'), { recursive: true }); writeFileSync(s.registry, content);
    const { plan, applied } = s.boot();
    assert.equal(plan.registry.status, 'replace');
    assert.equal(readFileSync(applied.registry.backup, 'utf8'), content);
    assert.equal(JSON.parse(readFileSync(s.registry, 'utf8')).schema, 'codex-background.registry.v1');
  }
});

test('flags: unknown or malformed options are usage errors', async () => {
  const s = sandbox();
  for (const args of [['--nope'], ['--codex-home'], ['--host-timeout', 'abc'], ['--host-timeout', '10'], ['--dry-run=1']]) {
    const result = await s.cli(args);
    assert.equal(result.code, 2, args.join(' ')); assert.match(result.err, /Usage:/);
  }
  assert.deepEqual(parseArgs(['--workspace-root', 'a', '--workspace-root=b', '--host-timeout=60', '--json']), { workspaceRoots: ['a', 'b'], hostTimeout: 60, json: true });
  assert.ok(!existsSync(s.codexHome));
  assert.equal((await s.cli(['--help'])).code, 0);
});
