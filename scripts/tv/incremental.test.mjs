import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import releases from '../releases.cjs';
import {planIncremental,applyIncremental,programManifest,stageSignedRelease} from './incremental.mjs';

const put=(root,name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-incremental-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'app'),staged=path.join(base,'staged');fs.mkdirSync(root);fs.mkdirSync(staged);
  const pkg=JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{react:'1.0.0'},devDependencies:{vite:'1.0.0'}});
  const lock=JSON.stringify({name:'fixture',version:'1.0.0',packages:{'':{version:'1.0.0'},'node_modules/react':{version:'1.0.0'}}});
  for(const directory of [root,staged]){
    put(directory,'package.json',pkg);put(directory,'package-lock.json',lock);
    put(directory,'release.json',JSON.stringify({version:'1.0.0',channel:'development'}));
    put(directory,'server/src/index.ts','console.log("old")\n');
  }
  put(root,'data/live-tv.json','private fixture');put(root,'data/dabiao.db','database fixture');put(root,'.env','secret fixture');
  const git=(args)=>{const result=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  git(['init','-q']);git(['add','package.json','package-lock.json','release.json','server/src/index.ts']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  return {root,staged};
}
test('unchanged dependency lock reuses existing modules while only changed program bytes are copied',t=>{
  const {root,staged}=fixture(t);put(staged,'server/src/index.ts','console.log("new")\n');
  const plan=planIncremental(root,staged),commands=[];
  assert.deepEqual(plan.changes,['server/src/index.ts']);assert.equal(plan.lockChanged,false);
  const result=applyIncremental(root,plan,{run:(program,args)=>commands.push([program,...args])});
  assert.equal(result.changed,1);assert.equal(result.lockChanged,false);
  assert.equal(commands.length,1);assert.ok(commands[0].includes('build'));assert.ok(!commands[0].includes('install'));
  assert.equal(fs.readFileSync(path.join(root,'server/src/index.ts'),'utf8'),'console.log("new")\n');
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
  assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'secret fixture');
});
test('changed lock invokes npm incremental reification and reports added dependency',t=>{
  const {root,staged}=fixture(t),pkg=JSON.parse(fs.readFileSync(path.join(staged,'package.json'))),lock=JSON.parse(fs.readFileSync(path.join(staged,'package-lock.json')));
  pkg.dependencies.other='2.0.0';lock.packages['node_modules/other']={version:'2.0.0'};
  put(staged,'package.json',JSON.stringify(pkg));put(staged,'package-lock.json',JSON.stringify(lock));
  const plan=planIncremental(root,staged),commands=[];
  assert.equal(plan.lockChanged,true);assert.deepEqual(plan.dependencies,[{name:'other',from:null,to:'2.0.0'}]);
  assert.deepEqual(plan.packages,[{name:'node_modules/other',from:null,to:'2.0.0'}]);
  applyIncremental(root,plan,{run:(program,args)=>commands.push([program,...args])});
  assert.ok(commands[0].includes('install'));assert.ok(commands[0].includes('--ignore-scripts'));assert.ok(commands[1].includes('build'));
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
});
test('release version bump changes lock metadata but skips npm when dependency graph is identical',t=>{
  const {root,staged}=fixture(t),pkg=JSON.parse(fs.readFileSync(path.join(staged,'package.json'))),lock=JSON.parse(fs.readFileSync(path.join(staged,'package-lock.json')));
  pkg.version='1.0.1';lock.version='1.0.1';lock.packages[''].version='1.0.1';
  put(staged,'package.json',JSON.stringify(pkg));put(staged,'package-lock.json',JSON.stringify(lock));
  const plan=planIncremental(root,staged),commands=[];
  assert.equal(plan.lockChanged,true);assert.equal(plan.dependenciesChanged,false);
  applyIncremental(root,plan,{run:(program,args)=>commands.push([program,...args])});
  assert.ok(commands.some(args=>args.includes('build')));assert.ok(!commands.some(args=>args.includes('install')));
});
test('local edits and untracked collisions stop before changing a single program file',t=>{
  const {root,staged}=fixture(t);put(staged,'server/src/index.ts','console.log("release")\n');
  put(root,'server/src/index.ts','console.log("user edit")\n');
  assert.throws(()=>planIncremental(root,staged),/本地程序文件有修改/);
  assert.equal(fs.readFileSync(path.join(root,'server/src/index.ts'),'utf8'),'console.log("user edit")\n');
  put(root,'server/src/index.ts','console.log("old")\n');put(root,'client/custom.ts','user file');put(staged,'client/custom.ts','release file');
  assert.throws(()=>planIncremental(root,staged),/client\/custom.ts/);
});
test('an edit arriving after preflight is rechecked and never overwritten',t=>{
  const {root,staged}=fixture(t);put(staged,'server/src/index.ts','console.log("release")\n');
  const plan=planIncremental(root,staged);put(root,'server/src/index.ts','console.log("late user edit")\n');
  assert.throws(()=>applyIncremental(root,plan,{run:()=>{}}),/更新期间本地文件发生变化/);
  assert.equal(fs.readFileSync(path.join(root,'server/src/index.ts'),'utf8'),'console.log("late user edit")\n');
});
test('deleted program files need an existing signed-state manifest and must remain unmodified',t=>{
  const {root,staged}=fixture(t);put(root,'server/src/old.ts','old tool');
  const first=planIncremental(root,staged);assert.deepEqual(first.removals,[]);
  put(staged,'server/src/old.ts','old tool');const manifest=programManifest(planIncremental(root,staged),'1.0.0');
  fs.unlinkSync(path.join(staged,'server/src/old.ts'));
  const second=planIncremental(root,staged,manifest);assert.deepEqual(second.removals,['server/src/old.ts']);
  applyIncremental(root,second,{run:()=>{}});assert.equal(fs.existsSync(path.join(root,'server/src/old.ts')),false);
  put(root,'server/src/old.ts','user edit');assert.throws(()=>planIncremental(root,staged,manifest),/本地修改/);
});
test('unknown install scripts and unsafe release paths are rejected before data changes',t=>{
  const {root,staged}=fixture(t),lock=JSON.parse(fs.readFileSync(path.join(staged,'package-lock.json')));
  lock.packages['node_modules/unknown']={version:'1.0.0',hasInstallScript:true};put(staged,'package-lock.json',JSON.stringify(lock));
  assert.throws(()=>planIncremental(root,staged),/安装脚本/);
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
  fs.rmSync(path.join(staged,'package-lock.json'));
  put(staged,'data/private.json','do not import');assert.throws(()=>planIncremental(root,staged),/不允许的路径/);
});
test('interrupted build leaves persistent data intact and reports partial program update',t=>{
  const {root,staged}=fixture(t);put(staged,'server/src/index.ts','console.log("new")\n');
  const plan=planIncremental(root,staged);assert.throws(()=>applyIncremental(root,plan,{run:()=>{throw Error('build stopped');}}),/build stopped/);
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
});
test('one-shot stage verifies an exact signed archive and refuses altered archive bytes',async t=>{
  const {root,staged}=fixture(t),keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  for(const directory of [root,staged]){
    put(directory,'prisma/schema.prisma','datasource db { provider = "sqlite" url = "file:fixture.db" }');
    put(directory,'scripts/keep.mjs','export const keep=true;');
    put(directory,'deploy/update-public.pem',keys.publicKey);
  }
  const contract=releases.dataContract(root);
  put(root,'release.json',JSON.stringify({version:'1.0.0',channel:'development',dataContract:contract}));
  put(staged,'release.json',JSON.stringify({version:'1.0.1',channel:'stable',dataContract:contract}));
  const names=['package.json','package-lock.json','release.json','server/src/index.ts','prisma/schema.prisma','scripts/keep.mjs','deploy/update-public.pem'];
  const tar=path.join(path.dirname(root),'source.tar.gz'),packed=spawnSync('tar',['-czf',tar,...names],{cwd:staged,encoding:'utf8'});
  assert.equal(packed.status,0,packed.stderr);
  const archive=fs.readFileSync(tar),manifest={schemaVersion:1,repository:'dabiao996/dbtv',version:'1.0.1',revision:'b'.repeat(40),dataContract:contract,image:'ghcr.io/dabiao996/dbtv@sha256:'+'c'.repeat(64),source:{url:'https://github.com/dabiao996/dbtv/releases/download/v1.0.1/dbtv-source.tar.gz',sha256:createHash('sha256').update(archive).digest('hex')}};
  const bytes=Buffer.from(JSON.stringify(manifest)),signature=sign(null,bytes,keys.privateKey).toString('base64');
  const fetcher=async(url)=>new Response(url.endsWith('/release-manifest.json')?bytes:url.endsWith('/release-manifest.sig')?signature:url.endsWith('/dbtv-source.tar.gz')?archive:JSON.stringify({tag_name:'v1.0.1',draft:false,prerelease:false}));
  const selected=await stageSignedRelease(root,'1.0.1',{fetcher});
  try{assert.equal(fs.readFileSync(path.join(selected.source,'release.json'),'utf8'),fs.readFileSync(path.join(staged,'release.json'),'utf8'));}
  finally{fs.rmSync(selected.staging,{recursive:true,force:true});}
  put(root,'release.json',JSON.stringify({version:'1.0.2',channel:'stable',dataContract:contract}));
  const older=await stageSignedRelease(root,'1.0.1',{fetcher});
  fs.rmSync(older.staging,{recursive:true,force:true});
  const tampered=async(url)=>url.endsWith('/dbtv-source.tar.gz')?new Response(Buffer.from('bad archive')):fetcher(url);
  await assert.rejects(stageSignedRelease(root,'1.0.1',{fetcher:tampered}),/校验失败/);
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
});
test('changed local dependency is synchronized by npm without registry access',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-npm-diff-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'app'),staged=path.join(base,'staged');fs.mkdirSync(root);fs.mkdirSync(staged);
  for(const [folder,version] of [['sample-v1','1.0.0'],['sample-v2','2.0.0']])put(base,`${folder}/package.json`,JSON.stringify({name:'sample',version}));
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  const install=(cwd,args)=>{const value=spawnSync(process.execPath,[npm,'install','--offline','--ignore-scripts','--no-audit','--no-fund',...args],{cwd,encoding:'utf8'});assert.equal(value.status,0,value.stderr);};
  put(root,'package.json',JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{sample:'file:../sample-v1'}}));
  put(root,'release.json',JSON.stringify({version:'1.0.0',channel:'development'}));
  install(root,[]);
  put(staged,'package.json',JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{sample:'file:../sample-v2'}}));
  put(staged,'release.json',fs.readFileSync(path.join(root,'release.json')));
  fs.copyFileSync(path.join(root,'package-lock.json'),path.join(staged,'package-lock.json'));
  install(staged,['--package-lock-only']);
  const git=args=>{const value=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(value.status,0,value.stderr);};
  git(['init','-q']);git(['add','package.json','package-lock.json','release.json']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const plan=planIncremental(root,staged);assert.equal(plan.lockChanged,true);
  const result=applyIncremental(root,plan,{run:(program,args,options)=>{
    if(args.includes('install')){const value=spawnSync(program,[...args,'--offline'],{cwd:options.cwd,encoding:'utf8'});assert.equal(value.status,0,value.stderr);}
  }});
  assert.equal(result.lockChanged,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'node_modules/sample/package.json'))).version,'2.0.0');
});
