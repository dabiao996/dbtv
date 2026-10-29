import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {PrismaClient} from '@prisma/client';

// Uses the normal first-install HTTP flow, never an existing installation or DB.
test('fresh install source JSON uploads enforce auth, safely merge, atomically replace and preserve unrelated records',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-source-upload-')),url='file:'+join(folder,'test.db');
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const env={...process.env,DBTV_DATA_DIR:join(folder,'state'),INSTALL_TOKEN:'fixture-source-import-token-0123456789',DATABASE_PROVIDER:'sqlite',DATABASE_URL:url,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)};
  let server;const db=new PrismaClient({datasourceUrl:url});
  const call=async(path,body,cookie='',extraHeaders={})=>{
    const response=await fetch(`http://127.0.0.1:${port}/api${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...path==='/install'?{'X-Install-Token':env.INSTALL_TOKEN}:{},...cookie?{Cookie:cookie}:{},...extraHeaders},...body===undefined?{}:{body:JSON.stringify(body)}});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const source=(key,name=key)=>({key,name,type:'local',api:'local'});
  const upload=(sites,extra={})=>({rawConfig:JSON.stringify({sites}),...extra});
  const snapshot=async()=>({sources:await db.source.findMany({orderBy:{key:'asc'}}),videos:await db.video.findMany(),bindings:await db.categoryBinding.findMany(),grants:await db.userSource.findMany(),episodes:await db.episode.findMany(),favorites:await db.favorite.findMany(),history:await db.watchHistory.findMany(),site:await db.setting.findUnique({where:{key:'siteName'}})});
  try{
    const pushed=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});assert.equal(pushed.status,0,pushed.stdout+pushed.stderr);
    server=spawn(process.execPath,['server/dist/index.js'],{env,stdio:'ignore'});
    let started=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('fixture server exited');try{if((await call('/install/status')).status===200){started=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(started,true);
    const installed=await call('/install',{username:'upload_admin',password:'abc123',confirmPassword:'abc123'});assert.equal(installed.status,201);const admin=installed.cookie;
    assert.equal((await call('/settings',{allowRegister:'true',siteName:'Preserved Brand'},admin)).status,200);
    assert.equal((await call('/auth/register',{username:'upload_user',password:'abc123',confirmPassword:'abc123'})).status,201);
    const user=(await call('/auth/login',{username:'upload_user',password:'abc123'})).cookie;
    const account=await db.user.findUniqueOrThrow({where:{username:'upload_user'}});
    const installAccount=await db.user.findUniqueOrThrow({where:{username:'upload_admin'}});
    await db.source.createMany({data:[{...source('keep'),enabled:false,searchable:false,quickSearch:false,filterable:false},{...source('remove')}]});
    await db.video.create({data:{id:'remove:movie',sourceKey:'remove',title:'Preserved until explicit replace'}});
    await db.categoryBinding.create({data:{sourceKey:'remove',remoteCategory:'Movie',localCategory:'电影'}});
    await db.userSource.create({data:{sourceKey:'remove',userId:account.id}});
    await db.episode.create({data:{id:'remove:episode',videoId:'remove:movie',lineName:'Original',name:'One',url:'https://example.com/video.mp4'}});
    await db.favorite.create({data:{userId:account.id,sourceKey:'remove',videoId:'remove:movie',title:'Favorite'}});
    await db.watchHistory.create({data:{userId:account.id,sourceKey:'remove',videoId:'remove:movie',title:'History',progress:12}});
    const before=await snapshot();
    assert.equal((await call('/config/import-json',upload([source('new')]))).status,401);
    assert.equal((await call('/config/import-json',upload([source('new')]),user)).status,403);
    assert.equal((await call('/config/import-json',upload([source('new')]),admin,{Origin:'https://evil.invalid'})).status,403);
    for(const invalid of [upload([]),upload([source('same'),source('same')]),upload([{...source('new'),enabled:'false'}]),upload([source('new')],{mode:'replace'}),upload([source('new')],{mode:'replace',confirmReplace:'true'}),{rawConfig:'not json'},upload([source('new')],{mode:'unknown'})])assert.equal((await call('/config/import-json',invalid,admin)).status,400);
    assert.equal((await call('/config/import-json',{rawConfig:'影'.repeat(400000)},admin)).status,413);
    assert.deepEqual(await snapshot(),before);
    const merged=await call('/config/import-json',upload([source('keep','Updated'),source('new')]),admin);
    assert.equal(merged.status,200);assert.equal(merged.data.mode,'merge');assert.equal(merged.data.created,1);assert.equal(merged.data.updated,1);assert.equal(merged.data.removed,0);
    assert.equal(await db.source.count(),3);const kept=await db.source.findUniqueOrThrow({where:{key:'keep'}});assert.equal(kept.name,'Updated');for(const flag of ['enabled','searchable','quickSearch','filterable'])assert.equal(kept[flag],false);
    const afterMerge=await snapshot();for(const key of ['videos','bindings','grants','episodes','favorites','history','site'])assert.deepEqual(afterMerge[key],before[key]);
    assert.equal((await call('/config/import-json',upload([source('keep','Updated'),source('new')]),admin)).status,200);assert.equal(await db.source.count(),3);
    // Force a database failure after replace's deletion to prove rollback, not
    // merely pre-validation. Both deletion and prior upserts must roll back.
    await db.$executeRawUnsafe(`CREATE TRIGGER fixture_source_fail BEFORE INSERT ON Source WHEN NEW.key = 'fail' BEGIN SELECT RAISE(ABORT, 'fixture-failure'); END`);
    const beforeFailure=await snapshot();
    const failed=await call('/config/import-json',upload([source('keep','Must roll back'),source('fail')],{mode:'replace',confirmReplace:true}),admin);
    assert.equal(failed.status,500);assert.deepEqual(await snapshot(),beforeFailure);assert(!JSON.stringify(failed.data).includes('fixture-failure'));
    await db.$executeRawUnsafe('DROP TRIGGER fixture_source_fail');
    const replaced=await call('/config/import-json',upload([source('keep')],{mode:'replace',confirmReplace:true}),admin);
    assert.equal(replaced.status,200);assert.equal(replaced.data.removed,2);assert.equal(await db.source.count(),1);
    assert.equal(await db.video.count(),0);assert.equal(await db.categoryBinding.count(),0);assert.equal(await db.userSource.count(),0);
    // These legacy records use plain identifiers, not Source foreign keys.
    assert.deepEqual(await db.episode.findMany(),before.episodes);assert.deepEqual(await db.favorite.findMany(),before.favorites);assert.deepEqual(await db.watchHistory.findMany(),before.history);
    assert.equal((await db.user.findUniqueOrThrow({where:{id:installAccount.id}})).passwordHash,installAccount.passwordHash);
    const repeated=await call('/config/import-json',upload([source('keep')],{mode:'replace',confirmReplace:true}),admin);assert.equal(repeated.status,200);assert.equal(repeated.data.removed,0);
    // A 1 MiB raw file is valid even when JSON escaping expands the HTTP body
    // beyond the application's usual 2 MiB request limit.
    const boundary=JSON.stringify({sites:[source('keep')]}),padding=1024*1024-Buffer.byteLength(boundary);
    const encodedBody='{"rawConfig":"'+JSON.stringify(boundary).slice(1,-1)+'\\u0020'.repeat(padding)+'"}';
    const escaped=await fetch(`http://127.0.0.1:${port}/api/config/import-json`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:admin},body:encodedBody});
    assert.equal(escaped.status,200);assert.equal((await escaped.json()).sites,1);
    const malformed=await fetch(`http://127.0.0.1:${port}/api/config/import-json`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:admin},body:'{'});
    assert.equal(malformed.status,400);assert.equal(typeof (await malformed.json()).error,'string');
    const exported=await call('/config',undefined,admin);assert.equal(exported.status,200);assert.equal(exported.data.sites.length,1);assert.equal(exported.data.name,'Preserved Brand');
    // Existing editor and root-file restore routes remain usable.
    assert.equal((await call('/config',{rawConfig:JSON.stringify(exported.data)},admin)).status,200);
    assert.equal((await call('/config/import-local',{},admin)).status,200);
  }finally{if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit')}await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});
