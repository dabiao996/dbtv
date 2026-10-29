import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {createVirtualUploaderService,virtualProfileInput,virtualVideoKey,registerVirtualUploaders} from '../src/virtual-uploaders.js';

const video=(id='source:movie')=>({id,sourceKey:'source',title:'Movie'} as any);
test('virtual profile input rejects unsafe avatars and normalizes video identity',()=>{
  assert.deepEqual(virtualProfileInput({name:'  展示影友  ',avatarUrl:null,enabled:true}),{name:'展示影友',avatarUrl:null,enabled:true});
  for(const avatarUrl of ['javascript:alert(1)','data:image/svg+xml,test','http://example.com/a','//example.com/a','/\\example.com/a','https://name:password@example.com/a','https://example.com/a b'])assert.throws(()=>virtualProfileInput({name:'影友',enabled:true,avatarUrl}));
  for(const avatarUrl of ['/images/a.png','https://example.com/a.png'])assert.equal(virtualProfileInput({name:'影友',enabled:false,avatarUrl}).avatarUrl,avatarUrl);
  for(const name of ['', 'a'.repeat(41), '\n'])assert.throws(()=>virtualProfileInput({name,enabled:true}));
  assert.equal(virtualVideoKey(video('source:movie')),virtualVideoKey(video('movie')));
  assert.equal(virtualVideoKey({...video(),id:41,videoId:'source:movie'}),virtualVideoKey(video()));
  assert.equal(virtualVideoKey({...video(),id:987,videoId:'movie'}),virtualVideoKey(video()));
  assert.notEqual(virtualVideoKey(video()),virtualVideoKey({...video(),sourceKey:'different'}));
  assert.equal(virtualVideoKey({name:'not a video',id:'1'}),null);
});

test('virtual uploader batches and assignments persist independently of real accounts',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-virtual-users-')),url='file:'+join(folder,'test.db');
  const pushed=spawnSync(process.execPath,['scripts/database.mjs','push'],{env:{...process.env,DBTV_DATA_DIR:folder,DATABASE_PROVIDER:'sqlite',DATABASE_URL:url},encoding:'utf8'});
  assert.equal(pushed.status,0,pushed.stdout+pushed.stderr);
  const db=new PrismaClient({datasourceUrl:url});
  try{
    const user=await db.user.create({data:{username:'private-admin-login',passwordHash:'not-a-real-password',role:'admin',displayName:'Real Admin',avatarUrl:'https://example.com/private.png'}});
    const service=createVirtualUploaderService(db);
    const empty={...video(),uploader:{name:user.username,avatarUrl:user.avatarUrl}};
    await service.enrich(empty);assert.equal(empty.uploader,undefined);
    assert.equal(await db.videoAttribution.count(),0);
    for(const count of [0,101,1.5])await assert.rejects(service.generate({count,requestId:randomUUID()}));
    await assert.rejects(service.generate({count:1,requestId:'short'}));
    const requestId=randomUUID();
    const batch=await service.generate({count:2,requestId});
    assert.equal(batch.items.length,2);assert.equal(batch.replayed,false);
    assert(batch.items.every((item:any)=>item.name.startsWith('虚拟影友 ')));
    const replay=await service.generate({count:2,requestId});assert.equal(replay.replayed,true);
    assert.deepEqual(replay.items.map((x:any)=>x.id),batch.items.map((x:any)=>x.id));
    await assert.rejects(service.generate({count:3,requestId}),/同一请求标识/);
    assert.equal(await db.virtualUploader.count(),2);assert.equal(await db.user.count(),1);
    const item={...video(),uploader:{name:user.username}},variant=video('movie'),favorite={...video(),id:11,videoId:'source:movie'},history={...video(),id:22,videoId:'movie'};
    await service.enrich({items:[{...item,variants:[variant]}],list:[item,favorite,history]});
    assert.deepEqual(favorite.uploader,history.uploader);assert.deepEqual(favorite.uploader,item.uploader);
    assert.equal(item.uploader.virtual,true);assert.equal(item.uploader.name,variant.uploader.name);
    assert(!JSON.stringify(item).includes(user.username));assert(!JSON.stringify(item).includes(user.avatarUrl!));
    const assigned=await db.videoAttribution.findUniqueOrThrow({where:{videoKey:virtualVideoKey(video())!}});
    assert.equal(await db.videoAttribution.count(),1);
    await service.generate({count:3,requestId:randomUUID()});
    const restarted=createVirtualUploaderService(db),same=video();await restarted.enrich(same);
    assert.equal(same.uploader.name,item.uploader.name);
    await service.update(assigned.uploaderId,{name:'虚拟展示甲',avatarUrl:'/images/fixture.png',enabled:false});
    const hidden={...video(),uploader:item.uploader};await restarted.enrich(hidden);assert.equal(hidden.uploader,undefined);
    assert.equal((await db.videoAttribution.findUniqueOrThrow({where:{videoKey:assigned.videoKey}})).uploaderId,assigned.uploaderId);
    await service.update(assigned.uploaderId,{name:'虚拟展示乙',avatarUrl:null,enabled:true});
    const restored=video();await restarted.enrich(restored);assert.deepEqual(restored.uploader,{name:'虚拟展示乙',avatarUrl:null,virtual:true});
    await assert.rejects(service.update(String(user.id),{name:'bad',avatarUrl:null,enabled:true}),/不存在/);
    assert.equal((await db.user.findUniqueOrThrow({where:{id:user.id}})).username,user.username);
    // Simulate lost acknowledgement after commit: generation only reads back,
    // never re-runs its write transaction.
    let writes=0;
    const uncertain=createVirtualUploaderService(new Proxy(db,{get(target,key){if(key==='$transaction')return async(operation:any)=>{writes++;await target.$transaction(operation);throw Object.assign(Error('lost commit acknowledgement'),{code:'P1008'})};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}));
    const recovered=await uncertain.generate({count:1,requestId:randomUUID()});assert.equal(recovered.replayed,true);assert.equal(writes,1);
    assert.equal(await db.virtualUploader.count(),6);
    const concurrentId=randomUUID();
    const concurrent=await Promise.all([service.generate({count:100,requestId:concurrentId}),restarted.generate({count:100,requestId:concurrentId})]);
    assert(concurrent.every(result=>result.items.length===100));
    assert.deepEqual(concurrent[0].items.map((x:any)=>x.id),concurrent[1].items.map((x:any)=>x.id));
    assert.equal(await db.virtualUploader.count(),106);
    const first=video('source:concurrent'),second=video('concurrent');
    await Promise.all([service.enrich(first),restarted.enrich(second)]);
    assert.deepEqual(first.uploader,second.uploader);
    assert.equal(await db.videoAttribution.count({where:{videoKey:virtualVideoKey(first)!}}),1);
  }finally{await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});

test('all virtual uploader administration endpoints require an administrator',async()=>{
  const handlers:any[]=[];
  const app:any={get:(_path:string,handler:any)=>handlers.push(handler),post:(_path:string,handler:any)=>handlers.push(handler),put:(_path:string,handler:any)=>handlers.push(handler)};
  let called=false;
  const blocked=async()=>{called=true;throw Error('unauthorized database call')};
  registerVirtualUploaders(app,{}, {requireAdmin:async(_req,res)=>{res.status(403).json({error:'需要管理员权限'});return null;}},{list:blocked,generate:blocked,update:blocked,enrich:blocked});
  for(const handler of handlers){let status=0;const res={status(code:number){status=code;return this},json(){return this}};await handler({body:{},params:{}},res);assert.equal(status,403)}
  assert.equal(called,false);assert.equal(handlers.length,3);
});

test('failed optional enrichment clears legacy account attribution before any database work',async()=>{
  const body={items:[{...video(),uploader:{name:'private-login',avatarUrl:'/private-avatar'}}]};
  const service=createVirtualUploaderService({videoAttribution:{findMany:async()=>{throw Error('database unavailable')}}});
  await assert.rejects(service.enrich(body),/database unavailable/);
  assert.equal(body.items[0].uploader,undefined);
});

test('upgrading the previous schema preserves existing accounts, balances and media unchanged',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-virtual-upgrade-')),filename=join(folder,'existing.db'),url='file:'+filename;
  const env={...process.env,DBTV_DATA_DIR:folder,DATABASE_PROVIDER:'sqlite',DATABASE_URL:url};
  const previous=readFileSync('prisma/schema.prisma','utf8').replace(/model (?:VirtualUploader|VideoAttribution|VirtualUploaderBatch) \{[^}]*\}/g,'');
  assert(!previous.includes('model VirtualUploader'));assert(!previous.includes('model VideoAttribution'));
  const oldSchema=join(folder,'old.prisma');writeFileSync(oldSchema,previous);writeFileSync(filename,'');
  const initialized=spawnSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',oldSchema,'--skip-generate'],{env,encoding:'utf8'});
  assert.equal(initialized.status,0,initialized.stdout+initialized.stderr);
  const db=new PrismaClient({datasourceUrl:url});
  try{
    const plan=await db.membershipPlan.create({data:{name:'Preserved membership',description:'Existing plan',pricePoints:500,durationDays:30,enabled:true,permissions:'["playback"]',sourceKeys:'["private"]'}});
    const user=await db.user.create({data:{username:'preserve-login',memberNo:'DTV-PRESERVE',passwordHash:'preserve-password-hash',displayName:'Preserved Name',role:'admin',points:12345,walletVersion:7,membershipPlanId:plan.id,membershipExpiresAt:new Date('2030-01-01T00:00:00Z')}});
    await db.source.create({data:{key:'private',name:'Preserved source',type:'local',api:'private-path',enabled:false,rawConfig:'{"doNotChange":true}'}});
    await db.video.create({data:{id:'private:existing',sourceKey:'private',title:'Preserved video',visible:false,desc:'Existing synopsis'}});
    await db.episode.create({data:{id:'private:episode',videoId:'private:existing',lineName:'Original',name:'Episode',url:'https://example.com/private.mp4'}});
    await db.userSource.create({data:{userId:user.id,sourceKey:'private'}});
    await db.pointLedger.create({data:{userId:user.id,operationKey:'preserved-operation',requestHash:'preserved-hash',kind:'admin_grant',delta:12345,balanceAfter:12345,reason:'Preserved journal'}});
    const snapshot=async()=>({users:await db.user.findMany(),plans:await db.membershipPlan.findMany(),sources:await db.source.findMany(),videos:await db.video.findMany(),episodes:await db.episode.findMany(),grants:await db.userSource.findMany(),ledger:await db.pointLedger.findMany()});
    const before=await snapshot();await db.$disconnect();
    const upgraded=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});
    assert.equal(upgraded.status,0,upgraded.stdout+upgraded.stderr);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await db.virtualUploader.count(),0);
    assert.equal(await db.videoAttribution.count(),0);
    assert.equal(await db.virtualUploaderBatch.count(),0);
    // Re-running the same safe upgrade must also leave all records untouched.
    await db.$disconnect();
    const repeated=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});
    assert.equal(repeated.status,0,repeated.stdout+repeated.stderr);
    assert.deepEqual(await snapshot(),before);
  }finally{await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});
