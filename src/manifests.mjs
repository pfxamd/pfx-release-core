const packageSection = /(^|\n)(\[(?:package|workspace\.package)\])\s*\n/g;

export function syncCargoManifest(input, version) {
  if (typeof input !== 'string') throw new Error('Cargo manifest must be text');
  const sections = [...input.matchAll(packageSection)];
  const target = sections.find(x => x[2] === '[workspace.package]') || sections.find(x => x[2] === '[package]');
  if (!target) throw new Error('Cargo manifest has no [package] or [workspace.package] section');
  const begin = target.index + target[0].length;
  const end = sections.concat([...input.matchAll(/(?:^|\n)\[[^\]\r\n]+\]\s*\n/g)])
    .map(x => x.index).filter(pos => pos > target.index).sort((a,b) => a-b)[0] ?? input.length;
  const block = input.slice(begin,end);
  const versionLine = /(^|\n)(version\s*=\s*")([^"]+)("(?=[ \t]*(?:#.*)?(?:\r?\n|$)))/;
  if (!versionLine.test(block)) throw new Error('Cargo manifest missing literal version in ' + target[2]);
  return input.slice(0,begin) + block.replace(versionLine, (_m,n,start,_old,endQuote)=>n+start+version+endQuote) + input.slice(end);
}

export function readCargoPackageName(input) {
  const section = /(?:^|\n)\[package\]\s*\r?\n([\s\S]*?)(?=\r?\n\[[^\]]+\]|$)/.exec(input);
  return section && /(?:^|\n)name\s*=\s*"([^"]+)"/.exec(section[1])?.[1] || null;
}

export function syncCargoLock(input, version, names) {
  if (typeof input !== 'string' || !(names instanceof Set)) throw new Error('Invalid Cargo lock input');
  return input.replace(/(^|\n)(\[\[package\]\]\s*\r?\n)([\s\S]*?)(?=\r?\n\[\[package\]\]|$)/g,
    (all, prefix, heading, section) => {
      const name = /(?:^|\n)name\s*=\s*"([^"]+)"/.exec(section)?.[1];
      if (!name || !names.has(name)) return all;
      if (!/(?:^|\n)version\s*=\s*"[^"]+"/.test(section)) throw new Error('Cargo.lock missing version for ' + name);
      return prefix + heading + section.replace(/(^|\n)(version\s*=\s*")[^"]+(")/, (_x,n,a,b)=>n+a+version+b);
    });
}

export function syncNpmLock(lock, version, names) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('Invalid npm lockfile');
  const result = structuredClone(lock);
  if (typeof result.version === 'string') result.version = version;
  if (result.packages && typeof result.packages === 'object') {
    for (const [path, pkg] of Object.entries(result.packages)) {
      if (!pkg || typeof pkg !== 'object') continue;
      if (path === '' || (!path.includes('node_modules') && names.has(pkg.name))) {
        if (typeof pkg.version === 'string') pkg.version = version;
      }
    }
  }
  return result;
}
