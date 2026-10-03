import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const fixture = String.raw`import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const argv = process.argv.slice(2);
const get = flag => argv[argv.indexOf(flag) + 1];
const spec = JSON.parse(readFileSync(get('--brief'), 'utf8'));
if (spec.delayOutput) await delay(spec.delayOutput);
const out = get('--out-dir'); mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'received.json'), JSON.stringify(argv));
function result(code = 0) {
  const text = spec.raw ?? JSON.stringify({ finalMessage: 'report\nexact', threadId: 'Opaque:Thread/9', artifacts: { custom: true }, status: code ? 'timeout' : 'completed' }, null, 2);
  writeFileSync(join(out, 'result.json'), spec.binary ? Buffer.from([255, 0, 254]) : text);
  process.exit(code);
}
if (spec.mode === 'usage') process.exit(2);
if (spec.mode === 'stuck') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore', windowsHide: true });
  writeFileSync(join(out, 'child.pid'), String(child.pid));
  process.on('SIGTERM', () => process.exit(143));
  setInterval(()=>{},1000);
} else {
  const noise = setInterval(()=>{process.stdout.write('progress stdout\n');process.stderr.write('progress stderr\n');}, 100);
  await delay(spec.delayMs ?? 100); clearInterval(noise); result(spec.code ?? 0);
}
`;
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codex-background-'));
  const workspace = join(root, 'work'), artifacts = join(root, 'artifacts'), state = join(artifacts, 'state');
  mkdirSync(workspace); mkdirSync(artifacts);
  const relays = {};
  for (const key of ['agy', 'codex', 'zcode', 'cline', 'opencode']) {
    const scripts = join(root, key + '-delegate', 'scripts'); mkdirSync(scripts, { recursive: true });
    relays[key] = join(scripts, 'relay.mjs'); writeFileSync(relays[key], fixture);
  }
  const registryFile = join(root, 'registry.json');
  const registry = { schema: 'codex-background.registry.v1', hostToolTimeoutSeconds: 180, stateDirectory: state, workspaceRoots: [workspace], artifactRoots: [artifacts], relays };
  writeFileSync(registryFile, JSON.stringify(registry));
  return { root, workspace, artifacts, state, registryFile, registry };
}
function client(s) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_BACKGROUND_REGISTRY: s.registryFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), messages = [], calls = []; let id = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); messages.push(message);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  function request(method, params) {
    const requestId = ++id;
    if (method === 'tools/call') calls.push(params);
    const promise = new Promise(resolve => pending.set(requestId, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return { id: requestId, promise };
  }
  const tool = (name, args) => request('tools/call', { name, arguments: args });
  function args(runId, spec = {}, overrides = {}) {
    const brief = join(s.workspace, runId + '.json'); writeFileSync(brief, JSON.stringify(spec));
    return { runId, implementer: 'agy', brief, workspace: s.workspace, outputDirectory: join(s.artifacts, runId), relayTimeoutSeconds: 90, relayArgs: [], ...overrides };
  }
  return { child, messages, calls, closed, request, tool, args,
    run: (runId, spec, overrides) => tool('delegate_run', args(runId, spec, overrides)),
    async close() { child.stdin.end(); await closed; assert.equal(stderr, '', 'no child stderr reaches MCP transport'); },
  };
}
function outcome(response) { assert.ok(response.result, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); }
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(50); } assert.ok(fn(), 'fixture became ready'); }
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/\)\s+Z\s/.test(readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return true; }
}
async function clean(s, c) { await c.close(); rmSync(s.root, { recursive: true, force: true }); }

test('one pending MCP invocation stays quiet for more than sixty seconds', { timeout: 85000 }, async t => {
  const s = setup(), c = client(s);
  try {
    await c.request('initialize', { protocolVersion: '2024-11-05' }).promise;
    const listed = await c.request('tools/list', {}).promise;
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['delegate_run', 'delegate_wait', 'delegate_abort']);
    const started = Date.now();
    const native = ['--session', 'Opaque:Resume/ID', '--effort', 'high'];
    const call = c.run('long', { delayMs: 65000 }, { relayArgs: native });
    const response = await call.promise, value = outcome(response), elapsedMs = Date.now() - started;
    assert.ok(elapsedMs >= 65000); assert.equal(c.calls.length, 1); assert.equal(c.messages.length, 3);
    assert.equal(c.messages.filter(m => m.id === call.id).length, 1);
    assert.equal(c.messages.filter(m => !Object.hasOwn(m, 'id')).length, 0);
    assert.equal(value.adapterStatus, 'completed'); assert.equal(response.result.isError, false);
    assert.equal(value.resultText, readFileSync(value.resultPath, 'utf8'));
    assert.equal(JSON.parse(value.resultText).threadId, 'Opaque:Thread/9');
    assert.equal(JSON.parse(value.resultText).finalMessage, 'report\nexact');
    assert.deepEqual(JSON.parse(readFileSync(join(value.outputDirectory, 'received.json'), 'utf8')).slice(0, native.length), native);
    assert.match(readFileSync(value.stdoutPath, 'utf8'), /progress stdout/);
    assert.match(readFileSync(value.stderrPath, 'utf8'), /progress stderr/);
    t.diagnostic(JSON.stringify({ elapsedMs, mcpToolInvocations: 1, intermediateMessages: 0, completionResponses: 1 }));
  } finally { await clean(s, c); }
});
test('opaque result bytes and nonzero relay failures are preserved', async () => {
  const s = setup(), c = client(s);
  try {
    for (const [id, spec] of [['opaque', { raw: 'not JSON\n  unchanged' }], ['binary', { binary: true }], ['failed', { code: 1 }], ['timeout', { code: 124 }], ['usage', { mode: 'usage' }]]) {
      const response = await c.run(id, spec).promise, value = outcome(response);
      assert.equal(response.result.isError, ['failed', 'timeout', 'usage'].includes(id));
      if (id === 'usage') { assert.equal(existsSync(value.resultPath), false); assert.equal(value.resultText, undefined); }
      else assert.deepEqual(Buffer.from(value.resultText, value.resultEncoding === 'base64' ? 'base64' : 'utf8'), readFileSync(value.resultPath));
    }
  } finally { await clean(s, c); }
});
test('cancelling a wait preserves the job; reattach does not redispatch', async () => {
  const s = setup(), c = client(s);
  try {
    const call = c.run('cancel', { delayMs: 1000 });
    c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call.id } }) + '\n');
    assert.equal((await c.tool('delegate_run', { runId: 'cancel', implementer: 'agy', brief: join(s.workspace, 'cancel.json'), workspace: s.workspace, outputDirectory: join(s.artifacts, 'another'), relayTimeoutSeconds: 90 }).promise).result.isError, true);
    const value = outcome(await c.tool('delegate_wait', { runId: 'cancel' }).promise);
    assert.equal(value.adapterStatus, 'completed'); assert.equal(c.messages.filter(m => m.id === call.id).length, 0);
    assert.equal(JSON.parse(readFileSync(join(value.outputDirectory, 'received.json'), 'utf8')).filter(arg => arg === '--brief').length, 1);
  } finally { await clean(s, c); }
});
test('explicit abort terminates the owned tree and preserves artifacts', async () => {
  const s = setup(), c = client(s);
  try {
    const call = c.run('abort', { mode: 'stuck' }); const pidFile = join(s.artifacts, 'abort', 'child.pid');
    await until(() => existsSync(pidFile)); const pid = Number(readFileSync(pidFile));
    const value = outcome(await c.tool('delegate_abort', { runId: 'abort' }).promise);
    assert.equal(value.adapterStatus, 'aborted'); assert.equal(outcome(await call.promise).adapterStatus, 'aborted');
    await until(() => !alive(pid)); assert.equal(existsSync(pidFile), true); assert.equal(value.resultText, undefined);
  } finally { await clean(s, c); }
});
test('adapter guard bounds a relay that ignores its own timeout', { timeout: 23000 }, async () => {
  const s = setup(), c = client(s);
  try {
    const started = Date.now(); const value = outcome(await c.run('guard', { mode: 'stuck' }, { relayTimeoutSeconds: 1 }).promise);
    assert.equal(value.adapterStatus, 'adapter_timeout'); assert.ok(Date.now() - started >= 16000);
    await until(() => !alive(Number(readFileSync(join(value.outputDirectory, 'child.pid')))));
  } finally { await clean(s, c); }
});
test('server shutdown aborts owned jobs and terminal outcomes survive restart', async () => {
  const s = setup(), c = client(s);
  try {
    c.run('shutdown', { mode: 'stuck' }); const pidFile = join(s.artifacts, 'shutdown', 'child.pid');
    await until(() => existsSync(pidFile)); const pid = Number(readFileSync(pidFile));
    c.child.stdout.destroy(); // A disconnected host must not crash cleanup with EPIPE.
    await c.close(); await until(() => !alive(pid));
    const next = client(s);
    try { assert.equal(outcome(await next.tool('delegate_wait', { runId: 'shutdown' }).promise).adapterStatus, 'aborted'); }
    finally { await next.close(); }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
test('restart recovers terminal reports and unresolved state never adopts a PID', async () => {
  const s = setup(), c = client(s);
  try {
    const original = outcome(await c.run('done', {}).promise); await c.close();
    mkdirSync(join(s.state, 'unresolved')); writeFileSync(join(s.state, 'unresolved', 'run.json'), JSON.stringify({ pid: process.pid }));
    const next = client(s);
    try {
      assert.deepEqual(outcome(await next.tool('delegate_wait', { runId: 'done' }).promise), original);
      assert.equal(outcome(await next.tool('delegate_wait', { runId: 'unresolved' }).promise).adapterStatus, 'recovery_required');
      assert.equal((await next.tool('delegate_abort', { runId: 'unresolved' }).promise).result.isError, true);
      assert.equal((await next.run('done', {}).promise).result.isError, true);
      assert.equal(alive(process.pid), true);
    } finally { await next.close(); }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
test('configured roots, host budget, executable injection and common overrides fail before dispatch', async () => {
  const s = setup(), c = client(s);
  try {
    const cases = [{ implementer: 'missing' }, { relayPath: SERVER }, { workspace: s.root }, { brief: SERVER }, { outputDirectory: join(s.state, 'wrong') }, { outputDirectory: join(s.root, 'outside') }, { relayTimeoutSeconds: 150 }, { relayTimeoutSeconds: 0 }, { relayArgs: ['--timeout=1s'] }, { relayArgs: ['--brief', SERVER] }, { relayArgs: ['--add-dir', s.root] }];
    for (let i = 0; i < cases.length; i++) {
      assert.equal((await c.run('bad-' + i, {}, cases[i]).promise).result.isError, true);
      assert.equal(existsSync(join(s.state, 'bad-' + i)), false);
    }
  } finally { await clean(s, c); }
});
test('exclusive output claims prevent concurrent delegation across server instances', async () => {
  const s = setup(), c = client(s), other = client(s);
  try {
    const call = c.run('first', { delayOutput: 1000 }); await until(() => existsSync(join(s.state, 'first', 'run.json')));
    assert.equal((await other.run('second', {}, { outputDirectory: join(s.artifacts, 'first') }).promise).result.isError, true);
    assert.equal(outcome(await call.promise).adapterStatus, 'completed');
  } finally { await other.close(); await clean(s, c); }
});
test('registry rejects executables and mismatched implementer paths at startup', async () => {
  const s = setup();
  try {
    for (const relay of [process.execPath, s.registry.relays.codex]) {
      writeFileSync(s.registryFile, JSON.stringify({ ...s.registry, relays: { agy: relay } }));
      const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_BACKGROUND_REGISTRY: s.registryFile }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 1);
    }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
