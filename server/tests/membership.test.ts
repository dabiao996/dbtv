import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {createMembershipService,effectiveMembership,permissionForApi,permissionKeys} from '../src/membership.js';
import {createAccount,ensureMemberNumber,backfillMemberNumbers,newMemberNo,validPassword,accountSearchWhere} from '../src/identity.js';

const folder=mkdtempSync(join(tmpdir(),'dbtv-membership-test-')),url=`file:${join(folder,'test.db')}`;
const db=new PrismaClient({datasourceUrl:url});
let now=new Date('2026-10-21T00:00:00Z');
const service=createMembershipService(db,()=>now);
let admin:any,user:any,plan:any;
const load=(id:number)=>db.user.findUniqueOrThrow({where:{id},include:{sourceAccess:true,membershipPlan:true}});
before(async()=>{
  // Ignore any completed local installation choice while preparing this disposable fixture.
  const result=spawnSync(process.execPath,['scripts/database.mjs','push'],{env:{...process.env,DBTV_DATA_DIR:folder,DATABASE_PROVIDER:'sqlite',DATABASE_URL:url},encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  await service.ready();
  admin=await db.user.create({data:{username:'fixture_admin',passwordHash:'not-a-real-password',role:'admin'}});
  user=await db.user.create({data:{username:'fixture_user',passwordHash:'not-a-real-password'}});
  await db.source.createMany({data:[{key:'free-source',name:'普通源',type:'local',api:'local'},{key:'vip-source',name:'会员源',type:'local',api:'local'}]});
  plan=await service.savePlan(admin,undefined,{name:'测试VIP',description:'仅测试',pricePoints:100,durationDays:30,enabled:true,permissions:['sources','playback'],sourceKeys:['vip-source'],allSources:false});
});
after(async()=>{await db.$disconnect();rmSync(folder,{recursive:true,force:true})});

test('plan expiry falls back to ordinary permissions; admin rights cannot be bought',()=>{
  const free={id:'free',name:'普通用户',permissions:'["home"]',sourceKeys:'[]',allSources:false};
  const sample={role:'user',sourceAccess:[{sourceKey:'manual'}],membershipPlanId:'vip',membershipExpiresAt:new Date('2026-11-01'),membershipPlan:{id:'vip',name:'VIP',enabled:true,permissions:'["sources","admin"]',sourceKeys:'["vip"]'}};
  const active=effectiveMembership(sample,free,new Date('2026-10-21'));
  assert.deepEqual(active.permissions,['sources']);assert.deepEqual(active.sourceKeys,['manual','vip']);
  assert.deepEqual(effectiveMembership(sample,free,new Date('2026-11-02')).permissions,['home']);
  assert.deepEqual(effectiveMembership({...sample,role:'admin'},free).permissions,permissionKeys);
});
test('guest plan is reserved for the synthetic guest identity',()=>{
  const free={id:'free',name:'普通用户',permissions:'["home"]',sourceKeys:'[]',allSources:false};
  const guest={role:'user',guest:true,sourceAccess:[],accessGroupIds:null,membershipPlanId:'guest',membershipPlan:{id:'guest',name:'游客',enabled:true,permissions:'["playback"]',sourceKeys:'[]',allSources:true},membershipExpiresAt:null};
  assert.equal(effectiveMembership(guest,free).membership.planId,'guest');
  assert.equal(effectiveMembership({...guest,guest:false},free).membership.planId,'free');
});
test('permissions cover legacy direct-source search, detail URLs and playback alternatives',()=>{
  for(const path of ['/api/sources/x/videos/x:1','/api/playback-options','/api/playback-errors'])assert.equal(permissionForApi(path),'playback');
  assert.equal(permissionForApi('/api/sources/x/search'),'search');
  assert.equal(permissionForApi('/api/history','POST'),'playback');
  assert.equal(permissionForApi('/api/history','GET'),'history');
  assert.equal(permissionForApi('/api/recommendations/today'),'recommendations');
});
test('granting points is admin-only, idempotent, audited and never allows a negative balance',async()=>{
  const body={delta:500,reason:'测试奖励',requestId:randomUUID()};
  await assert.rejects(service.adjust(user,user.id,body),/管理员/);
  await service.adjust(admin,user.id,body);
  const replay=await service.adjust(admin,user.id,body);assert.equal(replay.replayed,true);
  assert.equal((await load(user.id)).points,500);
  await assert.rejects(service.adjust(admin,user.id,{...body,delta:501}),/同一请求/);
  await assert.rejects(service.adjust(admin,user.id,{delta:-501,reason:'测试扣除',requestId:randomUUID()}),/不足/);
  await assert.rejects(service.adjust(admin,user.id,{delta:1.2,reason:'测试奖励',requestId:randomUUID()}),/整数/);
  assert.equal(await db.pointLedger.count({where:{userId:user.id}}),1);
  assert.equal(await db.adminLog.count({where:{action:'points.adjust'}}),1);
});
test('repeated/concurrent redemption charges once and updates member expiry in the same transaction',async()=>{
  const body={planId:plan.id,expectedVersion:plan.version,requestId:randomUUID()};
  const results=await Promise.all([service.redeem(user,body),service.redeem(user,body),service.redeem(user,body)]);
  assert.equal(results.filter(x=>!x.replayed).length,1);
  const saved=await load(user.id);assert.equal(saved.points,400);assert.equal(saved.membershipPlanId,plan.id);assert.equal(saved.membershipExpiresAt?.toISOString(),'2026-11-20T00:00:00.000Z');
  assert.equal(await db.pointLedger.count({where:{kind:'membership_redeem',userId:user.id}}),1);
  const effective=await service.hydrate(saved);assert.deepEqual(effective.permissions,['sources','playback']);assert.deepEqual(effective.sourceAccess,[{sourceKey:'vip-source'}]);
});
test('P1008 before and after commit retries by ledger key without a second debit or grant',async()=>{
  const error=()=>Object.assign(Error('SQLite timeout'),{code:'P1008'});
  const timeoutUser=await db.user.create({data:{username:'fixture_timeout_user',passwordHash:'fixture',points:500}});
  let calls=0;
  const before=new Proxy(db,{get(target,key){
    if(key==='$transaction')return async(...args:any[])=>{if(++calls===1)throw error();return (target.$transaction as any)(...args)};
    return Reflect.get(target,key,target);
  }});
  const retryBefore=createMembershipService(before,()=>now);
  const grant={delta:120,reason:'超时重试测试',requestId:randomUUID()};
  const balance=(await load(timeoutUser.id)).points;
  const granted=await retryBefore.adjust(admin,timeoutUser.id,grant);
  assert.equal(granted.replayed,false);assert.equal(calls,2);
  assert.equal((await load(timeoutUser.id)).points,balance+120);
  assert.equal(await db.pointLedger.count({where:{operationKey:granted.entry.operationKey}}),1);

  calls=0;
  const after=new Proxy(db,{get(target,key){
    if(key==='$transaction')return async(...args:any[])=>{
      const result=await (target.$transaction as any)(...args);
      if(++calls===1)throw error();
      return result;
    };
    return Reflect.get(target,key,target);
  }});
  const retryAfter=createMembershipService(after,()=>now);
  const request={planId:plan.id,expectedVersion:plan.version,requestId:randomUUID()};
  const beforeRedeem=await load(timeoutUser.id);
  const redeemed=await retryAfter.redeem(timeoutUser,request);
  assert.equal(redeemed.replayed,true);assert.equal(calls,2);
  const saved=await load(timeoutUser.id);
  assert.equal(saved.points,beforeRedeem.points-plan.pricePoints);
  assert.equal(saved.membershipExpiresAt?.getTime(),now.getTime()+30*86400000);
  assert.equal(await db.pointLedger.count({where:{operationKey:redeemed.entry.operationKey}}),1);
});
test('P1008 has a five-attempt limit and unrelated errors are never retried',async()=>{
  let attempts=0;
  const fail=(code:string)=>new Proxy(db,{get(target,key){
    if(key==='$transaction')return async()=>{attempts++;throw Object.assign(Error(code),{code})};
    return Reflect.get(target,key,target);
  }});
  await assert.rejects(createMembershipService(fail('P1008')).adjust(admin,user.id,{delta:1,reason:'上限测试',requestId:randomUUID()}),(e:any)=>e.code==='P1008');
  assert.equal(attempts,5);
  attempts=0;
  await assert.rejects(createMembershipService(fail('P2024')).adjust(admin,user.id,{delta:1,reason:'非重试测试',requestId:randomUUID()}),(e:any)=>e.code==='P2024');
  assert.equal(attempts,1);
});
test('renewal extends from expiry; changed price, disabled plans and invalid requests do not consume points',async()=>{
  await service.redeem(user,{planId:plan.id,expectedVersion:plan.version,requestId:randomUUID()});
  assert.equal((await load(user.id)).membershipExpiresAt?.toISOString(),'2026-12-20T00:00:00.000Z');
  await assert.rejects(service.redeem(user,{planId:plan.id,expectedVersion:plan.version+1,requestId:randomUUID()}),/变化/);
  await assert.rejects(service.redeem(user,{planId:'free',expectedVersion:0,requestId:randomUUID()}),/有效套餐/);
  await assert.rejects(service.redeem(user,{planId:plan.id,expectedVersion:0,requestId:'short'}),/请求标识/);
  const saved=await db.membershipPlan.findUniqueOrThrow({where:{id:plan.id}});
  await assert.rejects(service.savePlan(admin,plan.id,{...saved,permissions:['admin'],sourceKeys:[]}),/权限/);
  await service.savePlan(admin,plan.id,{...saved,permissions:['sources'],sourceKeys:['vip-source'],enabled:false});
  await assert.rejects(service.redeem(user,{planId:plan.id,expectedVersion:1,requestId:randomUUID()}),/未上架/);
  assert.equal((await load(user.id)).points,300);
  assert.equal((await service.hydrate(await load(user.id))).membership.active,false);
});
test('insufficient funds under concurrent purchases cannot overspend or create a partial membership',async()=>{
  const other=await db.user.create({data:{username:'fixture_other',passwordHash:'fixture',points:100}});
  const fresh=await service.savePlan(admin,undefined,{name:'测试并发',description:'',pricePoints:100,durationDays:1,enabled:true,permissions:['home'],sourceKeys:[],allSources:false});
  const results=await Promise.allSettled([service.redeem(other,{planId:fresh.id,expectedVersion:0,requestId:randomUUID()}),service.redeem(other,{planId:fresh.id,expectedVersion:0,requestId:randomUUID()})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await load(other.id)).points,0);assert.equal(await db.pointLedger.count({where:{userId:other.id}}),1);
  now=new Date('2027-01-01');
  assert.equal((await service.hydrate(await load(other.id))).membership.active,false);
});

test('member numbers are immutable, automatically backfilled and protected by a database unique index',async()=>{
  const legacy=await db.user.create({data:{username:'legacy_fixture',passwordHash:'fixture'}});
  await backfillMemberNumbers(db);
  const number=(await load(legacy.id)).memberNo;
  assert.match(number!,/^DTV-[A-F0-9]{12}$/);
  await backfillMemberNumbers(db);assert.equal((await load(legacy.id)).memberNo,number);
  assert.deepEqual(await Promise.all([ensureMemberNumber(db,legacy.id),ensureMemberNumber(db,legacy.id)]),[number,number]);
  const account=await createAccount(db,{username:'new_number_fixture',passwordHash:'fixture',memberNo:number});
  assert.match(account.memberNo,/^DTV-[A-F0-9]{12}$/);assert.notEqual(account.memberNo,number);
  await assert.rejects(db.user.create({data:{username:'duplicate_number_fixture',passwordHash:'fixture',memberNo:number}}),e=>(e as any).code==='P2002');
  const rows=await db.user.findMany({where:accountSearchWhere(number!.toLowerCase()),select:{id:true}});assert.deepEqual(rows,[{id:legacy.id}]);
  assert.match(newMemberNo(),/^DTV-[A-F0-9]{12}$/);
});
test('six-character passwords are accepted, five-character and oversized passwords rejected',()=>{
  assert.equal(validPassword('abc123'),true);assert.equal(validPassword('abc12'),false);assert.equal(validPassword('x'.repeat(129)),false);assert.equal(validPassword(123456),false);
});
test('source groups grant sources only; edits/disable propagate without erasing separate grants',async()=>{
  const group=await service.saveGroup(admin,undefined,{name:'电影专区测试组',description:'动态授权测试',enabled:true,permissions:['sources','playback'],sourceKeys:['vip-source']});
  const free={id:'free',name:'普通用户',permissions:'["home"]',sourceKeys:'[]',allSources:false};
  const sample={role:'user',sourceAccess:[{sourceKey:'manual-source'}],accessGroupIds:JSON.stringify([group.id]),membershipPlanId:null};
  const access=effectiveMembership(sample,free,new Date(),[group]);assert.deepEqual(access.permissions,['home']);assert.deepEqual(access.sourceKeys,['manual-source','vip-source']);
  const changed=await service.saveGroup(admin,group.id,{...group,permissions:['sources'],sourceKeys:['free-source'],version:0});
  assert.deepEqual(effectiveMembership(sample,free,new Date(),[changed]).sourceKeys,['manual-source','free-source']);
  assert.deepEqual(effectiveMembership(sample,free,new Date(),[{...changed,enabled:false}]).permissions,['home']);
  assert.deepEqual(effectiveMembership(sample,free,new Date(),[{...changed,enabled:false}]).sourceKeys,['manual-source']);
  await assert.rejects(service.saveGroup(user,undefined,{name:'bad'}),/管理员/);
  const ignored=await service.saveGroup(admin,undefined,{name:'no_function_grants',description:'',enabled:true,permissions:['admin'],sourceKeys:[]});assert.equal(ignored.permissions,'[]');
  await assert.rejects(service.validateGroups(['unknown']),/不存在/);
});
test('editing a group invalidates versions of linked membership offers and preserves unlinked plans',async()=>{
  const group=await service.saveGroup(admin,undefined,{name:'套餐联动测试',description:'',enabled:true,permissions:['playback'],sourceKeys:['vip-source']});
  const linked=await service.savePlan(admin,undefined,{name:'分组套餐',description:'',enabled:true,pricePoints:50,durationDays:2,allSources:false,permissions:[],sourceKeys:[],accessGroupIds:[group.id]});
  const before=(await db.membershipPlan.findUniqueOrThrow({where:{id:plan.id}})).version;
  await service.saveGroup(admin,group.id,{...group,version:0,permissions:['sources','playback'],sourceKeys:['free-source']});
  assert.equal((await db.membershipPlan.findUniqueOrThrow({where:{id:linked.id}})).version,1);
  assert.equal((await db.membershipPlan.findUniqueOrThrow({where:{id:plan.id}})).version,before);
  const sample=await db.user.create({data:{username:'group_plan_fixture',passwordHash:'fixture',membershipPlanId:linked.id,membershipExpiresAt:new Date(now.getTime()+86400000)}});
  const hydrated=await service.hydrate(await load(sample.id));assert.deepEqual(hydrated.permissions,[]);assert.deepEqual(hydrated.sourceAccess,[{sourceKey:'free-source'}]);
});
