import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';

test('real HTTP membership flow enforces privileges, source restrictions, expiry, CSRF and private wallets',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-membership-api-')),url=`file:${join(folder,'test.db')}`;
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const env={...process.env,DBTV_DATA_DIR:join(folder,'state'),INSTALL_TOKEN:'fixture-install-token-0123456789abcdef',DATABASE_PROVIDER:'sqlite',DATABASE_URL:url,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)};
  const db=new PrismaClient({datasourceUrl:url});let server;
  let adminCookie='',userCookie='';
  async function call(path,{body,cookie,method,origin}={}){
    const response=await fetch(`http://127.0.0.1:${port}/api${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{...path==='/install'?{'X-Install-Token':env.INSTALL_TOKEN}:{},...body===undefined?{}:{'Content-Type':'application/json'},...cookie?{Cookie:cookie}:{},...origin?{Origin:origin}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});
    const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    const push=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});assert.equal(push.status,0,push.stdout+push.stderr);
    server=spawn(process.execPath,['server/dist/index.js'],{env,stdio:'ignore'});
    let started=false;for(let i=0;i<100;i++){try{if((await call('/install/status')).status===200){started=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(started,true);
    const installed=await call('/install',{body:{username:'fixture_admin',password:'abc123',confirmPassword:'abc123'}});assert.equal(installed.status,201);adminCookie=installed.cookie;
    await db.source.createMany({data:[{key:'ordinary',name:'普通源',type:'local',api:'not-public-api'},{key:'premium',name:'会员源',type:'local',api:'not-public-api'}]});
    await db.video.create({data:{id:'premium:1',sourceKey:'premium',title:'测试片',category:'电影'}});
    await db.episode.create({data:{id:'premium:1:0:0',videoId:'premium:1',lineName:'测试线路',name:'正片',url:'https://media.example.invalid/authorized.mp4'}});
    assert.equal((await call('/membership')).status,401);
    assert.equal((await call('/auth/register',{body:{username:'fixture_user',password:'fixture-password-123',confirmPassword:'fixture-password-123'}})).status,403);
    assert.equal((await call('/settings',{cookie:adminCookie,body:{allowRegister:'true'}})).status,200);
    assert.equal((await call('/auth/register',{body:{username:'too_short',password:'abc12',confirmPassword:'abc12'}})).status,400);
    const registered=await call('/auth/register',{body:{username:'fixture_user',password:'abc123',confirmPassword:'abc123',role:'admin',points:999999,membershipPlanId:'fake',memberNo:'DTV-FORGED'}});assert.equal(registered.status,201);
    const userId=registered.data.id;
    assert.match(registered.data.memberNo,/^DTV-[A-F0-9]{12}$/);
    const login=await call('/auth/login',{body:{username:'fixture_user',password:'abc123'}});assert.equal(login.status,200);userCookie=login.cookie;
    assert.equal(login.data.user.role,'user');assert.equal(login.data.user.points,0);assert.equal('passwordHash' in login.data.user,false);
    assert.equal(login.data.user.memberNo,registered.data.memberNo);
    const created=await call('/admin/users',{cookie:adminCookie,body:{username:'six_char_account',password:'xyz789',sourceKeys:[],memberNo:'DTV-FORGED'}});assert.equal(created.status,201);assert.match(created.data.memberNo,/^DTV-[A-F0-9]{12}$/);assert.notEqual(created.data.memberNo,registered.data.memberNo);
    assert.equal((await call('/admin/users',{cookie:adminCookie,body:{username:'five_char_account',password:'xyz78',sourceKeys:[]}})).status,400);
    await db.user.createMany({data:Array.from({length:45},(_,i)=>({username:'bulk_fixture_'+i,memberNo:'DTV-'+(i+1).toString(16).toUpperCase().padStart(12,'0'),passwordHash:'fixture'}))});
    const firstPage=await call('/admin/member-search',{cookie:adminCookie});assert.equal(firstPage.data.items.length,20);assert.equal(firstPage.data.hasMore,true);assert.equal('passwordHash' in firstPage.data.items[0],false);
    const found=await call('/admin/member-search?q='+registered.data.memberNo.toLowerCase(),{cookie:adminCookie});assert.equal(found.data.total,1);assert.equal(found.data.items[0].id,userId);
    assert.equal((await call('/admin/member-search?q=fixture',{cookie:userCookie})).status,403);
    const adminData=await call('/admin/membership',{cookie:adminCookie});const free=adminData.data.plans.find(x=>x.id==='free');
    assert.equal((await call('/admin/membership/plans/free',{method:'PUT',cookie:adminCookie,body:{...free,permissions:['home','sources'],sourceKeys:[],allSources:false}})).status,200);
    for(const path of ['/admin/membership','/ADMIN/membership','/config'])assert.equal((await call(path,{cookie:userCookie})).status,403);
    assert.equal((await call('/membership',{cookie:userCookie,origin:'https://attacker.invalid'})).status,403);
    assert.equal((await call('/library/videos?q=test',{cookie:userCookie})).status,403);
    const denied=await call('/sources/premium/videos/premium%3A1',{cookie:userCookie});assert.equal(denied.status,403);
    const empty=await call('/library',{cookie:userCookie});assert.deepEqual(empty.data,[]);
    const gift={delta:300,reason:'集成测试赠送',requestId:randomUUID()};
    assert.equal((await call(`/admin/membership/users/${userId}/points`,{cookie:userCookie,body:gift})).status,403);
    assert.equal((await call(`/admin/membership/users/${userId}/points`,{cookie:adminCookie,body:gift,origin:'https://attacker.invalid'})).status,403);
    assert.equal((await call(`/admin/membership/users/${userId}/points`,{cookie:adminCookie,body:gift})).status,200);
    assert.equal((await call(`/admin/membership/users/${userId}/points`,{cookie:adminCookie,body:gift})).data.replayed,true);
    const plan=await call('/admin/membership/plans',{cookie:adminCookie,body:{name:'测试VIP',description:'仅供集成测试',pricePoints:100,durationDays:30,permissions:['sources','playback','search'],sourceKeys:['premium'],allSources:false,enabled:true}});assert.equal(plan.status,201);
    const redeem={planId:plan.data.id,expectedVersion:plan.data.version,pricePoints:0,userId:1,requestId:randomUUID()};
    assert.equal((await call('/membership/redeem',{cookie:userCookie,body:redeem})).status,200);
    assert.equal((await call('/membership/redeem',{cookie:userCookie,body:redeem})).data.replayed,true);
    const wallet=await call('/membership?userId=1',{cookie:userCookie});assert.equal(wallet.data.account.id,userId);assert.equal(wallet.data.account.points,200);assert.equal(wallet.data.ledger.length,2);assert.equal(wallet.data.account.membership.active,true);
    const detail=await call('/sources/premium/videos/premium%3A1',{cookie:userCookie});assert.equal(detail.status,200);assert.equal(detail.data.episodes.length,1);
    assert.equal((await call('/sources/ordinary',{cookie:userCookie})).status,403);
    const sources=await call('/sources',{cookie:userCookie});assert.equal(sources.data.length,1);assert.equal('api' in sources.data[0],false);
    // A legacy user update cannot forge a wallet balance or give an ordinary user administrator access.
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{points:999999,membershipPlanId:'forged'}})).status,200);
    assert.equal((await call('/membership',{cookie:userCookie})).data.account.points,200);
    await db.user.update({where:{id:userId},data:{membershipExpiresAt:new Date(Date.now()-1000)}});
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,403);
    assert.equal((await call('/membership',{cookie:userCookie})).data.account.membership.active,false);
    // A source group grants sources, not page functionality; configure page rights on the plan.
    const normal=(await call('/admin/membership',{cookie:adminCookie})).data.plans.find(x=>x.id==='free');
    const revisedNormal=await call('/admin/membership/plans/free',{method:'PUT',cookie:adminCookie,body:{...normal,permissions:['home','sources','playback'],sourceKeys:[],accessGroupIds:[],allSources:false}});assert.equal(revisedNormal.status,200,JSON.stringify(revisedNormal.data));
    const group=await call('/admin/access-groups',{cookie:adminCookie,body:{name:'测试源组',description:'动态绑定',sourceKeys:['premium'],enabled:true}});assert.equal(group.status,201);
    assert.equal((await call('/admin/access-groups',{cookie:userCookie})).status,403);
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{accessGroupIds:[group.data.id],memberNo:'DTV-FORGED'}})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,200);
    assert.equal((await call('/auth/me',{cookie:userCookie})).data.memberNo,registered.data.memberNo);
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{accessGroupIds:['missing']}})).status,400);
    assert.equal((await call('/admin/access-groups/'+group.data.id,{cookie:adminCookie,method:'PUT',body:{...group.data,permissions:['sources','playback'],sourceKeys:['premium'],enabled:false}})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,403);
    // Grade-level exclusions must win over all-source and separate account grants.
    await db.video.create({data:{id:'premium:adult',sourceKey:'premium',title:'分类限制测试',category:'伦理片'}});
    const plain=(await call('/admin/membership',{cookie:adminCookie})).data.plans.find(x=>x.id==='free');
    const restricted=await call('/admin/membership/plans/free',{cookie:adminCookie,method:'PUT',body:{...plain,permissions:['sources','search','playback','favorites','history'],sourceKeys:[],accessGroupIds:[],allSources:true,contentRules:{deniedSourceKeys:['ordinary'],deniedCategories:[{sourceKey:'*',name:'伦理'}]}}});assert.equal(restricted.status,200,JSON.stringify(restricted.data));
    assert.equal((await call('/sources/ordinary',{cookie:userCookie})).status,403);
    assert.equal((await call('/sources/premium/videos/premium%3Aadult',{cookie:userCookie})).status,403);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,200);
    const library=await call('/sources/premium/videos',{cookie:userCookie});assert.deepEqual(library.data.items.map(x=>x.id),['premium:1']);
    const blockedSearch=await call('/search?q='+encodeURIComponent('分类限制测试'),{cookie:userCookie});assert.deepEqual(blockedSearch.data,[]);
    assert.equal((await call('/playback-options?sourceKey=premium&videoId=premium%3Aadult',{cookie:userCookie})).status,403);
    assert.equal((await call('/history',{cookie:userCookie,body:{sourceKey:'premium',videoId:'premium:adult',category:'动作片',title:'伪造'}})).status,403);
    assert.equal((await call('/sources/premium/videos/premium%3Aadult',{cookie:adminCookie})).status,200);
    // Group category allow-list and level blacklist compose correctly in real HTTP flows.
    await db.video.update({where:{id:'premium:1'},data:{category:'动作片'}});
    await db.video.create({data:{id:'premium:comedy',sourceKey:'premium',title:'喜剧测试',category:'喜剧片'}});
    const currentGroup=(await db.accessGroup.findUnique({where:{id:group.data.id}}));
    assert.equal((await call('/admin/access-groups/'+group.data.id,{cookie:adminCookie,method:'PUT',body:{...currentGroup,sourceKeys:['premium'],enabled:true,categoryRules:[{sourceKey:'*',name:'动作'}]}})).status,200);
    const currentPlain=(await call('/admin/membership',{cookie:adminCookie})).data.plans.find(x=>x.id==='free');
    assert.equal((await call('/admin/membership/plans/free',{cookie:adminCookie,method:'PUT',body:{...currentPlain,permissions:['sources','search','playback'],sourceKeys:[],accessGroupIds:[group.data.id],allSources:false}})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3Acomedy',{cookie:userCookie})).status,403);
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{sourceKeys:['premium']}})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3Acomedy',{cookie:userCookie})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3Aadult',{cookie:userCookie})).status,403);
    // Simplified selection round-trips both unchecked group members and category bans.
    const beforeSimple=(await call('/admin/membership',{cookie:adminCookie})).data.plans.find(x=>x.id==='free');
    const simpleBody={...beforeSimple,permissions:['sources','search','playback'],sourceKeys:[],accessGroupIds:[group.data.id],allSources:false,contentRules:{sourceSelection:'grade',deniedSourceKeys:['premium'],deniedCategories:[{sourceKey:'*',name:'伦理'}]}};
    const simple=await call('/admin/membership/plans/free',{cookie:adminCookie,method:'PUT',body:simpleBody});assert.equal(simple.status,200);
    assert.deepEqual((await call('/sources',{cookie:userCookie})).data,[]);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,403);
    const rechecked=await call('/admin/membership/plans/free',{cookie:adminCookie,method:'PUT',body:{...simpleBody,version:simple.data.version,contentRules:{...simpleBody.contentRules,deniedSourceKeys:[]}}});assert.equal(rechecked.status,200);
    const persisted=(await call('/admin/membership',{cookie:adminCookie})).data.plans.find(x=>x.id==='free');assert.deepEqual(JSON.parse(persisted.contentRules).deniedCategories,[{sourceKey:'*',name:'伦理'}]);
    assert.equal((await call('/sources/premium/videos/premium%3A1',{cookie:userCookie})).status,200);
    assert.equal((await call('/sources/premium/videos/premium%3Acomedy',{cookie:userCookie})).status,403);
    assert.equal((await call('/sources/premium/videos/premium%3Aadult',{cookie:userCookie})).status,403);
    assert.equal((await call('/profile/password',{cookie:userCookie,body:{currentPassword:'abc123',newPassword:'abc12'}})).status,400);
    assert.equal((await call('/profile/password',{cookie:userCookie,body:{currentPassword:'abc123',newPassword:'xyz789'}})).status,200);
    assert.equal((await call('/membership',{cookie:userCookie})).status,401);
    const relogin=await call('/auth/login',{body:{username:'fixture_user',password:'xyz789'}});assert.equal(relogin.status,200);userCookie=relogin.cookie;
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{password:'rst123'}})).status,200);
    const resetLogin=await call('/auth/login',{body:{username:'fixture_user',password:'rst123'}});assert.equal(resetLogin.status,200);userCookie=resetLogin.cookie;
    assert.equal((await call('/admin/membership',{cookie:userCookie})).status,403);
    assert.equal((await call('/auth/login',{body:{username:'fixture_user',password:'wrong'}})).status,401);
    assert.equal((await call('/settings',{cookie:userCookie,body:{allowRegister:'false'}})).status,403);
    assert.equal((await call('/settings',{cookie:adminCookie,body:{allowRegister:'false'}})).status,200);
    assert.equal((await call('/auth/register',{body:{username:'blocked_user',password:'fixture-password-123',confirmPassword:'fixture-password-123'}})).status,403);
    assert.equal((await call(`/admin/users/${userId}`,{cookie:adminCookie,method:'PUT',body:{enabled:false}})).status,200);
    assert.equal((await call('/membership',{cookie:userCookie})).status,401);
  }finally{
    if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}
    await db.$disconnect();rmSync(folder,{recursive:true,force:true});
  }
});
