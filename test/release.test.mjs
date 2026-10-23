import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {advanceVersion,parseVersion,validateConfig,initializeConfig,getRelease,resolveFiles,syncFiles,renderBadge,renderChangelog,resolveApplicationRelease as sharedResolveApplicationRelease,resolveWebsiteRelease} from '../src/index.mjs';
import {syncCargoManifest,syncCargoLock} from '../src/manifests.mjs';

function withGitRepo(fn) {
  const dir=mkdtempSync(join(tmpdir(),'pfx-release-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  const commit=subject=>{git('add','.');git('-c','user.name=Test','-c','user.email=test@example.com','commit','-m',subject);};
  try {
    git('init','-q','-b','main'); mkdirSync(join(dir,'src'));
    writeFileSync(join(dir,'src','app.js'),'export const x=1;\n');
    writeFileSync(join(dir,'package.json'),'{"name":"test","version":"0.1.0-alpha.0"}\n');
    commit('initial');fn({dir,git,commit});
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('SemVer source-based increments',()=>{
 assert.equal(advanceVersion('0.1.0-alpha.0',3),'0.1.0-alpha.3');
 assert.equal(advanceVersion('0.1.0-beta',2),'0.1.0-beta.2');
 assert.equal(advanceVersion('1.2.3',4),'1.2.7');
 assert.equal(advanceVersion('1.2.3-rc.9',0),'1.2.3-rc.9');
 assert.throws(()=>parseVersion('01.0.0'));
 assert.throws(()=>parseVersion('1.2.3-alpha.01'));
});

test('Safety validation rejects bad paths and version loops',()=>{
 const p={schemaVersion:1,kind:'core',product:'PFx',channel:'Alpha',baseVersion:'0.1.0-alpha.0',baseline:'a'.repeat(40),sourcePaths:['src'],jsonVersions:['package.json']};
 assert.equal(validateConfig(p).product,'PFx');
 assert.throws(()=>validateConfig({...p,badgePath:'../x.svg'}));
 assert.throws(()=>validateConfig({...p,sourcePaths:['.']}));
 assert.throws(()=>validateConfig({...p,sourcePaths:['src','package.json']}));
 assert.equal(validateConfig({...p,allowGeneratedSourcePaths:true,sourcePaths:['src','package.json']}).allowGeneratedSourcePaths,true);
 assert.throws(()=>validateConfig({...p,allowGeneratedSourcePaths:true,sourcePaths:['src','package.json'],ignoreSubjects:[]}));
});

test('Source changes advance; metadata-only changes do not',()=>withGitRepo(({dir,commit})=>{
 initializeConfig(dir,{base:'0.1.0-alpha.0',source:'src'});
 let result=getRelease(dir);
 assert.equal(result.release.version,'0.1.0-alpha.0');
 let files=resolveFiles(dir,result.config,result.release,result.history.commits);
 assert.ok(syncFiles(dir,files).length);
 assert.deepEqual(syncFiles(dir,files,true),[]);
 commit('chore(release): sync core version metadata [skip ci]');
 assert.equal(getRelease(dir).release.version,'0.1.0-alpha.0');
 writeFileSync(join(dir,'src','app.js'),'export const x=2;\n');
 commit('feat: changed behavior');
 result=getRelease(dir);
 assert.equal(result.release.version,'0.1.0-alpha.1');
 assert.match(renderChangelog(result.release,result.history.commits),/Features/);
 files=resolveFiles(dir,result.config,result.release,result.history.commits);
 assert.ok(syncFiles(dir,files).includes('version.json'));
 assert.equal(JSON.parse(readFileSync(join(dir,'version.json'),'utf8')).version,'0.1.0-alpha.1');
 assert.deepEqual(syncFiles(dir,files,true),[]);
 writeFileSync(join(dir,'note.txt'),'documentation'); commit('docs: unrelated');
 assert.equal(getRelease(dir).release.version,'0.1.0-alpha.1');
}));

test('Bot subject excluded even if its commit modifies source',()=>withGitRepo(({dir,commit})=>{
 initializeConfig(dir,{base:'1.0.0',source:'src'});
 writeFileSync(join(dir,'src','app.js'),'export const x=3;\n');
 commit('chore(release): sync core version metadata [skip ci]');
 assert.equal(getRelease(dir).release.version,'1.0.0');
}));

test('SVG content safely escaped',()=>{
 const svg=renderBadge({kind:'core',channel:'Stable',label:'<unsafe & "label">'});
 assert.match(svg,/&lt;unsafe &amp; &quot;label&quot;&gt;/);
});


test('Package manifests, npm locks and Cargo workspace versions synchronize without touching external dependencies',()=>withGitRepo(({dir})=>{
 const root=join(dir,'Cargo.toml');
 const manifest='[workspace]\nmembers = ["member"]\n\n[workspace.package]\nversion = "0.3.0"\nedition = "2024"\n\n[workspace.lints.rust]\nunsafe_code = "forbid"\n';
 writeFileSync(root,manifest);
 writeFileSync(join(dir,'Cargo.lock'),'version = 3\n\n[[package]]\nname = "pfx"\nversion = "0.3.0"\n\n[[package]]\nname = "external"\nversion = "9.2.0"\n');
 writeFileSync(join(dir,'package-lock.json'),JSON.stringify({
  name:'test',version:'0.3.0',packages:{'':{name:'test',version:'0.3.0'},'node_modules/external':{name:'external',version:'9.2.0'}}
 }));
 assert.match(syncCargoManifest(manifest,'0.3.1'),/version = "0.3.1"/);
 assert.match(syncCargoLock(readFileSync(join(dir,'Cargo.lock'),'utf8'),'0.3.1',new Set(['pfx'])),/name = "pfx"\nversion = "0.3.1"/);
 const cfg=validateConfig({schemaVersion:1,kind:'core',product:'PFx',channel:'Alpha',
   baseVersion:'0.3.0',baseline:'a'.repeat(40),sourcePaths:['src'],jsonVersions:['package.json'],
   cargoVersions:['Cargo.toml'],cargoLocks:['Cargo.lock'],cargoNames:['pfx'],npmLocks:['package-lock.json'],
   changelogPath:false});
 const release={version:'0.3.1',kind:'core',label:'Alpha 0.3.1',channel:'Alpha'};
 const files=resolveFiles(dir,cfg,release,[]);
 assert.equal(files.has('CHANGELOG.md'),false);
 assert.equal(JSON.parse(files.get('package-lock.json')).packages['node_modules/external'].version,'9.2.0');
 assert.equal(JSON.parse(files.get('package-lock.json')).version,'0.3.1');
 assert.match(files.get('Cargo.toml'),/version = "0.3.1"/);
 assert.match(files.get('Cargo.lock'),/name = "external"\nversion = "9.2.0"/);
 assert.match(files.get('Cargo.lock'),/name = "pfx"\nversion = "0.3.1"/);
 assert.ok(syncFiles(dir,files).length);
 assert.deepEqual(syncFiles(dir,files,true),[]);
}));

test('Cargo package manifests and lockfile preserve separate dependencies',async()=>{
 const {syncCargoManifest,syncCargoLock,readCargoPackageName}=await import('../src/manifests.mjs');
 const source='[package]\nname = "core-a"\nversion = "1.0.0"\n[dependencies]\nother = "2.0.0"\n';
 assert.equal(readCargoPackageName(source),'core-a');
 assert.match(syncCargoManifest(source,'1.0.2'),/version = "1.0.2"/);
 assert.match(syncCargoManifest(source,'1.0.2'),/other = "2.0.0"/);
 assert.throws(()=>syncCargoManifest('[workspace]\nresolver="2"\n','1.0.2'));
 const lock='[[package]]\nname = "core-a"\nversion = "1.0.0"\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n';
 assert.match(syncCargoLock(lock,'1.0.2',new Set(['core-a'])),/name = "core-a"\nversion = "1.0.2"/);
 assert.match(syncCargoLock(lock,'1.0.2',new Set(['core-a'])),/name = "other"\nversion = "2.0.0"/);
});

test('Application adapter matches historic source-path versioning and public shape',()=>withGitRepo(({dir,commit,git})=>{
 const {resolveApplicationRelease} = {resolveApplicationRelease: sharedResolveApplicationRelease};
 const first=git('rev-parse','HEAD');
 const config={
  product:'PFx Test Studio', channel:'Alpha',
  baseline:first, baseVersion:'0.1.0-alpha.22',sourcePaths:['src','scripts','release.config.json']
 };
 const current=resolveApplicationRelease(dir,config);
 assert.deepEqual(Object.keys(current),['schemaVersion','product','channel','version','label','commit','sourceDate']);
 assert.equal(current.version,'0.1.0-alpha.22');
 mkdirSync(join(dir,'scripts'));writeFileSync(join(dir,'scripts','release.js'),'sample');
 commit('refactor: app release integration');
 const changed=resolveApplicationRelease(dir,config);
 assert.equal(changed.version,'0.1.0-alpha.23');
 assert.equal(changed.commit,git('rev-parse','HEAD'));
 assert.equal(resolveApplicationRelease(dir,{...config,baseVersion:'1.2.3'}).version,'1.2.4');
 assert.throws(()=>resolveApplicationRelease(dir,{...config,channel:'RC'}));
}));

test('website metadata distinguishes a source version from a metadata-only build', () => withGitRepo(({dir,git,commit}) => {
  const config = initializeConfig(dir, {product:'Site',kind:'app',channel:'Stable',base:'1.0.0',source:'src'});
  writeFileSync(join(dir,'src','site.txt'),'one'); commit('feat: a website feature');
  const first = resolveWebsiteRelease(dir);
  assert.equal(first.version,'1.0.1');
  assert.equal(first.buildCommit,first.commit);
  assert.equal(first.changes[0].version,'1.0.1');
  assert.equal(first.changes[0].summary,'feat: a website feature');
  writeFileSync(join(dir,'notes.txt'),'metadata only'); commit('docs: notes');
  const next = resolveWebsiteRelease(dir);
  assert.equal(next.version,first.version);
  assert.equal(next.commit,first.commit);
  assert.notEqual(next.buildCommit,first.buildCommit);
  assert.deepEqual(resolveWebsiteRelease(dir),next);
}));
