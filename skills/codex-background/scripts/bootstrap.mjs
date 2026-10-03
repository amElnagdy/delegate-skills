#!/usr/bin/env node
/** Codex host setup for codex-background: writes the registry and the managed config.toml block. Node built-ins only; no network. */
import { spawn } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EOL, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'codex-background.registry.v1';
const NAMESPACE = 'mcp__codex_background';
const DIRECT = 'direct_only_tool_namespaces';
const MCP = ['mcp_servers', 'codex_background'];
const MCP_ENV = [...MCP, 'env'];
const CODE_MODE = ['features', 'code_mode'];
const BEGIN = '# BEGIN codex-background (managed by codex-background bootstrap; re-run bootstrap instead of editing)';
const END = '# END codex-background';
const OWNED = { [MCP.join('.')]: ['command', 'args', 'tool_timeout_sec', 'required'], [MCP_ENV.join('.')]: ['CODEX_BACKGROUND_REGISTRY'] };
const DEFAULT_TIMEOUT = 7200;
const MAX_TIMEOUT = 2147483;
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const USAGE = `Usage: node bootstrap.mjs [options]
  --codex-home <dir>       Codex home (default: $CODEX_HOME, then ~/.codex)
  --skills-dir <dir>       installed skills directory (default: parent of this skill)
  --workspace-root <dir>   approved workspace root; repeatable (default: home directory, plus <codex-home>/worktrees if present)
  --host-timeout <s>       host tool timeout in seconds (default: ${DEFAULT_TIMEOUT}; a previous bootstrap value is kept)
  --dry-run                print planned changes, write nothing
  --check                  validate config, registry and MCP tools/list, write nothing
  --json                   machine-readable summary
  --help                   show this help`;

class ConfigError extends Error {}
class UsageError extends Error {}

const fwd = path => process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
const same = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
const startsWith = (path, prefix) => prefix.length <= path.length && prefix.every((part, i) => part === path[i]);
const pathKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (path, root) => { const r = relative(pathKey(root), pathKey(path)); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const quote = value => `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, c => ({ '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' })[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

// ---- Minimal position-based TOML reader: enough to find tables, keys and value extents without rewriting anything. ----
function skipString(t, i) {
  const q = t[i];
  if (t.startsWith(q.repeat(3), i)) {
    for (let j = i + 3; j < t.length; j++) {
      if (q === '"' && t[j] === '\\') { j++; continue; }
      if (t.startsWith(q.repeat(3), j)) { let k = j + 3; while (k < t.length && t[k] === q && k < j + 5) k++; return k; }
    }
    throw new ConfigError('unterminated multi-line string');
  }
  for (let j = i + 1; j < t.length && t[j] !== '\n'; j++) {
    if (q === '"' && t[j] === '\\') { j++; continue; }
    if (t[j] === q) return j + 1;
  }
  throw new ConfigError('unterminated string');
}
function unquote(token) {
  const q = token[0], triple = token.length >= 6 && token.startsWith(q.repeat(3));
  let body = token.slice(triple ? 3 : 1, triple ? -3 : -1);
  if (triple) body = body.replace(/^\r?\n/, '');
  if (q === "'") return body;
  return body.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g, (_, small, big, c) => {
    if (small || big) return String.fromCodePoint(parseInt(small || big, 16));
    const known = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (!Object.hasOwn(known, c)) throw new ConfigError(`invalid escape \\${c}`);
    return known[c];
  });
}
function skipValue(t, i) {
  const c = t[i];
  if (c === '"' || c === "'") return skipString(t, i);
  if (c === '[' || c === '{') {
    for (let depth = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"' || ch === "'") { i = skipString(t, i) - 1; continue; }
      if (ch === '#') { while (i < t.length && t[i] !== '\n') i++; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if ((ch === ']' || ch === '}') && --depth === 0) return i + 1;
    }
    throw new ConfigError('unterminated array or inline table');
  }
  const start = i;
  while (i < t.length && !/[\s#,\]}]/.test(t[i])) i++;
  if (i === start) throw new ConfigError('missing value');
  return i;
}
function readKey(t, i) {
  const path = [];
  for (;;) {
    while (t[i] === ' ' || t[i] === '\t') i++;
    const c = t[i];
    if (c === '"' || c === "'") { const end = skipString(t, i); path.push(unquote(t.slice(i, end))); i = end; }
    else { const m = /^[A-Za-z0-9_-]+/.exec(t.slice(i, i + 256)); if (!m) throw new ConfigError('invalid key'); path.push(m[0]); i += m[0].length; }
    while (t[i] === ' ' || t[i] === '\t') i++;
    if (t[i] === '.') i++; else return { path, next: i };
  }
}
function scan(text) {
  const entries = [];
  let table = [], array = false, i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const after = from => { const n = text.indexOf('\n', from); return n < 0 ? text.length : n + 1; };
  const tail = /^[ \t]*(#[^\r\n]*)?\r?\n?$/;
  while (i < text.length) {
    const start = i, end = after(i);
    let p = start;
    while (text[p] === ' ' || text[p] === '\t') p++;
    try {
      const c = text[p];
      if (c === undefined || c === '\r' || c === '\n') { entries.push({ kind: 'blank', start, end }); i = end; }
      else if (c === '#') { entries.push({ kind: 'comment', start, end, text: text.slice(p, end).trimEnd() }); i = end; }
      else if (c === '[') {
        const isArray = text[p + 1] === '[', close = isArray ? ']]' : ']';
        const { path, next } = readKey(text, p + (isArray ? 2 : 1));
        if (!text.startsWith(close, next) || !tail.test(text.slice(next + close.length, end))) throw new ConfigError('invalid table header');
        table = path; array = isArray;
        entries.push({ kind: 'header', start, end, path, array: isArray }); i = end;
      } else {
        const { path, next } = readKey(text, p);
        if (text[next] !== '=') throw new ConfigError('expected "=" after key');
        let valueStart = next + 1;
        while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart++;
        const valueEnd = skipValue(text, valueStart), lineEnd = after(valueEnd);
        if (!tail.test(text.slice(valueEnd, lineEnd))) throw new ConfigError('unexpected text after value');
        entries.push({ kind: 'key', start, end: lineEnd, path, table, array, valueStart, valueEnd }); i = lineEnd;
      }
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw new ConfigError(`line ${text.slice(0, start).split('\n').length}: ${error.message}`);
    }
  }
  return entries;
}
function skipTrivia(t, i) {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] !== '#') return i;
    while (i < t.length && t[i] !== '\n') i++;
  }
}
function parseArray(t, i) {
  if (t[i] !== '[') throw new ConfigError('is not an array');
  const elements = [];
  let lastComma = -1;
  i++;
  for (;;) {
    i = skipTrivia(t, i);
    if (t[i] === ']') return { elements, close: i, lastComma };
    if ((t[i] !== '"' && t[i] !== "'") || t.startsWith(t[i].repeat(3), i)) throw new ConfigError('has items that are not single-line strings');
    const end = skipString(t, i);
    elements.push({ start: i, end, value: unquote(t.slice(i, end)) });
    lastComma = -1;
    i = skipTrivia(t, end);
    if (t[i] === ',') lastComma = ++i;
    else if (t[i] !== ']') throw new ConfigError('is malformed');
  }
}
function decodeValue(raw) {
  try {
    if (raw[0] === '"' || raw[0] === "'") return unquote(raw);
    if (raw[0] === '[') return parseArray(raw, 0).elements.map(e => e.value);
  } catch (error) { if (!(error instanceof ConfigError)) throw error; return undefined; }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^[+-]?\d[\d_]*$/.test(raw)) return Number(raw.replaceAll('_', ''));
  return undefined;
}

/** Reads back what bootstrap owns from config.toml text. */
export function readManaged(text) {
  const entries = scan(text);
  const out = { block: entries.some(e => e.kind === 'comment' && e.text === END), main: false, env: false, values: {}, envValues: {}, namespaces: undefined };
  for (const e of entries) {
    if (e.kind === 'header' && !e.array && same(e.path, MCP)) out.main = true;
    if (e.kind === 'header' && !e.array && same(e.path, MCP_ENV)) out.env = true;
    if (e.kind !== 'key' || e.array || e.path.length !== 1) continue;
    const value = decodeValue(text.slice(e.valueStart, e.valueEnd));
    if (same(e.table, MCP)) out.values[e.path[0]] = value;
    else if (same(e.table, MCP_ENV)) out.envValues[e.path[0]] = value;
    else if (same(e.table, CODE_MODE) && e.path[0] === DIRECT) out.namespaces = value;
  }
  return out;
}

function appendNamespace(t, key, eol) {
  const arr = parseArray(t, key.valueStart);
  if (arr.elements.some(e => e.value === NAMESPACE)) return [];
  const item = JSON.stringify(NAMESPACE), last = arr.elements.at(-1);
  const lineStart = at => t.lastIndexOf('\n', at - 1) + 1;
  const indent = at => /^[ \t]*/.exec(t.slice(lineStart(at), at))[0];
  if (!last) {
    const own = lineStart(arr.close) > key.valueStart && !t.slice(lineStart(arr.close), arr.close).trim();
    return [own ? { start: lineStart(arr.close), end: lineStart(arr.close), text: `${indent(arr.close)}  ${item},${eol}` } : { start: arr.close, end: arr.close, text: item }];
  }
  const tailAt = arr.lastComma === -1 ? last.end : arr.lastComma;
  if (!t.slice(tailAt, arr.close).includes('\n')) return [{ start: last.end, end: last.end, text: `, ${item}` }];
  const next = t.indexOf('\n', tailAt) + 1;
  return [...(arr.lastComma === -1 ? [{ start: last.end, end: last.end, text: ',' }] : []), { start: next, end: next, text: `${indent(last.start)}${item},${eol}` }];
}
function sectionRange(entries, i) {
  let last = entries[i];
  for (let j = i + 1; j < entries.length && entries[j].kind !== 'header'; j++) if (entries[j].kind === 'key') last = entries[j];
  return { start: entries[i].start, end: last.end };
}

/** Line-based edit: owns the two codex_background tables (inside a marked block) and the code_mode namespace entry; every other byte is preserved. */
export function editConfigToml(text, { command, serverPath, timeoutSeconds, registryPath }) {
  const lf = (text.match(/\n/g) ?? []).length, crlf = (text.match(/\r\n/g) ?? []).length;
  const eol = !lf ? EOL : crlf >= lf - crlf ? '\r\n' : '\n';
  const entries = scan(text);
  const comments = entries.filter(e => e.kind === 'comment');
  const begins = comments.filter(e => e.text.startsWith('# BEGIN codex-background')), ends = comments.filter(e => e.text === END);
  if (begins.length > 1 || begins.length !== ends.length || (begins[0] && begins[0].start > ends[0].start)) throw new ConfigError('Unbalanced or duplicate "codex-background" BEGIN/END markers in config.toml; fix or remove them by hand, then re-run bootstrap.');
  const block = begins[0] ? { start: begins[0].start, end: ends[0].end } : null;
  const inBlock = e => block && e.start >= block.start && e.start < block.end;
  const manual = (what, how) => new ConfigError(`${what} Edit config.toml by hand: ${how}, then re-run bootstrap.`);

  for (const e of entries) {
    if (inBlock(e)) continue;
    if (e.kind === 'header' && e.array && (startsWith(MCP_ENV, e.path) || startsWith(CODE_MODE, e.path))) throw manual(`[[${e.path.join('.')}]] conflicts with what bootstrap manages.`, 'rename or remove that array of tables');
    if (e.kind !== 'key' || startsWith(e.table, MCP) || startsWith(e.table, CODE_MODE)) continue;
    const abs = [...e.table, ...e.path];
    if (startsWith(abs, MCP) || startsWith(MCP, abs)) throw manual(`mcp_servers.codex_background is defined with dotted or inline syntax (${abs.join('.')}).`, 'convert it to [mcp_servers.codex_background] tables or remove it');
    if (startsWith(abs, CODE_MODE) || startsWith(CODE_MODE, abs)) throw manual(`features.code_mode is defined with dotted, inline or boolean syntax (${abs.join('.')}).`, `make it a [features.code_mode] table whose ${DIRECT} array contains "${NAMESPACE}"`);
  }
  const owned = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'header' && !inBlock(e) && !e.array && (same(e.path, MCP) || same(e.path, MCP_ENV)));
  if (new Set(owned.map(({ e }) => e.path.join('.'))).size !== owned.length || (block && owned.length)) throw new ConfigError('Duplicate [mcp_servers.codex_background] tables in config.toml (TOML forbids this). Remove the extra copies by hand, then re-run bootstrap.');
  const dropped = entries.filter(e => e.kind === 'key' && !e.array && e.path.length >= 1 && OWNED[e.table.join('.')] && !(e.path.length === 1 && OWNED[e.table.join('.')].includes(e.path[0]))).map(e => `${e.table.at(-1) === 'env' ? 'env.' : ''}${e.path.join('.')}`);

  const edits = [];
  const codeModes = entries.filter(e => e.kind === 'header' && !inBlock(e) && !e.array && same(e.path, CODE_MODE));
  if (codeModes.length > 1) throw new ConfigError('Duplicate [features.code_mode] tables in config.toml. Remove the extra copy by hand, then re-run bootstrap.');
  const needTable = !codeModes.length;
  if (codeModes.length) {
    const header = codeModes[0];
    const keys = entries.filter(e => e.kind === 'key' && !inBlock(e) && same(e.table, CODE_MODE) && e.path[0] === DIRECT);
    if (keys.length > 1 || keys.some(e => e.path.length > 1)) throw manual(`${DIRECT} is defined more than once or with dotted keys.`, `list "${NAMESPACE}" in a single ${DIRECT} array under [features.code_mode]`);
    if (!keys.length) {
      const line = `${DIRECT} = [${quote(NAMESPACE)}]`;
      edits.push(text.endsWith('\n') || header.end < text.length ? { start: header.end, end: header.end, text: line + eol } : { start: header.end, end: header.end, text: eol + line });
    } else {
      try { edits.push(...appendNamespace(text, keys[0], eol)); }
      catch (error) { if (!(error instanceof ConfigError)) throw error; throw manual(`${DIRECT} ${error.message}.`, `add "${NAMESPACE}" to that array`); }
    }
  }

  const lines = [BEGIN, `[${MCP.join('.')}]`, `command = ${quote(command)}`, `args = [${quote(serverPath)}]`, `tool_timeout_sec = ${timeoutSeconds}`, 'required = true', '', `[${MCP_ENV.join('.')}]`, `CODEX_BACKGROUND_REGISTRY = ${quote(registryPath)}`];
  if (needTable) lines.push('', `[${CODE_MODE.join('.')}]`, `${DIRECT} = [${quote(NAMESPACE)}]`);
  const blockText = [...lines, END].map(l => l + eol).join('');
  if (block) edits.push({ ...block, text: blockText });
  else if (owned.length) owned.forEach(({ i }, n) => edits.push({ ...sectionRange(entries, i), text: n ? '' : blockText }));
  else edits.push({ start: text.length, end: text.length, text: (text && !text.endsWith('\n') ? eol : '') + (text.trim() ? eol : '') + blockText });

  edits.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start));
  let result = text;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  if (!result.endsWith('\n')) result += eol;
  return { text: result, changed: result !== text, dropped };
}

// ---- Host, registry and plan ----
function hostProblem(platform, exists, env) {
  if (platform === 'linux') return !exists('/usr/bin/cc') ? 'Linux ownership requires the system C compiler at /usr/bin/cc' : !exists('/proc') ? 'Linux ownership requires procfs at /proc' : null;
  if (platform === 'win32') {
    const root = env.SystemRoot || env.WINDIR;
    return !root ? 'Windows system directory is unavailable (SystemRoot is not set)' : !exists(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) ? 'Windows ownership requires inbox Windows PowerShell' : null;
  }
  return `Unsupported host (${platform}): codex-background needs Windows or Linux process ownership. Nothing was written.`;
}
function resolvePaths(opts) {
  const env = opts.env ?? process.env, home = resolve(opts.homeDir ?? homedir());
  const codexHome = resolve(opts.codexHome ?? (env.CODEX_HOME || join(home, '.codex')));
  const base = join(codexHome, 'codex-background');
  return {
    env, home, codexHome, base, platform: opts.platform ?? process.platform, exists: opts.exists ?? existsSync,
    skillsDir: resolve(opts.skillsDir ?? dirname(dirname(HERE))), nodePath: opts.nodePath ?? process.execPath, serverPath: opts.serverPath ?? join(HERE, 'server.mjs'),
    configFile: join(codexHome, 'config.toml'), registryFile: join(base, 'registry.json'),
  };
}
function isDirectory(path) { try { return statSync(path).isDirectory(); } catch { return false; } }

export function scanRelays(skillsDir) {
  if (!isDirectory(skillsDir)) throw Error(`Skills directory not found: ${skillsDir}`);
  const relays = {}, skipped = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const match = /^([a-z][a-z0-9-]*)-delegate$/.exec(name);
    if (!match) continue;
    let real;
    try { real = realpathSync(join(skillsDir, name, 'scripts', 'relay.mjs')); if (!statSync(real).isFile()) continue; } catch { continue; }
    if (basename(real) !== 'relay.mjs' || basename(dirname(real)) !== 'scripts' || basename(dirname(dirname(real))) !== name) { skipped.push(`${name} (resolves to ${real}, which the server would reject)`); continue; }
    relays[match[1]] = fwd(real);
  }
  return { relays, skipped };
}
function dedupeRoots(roots) {
  const items = [...new Set(roots.map(r => resolve(r)))].map(path => ({ path, real: realpathSync(path) }));
  return items.filter(item => !items.some(other => other !== item && inside(item.real, other.real) && (!inside(other.real, item.real) || items.indexOf(other) < items.indexOf(item)))).map(item => fwd(item.path));
}

export function planBootstrap(opts = {}) {
  const p = resolvePaths(opts);
  const problem = hostProblem(p.platform, p.exists, p.env);
  if (problem) throw Error(problem);
  const { relays, skipped } = scanRelays(p.skillsDir);
  if (!Object.keys(relays).length) throw Error(`No *-delegate skills with scripts/relay.mjs found in ${p.skillsDir}. Install at least one (for example: npx skills add amElnagdy/delegate-skills --skill codex-delegate) and re-run bootstrap.`);
  if (opts.hostTimeout !== undefined && !(Number.isInteger(opts.hostTimeout) && opts.hostTimeout > 30 && opts.hostTimeout <= MAX_TIMEOUT)) throw new UsageError(`--host-timeout must be an integer between 31 and ${MAX_TIMEOUT}`);

  const stateDirectory = fwd(join(p.base, 'state')), artifactRoot = fwd(p.base);
  let existing = null, foreign = null;
  const existingRaw = p.exists(p.registryFile) ? readFileSync(p.registryFile, 'utf8') : null;
  if (existingRaw !== null) {
    try { existing = JSON.parse(existingRaw); } catch { foreign = 'is not valid JSON'; }
    if (existing && (typeof existing !== 'object' || existing.schema !== SCHEMA)) foreign = 'has an unknown schema';
    else if (existing && !(typeof existing.stateDirectory === 'string' && pathKey(existing.stateDirectory) === pathKey(stateDirectory) && Array.isArray(existing.artifactRoots) && existing.artifactRoots.length === 1 && typeof existing.artifactRoots[0] === 'string' && pathKey(existing.artifactRoots[0]) === pathKey(artifactRoot))) foreign = 'was not produced by bootstrap (different state or artifact roots)';
    if (foreign) existing = null;
  }
  const kept = existing && Array.isArray(existing.workspaceRoots) ? existing.workspaceRoots.filter(r => typeof r === 'string' && isAbsolute(r) && isDirectory(r)) : [];
  const keptTimeout = existing && Number.isInteger(existing.hostToolTimeoutSeconds) && existing.hostToolTimeoutSeconds > 30 && existing.hostToolTimeoutSeconds <= MAX_TIMEOUT ? existing.hostToolTimeoutSeconds : undefined;
  const timeout = opts.hostTimeout ?? keptTimeout ?? DEFAULT_TIMEOUT;
  let roots;
  if (opts.workspaceRoots?.length) {
    roots = opts.workspaceRoots.map(r => resolve(r));
    for (const root of roots) if (!isDirectory(root)) throw Error(`Workspace root is not an existing directory: ${root}`);
  } else if (kept.length) roots = kept;
  else {
    if (!isDirectory(p.home)) throw Error(`Home directory is not an existing directory: ${p.home}`);
    roots = [p.home, ...(isDirectory(join(p.codexHome, 'worktrees')) ? [join(p.codexHome, 'worktrees')] : [])];
  }
  const registry = { schema: SCHEMA, hostToolTimeoutSeconds: timeout, stateDirectory, workspaceRoots: dedupeRoots(roots), artifactRoots: [artifactRoot], relays };
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  const registryPlan = { file: p.registryFile, status: existingRaw === null ? 'create' : foreign ? 'replace' : existingRaw === serialized ? 'unchanged' : 'update', reason: foreign, registry, serialized, backup: foreign !== null };

  const configExists = p.exists(p.configFile), configText = configExists ? readFileSync(p.configFile, 'utf8') : '';
  let configPlan;
  try {
    const edit = editConfigToml(configText, { command: fwd(p.nodePath), serverPath: fwd(realpathSync(p.serverPath)), timeoutSeconds: timeout, registryPath: fwd(p.registryFile) });
    configPlan = { file: p.configFile, status: !configExists ? 'create' : edit.changed ? 'update' : 'unchanged', text: edit.text, dropped: edit.dropped, backup: configExists && edit.changed };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configPlan = { file: p.configFile, status: 'refused', error: error.message, dropped: [], backup: false };
  }
  const directories = ['state', 'briefs', 'runs'].map(name => join(p.base, name));
  return { codexHome: p.codexHome, skillsDir: p.skillsDir, platform: p.platform, relays, skipped, registry: registryPlan, config: configPlan, directories: directories.filter(d => !isDirectory(d)), allDirectories: directories };
}

function atomicWrite(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  try { renameSync(temporary, file); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function backup(file, stamp) {
  for (let n = 0; ; n++) {
    const target = `${file}.bak-${stamp}${n ? `-${n}` : ''}`;
    try { copyFileSync(file, target, constants.COPYFILE_EXCL); return target; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export function applyBootstrap(plan, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const result = { registry: { status: plan.registry.status, backup: null }, config: { status: plan.config.status, backup: null }, createdDirectories: plan.directories };
  for (const dir of plan.allDirectories) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (plan.registry.status !== 'unchanged') {
    if (plan.registry.backup) result.registry.backup = backup(plan.registry.file, stamp);
    atomicWrite(plan.registry.file, plan.registry.serialized, 0o600);
  }
  if (plan.config.status === 'create' || plan.config.status === 'update') {
    if (plan.config.backup) result.config.backup = backup(plan.config.file, stamp);
    atomicWrite(plan.config.file, plan.config.text, plan.config.backup ? statSync(plan.config.file).mode & 0o777 : 0o600);
  }
  return result;
}

// ---- Validation ----
function probeServer({ command, args, registryPath, timeoutMs = 20000 }) {
  return new Promise(resolveProbe => {
    let child, stderr = '', settled = false;
    const replies = new Map();
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(limit);
      resolveProbe({ stderr: stderr.trim(), ...value });
      if (child && child.exitCode === null) { child.stdin.end(); setTimeout(() => child.kill(), 5000).unref(); }
    };
    const limit = setTimeout(() => finish({ error: `no MCP reply within ${timeoutMs / 1000}s` }), timeoutMs);
    try { child = spawn(command, args, { env: { ...process.env, CODEX_BACKGROUND_REGISTRY: registryPath }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ error: error.message }); return; }
    child.once('error', error => finish({ error: error.message }));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('close', code => finish({ error: `server exited (${code}) before replying` }));
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      replies.set(message.id, message);
      if (replies.has(1) && replies.has(2)) finish({ initialize: replies.get(1).result, tools: replies.get(2).result?.tools, error: replies.get(1).error?.message ?? replies.get(2).error?.message });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-background-bootstrap', version: '0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}

export async function checkBootstrap(opts = {}) {
  const p = resolvePaths(opts), items = [];
  const add = (name, ok, detail = '') => items.push({ name, ok: Boolean(ok), detail });
  const problem = hostProblem(p.platform, p.exists, p.env);
  add('host supported', !problem, problem ?? p.platform);
  if (problem) return { ok: false, items };
  let registry = null, managed = null;
  try { registry = JSON.parse(readFileSync(p.registryFile, 'utf8')); add('registry parses', registry?.schema === SCHEMA, registry?.schema === SCHEMA ? p.registryFile : `unexpected schema in ${p.registryFile}`); }
  catch (error) { add('registry parses', false, `${p.registryFile}: ${error.message}`); }
  for (const [key, path] of Object.entries(registry?.relays ?? {})) add(`relay ${key} exists`, typeof path === 'string' && p.exists(path) && statSync(path).isFile(), String(path));
  try { managed = readManaged(readFileSync(p.configFile, 'utf8')); } catch (error) { add('config.toml readable', false, `${p.configFile}: ${error.message}`); }
  let command, args, registryPath;
  if (managed) {
    command = managed.values.command; args = managed.values.args; registryPath = managed.envValues.CODEX_BACKGROUND_REGISTRY;
    const wrong = [];
    if (!managed.main || !managed.env) wrong.push('managed tables missing');
    if (typeof command !== 'string' || pathKey(command) !== pathKey(p.nodePath)) wrong.push('command is not this Node');
    if (!Array.isArray(args) || args.length !== 1 || pathKey(args[0]) !== pathKey(realpathSync(p.serverPath))) wrong.push("args is not this skill's server.mjs");
    if (managed.values.required !== true) wrong.push('required is not true');
    if (registry && managed.values.tool_timeout_sec !== registry.hostToolTimeoutSeconds) wrong.push('tool_timeout_sec differs from the registry');
    if (typeof registryPath !== 'string' || pathKey(registryPath) !== pathKey(p.registryFile)) wrong.push('CODEX_BACKGROUND_REGISTRY is not the generated registry');
    add('config.toml: mcp_servers.codex_background', !wrong.length, wrong.join('; ') || p.configFile);
    add(`config.toml: ${DIRECT} contains ${NAMESPACE}`, Array.isArray(managed.namespaces) && managed.namespaces.includes(NAMESPACE), '[features.code_mode]');
  }
  if (!managed || !registry || !p.exists(String(command))) add('server: initialize + tools/list', false, 'skipped: config or registry is incomplete');
  else {
    const probe = await probeServer({ command, args: Array.isArray(args) ? args : [], registryPath: typeof registryPath === 'string' ? registryPath : p.registryFile });
    const names = (probe.tools ?? []).map(tool => tool.name);
    add('server: initialize + tools/list', !probe.error && ['delegate_run', 'delegate_wait', 'delegate_abort'].every(n => names.includes(n)), probe.error ? `${probe.error}${probe.stderr ? ` (${probe.stderr})` : ''}` : names.join(', '));
    const listed = probe.tools?.find(tool => tool.name === 'delegate_run')?.inputSchema?.properties?.implementer?.enum;
    const expected = Object.keys(registry.relays ?? {}).sort();
    add('server: implementer enum equals registered keys', Array.isArray(listed) && same([...listed].sort(), expected), Array.isArray(listed) ? listed.join(', ') : 'delegate_run not listed');
  }
  return { ok: items.every(item => item.ok), items };
}

// ---- CLI ----
export function parseArgs(argv) {
  const args = { workspaceRoots: [] };
  const valued = { '--codex-home': 'codexHome', '--skills-dir': 'skillsDir', '--workspace-root': 'workspaceRoots', '--host-timeout': 'hostTimeout' };
  const flags = { '--dry-run': 'dryRun', '--check': 'check', '--json': 'json', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i]];
    if (Object.hasOwn(flags, name) && inline === undefined) args[flags[name]] = true;
    else if (Object.hasOwn(valued, name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) throw new UsageError(`${name} needs a value`);
      if (name === '--workspace-root') args.workspaceRoots.push(value);
      else if (name === '--host-timeout') { if (!/^\d+$/.test(value)) throw new UsageError('--host-timeout must be an integer number of seconds'); args.hostTimeout = Number(value); }
      else args[valued[name]] = value;
    } else throw new UsageError(`Unknown option: ${argv[i]}`);
  }
  return args;
}

const PAST = { create: 'created', update: 'updated', unchanged: 'unchanged', replace: 'replaced', refused: 'not changed' };
const FUTURE = { create: 'would create', update: 'would update', unchanged: 'unchanged', replace: 'would replace', refused: 'would not change' };

export async function run(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? (line => process.stdout.write(`${line}\n`)), err = io.err ?? (line => process.stderr.write(`${line}\n`));
  let args;
  try { args = parseArgs(argv); } catch (error) { if (!(error instanceof UsageError)) throw error; err(`${error.message}\n${USAGE}`); return 2; }
  if (args.help) { out(USAGE); return 0; }
  const common = { codexHome: args.codexHome, skillsDir: args.skillsDir, platform: io.platform, homeDir: io.homeDir, env: io.env, exists: io.exists, nodePath: io.nodePath, serverPath: io.serverPath };
  const lines = [], report = { ok: true };
  const show = items => items.forEach(item => lines.push(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`));
  try {
    if (args.check) {
      const check = await checkBootstrap(common);
      Object.assign(report, { ok: check.ok, mode: 'check', checks: check.items });
      lines.push('codex-background check (nothing written)'); show(check.items);
      lines.push(check.ok ? 'All checks passed.' : 'Check failed; run bootstrap again after fixing the items above.');
    } else {
      const plan = planBootstrap({ ...common, workspaceRoots: args.workspaceRoots, hostTimeout: args.hostTimeout });
      const words = args.dryRun ? FUTURE : PAST;
      const applied = args.dryRun ? null : applyBootstrap(plan);
      const registryFile = plan.registry.file.replaceAll('\\', '/'), configFile = plan.config.file.replaceAll('\\', '/');
      Object.assign(report, { mode: args.dryRun ? 'dry-run' : 'apply', codexHome: plan.codexHome, skillsDir: plan.skillsDir, relays: Object.keys(plan.relays), registry: { file: registryFile, status: plan.registry.status, backup: applied?.registry.backup ?? null }, config: { file: configFile, status: plan.config.status, backup: applied?.config.backup ?? null, dropped: plan.config.dropped, ...(plan.config.error ? { error: plan.config.error } : {}) }, directoriesCreated: plan.directories });
      lines.push(`codex-background bootstrap${args.dryRun ? ' (dry run; nothing written)' : ''}`, `  Codex home: ${plan.codexHome}`, `  Skills dir: ${plan.skillsDir}`, `  Relays:     ${Object.keys(plan.relays).join(', ')}`);
      for (const note of plan.skipped) lines.push(`  Skipped:    ${note}`);
      lines.push(`  Registry:   ${words[plan.registry.status]} ${registryFile}${plan.registry.reason ? ` (existing file ${plan.registry.reason}; ${args.dryRun ? 'would be backed up' : 'backed up'}${applied?.registry.backup ? ` to ${applied.registry.backup}` : ''})` : ''}`);
      lines.push(`  Workspaces: ${plan.registry.registry.workspaceRoots.join(', ')}`);
      lines.push(`  Config:     ${words[plan.config.status]} ${configFile}${plan.config.backup ? ` (${args.dryRun ? 'would back up' : 'backup'}${applied?.config.backup ? `: ${applied.config.backup}` : ''})` : ''}`);
      if (plan.directories.length) lines.push(`  Directories: ${args.dryRun ? 'would create' : 'created'} ${plan.directories.join(', ')}`);
      if (plan.config.dropped.length) lines.push(`  Dropped non-owned keys from the codex_background tables (kept in the backup): ${plan.config.dropped.join(', ')}`);
      const registryChanged = plan.registry.status !== 'unchanged', configChanged = ['create', 'update'].includes(plan.config.status);
      if (plan.config.status === 'refused') {
        report.ok = false; lines.push(`  config.toml was NOT modified: ${plan.config.error}`);
      } else if (!args.dryRun) {
        const check = await checkBootstrap(common);
        report.checks = check.items; report.ok = check.ok;
        lines.push('Validation:'); show(check.items);
      }
      report.restartRequired = !args.dryRun && report.ok && (registryChanged || configChanged);
      lines.push(args.dryRun ? 'Dry run complete; nothing was written.'
        : !report.ok ? 'Bootstrap did not finish cleanly; fix the items above and re-run.'
        : configChanged ? 'Restart Codex (or reload MCP servers) to load codex-background.'
        : registryChanged ? 'The registry changed: restart Codex (or reload the codex-background MCP server) so the server re-reads it.'
        : plan.directories.length ? 'Configuration is current; created the missing working directories.' : 'Already configured.');
    }
  } catch (error) {
    if (error instanceof UsageError) { err(`${error.message}\n${USAGE}`); return 2; }
    report.ok = false; report.error = error.message;
    if (args.json) out(JSON.stringify(report, null, 2)); else err(error.message);
    return 1;
  }
  if (args.json) out(JSON.stringify(report, null, 2)); else for (const line of lines) out(line);
  return report.ok ? 0 : 1;
}

function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) process.exitCode = await run();
