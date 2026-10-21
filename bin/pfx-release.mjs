#!/usr/bin/env node
import { resolve } from 'node:path';
import { getRelease, initializeConfig, resolveFiles, syncFiles } from '../src/index.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--') || !args[i].slice(2)) { console.error('Unexpected argument: ' + args[i]); process.exit(2); }
  const key = args[i].slice(2);
  if (!['root','config','product','channel','base','source','kind'].includes(key) || !args[i+1] || args[i+1].startsWith('--')) {
    console.error('Invalid option: ' + args[i]); process.exit(2);
  }
  options[key] = args[++i];
}
const root = resolve(options.root || process.cwd());
const location = options.config || '.pfx/release.json';
try {
  if (command === 'help') {
    console.log('PFx Release Core\nCommands: init, resolve, sync, check, changelog\nOptions: --root PATH --config PATH\nInit options: --product NAME --channel Alpha|Beta|RC|Stable|Development --base VERSION --source src,app --kind core|app|library');
  } else if (command === 'init') {
    console.log(JSON.stringify(initializeConfig(root,options),null,2));
  } else if (['resolve','sync','check','changelog'].includes(command)) {
    const {config,history,release} = getRelease(root,location);
    if (command === 'resolve') console.log(JSON.stringify(release,null,2));
    else if (command === 'changelog') process.stdout.write(resolveFiles(root,config,release,history.commits).get(config.changelogPath));
    else {
      const changes = syncFiles(root,resolveFiles(root,config,release,history.commits),command==='check');
      if (command === 'check' && changes.length) { console.error('Outdated release files: ' + changes.join(', ')); process.exitCode = 1; }
      else console.log(JSON.stringify({version:release.version,changed:changes},null,2));
    }
  } else { throw new Error('Unknown command: ' + command); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
