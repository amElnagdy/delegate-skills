#!/usr/bin/env node
/** Codex host integration only. Registered relays retain all implementer behavior. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' };
const COMMON_FLAGS = ['--brief', '--cd', '--out-dir', '--timeout'];
const GRACE_MS = 15000;
const DELIVERY_MARGIN_MS = 30000;
const MAX_TIMER_MS = 2147483647;

function onlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('Unexpected object fields');
}
function absolute(value) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) throw Error('Paths must be absolute');
  return resolve(value);
}
function futurePath(value) {
  let parent = absolute(value);
  const parts = [];
  while (!existsSync(parent)) { parts.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...parts);
}
function within(path, roots) {
  return roots.some(root => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); });
}
function directories(values) {
  if (!Array.isArray(values) || !values.length) throw Error('Configure nonempty root arrays');
  return values.map(value => { const path = realpathSync(absolute(value)); if (!statSync(path).isDirectory()) throw Error('Configured root is not a directory'); return path; });
}
function readRegistry(file) {
  if (!['win32', 'linux'].includes(process.platform)) throw Error('Safe ownership requires Windows or Linux; other hosts are unsupported');
  if (process.platform === 'linux' && !existsSync('/usr/bin/cc')) throw Error('Linux ownership requires the system C compiler at /usr/bin/cc');
  if (!file) throw Error('Missing CODEX_BACKGROUND_REGISTRY: configure the codex-background MCP server registry first');
  const source = readFileSync(absolute(file), 'utf8');
  const registry = JSON.parse(source);
  onlyKeys(registry, ['schema', 'hostToolTimeoutSeconds', 'stateDirectory', 'workspaceRoots', 'artifactRoots', 'relays']);
  if (registry.schema !== 'codex-background.registry.v1') throw Error('Unsupported registry schema');
  const budgetMs = registry.hostToolTimeoutSeconds * 1000;
  if (!Number.isInteger(registry.hostToolTimeoutSeconds) || budgetMs <= DELIVERY_MARGIN_MS || budgetMs > MAX_TIMER_MS) throw Error('Invalid host tool timeout');
  const workspaceRoots = directories(registry.workspaceRoots);
  const artifactRoots = directories(registry.artifactRoots);
  const stateDirectory = futurePath(registry.stateDirectory);
  if (!within(stateDirectory, artifactRoots)) throw Error('State directory is outside artifact roots');
  if (!registry.relays || typeof registry.relays !== 'object' || Array.isArray(registry.relays) || !Object.keys(registry.relays).length) throw Error('Configure an explicit relay registry');
  const relays = new Map();
  for (const [key, value] of Object.entries(registry.relays)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw Error('Invalid implementer key');
    const path = realpathSync(absolute(value));
    if (!statSync(path).isFile() || basename(path) !== 'relay.mjs' || basename(dirname(path)) !== 'scripts' || basename(dirname(dirname(path))) !== `${key}-delegate`) throw Error(`Invalid registered relay for ${key}`);
    relays.set(key, path);
  }
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(join(stateDirectory, 'output-claims'), { recursive: true });
  return { budgetMs, workspaceRoots, artifactRoots, stateDirectory, relays };
}
function validId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw Error('Invalid runId');
}
function persist(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
function opaqueResult(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const utf8 = Buffer.from(text).equals(bytes);
  return { resultPath: path, resultEncoding: utf8 ? 'utf8' : 'base64', resultText: utf8 ? text : bytes.toString('base64') };
}
function toolResult(outcome) {
  return { content: [{ type: 'text', text: JSON.stringify(outcome) }], isError: outcome.adapterStatus !== 'completed' };
}

export function startServer({ registryFile = process.env.CODEX_BACKGROUND_REGISTRY, input = process.stdin, output = process.stdout } = {}) {
  const registry = readRegistry(registryFile);
  const jobs = new Map();
  const active = new Set();
  const cancelled = new Set();
  const artifactRoot = registry.artifactRoots[0].replaceAll('\\', '/');
  const idSchema = { type: 'object', properties: { runId: ID }, required: ['runId'], additionalProperties: false };
  const runSchema = {
    type: 'object', additionalProperties: false,
    required: ['runId', 'implementer', 'brief', 'workspace', 'outputDirectory', 'relayTimeoutSeconds'],
    properties: {
      runId: ID, implementer: { type: 'string', enum: [...registry.relays.keys()] },
      brief: { type: 'string', description: `Absolute existing brief file in approved roots, e.g. ${artifactRoot}/briefs/<runId>.txt (create the briefs directory if missing).` },
      workspace: { type: 'string', description: 'Absolute approved workspace directory.' },
      outputDirectory: { type: 'string', description: `Absolute fresh relay artifact directory, e.g. ${artifactRoot}/runs/<runId>.` },
      relayTimeoutSeconds: { type: 'integer', minimum: 1, maximum: Math.floor((registry.budgetMs - DELIVERY_MARGIN_MS - 1) / 1000) },
      relayArgs: { type: 'array', items: { type: 'string' }, default: [] },
    },
  };
  const tools = [
    { name: 'delegate_run', description: 'Codex only: invoke a registered existing delegate relay. This request stays pending until relay closure. Do not poll or read progress logs; review the opaque result and rerun gates before landing.', inputSchema: runSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
    { name: 'delegate_wait', description: 'Reattach after an interrupted wait; never redispatch. Wait for a live owned job, recover a persisted terminal outcome, or report recovery_required for unresolved state.', inputSchema: idSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'delegate_abort', description: 'Explicitly terminate only a live job owned by this server. Cancelling a wait alone does not abort delegation. Never kill an old PID after restart.', inputSchema: idSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  ];
  let transportOpen = true;
  const send = value => { if (transportOpen && !output.destroyed && !output.writableEnded) output.write(`${JSON.stringify(value)}\n`); };

  function prepare(args) {
    onlyKeys(args, Object.keys(runSchema.properties));
    validId(args.runId);
    if (!registry.relays.has(args.implementer)) throw Error('Implementer is not registered');
    const workspace = realpathSync(absolute(args.workspace));
    const brief = realpathSync(absolute(args.brief));
    const outputDirectory = futurePath(args.outputDirectory);
    if (!statSync(workspace).isDirectory() || !within(workspace, registry.workspaceRoots)) throw Error('Workspace is outside configured roots');
    if (!statSync(brief).isFile() || !within(brief, [...registry.workspaceRoots, ...registry.artifactRoots])) throw Error('Brief is outside configured roots');
    if (!within(outputDirectory, registry.artifactRoots) || within(outputDirectory, [registry.stateDirectory])) throw Error('Output must be in artifact roots and outside adapter state');
    if (existsSync(outputDirectory)) throw Error('Use a fresh output directory');
    const timeoutMs = args.relayTimeoutSeconds * 1000;
    if (!Number.isInteger(args.relayTimeoutSeconds) || timeoutMs <= 0 || timeoutMs + DELIVERY_MARGIN_MS >= registry.budgetMs) throw Error('Host timeout must exceed relay timeout by more than thirty seconds');
    const relayArgs = args.relayArgs ?? [];
    if (!Array.isArray(relayArgs) || relayArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw Error('relayArgs must be a string array');
    for (const arg of relayArgs) if (COMMON_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`))) throw Error('Common flags must use structured inputs');
    // Extra workspace access is checked without changing the relay-native argument array.
    for (let i = 0; i < relayArgs.length; i++) {
      if (relayArgs[i].startsWith('--add-dir=')) throw Error('Use a separate --add-dir value');
      if (relayArgs[i] === '--add-dir') {
        const value = relayArgs[++i];
        if (!value || !within(realpathSync(resolve(workspace, value)), registry.workspaceRoots)) throw Error('Extra workspace is outside configured roots');
      }
    }
    const runDirectory = join(registry.stateDirectory, args.runId);
    if (existsSync(runDirectory)) throw Error('runId already used; call delegate_wait');
    const relayPath = registry.relays.get(args.implementer);
    if (realpathSync(relayPath) !== relayPath) throw Error('Registered relay identity changed; reload the registry');
    const argv = [...relayArgs, '--brief', brief, '--cd', workspace, '--out-dir', outputDirectory, '--timeout', `${args.relayTimeoutSeconds}s`];
    return { runId: args.runId, implementer: args.implementer, workspace, outputDirectory, runDirectory, relayPath, argv, timeoutMs };
  }

  async function terminate(job) {
    if (job.anchorExited) return job.cleanup; // Native parent-death cleanup owns the tree now; never signal an old PID.
    if (job.exited || job.ownerExited || job.child.exitCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise((resolveStop, rejectStop) => {
        const systemRoot = process.env.SystemRoot || process.env.WINDIR;
        if (!systemRoot) { rejectStop(Error('Windows system directory is unavailable')); return; }
        const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const limit = setTimeout(() => { killer.kill(); rejectStop(Error('Process-tree termination timed out')); }, 5000);
        killer.once('error', error => { clearTimeout(limit); rejectStop(error); });
        killer.once('exit', code => { clearTimeout(limit); if (code === 0 || job.ownerExited) resolveStop(); else rejectStop(Error(`Process-tree termination failed (${code})`)); });
      });
    } else {
      try { process.kill(-job.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Sweep the owned process group even if its parent exits before a stubborn descendant.
      await new Promise(resolveGrace => setTimeout(resolveGrace, 3500));
      if (job.anchorExited) { await job.cleanup; return; } // Never signal a recycled group ID.
      try { process.kill(-job.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  function stop(job, reason) {
    if (job.anchorExited) return job.cleanup;
    if (job.exited || job.ownerExited) return job.termination ?? Promise.resolve();
    if (!job.termination) {
      job.stopReason = reason;
      job.termination = terminate(job);
      job.termination.catch(error => { job.errors.push(error.message); });
    }
    return job.termination;
  }

  function launch(args) {
    if (closing) throw Error('Server is shutting down; no new delegation is accepted');
    const spec = prepare(args);
    mkdirSync(spec.runDirectory); // Exclusive durable run claim, including across server instances.
    const outputKey = createHash('sha256').update(process.platform === 'win32' ? spec.outputDirectory.toLowerCase() : spec.outputDirectory).digest('hex');
    const claim = join(registry.stateDirectory, 'output-claims', outputKey);
    const manifest = { runId: spec.runId, implementer: spec.implementer, outputDirectory: spec.outputDirectory, resultPath: join(spec.outputDirectory, 'result.json'), stdoutPath: join(spec.runDirectory, 'stdout.log'), stderrPath: join(spec.runDirectory, 'stderr.log'), phase: 'claimed' };
    try { writeFileSync(claim, spec.runId, { flag: 'wx', mode: 0o600 }); persist(join(spec.runDirectory, 'run.json'), manifest); }
    catch (error) { persist(join(spec.runDirectory, 'outcome.json'), { ...manifest, adapterStatus: 'failed', error: error.message }); throw error; }
    const stdout = createWriteStream(manifest.stdoutPath, { flags: 'wx', mode: 0o600 });
    const stderr = createWriteStream(manifest.stderrPath, { flags: 'wx', mode: 0o600 });
    const stdoutDone = finished(stdout).catch(error => error);
    const stderrDone = finished(stderr).catch(error => error);
    const ownerSpec = join(spec.runDirectory, 'owner-spec.json');
    persist(ownerSpec, { node: process.execPath, relayPath: spec.relayPath, argv: spec.argv, workspace: spec.workspace, runDirectory: spec.runDirectory });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), ownerSpec], { cwd: spec.workspace, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { child, errors: [], stopReason: null, termination: null, ownerExited: false, anchorExited: false, cleanup: Promise.resolve(), exited: false };
    jobs.set(spec.runId, job);
    const guard = setTimeout(() => { stop(job, 'adapter_timeout').catch(() => {}); }, spec.timeoutMs + GRACE_MS);
    child.once('error', error => { job.errors.push(error.message); });
    child.once('exit', () => {
      job.anchorExited = true;
      clearTimeout(guard);
      job.cleanup = (async () => {
        if (process.platform === 'linux' && existsSync(join(spec.runDirectory, 'owner-ready.json'))) {
          const deadline = Date.now() + 5000;
          while (!existsSync(join(spec.runDirectory, 'owner-closed.json'))) {
            if (Date.now() >= deadline) throw Error('Linux ownership cleanup was not confirmed after supervisor exit');
            await new Promise(resolveCleanup => setTimeout(resolveCleanup, 20));
          }
        }
        job.ownerExited = true;
      })();
      job.cleanup.catch(error => { job.errors.push(error.message); });
      const drain = setTimeout(() => { if (!job.exited) { child.stdout.destroy(); child.stderr.destroy(); stdout.end(); stderr.end(); } }, 1000);
      drain.unref();
    });
    for (const [source, target] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      target.once('error', () => { source.unpipe(target); source.resume(); });
      source.pipe(target);
    }
    job.done = new Promise(resolveDone => child.once('close', async (exitCode, signal) => {
      clearTimeout(guard);
      if (job.termination) await job.termination.catch(() => {});
      await job.cleanup.catch(() => {});
      job.exited = true;
      stdout.end(); stderr.end();
      for (const error of await Promise.all([stdoutDone, stderrDone])) if (error) job.errors.push(error.message);
      let result = {};
      try { result = opaqueResult(manifest.resultPath); } catch (error) { job.errors.push(error.message); }
      let relayExit = { exitCode, signal };
      try { relayExit = JSON.parse(readFileSync(join(spec.runDirectory, 'relay-exit.json'), 'utf8')); } catch {}
      try {
        const owner = JSON.parse(readFileSync(join(spec.runDirectory, 'owner-outcome.json'), 'utf8'));
        if (owner.error) job.errors.push(owner.error);
        if (process.platform === 'win32' && owner.ownerExitCode !== relayExit.exitCode && !job.stopReason) job.errors.push('Windows job owner did not close normally');
      } catch { if (!job.stopReason) job.errors.push('Ownership supervisor exited without a terminal outcome'); }
      const outcome = { ...manifest, ...result, ...relayExit, phase: 'closed', adapterStatus: job.stopReason || (exitCode === 0 && relayExit.exitCode === 0 && !job.errors.length ? 'completed' : 'failed'), errors: job.errors };
      try { persist(join(spec.runDirectory, 'outcome.json'), outcome); } catch (error) { outcome.adapterStatus = 'failed'; outcome.errors.push(error.message); }
      resolveDone(outcome);
    }));
    return job.done;
  }

  async function callTool(name, args) {
    if (name === 'delegate_run') return toolResult(await launch(args));
    onlyKeys(args, ['runId']); validId(args.runId);
    const job = jobs.get(args.runId);
    if (name === 'delegate_wait') {
      if (job) return toolResult(await job.done);
      const runDirectory = join(registry.stateDirectory, args.runId);
      if (existsSync(join(runDirectory, 'outcome.json'))) return toolResult(JSON.parse(readFileSync(join(runDirectory, 'outcome.json'), 'utf8')));
      if (!existsSync(runDirectory)) throw Error('Unknown runId');
      return toolResult({ runId: args.runId, adapterStatus: 'recovery_required', runDirectory, errors: ['No persisted terminal outcome or live owned job; inspect artifacts, never redispatch automatically or adopt an old PID.'] });
    }
    if (name === 'delegate_abort') {
      if (!job) throw Error('Abort only applies to a live job owned by this server');
      await stop(job, 'aborted');
      return toolResult(await job.done);
    }
    throw Error('Unknown tool');
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (request.method === 'notifications/cancelled') { if (active.has(request.params?.requestId)) cancelled.add(request.params.requestId); return; }
    if (!Object.hasOwn(request, 'id')) return;
    if (active.has(request.id)) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'Duplicate request ID' } }); return; }
    active.add(request.id);
    (async () => {
      if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-background', version: '0.5.0' }, instructions: `Codex only. Delegate through a registered relay with one pending delegate_run call. No sleep/status/log polling or intermediate progress. An interrupted wait can reattach by runId; only delegate_abort stops a job. Keep the outer host call pending, review opaque resultText, rerun gates and land through the selected delegate skill. Write the brief to ${artifactRoot}/briefs/<runId>.txt (or anywhere inside an approved workspace or artifact root) and use ${artifactRoot}/runs/<runId> as outputDirectory.` };
      if (request.method === 'ping') return {};
      if (request.method === 'tools/list') return { tools };
      if (request.method === 'tools/call') {
        try { return await callTool(request.params?.name, request.params?.arguments); }
        catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
      }
      throw Error('Unknown method');
    })().then(result => { if (!cancelled.has(request.id)) send({ jsonrpc: '2.0', id: request.id, result }); }, error => { if (!cancelled.has(request.id)) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: error.message } }); }).finally(() => { active.delete(request.id); cancelled.delete(request.id); });
  });
  let closing;
  function shutdown() {
    closing ??= Promise.allSettled([...jobs.values()].map(async job => { await stop(job, 'aborted'); await job.done; })).then(() => { lines.close(); });
    return closing;
  }
  lines.once('close', () => { transportOpen = false; shutdown().catch(() => {}); });
  output.once('error', () => { transportOpen = false; shutdown().catch(() => {}); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutdown().finally(() => { process.exitCode = 128; }); });
  return { shutdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startServer(); } catch (error) { process.stderr.write(`${error.message}\nTo configure codex-background, run: node "${fileURLToPath(new URL('./bootstrap.mjs', import.meta.url))}"\n`); process.exitCode = 1; }
}
