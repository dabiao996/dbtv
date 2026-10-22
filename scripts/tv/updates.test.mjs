import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import releases from '../releases.cjs';
import {transition,validateRequest,enable,processUpdate,consume,publicStatus,history} from './updates.mjs';
import {compose} from './core.mjs';
import {createDriver} from './update-driver.mjs';
import http from 'node:http';
const contract='a'.repeat(64),keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-updates-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'data'),{mode:0o700});enable(home,keys.publicKey);return home;}
function remote(version='0.2.0'){
  const manifest={schemaVersion:1,repository:'dabiao996/dbtv',version,revision:'b'.repeat(40),dataContract:contract,image:'ghcr.io/dabiao996/dbtv@sha256:'+'c'.repeat(64),source:{url:`https://github.com/dabiao996/dbtv/releases/download/v${version}/dbtv-source.tar.gz`,sha256:'d'.repeat(64)}};
  const bytes=Buffer.from(JSON.stringify(manifest)),signature=sign(null,bytes,keys.privateKey).toString('base64');
  const fetcher=async url=>String(url).endsWith('/release-manifest.json')?new Response(bytes):String(url).endsWith('/release-manifest.sig')?new Response(signature):Response.json({tag_name:`v${version}`,draft:false,prerelease:false,body:'测试正式版'});
  return {manifest,bytes,signature,fetcher};
}
const state={mode:'docker',port:8787,bind:'127.0.0.1',source:'/test/app',node:'/test/node',release:{version:'0.1.0',channel:'development',dataContract:contract}};
function operations({failHealth=false,failBackup=false}={}){
  const events=[],reports=[],records=[];
  return {events,reports,records,ops:{report:async value=>reports.push(value),stop:async value=>events.push(`stop:${value.release.version}`),backup:async()=>{events.push('backup');if(failBackup)throw Error('backup failed');return '/private/backup';},record:async value=>{events.push(`record:${value.state}`);records.push(structuredClone(value));},persist:async value=>events.push(`persist:${value.release.version}`),start:async value=>events.push(`start:${value.release.version}`),healthy:async value=>{events.push(`health:${value.release.version}`);if(failHealth&&value.release.version==='0.2.0')throw Error('new unhealthy');}}};
}
test('stable version comparisons are numeric, prerelease and shell text rejected',()=>{
  assert.equal(releases.compare('1.10.0','1.9.9'),1);assert.equal(releases.compare('1.0.0','1.0.0'),0);
  for(const value of ['latest','1.0.0-beta','v1.0.0','1.0.0;rm','../../1','01.0.0'])assert.throws(()=>releases.version(value));
});
test('Ed25519 verifies exact bytes; modified manifests, foreign keys and images fail closed',()=>{
  const value=remote();assert.equal(releases.verifyManifest(value.bytes,value.signature,keys.publicKey).version,'0.2.0');
  assert.throws(()=>releases.verifyManifest(Buffer.from(value.bytes.toString().replace('0.2.0','9.9.9')),value.signature,keys.publicKey));
  assert.throws(()=>releases.verifyManifest(value.bytes,value.signature,generateKeyPairSync('ed25519').publicKey));
  for(const patch of [{image:'ghcr.io/attacker/dbtv:latest'},{source:{url:'http://127.0.0.1/private',sha256:'d'.repeat(64)}},{repository:'other/project'}])assert.throws(()=>releases.validateManifest({...value.manifest,...patch}));
});
test('remote metadata and signature must agree; incomplete/failed releases are not latest',async()=>{
  const value=remote();assert.equal((await releases.release({key:keys.publicKey,fetcher:value.fetcher})).manifest.version,'0.2.0');
  await assert.rejects(releases.release({key:keys.publicKey,fetcher:async()=>new Response('',{status:404})}),/正式发行/);
  await assert.rejects(releases.release({key:null,fetcher:value.fetcher}),/公钥/);
  await assert.rejects(releases.release({key:keys.publicKey,fetcher:async()=>Response.json({tag_name:'v0.2.0',prerelease:true})}),/正式/);
});
test('queue accepts only bounded version/record identifiers and fresh timestamps',()=>{
  const valid={id:randomUUID(),action:'update',target:'0.2.0',actor:1,createdAt:new Date().toISOString()};assert.equal(validateRequest(valid),valid);
  for(const patch of [{command:'docker rm'},{target:'https://attacker'},{action:'restore'},{createdAt:'2000-01-01'},{id:'../../etc'}])assert.throws(()=>validateRequest({...valid,...patch}));
});
test('Docker compose pins an immutable digest, never a tag or arbitrary registry',()=>{
  const pinned=compose('/tmp/own-app',{...state,image:'ghcr.io/dabiao996/dbtv@sha256:'+'c'.repeat(64)});assert.ok(!pinned.includes('"build"'));assert.match(pinned,/sha256:/);
  assert.throws(()=>compose('/tmp/own-app',{...state,image:'ubuntu:latest'}));
});
test('actual HTTP checks verify running version and data contract, not just process liveness',async t=>{
  let value={ok:true,service:'web-tvbox',version:'0.1.0',dataContract:contract};
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/health'?value:{installed:true,database:{connected:true}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const selected={...state,port:server.address().port},driver=createDriver('/tmp/test',{processRunning:()=>true,waitHealthy:async()=>value});
  assert.equal(await driver.ready(selected),true);value={...value,version:'9.9.9'};assert.equal(await driver.ready(selected),false);await assert.rejects(driver.healthy(selected),/目标版本/);
  value={...value,version:'0.1.0',dataContract:'e'.repeat(64)};assert.equal(await driver.ready(selected),false);
});
test('successful update stops before snapshot, records before switch, checks health before completion',async()=>{
  const {ops,events,reports}=operations();const next={...state,release:{...state.release,version:'0.2.0'}};
  const value=await transition({before:state,next,job:{id:randomUUID()},ops});assert.equal(value.state,'complete');
  assert.deepEqual(events,['stop:0.1.0','backup','record:prepared','persist:0.2.0','start:0.2.0','health:0.2.0','record:complete']);assert.equal(reports.at(-1).state,'complete');
});
test('backup failure never launches new code or overwrites a database',async()=>{
  const {ops,events,reports}=operations({failBackup:true});const next={...state,release:{...state.release,version:'0.2.0'}};
  const value=await transition({before:state,next,job:{id:randomUUID()},ops});assert.equal(value.state,'rolled-back');assert.ok(!events.includes('start:0.2.0'));assert.equal(reports.at(-1).state,'rolled-back');
});
test('failed new version rolls back code only when data contract is identical',async()=>{
  const {ops,events}=operations({failHealth:true});const next={...state,release:{...state.release,version:'0.2.0'}};
  const value=await transition({before:state,next,job:{id:randomUUID()},ops});assert.equal(value.state,'rolled-back');assert.equal(events.at(-1),'health:0.1.0');
});
test('incompatible data blocks automatic rollback instead of restoring stale user data',async()=>{
  const {ops,events,reports}=operations({failHealth:true});const next={...state,release:{...state.release,version:'0.2.0',dataContract:'e'.repeat(64)}};
  const value=await transition({before:state,next,job:{id:randomUUID()},ops});assert.equal(value.state,'blocked');assert.ok(!events.includes('start:0.1.0'));assert.equal(reports.at(-1).state,'blocked');
});
test('worker verifies signed release, persists rollback history, and preserves port/data identity',async t=>{
  const home=fixture(t),value=remote(),{ops}=operations();
  const driver={...ops,ready:async()=>true,prepare:async before=>({...before,image:value.manifest.image}),runningImage:async()=>`sha256:${'f'.repeat(64)}`,permissions:async()=>{}};
  const result=await processUpdate(home,state,{id:randomUUID(),action:'update',target:'0.2.0',actor:1,createdAt:new Date().toISOString()},driver,{fetcher:value.fetcher});
  assert.equal(result.state,'complete');const saved=history(home)[0];assert.equal(saved.next.port,8787);assert.match(saved.previous.image,/^sha256:/);assert.equal(saved.state,'complete');
  assert.equal(fs.existsSync(path.join(home,'updates/active.json')),false);const publicValue=JSON.parse(fs.readFileSync(path.join(home,'data/updates/status.json')));assert.equal(publicValue.history[0].canRollback,true);assert.equal(JSON.stringify(publicValue).includes('/private/backup'),false);
  const changed={...saved.next,port:8899,origin:'https://tv.example.com'};
  const rollback=await processUpdate(home,changed,{id:randomUUID(),action:'rollback',target:saved.id,actor:1,createdAt:new Date().toISOString()},{...driver,verifyPrevious:async previous=>assert.match(previous.image,/^sha256:/)},{fetcher:async()=>{throw Error('rollback must use local history');}});
  assert.equal(rollback.state,'complete');assert.equal(rollback.record.next.release.version,'0.1.0');assert.equal(rollback.record.next.port,8899);assert.equal(rollback.record.next.origin,'https://tv.example.com');assert.equal(history(home).length,2);
});
test('external SQL and unfinished operations are blocked before side effects',async t=>{
  const home=fixture(t),request={id:randomUUID(),action:'update',target:'0.2.0',createdAt:new Date().toISOString()},driver={ready:async()=>{throw Error('must not run');}};
  fs.writeFileSync(path.join(home,'data/database.json'),JSON.stringify({provider:'postgresql'}),{mode:0o600});
  await assert.rejects(processUpdate(home,state,request,driver),/外部数据库/);fs.unlinkSync(path.join(home,'data/database.json'));
  fs.mkdirSync(path.join(home,'updates'),{recursive:true});fs.writeFileSync(path.join(home,'updates/active.json'),'{}',{mode:0o600});await assert.rejects(processUpdate(home,state,request,driver),/上次更新/);
});
test('web queue cannot supply executable paths and does not leak private history',async t=>{
  const home=fixture(t);fs.mkdirSync(path.join(home,'data/updates'));fs.writeFileSync(path.join(home,'data/updates/request.json'),JSON.stringify({id:randomUUID(),action:'update',target:'0.2.0',createdAt:new Date().toISOString(),source:'/etc'}),{mode:0o600});
  await assert.rejects(consume(home,state,{}),/无效/);assert.equal(history(home).length,0);publicStatus(home,{currentContract:contract});
});
