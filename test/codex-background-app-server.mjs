// Optional native-host measurement: set CODEX_BACKGROUND_APP_SERVER to a reviewed Codex binary.
// No model turn, API request, credentials or real implementer delegation is performed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const binary = process.env.CODEX_BACKGROUND_APP_SERVER;
if (!binary || !isAbsolute(binary)) throw Error('Set CODEX_BACKGROUND_APP_SERVER to the absolute installed Codex binary; no discovery is performed');
const root = mkdtempSync(join(tmpdir(), 'codex-native-wait-'));
let child;
try {
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts'), home = join(root, 'home');
  for (const dir of [workspace, artifacts, home]) mkdirSync(dir);
  const scripts = join(root, 'agy-delegate', 'scripts'); mkdirSync(scripts, { recursive: true });
  const relay = join(scripts, 'relay.mjs');
  writeFileSync(relay, "import{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';const args=process.argv.slice(2);const out=args[args.indexOf('--out-dir')+1];mkdirSync(out);const noise=setInterval(()=>{process.stdout.write('stdout noise\\n');process.stderr.write('stderr noise\\n');},500);setTimeout(()=>{clearInterval(noise);writeFileSync(join(out,'result.json'),'opaque fixture completed');process.exit(0);},65000);");
  const brief = join(workspace, 'brief.txt'); writeFileSync(brief, 'Local timing fixture only.');
  const registry = join(root, 'registry.json');
  writeFileSync(registry, JSON.stringify({ schema: 'codex-background.registry.v1', hostToolTimeoutSeconds: 180, stateDirectory: join(artifacts, 'state'), workspaceRoots: [workspace], artifactRoots: [artifacts], relays: { agy: relay } }));
  const server = fileURLToPath(new URL('../skills/codex-background/scripts/server.mjs', import.meta.url));
  const config = {
    'mcp_servers.codex_background.command': process.execPath,
    'mcp_servers.codex_background.args': [server],
    'mcp_servers.codex_background.env.CODEX_BACKGROUND_REGISTRY': registry,
    'mcp_servers.codex_background.tool_timeout_sec': 180,
    'mcp_servers.codex_background.required': true,
  };
  child = spawn(binary, ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])], { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let stderr = '', id = 0; const pending = new Map(), events = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); events.push({ at: Date.now(), message });
    if (Object.hasOwn(message, 'id') && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  function rpc(method, params) {
    const requestId = ++id; const response = new Promise(resolve => pending.set(requestId, resolve));
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    return Promise.race([response.then(message => { if (message.error) throw Error(JSON.stringify(message.error)); return message.result; }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('App Server RPC timed out: ' + method + '\n' + stderr.slice(-2000))), 170000); timer.unref(); })]);
  }
  await rpc('initialize', { clientInfo: { name: 'codex_background_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const startedThread = await rpc('thread/start', { cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = startedThread.thread.id;
  const started = Date.now();
  const result = await rpc('mcpServer/tool/call', { threadId, server: 'codex_background', tool: 'delegate_run', arguments: { runId: 'native', implementer: 'agy', brief, workspace, outputDirectory: join(artifacts, 'output'), relayTimeoutSeconds: 90 } });
  const elapsedMs = Date.now() - started;
  const serialized = JSON.stringify(result); assert.match(serialized, /opaque fixture completed/); assert.ok(elapsedMs >= 65000);
  const modelEvents = events.filter(({ message }) => /reasoning|tokenUsage|turn\/started|turn\/completed/.test(message.method || ''));
  assert.equal(modelEvents.length, 0);
  assert.equal(events.filter(({ message }) => message.method === 'item/mcpToolCall/progress').length, 0);
  console.log(JSON.stringify({ elapsedMs, nativeMcpRequests: 1, completionResponses: 1, modelTurnsStarted: 0, modelUsageEvents: modelEvents.length, limitation: 'Direct App Server RPC measured; no active model turn or Desktop inference/token savings measured.' }, null, 2));
  child.stdin.end(); await closed;
} finally {
  if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
  rmSync(root, { recursive: true, force: true });
}
