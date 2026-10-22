import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import express from 'express';
import {createUpdates,registerUpdates} from '../src/updates.js';
const contract='a'.repeat(64);
function fixture(t:any){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-updates-api-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({version:'0.1.0',channel:'development',dataContract:contract}));return root;}
test('unconfigured and unreachable release checks are explicit errors, never fake up-to-date',async t=>{
  const root=fixture(t);let calls=0;const service=createUpdates({root,key:null,fetcher:async()=>{calls++;throw Error('no network');}});
  assert.equal((await service.check()).state,'unconfigured');assert.equal(calls,0);assert.equal(service.info().check.available,false);
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const failed=createUpdates({root,key:keys.publicKey,fetcher:async()=>new Response('',{status:404})});assert.equal((await failed.check()).state,'error');
});
test('check is cached; queue only accepts latest verified target and keeps passwords out of files',async t=>{
  const root=fixture(t),keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const value={schemaVersion:1,repository:'dabiao996/dbtv',version:'0.2.0',revision:'b'.repeat(40),dataContract:contract,image:'ghcr.io/dabiao996/dbtv@sha256:'+'c'.repeat(64),source:{url:'https://github.com/dabiao996/dbtv/releases/download/v0.2.0/dbtv-source.tar.gz',sha256:'d'.repeat(64)}};
  const bytes=Buffer.from(JSON.stringify(value)),sig=sign(null,bytes,keys.privateKey).toString('base64');let calls=0;
  const fetcher:any=async(url:string)=>{calls++;return url.endsWith('.json')?new Response(bytes):url.endsWith('.sig')?new Response(sig):Response.json({tag_name:'v0.2.0',body:'safe notes'});};
  const service=createUpdates({root,key:keys.publicKey,fetcher});await Promise.all([service.check(),service.check(true)]);assert.equal(calls,3);assert.equal(service.info().check.available,true);await service.check(true);assert.equal(calls,3);
  const directory=path.join(root,'data/updates');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({enabled:true,history:[]}));
  assert.throws(()=>service.queue('update','9.9.9',1));const queued=service.queue('update','0.2.0',1);assert.equal(queued.state,'queued');const file=path.join(directory,'request.json');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readFileSync(file,'utf8').includes('password'),false);assert.throws(()=>service.queue('update','0.2.0',1),/已有/);
});
test('update API enforces admin, same origin, password reauthentication and parameter whitelist',async t=>{
  const app=express();app.use(express.json());let queued=0;
  const service:any={info:()=>({current:{version:'0.1.0'}}),check:async()=>({state:'checked'}),queue:()=>{queued++;return {id:'test',state:'queued'};}};
  registerUpdates(app,{requireAdmin:async(req,res)=>{if(req.headers['x-role']!=='admin'){res.status(403).json({error:'admin'});return null;}return {id:1,passwordHash:'hash'};},checkPassword:(password,hash)=>password==='test-pass'&&hash==='hash'},service);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const send=(path:string,body?:any,role='admin',site=origin)=>fetch(origin+'/api/admin/updates'+path,{method:body?'POST':'GET',headers:{'x-role':role,Origin:site,'Content-Type':'application/json'},...body?{body:JSON.stringify(body)}:{}});
  assert.equal((await send('',undefined,'user')).status,403);assert.equal((await send('/check',{},'admin','https://attacker.invalid')).status,403);
  const request={action:'update',target:'0.2.0',confirmed:true,password:'wrong'};
  assert.equal((await send('/request',request)).status,403);assert.equal((await send('/request',{...request,password:'test-pass',command:'rm'})).status,400);assert.equal(queued,0);
  assert.equal((await send('/request',{...request,password:'test-pass'})).status,202);assert.equal(queued,1);
});
