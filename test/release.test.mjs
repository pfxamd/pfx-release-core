import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {advanceVersion,parseVersion,validateConfig,initializeConfig,getRelease,resolveFiles,syncFiles,renderBadge,renderChangelog} from '../src/index.mjs';

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
