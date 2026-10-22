import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {PrismaClient} from '@prisma/client';

test('real database resource catalog is read-only until publication and downlisting revokes public access without deleting data',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-resource-center-')),url=`file:${join(folder,'test.db')}`;
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const env={...process.env,DBTV_DATA_DIR:join(folder,'state'),INSTALL_TOKEN:'fixture-install-token-0123456789abcdef',DATABASE_PROVIDER:'sqlite',DATABASE_URL:url,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)};
  const db=new PrismaClient({datasourceUrl:url});let server;
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST')=>{const r=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,headers:{...path==='/install'?{'X-Install-Token':env.INSTALL_TOKEN}:{},'Content-Type':'application/json',...cookie?{Cookie:cookie}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  try{
    const push=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});assert.equal(push.status,0,push.stdout+push.stderr);
    server=spawn(process.execPath,['server/dist/index.js'],{env,stdio:'ignore'});
    let started=false;for(let i=0;i<100;i++){try{if((await call('/install/status')).status===200){started=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(started,true);
    const installed=await call('/install',{username:'resource_admin',password:'abc123',confirmPassword:'abc123'});assert.equal(installed.status,201);const admin=installed.cookie;
    assert.equal((await call('/admin/resource-center')).status,401);
    await call('/settings',{allowRegister:'true'},admin);const registered=await call('/auth/register',{username:'resource_user',password:'abc123',confirmPassword:'abc123'});assert.equal(registered.status,201);
    const user=(await call('/auth/login',{username:'resource_user',password:'abc123'})).cookie;
    assert.equal((await call('/admin/resource-center',undefined,user)).status,403);
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:true},user,'PUT')).status,403);
    assert.equal((await call('/admin/resource-center',undefined,admin)).data.storage,'source-file');assert.equal(await db.source.count(),0);
    const beforePlans=await db.membershipPlan.findMany();
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:true,api:'http://localhost'},admin,'PUT')).status,400);
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:true},admin,'PUT')).status,200);
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:true},admin,'PUT')).status,200);assert.equal(await db.source.count(),1);
    assert.deepEqual(await db.membershipPlan.findMany(),beforePlans);assert.equal(await db.userSource.count(),0);
    assert.deepEqual((await call('/library',undefined,user)).data,[]);
    await db.userSource.create({data:{userId:registered.data.id,sourceKey:'feifan'}});
    await db.source.update({where:{key:'feifan'},data:{searchable:false}});
    await db.video.create({data:{id:'feifan:fixture',sourceKey:'feifan',title:'仅供测试',category:'电影'}});
    await db.categoryBinding.create({data:{sourceKey:'feifan',remoteCategory:'动作片',localCategory:'电影'}});
    assert.equal((await call('/library',undefined,user)).data[0].key,'feifan');
    const endpoint='/sources/feifan/videos/feifan%3Afixture';assert.equal((await call(endpoint,undefined,user)).status,200);
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:false},admin,'PUT')).status,200);
    assert.deepEqual((await call('/library',undefined,user)).data,[]);assert.equal((await call(endpoint,undefined,user)).status,403);
    assert.equal(await db.video.count(),1);assert.equal(await db.categoryBinding.count(),1);assert.equal(await db.userSource.count(),1);
    assert.equal((await call('/admin/resource-center/feifan/publication',{published:true},admin,'PUT')).status,200);
    assert.equal((await db.source.findUnique({where:{key:'feifan'}})).searchable,false);assert.equal((await call(endpoint,undefined,user)).status,200);
  }finally{if(server){server.kill('SIGTERM');await once(server,'exit');}await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});
