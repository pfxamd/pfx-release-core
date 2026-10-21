import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readCargoPackageName, syncCargoLock, syncCargoManifest, syncNpmLock } from './manifests.mjs';

export const SYNC_MESSAGE = 'chore(release): sync core version metadata [skip ci]';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA_PATTERN = /^[a-f\d]{40}$/i;
const CHANNELS = new Set(['Alpha', 'Beta', 'RC', 'Stable', 'Development']);

export function parseVersion(value) {
  const match = typeof value === 'string' && VERSION_PATTERN.exec(value);
  if (!match || (match[4] && match[4].split('.').some(v => /^\d+$/.test(v) && v.length > 1 && v[0] === '0'))) {
    throw new Error('Invalid SemVer baseVersion: ' + value);
  }
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease: match[4] || '' };
}

export function advanceVersion(base, increments) {
  if (!Number.isSafeInteger(increments) || increments < 0) throw new Error('Invalid source commit count');
  const parts = parseVersion(base);
  if (increments === 0) return base;
  const numeric = String(increments);
  if (!parts.prerelease) return [parts.major, parts.minor, parts.patch + BigInt(increments)].join('.');
  const identifiers = parts.prerelease.split('.');
  const last = identifiers.length - 1;
  if (/^\d+$/.test(identifiers[last])) identifiers[last] = String(BigInt(identifiers[last]) + BigInt(increments));
  else identifiers.push(numeric);
  return [parts.major, parts.minor, parts.patch].join('.') + '-' + identifiers.join('.');
}

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid ' + label);
}
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
    !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') && !path.includes('\\');
}
function checkedPath(root, path) {
  if (!safePath(path)) throw new Error('Unsafe release path: ' + path);
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..' + sep) || full === root) throw new Error('Release path escapes root');
  let next = root;
  for (const part of path.split('/')) {
    next = resolve(next, part);
    if (existsSync(next) && lstatSync(next).isSymbolicLink()) throw new Error('Symlink release path: ' + path);
  }
  return full;
}

export function validateConfig(raw) {
  requireObject(raw, 'release configuration');
  const cfg = {
    schemaVersion: raw.schemaVersion, product: raw.product, kind: raw.kind || 'core',
    channel: raw.channel, baseVersion: raw.baseVersion, baseline: raw.baseline,
    sourcePaths: raw.sourcePaths, jsonVersions: raw.jsonVersions || [],
    cargoVersions: raw.cargoVersions || [], cargoLocks: raw.cargoLocks || [],
    cargoNames: raw.cargoNames || [], npmLocks: raw.npmLocks || [],
    metadataPath: raw.metadataPath || 'version.json', badgePath: raw.badgePath || 'version-badge.svg',
    changelogPath: raw.changelogPath === false ? false : (raw.changelogPath || 'CHANGELOG.md'), ignoreSubjects: raw.ignoreSubjects || [SYNC_MESSAGE],
    allowGeneratedSourcePaths: raw.allowGeneratedSourcePaths === true
  };
  if (cfg.schemaVersion !== 1 || !['core','app','library'].includes(cfg.kind) ||
      typeof cfg.product !== 'string' || !cfg.product.trim() || !CHANNELS.has(cfg.channel) ||
      !SHA_PATTERN.test(cfg.baseline)) throw new Error('Invalid release configuration fields');
  parseVersion(cfg.baseVersion);
  for (const name of ['sourcePaths','jsonVersions','ignoreSubjects','cargoVersions','cargoLocks','cargoNames','npmLocks']) {
    if (!Array.isArray(cfg[name])) throw new Error('Invalid ' + name);
  }
  if (!cfg.sourcePaths.length || cfg.sourcePaths.some(p => !safePath(p)) ||
      [...cfg.jsonVersions,...cfg.cargoVersions,...cfg.cargoLocks,...cfg.npmLocks].some(p => !safePath(p)) ||
      [cfg.metadataPath,cfg.badgePath,...(cfg.changelogPath === false ? [] : [cfg.changelogPath])].some(p => !safePath(p)) ||
      cfg.ignoreSubjects.some(s => typeof s !== 'string') || cfg.cargoNames.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(n))) throw new Error('Unsafe or empty release paths');
  const outputs = [cfg.metadataPath,cfg.badgePath,...(cfg.changelogPath === false ? [] : [cfg.changelogPath]),
    ...cfg.jsonVersions,...cfg.cargoVersions,...cfg.cargoLocks,...cfg.npmLocks];
  if (new Set(outputs).size !== outputs.length) throw new Error('Duplicate release output paths');
  if (!cfg.allowGeneratedSourcePaths && outputs.some(path => cfg.sourcePaths.some(src => path === src || path.startsWith(src + '/')))) {
    throw new Error('Generated release output is inside sourcePaths');
  }
  if (cfg.allowGeneratedSourcePaths && !cfg.ignoreSubjects.includes(SYNC_MESSAGE)) {
    throw new Error('Generated source paths require the exact sync commit exclusion');
  }
  return cfg;
}

function git(root, ...args) {
  try { return execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer: 16 * 1024 * 1024}).trim(); }
  catch (error) { throw new Error('Git ' + args[0] + ' failed: ' + (error.stderr?.toString().trim() || error.message)); }
}
export function readGitHistory(root, config) {
  if (git(root,'rev-parse','--is-shallow-repository') === 'true') throw new Error('Full Git history is required; fetch with depth 0');
  git(root, 'merge-base', '--is-ancestor', config.baseline, 'HEAD');
  const lines = git(root, 'log', '--first-parent', '--format=%H%x09%s%x09%cI',
    config.baseline + '..HEAD', '--', ...config.sourcePaths);
  const commits = lines ? lines.split('\n').filter(Boolean).map(line => {
    const [sha, subject, date] = line.split('\t');
    if (!SHA_PATTERN.test(sha) || !date) throw new Error('Malformed Git log entry');
    return {sha, subject, date};
  }).filter(item => !config.ignoreSubjects.includes(item.subject)) : [];
  const sourceCommit = commits[0]?.sha || config.baseline;
  return {commits, sourceCommit, sourceDate: git(root,'show','-s','--format=%cI', sourceCommit)};
}

export function buildRelease(config, history) {
  const version = advanceVersion(config.baseVersion, history.commits.length);
  return {
    schemaVersion: 1, kind: config.kind, product: config.product, channel: config.channel,
    version, label: config.channel + ' ' + version,
    commit: history.sourceCommit, sourceDate: history.sourceDate
  };
}

function escapeXml(input) {
  return String(input).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[char]));
}
export function renderBadge(release) {
  const name = release.kind === 'core' ? 'core' : release.kind;
  const label = release.label;
  const width = Math.max(154, 55 + label.length * 7);
  const color = release.channel === 'Stable' ? '#287d5e' : release.channel === 'Development' ? '#68538b' : '#a36a24';
  const title = escapeXml(name + ': ' + label);
  const text = escapeXml(label);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="24" role="img" aria-label="' + title + '">' +
    '<title>' + title + '</title><rect width="' + width + '" height="24" rx="5" fill="#30363d"/>' +
    '<path d="M48 0h' + (width-53) + 'a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H48Z" fill="' + color + '"/>' +
    '<g fill="#fff" font-family="Verdana,Arial,sans-serif" font-size="11" text-anchor="middle">' +
    '<text x="24" y="16">' + name + '</text><text x="' + (48+(width-48)/2) + '" y="16">' + text + '</text></g></svg>\n';
}

function escapeMarkdown(value) { return value.replace(/[\\\x60*_\[\]<>]/g, '\\$&').replace(/[\r\n]/g,' '); }
export function renderChangelog(release, commits) {
  const groups = new Map([['Breaking changes',[]],['Features',[]],['Fixes',[]],['Maintenance',[]]]);
  for (const commit of commits) {
    const subject = commit.subject;
    const header = /^(feat|fix|perf|refactor|docs|test|chore|build|ci)(?:\([^)]*\))?(!)?:\s*(.*)$/.exec(subject);
    const key = header?.[2] ? 'Breaking changes' : header?.[1] === 'feat' ? 'Features' : header?.[1] === 'fix' ? 'Fixes' : 'Maintenance';
    const line = (header ? header[3] : subject) || 'Unnamed change';
    groups.get(key).push('- ' + escapeMarkdown(line) + ' (' + commit.sha.slice(0,7) + ')');
  }
  let text = '# Changelog\n\nGenerated from first-parent source commits; see Git for full history.\n\n## ' + release.version + '\n\n';
  if (!commits.length) return text + 'No source changes since the configured baseline.\n';
  for (const [heading, values] of groups) if (values.length) text += '### ' + heading + '\n\n' + values.join('\n') + '\n\n';
  return text.trimEnd() + '\n';
}

export function resolveFiles(root, config, release, commits) {
  const paths = new Map();
  const json = value => JSON.stringify(value, null, 2) + '\n';
  paths.set(config.metadataPath, json(release));
  paths.set(config.badgePath, renderBadge(release));
  if (config.changelogPath !== false) paths.set(config.changelogPath, renderChangelog(release, commits));
  const packageNames = new Set();
  for (const name of config.jsonVersions) {
    const original = JSON.parse(readFileSync(checkedPath(root, name),'utf8'));
    requireObject(original, name);
    if (typeof original.name === 'string') packageNames.add(original.name);
    original.version = release.version;
    paths.set(name, json(original));
  }
  const cargoNames = new Set(config.cargoNames);
  for (const name of config.cargoVersions) {
    const input = readFileSync(checkedPath(root, name), 'utf8');
    const crate = readCargoPackageName(input);
    if (crate) cargoNames.add(crate);
    paths.set(name, syncCargoManifest(input, release.version));
  }
  for (const name of config.npmLocks) {
    const lock = JSON.parse(readFileSync(checkedPath(root, name), 'utf8'));
    paths.set(name, json(syncNpmLock(lock, release.version, packageNames)));
  }
  for (const name of config.cargoLocks) {
    const location = checkedPath(root, name);
    if (existsSync(location)) {
      paths.set(name, syncCargoLock(readFileSync(location, 'utf8'), release.version, cargoNames));
    }
  }
  for (const path of paths.keys()) checkedPath(root,path);
  return paths;
}

export function syncFiles(root, files, check = false) {
  const changed = [];
  for (const [name, content] of files) {
    const path = checkedPath(root,name);
    if (!existsSync(path) || readFileSync(path,'utf8') !== content) changed.push(name);
  }
  if (check || !changed.length) return changed;
  for (const name of changed) {
    const path = checkedPath(root,name);
    mkdirSync(dirname(path),{recursive:true});
    const temporary = path + '.pfx-temp-' + process.pid;
    try { writeFileSync(temporary,files.get(name),'utf8'); renameSync(temporary,path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return changed;
}

export function readConfig(root, location = '.pfx/release.json') {
  return validateConfig(JSON.parse(readFileSync(checkedPath(root,location),'utf8')));
}

export function getRelease(root, location = '.pfx/release.json') {
  root = resolve(root);
  const config = readConfig(root,location);
  const history = readGitHistory(root,config);
  return {config,history,release:buildRelease(config,history)};
}

export function initializeConfig(root, options = {}) {
  root = resolve(root);
  const location = options.config || '.pfx/release.json';
  const dest = checkedPath(root,location);
  if (existsSync(dest)) throw new Error('Release config already exists: ' + location);
  if (git(root,'rev-parse','--is-shallow-repository') === 'true') throw new Error('Full Git history required');
  const existing = existsSync(resolve(root,'package.json')) ? JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')) : {};
  const sourcePaths = options.source ? options.source.split(',').map(x=>x.trim()) : ['src'];
  const cfg = validateConfig({
    schemaVersion:1,kind:options.kind || 'core',product:options.product || existing.name || 'PFx Project',
    channel:options.channel || 'Alpha',baseVersion:options.base || existing.version || '0.1.0-alpha.0',
    baseline:git(root,'rev-parse','HEAD'),sourcePaths,
    jsonVersions:existsSync(resolve(root,'package.json')) ? ['package.json'] : [],
    metadataPath:'version.json',badgePath:'version-badge.svg',changelogPath:'CHANGELOG.md',
    ignoreSubjects:[SYNC_MESSAGE]
  });
  mkdirSync(dirname(dest),{recursive:true});
  writeFileSync(dest,JSON.stringify(cfg,null,2)+'\n');
  return cfg;
}

/**
 * Backwards-compatible release resolver for PFx website and studio builds.
 * Retains the original public JSON contract: app commit/date refer to HEAD,
 * while only first-parent commits changing configured paths advance the version.
 */
export function resolveApplicationRelease(root, raw) {
  root = resolve(root);
  requireObject(raw, 'application release config');
  const cfg = validateConfig({
    schemaVersion: 1, kind: 'app', product: raw.product,
    channel: raw.channel, baseVersion: raw.baseVersion,
    baseline: raw.baseline, sourcePaths: raw.sourcePaths,
    jsonVersions: [], changelogPath: false, ignoreSubjects: [],
    allowGeneratedSourcePaths: false
  });
  if (!['Alpha', 'Beta', 'Stable'].includes(cfg.channel)) throw new Error('Invalid application release channel');
  const { commits } = readGitHistory(root, cfg);
  const version = advanceVersion(cfg.baseVersion, commits.length);
  return {
    schemaVersion: 1, product: cfg.product, channel: cfg.channel, version,
    label: cfg.channel + ' ' + version,
    commit: git(root, 'rev-parse', 'HEAD'),
    sourceDate: git(root, 'show', '-s', '--format=%cI', 'HEAD')
  };
}
