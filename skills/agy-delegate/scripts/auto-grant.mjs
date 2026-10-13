// Project permission schema inferred from AGY; see the dispatch reference for compatibility.
// Node built-ins only. Shell grants are approvals, not filesystem confinement.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_COMMANDS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'py', 'pip', 'git', 'pwsh', 'powershell',
  'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content', 'Out-File', 'Test-Path',
  'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Select-String',
  'Write-Output', 'echo', 'dir', 'type', 'cd',
];
const DEFAULT_DENY = ['command(regex:git push.*)', 'command(regex:git reset --hard.*)',
  'command(regex:git clean.*)', 'command(regex:rm -rf.*)'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unique = values => [...new Set(values)];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`invalid JSON in ${path}: ${error.message}`); }
  if (!object(value)) throw new Error(`expected JSON object in ${path}`);
  return value;
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function canonical(path) {
  const absolute = realpathSync.native(resolve(path));
  if (!statSync(absolute).isDirectory()) throw new Error(`workspace is not a directory: ${path}`);
  if (/[()\r\n]/.test(absolute)) throw new Error(`workspace cannot be represented in a permission rule: ${path}`);
  return absolute;
}
function strings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new Error(`${label} must be an array of strings`);
  return value;
}
function commandRules(commands) {
  return unique(commands).flatMap(command => {
    if (typeof command !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(command)) {
      throw new Error(`invalid allow-command name: ${command}; use a bare executable or cmdlet name`);
    }
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [`command(regex:^${escaped} .*$)`, `command(regex:^${escaped}$)`];
  });
}

const encodedJson = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => existsSync(path) ? hash(readFileSync(path)) : null;

function recoverPending(registry, registryPath, agyDir, dryRun) {
  if (registry.pending === undefined) return;
  const pending = registry.pending;
  if (!object(pending) || !UUID.test(pending.projectId) || typeof pending.key !== 'string'
    || !object(pending.project) || pending.project.id !== pending.projectId
    || !object(pending.entry) || pending.entry.projectId !== pending.projectId
    || typeof pending.entry.workdir !== 'string'
    || (pending.beforeHash !== null && !/^[0-9a-f]{64}$/.test(pending.beforeHash))) {
    throw new Error(`invalid pending auto-grant transaction in ${registryPath}`);
  }
  strings(pending.entry.managedAllow, 'pending managed allow');
  strings(pending.entry.managedDeny, 'pending managed deny');
  strings(pending.entry.managedResources, 'pending managed resources');
  const key = process.platform === 'win32' ? pending.entry.workdir.toLowerCase() : pending.entry.workdir;
  if (key !== pending.key) throw new Error(`pending workspace mismatch in ${registryPath}`);
  const entry = registry.projects[pending.key] || null;
  if (JSON.stringify(entry) !== JSON.stringify(pending.beforeEntry)
    && JSON.stringify(entry) !== JSON.stringify(pending.entry)) {
    throw new Error(`registry entry changed during interrupted auto-grant transaction: ${registryPath}`);
  }
  if (dryRun) throw new Error('an interrupted auto-grant transaction needs recovery; retry a normal write dispatch (dry-run writes nothing)');
  const projectPath = join(agyDir, 'projects', `${pending.projectId}.json`);
  const current = fileHash(projectPath);
  const desired = hash(encodedJson(pending.project));
  if (current !== desired) {
    if (current !== pending.beforeHash) throw new Error(`project changed during interrupted auto-grant transaction: ${projectPath}; preserve and inspect it before retrying`);
    writeJson(projectPath, pending.project);
  }
  registry.projects[pending.key] = pending.entry;
  delete registry.pending;
  writeJson(registryPath, registry);
}

// All relay writers serialize registry updates. Dead-process locks are recoverable.
function lockRegistry(path) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      return () => { if (existsSync(path)) unlinkSync(path); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(path, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('invalid lock owner');
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(path); continue; } }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        // A just-created lock may still be empty; do not steal a live writer's lock.
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 60_000) { unlinkSync(path); continue; }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`timed out waiting for project registry lock: ${path}`);
}

export function prepareAutoGrant(opts, { env = process.env, dryRun = false } = {}) {
  const reason = opts.autoGrant === false ? 'disabled' : opts.readOnly ? 'read-only'
    : opts.dangerouslySkipPermissions ? 'permission-bypass' : opts.resumeLast || opts.conversation ? 'resume' : null;
  if (reason) return { enabled: false, reason, dryRun };
  const workdir = canonical(opts.cd);
  const workspaces = unique([workdir, ...(opts.addDirs || []).map(canonical)]);
  const key = process.platform === 'win32' ? workdir.toLowerCase() : workdir;
  const configDir = resolve(env.DELEGATE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'delegate-skills'));
  const agyDir = resolve(env.AGY_CONFIG_DIR || join(homedir(), '.gemini', 'config'));
  const registryPath = join(configDir, 'agy-projects.json');
  const release = dryRun ? () => {} : lockRegistry(`${registryPath}.lock`);
  try {
    const registry = readJson(registryPath, { version: 1, projects: {} });
    if (registry.version !== 1 || !object(registry.projects)) throw new Error(`unsupported registry schema: ${registryPath}`);
    recoverPending(registry, registryPath, agyDir, dryRun);
    const previous = registry.projects[key];
    if (previous && (!object(previous) || !UUID.test(previous.projectId))) throw new Error(`invalid project entry in ${registryPath}`);
    const projectId = opts.project || (!opts.newProject && previous?.projectId) || randomUUID();
    if (!UUID.test(projectId)) throw new Error('auto-grant --project requires a project UUID; use --no-auto-grant for project names');
    const projectPath = join(agyDir, 'projects', `${projectId}.json`);
    if (opts.project && !existsSync(projectPath)) throw new Error(`existing project not found: ${projectPath}`);
    const project = readJson(projectPath, { id: projectId, name: basename(workdir) || 'delegate-project' });
    if (project.id !== projectId) throw new Error(`project id mismatch in ${projectPath}`);
    if (project.permissionGrants !== undefined && !object(project.permissionGrants)) throw new Error(`invalid permissionGrants in ${projectPath}`);
    const container = project.permissionGrants || {};
    if (container.permissionGrants !== undefined && !object(container.permissionGrants)) throw new Error(`invalid nested permissionGrants in ${projectPath}`);
    const grants = container.permissionGrants || {};
    const oldAllow = strings(grants.allow, 'project allow');
    const oldDeny = strings(grants.deny, 'project deny');
    const managed = previous?.projectId === projectId ? previous : {};
    const managedAllow = strings(managed.managedAllow, 'managed allow');
    const managedDeny = strings(managed.managedDeny, 'managed deny');
    const requestedAllow = [...workspaces.map(path => `write_file(${path})`), ...commandRules([
      ...DEFAULT_COMMANDS, ...strings(opts.allowCommands, 'allowCommands'),
    ])];
    const userAllow = oldAllow.filter(rule => !managedAllow.includes(rule));
    const userDeny = oldDeny.filter(rule => !managedDeny.includes(rule));
    const allow = unique([...userAllow, ...requestedAllow]);
    const deny = unique([...userDeny, ...DEFAULT_DENY]);
    project.permissionGrants = { ...container, permissionGrants: { ...grants, allow, deny } };
    const resources = project.projectResources === undefined ? {} : project.projectResources;
    if (!object(resources) || (resources.resources !== undefined && (!Array.isArray(resources.resources)
      || resources.resources.some(entry => !object(entry) || (entry.folderUri !== undefined && typeof entry.folderUri !== 'string'))))) {
      throw new Error(`invalid projectResources in ${projectPath}`);
    }
    const oldManagedResources = strings(managed.managedResources, 'managed resources');
    const entries = (resources.resources || []).filter(entry => !oldManagedResources.includes(entry.folderUri));
    const userResources = entries.map(entry => entry.folderUri);
    const requestedResources = workspaces.map(path => pathToFileURL(path).href);
    for (const folderUri of requestedResources) {
      if (!entries.some(entry => entry.folderUri === folderUri)) entries.push({ folderUri });
    }
    project.projectResources = { ...resources, resources: entries };
    const result = { enabled: true, dryRun, projectId, projectPath, registryPath, workdir,
      reused: existsSync(projectPath), allow, deny, commandPermissionsAreNotSandboxed: true };
    if (!dryRun) {
      const entry = { projectId, workdir,
        managedAllow: requestedAllow.filter(rule => !userAllow.includes(rule)),
        managedDeny: DEFAULT_DENY.filter(rule => !userDeny.includes(rule)),
        managedResources: requestedResources.filter(uri => !userResources.includes(uri)),
      };
      // Journal ownership before touching permissions. A later dispatch can finish
      // either interrupted phase without treating relay-owned grants as user rules.
      registry.pending = { key, projectId, project, entry,
        beforeHash: fileHash(projectPath), beforeEntry: registry.projects[key] || null };
      writeJson(registryPath, registry);
      writeJson(projectPath, project);
      registry.projects[key] = entry;
      delete registry.pending;
      writeJson(registryPath, registry);
    }
    return result;
  } finally { release(); }
}
