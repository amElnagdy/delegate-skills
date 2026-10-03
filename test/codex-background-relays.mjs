import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHarness } from './harness/create-harness.mjs';
import { installShim } from './harness/install-shim.mjs';

const server = fileURLToPath(new URL('../skills/codex-background/scripts/server.mjs', import.meta.url));
const cases = [
  { key: 'agy', mode: 'agy-analysis', args: ['--read-only', '--effort', 'high'], expected: ['--effort', 'high'] },
  { key: 'codex', mode: 'capture', args: ['--session', 'thread-abc'], expected: ['resume', 'thread-abc'] },
  { key: 'zcode', mode: 'zcode-success', args: ['--session', 'sess_prior-0', '--disallowed-tools', 'Write,Edit'], expected: ['--resume', 'sess_prior-0'] },
  { key: 'cline', mode: 'cline-success', args: ['--provider', 'fake', '--model', 'fake-model'], expected: ['--model', 'fake-model'] },
  { key: 'opencode', mode: 'opencode-success', args: ['--model', 'fake/model', '--variant', 'high'], expected: ['--model', 'fake/model#high'] },
];
for (const provider of cases) for (const timedOut of [false, true]) test('registered unchanged ' + provider.key + ' relay ' + (timedOut ? 'preserves timeout and process-tree cleanup' : 'preserves native contract'), { timeout: 30000 }, async () => {
  const h = createHarness(); let child;
  try {
    installShim(h); assert.equal(h.failed, 0);
    const workspace = h.freshRepo('workspace'); const artifacts = join(h.scratch, 'artifacts'); mkdirSync(artifacts);
    const registryFile = join(h.scratch, 'registry.json');
    writeFileSync(registryFile, JSON.stringify({ schema: 'codex-background.registry.v1', hostToolTimeoutSeconds: 90, stateDirectory: join(artifacts, 'state'), workspaceRoots: [h.scratch], artifactRoots: [artifacts], relays: { [provider.key]: h.relayPath(provider.key) } }));
    const capture = join(h.scratch, 'captured.json');
    child = spawn(process.execPath, [server], {
      env: { ...h.baseEnv, CODEX_BACKGROUND_REGISTRY: registryFile, SMOKE_MODE: timedOut ? 'timeout' : provider.mode, SMOKE_PID_FILE: join(h.scratch, 'implementer.pid'), SMOKE_GRAND_PID_FILE: join(h.scratch, 'grandchild.pid'), SMOKE_ARGS_FILE: capture, SMOKE_VERSION: 'opencode v2.0.11', ZCODE_CLI: join(h.scratch, 'shim', h.WIN ? 'zcode.cmd' : 'zcode') },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const messages = [], pending = new Map(); let nextId = 0;
    createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); messages.push(message); pending.get(message.id)?.(message); pending.delete(message.id); });
    function call(name, args) {
      const id = ++nextId; const promise = new Promise(resolve => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); return promise;
    }
    const response = await call('delegate_run', { runId: provider.key, implementer: provider.key, brief: h.briefPath, workspace, outputDirectory: join(artifacts, 'output'), relayTimeoutSeconds: timedOut ? 2 : 10, relayArgs: provider.args });
    assert.equal(response.result.isError, timedOut, JSON.stringify(response));
    const outcome = JSON.parse(response.result.content[0].text); assert.equal(outcome.adapterStatus, timedOut ? 'failed' : 'completed');
    const raw = readFileSync(outcome.resultPath, 'utf8'); assert.equal(outcome.resultText, raw);
    const result = JSON.parse(raw); assert.equal(result.status, timedOut ? 'timeout' : 'completed');
    if (timedOut) {
      for (const filename of ['implementer.pid', 'grandchild.pid']) {
        const pid = Number(readFileSync(join(h.scratch, filename))); assert.ok(await h.until(() => !h.alive(pid), 5000), filename + ' terminated');
      }
      assert.equal(messages.length, 1); assert.equal(stderr, ''); return;
    }
    assert.equal(typeof result.finalMessage, 'string');
    // The existing capture fixture intentionally exits without a Codex final message.
    if (provider.key === 'codex') assert.equal(result.finalMessage, ''); else assert.ok(result.finalMessage.length);
    if (provider.key === 'codex') assert.equal(result.session, 'thread-abc');
    if (provider.key === 'zcode') assert.equal(result.sessionId, 'sess_smoke-1');
    if (provider.key === 'opencode') assert.equal(result.sessionId, 'ses_smoke_opencode');
    const text = readFileSync(capture, 'utf8');
    const captured = provider.key === 'agy' && h.WIN ? text.split(/\r?\n/).filter(Boolean) : JSON.parse(text);
    const argv = Array.isArray(captured) ? captured : captured.args;
    const at = argv.indexOf(provider.expected[0]); assert.ok(at >= 0); assert.equal(argv[at + 1], provider.expected[1]);
    if (provider.key === 'cline') assert.equal(captured.brief, readFileSync(h.briefPath, 'utf8'));
    const recovered = await call('delegate_wait', { runId: provider.key });
    assert.deepEqual(JSON.parse(recovered.result.content[0].text), outcome);
    assert.equal(readFileSync(outcome.resultPath, 'utf8'), raw); assert.equal(messages.length, 2); assert.equal(stderr, '');
  } finally {
    if (child) { const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await closed; }
    h.cleanup();
  }
});
