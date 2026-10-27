import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {runOneShot} from './incremental-worker.mjs';

const put=(root,name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value,{mode:0o600});};
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-worker-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'app'),source=path.join(base,'source');fs.mkdirSync(root);fs.mkdirSync(source);
  for(const directory of [root,source]){
    put(directory,'package.json',JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{}}));
    put(directory,'package-lock.json',JSON.stringify({name:'fixture',version:'1.0.0',packages:{}}));
    put(directory,'release.json',JSON.stringify({version:'1.0.0',channel:'development'}));
    put(directory,'server/src/index.ts','old program');
  }
  put(source,'server/src/index.ts','new program');put(root,'data/live-tv.json','private fixture');put(root,'data/dabiao.db','database fixture');
  const git=args=>{const result=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  git(['init','-q']);git(['add','package.json','package-lock.json','release.json','server/src/index.ts']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const directory=path.join(root,'data/updates');fs.mkdirSync(directory,{mode:0o700});
  const queue=()=>put(root,'data/updates/request.json',JSON.stringify({id:randomUUID(),action:'update',target:'1.0.1',actor:1,createdAt:new Date().toISOString()}));
  const stage=async()=>({source,remote:{manifest:{dataContract:'a'.repeat(64)}}});
  return {root,source,directory,queue,stage};
}
test('preflight incompatibility fails without changing program or user data and permits a corrected request',async t=>{
  const {root,directory,queue}=fixture(t);queue();
  const value=await runOneShot(root,{stage:async()=>{throw Error('数据库兼容标识不同');}});
  assert.equal(value.state,'failed');assert.equal(fs.existsSync(path.join(directory,'incremental-active.json')),false);
  assert.equal(fs.readFileSync(path.join(root,'server/src/index.ts'),'utf8'),'old program');
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
  queue();
});
test('one-shot success writes only program manifest and clears its task marker',async t=>{
  const {root,directory,queue,stage}=fixture(t);queue();
  const value=await runOneShot(root,{stage,apply:(selected,plan)=>{
    assert.equal(selected,root);assert.deepEqual(plan.changes,['server/src/index.ts']);
    put(root,'server/src/index.ts','new program');return {changed:1,removed:0,lockChanged:false};
  },health:async()=>true});
  assert.equal(value.state,'complete');assert.equal(fs.existsSync(path.join(directory,'incremental-active.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'status.json'))).job.state,'complete');
  assert.equal(fs.statSync(path.join(directory,'program-manifest.json')).mode&0o777,0o600);
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
});
test('interrupted apply blocks retry while leaving database and live JSON unchanged',async t=>{
  const {root,directory,queue,stage}=fixture(t);queue();
  const value=await runOneShot(root,{stage,apply:()=>{put(root,'server/src/index.ts','partial program');throw Error('synthetic interruption');}});
  assert.equal(value.state,'blocked');assert.equal(fs.existsSync(path.join(directory,'incremental-active.json')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'status.json'))).job.state,'blocked');
  assert.equal(fs.readFileSync(path.join(root,'data/dabiao.db'),'utf8'),'database fixture');
  assert.equal(fs.readFileSync(path.join(root,'data/live-tv.json'),'utf8'),'private fixture');
  queue();await assert.rejects(runOneShot(root,{stage}),/尚未完成/);
});
