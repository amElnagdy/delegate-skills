#!/usr/bin/env node
// Keep an ownership anchor alive until the registered relay and its descendants exit.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const exitPath = join(spec.runDirectory, 'relay-exit.json');
const outcomePath = join(spec.runDirectory, 'owner-outcome.json');
function record(path, value) { writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path); }
if (process.platform === 'win32') {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw Error('Windows system directory unavailable');
  const owner = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(readFileSync(new URL('./windows-job.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64')], { env: { ...process.env, CODEX_BACKGROUND_OWNER_SPEC: process.argv[2], CODEX_BACKGROUND_OWNER_HELPER: fileURLToPath(new URL('./windows-job.cs', import.meta.url)) }, windowsHide: true, stdio: 'inherit' });
  owner.once('error', error => { record(outcomePath, { error: error.message }); process.exitCode = 1; });
  owner.once('exit', (code, signal) => {
    record(outcomePath, { ownerExitCode: code, ownerSignal: signal, ...(!existsSync(exitPath) ? { error: 'Windows job owner could not initialize or finish; inspect stderr.log' } : {}) });
    process.exitCode = code === 0 || existsSync(exitPath) ? 0 : 1;
  });
} else if (process.platform === 'linux') {
  let owner, stopping = false;
  // Reserve the group identity and forward a stop that races compilation/owner startup.
  process.on('SIGTERM', () => { stopping = true; owner?.kill('SIGTERM'); });
  const executable = join(spec.runDirectory, 'linux-owner');
  const compiled = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./linux-owner.c', import.meta.url)), '-o', executable], { encoding: 'utf8', timeout: 10000 });
  if (compiled.error || compiled.status !== 0) {
    record(outcomePath, { error: 'Linux ownership helper requires /usr/bin/cc: ' + (compiled.error?.message || compiled.stderr) });
    process.exitCode = 1;
  } else {
    owner = spawn(executable, [spec.runDirectory, spec.node, spec.relayPath, ...spec.argv], { cwd: spec.workspace, stdio: 'inherit' });
    if (stopping) owner.kill('SIGTERM');
    owner.once('error', error => { record(outcomePath, { error: error.message }); process.exitCode = 1; });
    owner.once('exit', (code, signal) => {
      record(outcomePath, { ownerExitCode: code, ownerSignal: signal, ...(code !== 0 ? { error: 'Linux ownership helper failed; inspect stderr.log' } : {}) });
      process.exitCode = code === 0 ? 0 : 1;
    });
  }
} else {
  record(outcomePath, { error: 'Safe process-tree ownership is supported on Windows and Linux only' });
  process.exitCode = 1;
}
