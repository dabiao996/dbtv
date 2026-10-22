import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';

test('fresh browser installation chooses SQLite without a pre-created schema, survives restart, protects secrets and locks reinstallation',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-web-install-')),state=join(folder,'state'),database=join(folder,'fresh.db');
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const token='fixture-install-token-0123456789abcdef';
  const env={...process.env,DBTV_DATA_DIR:state,INSTALL_TOKEN:token,INSTALL_TOKEN_LOG:'false',DATABASE_PROVIDER:'sqlite',DATABASE_URL:`file:${database}`,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)};
  let child,logs='';
  const call=async(path,body,setupToken=token,origin)=>{const r=await fetch(`http://127.0.0.1:${port}/api${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Install-Token':setupToken,...origin?{Origin:origin}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  async function start(){child=spawn(process.execPath,['server/dist/index.js'],{env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs+=chunk.toString();});for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('安装测试进程提前退出');try{const r=await call('/install/status');if(r.status===200)return r.data;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('启动超时');}
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
  try{
    const initial=await start();assert.equal(initial.installed,false);assert.equal(initial.database.selectable,true);assert.equal(initial.requiresSetupToken,true);assert.equal(initial.database.schemaReady,false);
    assert.equal(logs.includes(token),false);assert.match(logs,/私有数据目录/);
    const publicText=JSON.stringify(initial);assert.equal(publicText.includes(token),false);assert.equal(publicText.includes(folder),false);
    assert.equal((await call('/settings')).status,200);assert.equal((await call('/auth/me')).data,null);
    assert.equal((await call('/auth/register',{username:'attacker',password:'abc123',confirmPassword:'abc123'})).status,503);
    assert.equal((await call('/install/database/test',{provider:'sqlite'},'')).status,403);
    assert.equal((await call('/install/database/test',{provider:'sqlite'},token,'https://attacker.invalid')).status,403);
    assert.equal((await call('/install/database/test',{provider:'sqlite',path:'/tmp/other'})).status,400);
    const bad=await call('/install/database/test',{provider:'mysql',host:'127.0.0.1',port:1,database:'dbtv',username:'private-user',password:'private-secret'});assert.equal(bad.status,400);assert.equal(JSON.stringify(bad.data).includes('private-'),false);
    assert.equal(existsSync(join(state,'database.json')),false);
    assert.equal((await call('/install/database/test',{provider:'sqlite'})).status,200);assert.equal(existsSync(join(state,'database.json')),false);
    const concurrent=await Promise.all([call('/install/database/test',{provider:'sqlite'}),call('/install/database/test',{provider:'sqlite'})]);assert.deepEqual(concurrent.map(value=>value.status).sort(),[200,409]);
    const request={database:{provider:'sqlite'},username:'fresh_admin',password:'abc123',confirmPassword:'abc123'};
    assert.equal((await call('/install',{...request,confirmPassword:'different'})).status,400);
    const installed=await call('/install',request);assert.equal(installed.status,201,JSON.stringify(installed.data));assert.ok(installed.cookie);
    assert.equal(statSync(join(state,'database.json')).mode&0o777,0o600);
    const saved=JSON.parse(readFileSync(join(state,'database.json'),'utf8'));assert.equal(saved.provider,'sqlite');assert.equal(saved.url,`file:${database}`);
    const r=await fetch(`http://127.0.0.1:${port}/api/auth/me`,{headers:{Cookie:installed.cookie}});assert.equal(r.status,200);assert.equal((await r.json()).role,'admin');
    const settings=JSON.stringify((await call('/settings')).data);assert.equal(settings.includes('DATABASE_URL'),false);assert.equal(settings.includes(token),false);assert.equal(settings.includes(folder),false);
    assert.equal((await call('/install/database/test',{provider:'postgresql'})).status,409);assert.equal((await call('/install',request)).status,409);
    await stop();env.DATABASE_URL=`file:${join(folder,'wrong-env.db')}`;
    const restarted=await start();assert.equal(restarted.installed,true);assert.equal(restarted.database.selectable,false);assert.equal(existsSync(join(folder,'wrong-env.db')),false);
    assert.equal((await call('/install',request)).status,409);
    await stop();
    // A durable install marker cannot be bypassed by pointing the saved connection at a new empty DB.
    writeFileSync(join(state,'database.json'),JSON.stringify({...saved,url:`file:${join(folder,'lost.db')}`}));
    const lost=await start();assert.equal(lost.installed,true);assert.equal(lost.recovery,true);assert.equal((await call('/install',request)).status,409);
  }finally{await stop();rmSync(folder,{recursive:true,force:true});}
});
