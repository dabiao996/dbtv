import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PrismaClient} from '@prisma/client';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {registerLive} from '../dist/live.js';
import {liveSupplements} from '../dist/live-supplements.js';

test('live real-database import, auth, pagination, preserved publication, signed media relay and atomic failure',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-live-integration-')),url='file:'+join(folder,'test.db'),db=new PrismaClient({datasourceUrl:url});let server,broken=false,requests=0,geo=false;
  const playlist='#EXTM3U\n#EXTINF:-1 tvg-id="Test.cn@HD",Test HD\nhttps://example.com/master.m3u8\n#EXTINF:-1 tvg-id="Test.cn@SD",Test SD\nhttps://example.com/sd.m3u8\n#EXTINF:-1 tvg-id="Other.us",Other\nhttps://example.com/other.m3u8\n';
  const upstream=async url=>{requests++;if(url.endsWith('/iptv/index.m3u'))return {url,body:Buffer.from(playlist),type:'text/plain'};if(url.endsWith('/api/channels.json'))return {url,body:Buffer.from(broken?'invalid':JSON.stringify([{id:'Test.cn',name:'测试新闻台',country:'CN',categories:['news']},{id:'Other.us',name:'Other',country:'US',categories:['movies']}]))};if(url.endsWith('.m3u8'))return {url,type:'application/vnd.apple.mpegurl',body:Buffer.from(geo?'the content is not available in your area: private-token':'#EXTM3U\n#EXTINF:6,\nsegment.ts\n')};if(url.endsWith('/segment.ts')){const body=Buffer.alloc(188);body[0]=0x47;return {url,type:'video/mp2t',body};}throw Error('unexpected URL');};
  try{
    const push=spawnSync(process.execPath,['scripts/database.mjs','push'],{env:{...process.env,DBTV_DATA_DIR:join(folder,'state'),DATABASE_PROVIDER:'sqlite',DATABASE_URL:url},encoding:'utf8'});assert.equal(push.status,0,push.stdout+push.stderr);
    const app=express();app.use(express.json());const requireUser=async(req,res)=>{const key=req.get('X-Fixture-User');if(!key){res.status(401).json({error:'login'});return null;}return req.authUser={id:key==='admin'?1:key==='viewer2'?3:2,role:key==='admin'?'admin':'user',permissions:key==='blocked'?[]:['playback']};};const requireAdmin=async(req,res)=>{const u=await requireUser(req,res);if(!u)return null;if(u.role!=='admin'){res.status(403).json({error:'admin'});return null;}return u;};
    const service=registerLive(app,db,{requireUser,requireAdmin},upstream);server=app.listen(0,'127.0.0.1');await once(server,'listening');const root='http://127.0.0.1:'+server.address().port;
    const call=async(path,user='admin',body,method=body===undefined?'GET':'POST')=>fetch(root+path,{method,headers:{...user?{'X-Fixture-User':user}:{},'Content-Type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});
    assert.equal((await call('/api/admin/live/status','')).status,401);assert.equal((await call('/api/admin/live/status','viewer')).status,403);assert.equal((await call('/api/live/channels','blocked')).status,403);
    assert.equal((await call('/api/admin/live/sync','admin',{})).status,202);await service.settled();assert.equal(await db.liveChannel.count(),2+liveSupplements.length);
    const news=await db.liveChannel.findFirst({where:{name:'测试新闻台'}});assert.equal(JSON.parse(news.rawConfig).length,2);
    const listing=await (await call('/api/live/channels?country=CN&category=news&pageSize=1','viewer')).json();assert.equal(listing.total,1);assert.equal(listing.items.length,1);assert.equal(listing.items[0].countryName,'中国');assert.ok(!JSON.stringify(listing).includes('https://example.com'));
    const filters=await (await call('/api/live/filters','viewer')).json();assert.equal(filters.countries.length,2);
    const rootStream=await call(`/api/live/channels/${news.id}/stream/0`,'viewer');assert.equal(rootStream.status,200);const manifest=await rootStream.text();assert.ok(!manifest.includes('https://example.com/segment.ts\n'));const segment=manifest.split('\n').find(x=>x.startsWith('/api/'));
    assert.equal((await call(segment,'')).status,401);assert.equal((await call(segment,'viewer2')).status,403);const bytes=await call(segment,'viewer');assert.equal(bytes.status,200);assert.equal((await bytes.arrayBuffer()).byteLength,188);
    geo=true;const denied=await call(`/api/live/channels/${news.id}/stream/0`,'viewer');assert.equal(denied.status,502);const denial=await denied.json();assert.equal(denial.code,'GEO_BLOCKED');assert.ok(!JSON.stringify(denial).includes('private-token'));assert.equal((await db.liveChannel.findUnique({where:{id:news.id}})).lastError,null);
    geo=false;const probe=await (await call(`/api/admin/live/channels/${news.id}/check`,'admin',{})).json();assert.equal(probe.ok,true);assert.equal((await (await call('/api/live/channels?country=CN&health=reachable','viewer')).json()).total,1);
    const before=requests;assert.equal((await call(segment.replace(/sig=[a-f0-9]+/,'sig='+'0'.repeat(64)),'viewer')).status,403);assert.equal(requests,before);
    assert.equal((await call('/api/admin/live/publication','viewer',{enabled:false,ids:[news.id]},'PUT')).status,403);
    await call('/api/admin/live/publication','admin',{enabled:false,ids:[news.id]},'PUT');assert.equal((await call(`/api/live/channels/${news.id}`,'viewer')).status,404);assert.equal((await call(segment,'viewer')).status,404);
    const extra=await db.liveChannel.findFirst({where:{name:liveSupplements[0].name}});await db.liveChannel.update({where:{id:extra.id},data:{enabled:false}});
    await service.sync(1);await service.settled();assert.equal((await db.liveChannel.findUnique({where:{id:news.id}})).enabled,false);assert.equal((await db.liveChannel.findUnique({where:{id:extra.id}})).enabled,false);assert.equal((await db.liveChannel.findUnique({where:{id:extra.id}})).rawConfig,extra.rawConfig);assert.equal(await db.source.count(),0);
    const snapshot=await db.liveChannel.findMany();broken=true;await service.sync(1);await service.settled();assert.equal((await service.status()).phase,'error');assert.deepEqual(await db.liveChannel.findMany(),snapshot);
    await call('/api/admin/live/publication','admin',{enabled:true,filter:{country:'CN'}},'PUT');assert.equal((await call(`/api/live/channels/${news.id}`,'viewer')).status,200);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});
