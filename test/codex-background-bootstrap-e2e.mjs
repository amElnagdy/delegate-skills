import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHarness } from './harness/create-harness.mjs';
import { installShim } from './harness/install-shim.mjs';
import { readManaged } from '../skills/codex-background/scripts/bootstrap.mjs';

const repoSkills = fileURLToPath(new URL('../skills/', import.meta.url));

test('fresh install: bootstrap, launch the server as Codex would, one delegate_run completes', { timeout: 90000 }, async () => {
  const h = createHarness(); let child;
  try {
    installShim(h); assert.equal(h.failed, 0);
    const installed = join(h.scratch, 'installed-skills'), codexHome = join(h.scratch, 'codex-home'), home = join(h.scratch, 'home');
    mkdirSync(home);
    for (const name of ['codex-background', 'agy-delegate', 'codex-delegate']) cpSync(join(repoSkills, name), join(installed, name), { recursive: true });
    const workspace = h.freshRepo('workspace');

    const boot = spawnSync(process.execPath, [join(installed, 'codex-background', 'scripts', 'bootstrap.mjs'), '--codex-home', codexHome, '--workspace-root', h.scratch], { env: { ...h.baseEnv, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    assert.equal(boot.status, 0, boot.stdout + boot.stderr);
    assert.match(boot.stdout, /Restart Codex/);

    const configText = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    const managed = readManaged(configText);
    assert.deepEqual(managed.namespaces, ['mcp__codex_background']);
    assert.equal(managed.values.required, true);
    const { command, args } = managed.values;
    assert.ok(existsSync(command)); assert.equal(args.length, 1);
    assert.ok(args[0].replaceAll('\\', '/').startsWith(installed.replaceAll('\\', '/')), 'server comes from the installed skill');
    const registryFile = managed.envValues.CODEX_BACKGROUND_REGISTRY;
    const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
    assert.deepEqual(Object.keys(registry.relays), ['agy', 'codex']);
    assert.equal(managed.values.tool_timeout_sec, registry.hostToolTimeoutSeconds);

    const artifactRoot = registry.artifactRoots[0], runId = 'e2e-1';
    child = spawn(command, args, { env: { ...h.baseEnv, SMOKE_MODE: 'agy-analysis', SMOKE_ARGS_FILE: join(h.scratch, 'captured.json'), CODEX_BACKGROUND_REGISTRY: registryFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const messages = [], pending = new Map(); let nextId = 0;
    createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); messages.push(message); pending.get(message.id)?.(message); pending.delete(message.id); });
    const request = (method, params) => { const id = ++nextId; const promise = new Promise(resolve => pending.set(id, resolve)); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return promise; };

    const init = await request('initialize', { protocolVersion: '2024-11-05' });
    assert.ok(init.result.instructions.includes(`${artifactRoot}/briefs/<runId>.txt`) && init.result.instructions.includes(`${artifactRoot}/runs/<runId>`), 'server tells Codex where briefs and runs go');
    const listed = await request('tools/list', {});
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['delegate_run', 'delegate_wait', 'delegate_abort']);

    const brief = join(artifactRoot, 'briefs', `${runId}.txt`);
    writeFileSync(brief, 'e2e brief');
    const response = await request('tools/call', { name: 'delegate_run', arguments: { runId, implementer: 'agy', brief, workspace, outputDirectory: join(artifactRoot, 'runs', runId), relayTimeoutSeconds: 60, relayArgs: ['--read-only'] } });
    assert.equal(response.result.isError, false, JSON.stringify(response));
    const outcome = JSON.parse(response.result.content[0].text);
    assert.equal(outcome.adapterStatus, 'completed');
    assert.equal(JSON.parse(outcome.resultText).status, 'completed');
    assert.equal(outcome.resultText, readFileSync(outcome.resultPath, 'utf8'));
    assert.ok(outcome.outputDirectory.replaceAll('\\', '/').includes('/codex-background/runs/'));
    assert.equal(messages.filter(m => m.id === 3).length, 1, 'a single response to delegate_run');
    assert.equal(messages.filter(m => !Object.hasOwn(m, 'id')).length, 0, 'no intermediate notifications');
    assert.equal(stderr, '');
  } finally {
    if (child) { const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await closed; }
    h.cleanup();
  }
});
