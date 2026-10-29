// Imported only by the opt-in disposable production-install regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {save} from './tv/core.mjs';
export async function testManagedStart(root,baseEnv){
  assert.notEqual(process.getuid?.(),0,'run this regression as a non-root user, like the native service');
  const home=path.dirname(root),data=path.join(home,'data');
  assert.equal(path.basename(root),'app');assert.ok(fs.existsSync(path.join(root,'.dbtv-source')));
  fs.mkdirSync(data,{mode:0o700});
  const node=path.join(home,'tools/node/bin/node');fs.mkdirSync(path.dirname(node),{recursive:true});fs.symlinkSync(process.execPath,node);
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
  assert.ok(fs.existsSync(path.join(npm,'bin/npm-cli.js')),'regression requires Node distribution npm');
  const npmTarget=path.join(home,'tools/node/lib/node_modules/npm');fs.mkdirSync(path.dirname(npmTarget),{recursive:true});fs.symlinkSync(npm,npmTarget);
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  // Use only the current test identity; never create or alter a host account.
  const serviceUser=os.userInfo().username;
  save(data,{version:1,id:'dbtv',mode:'native',source:root,node,port,bind:'127.0.0.1',origin:'',serviceUser,serviceUid:process.getuid(),serviceGid:process.getgid()});
  const env={...baseEnv,HOME:home,DB_AUTO_SYNC:'true'};delete env.PREFIX;delete env.INSTALL_TOKEN;
  const child=spawn(node,[path.join(root,'scripts/tv.mjs'),'serve','--home',home],{env,cwd:root,detached:true,stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs+=chunk.toString();});
  const origin=`http://127.0.0.1:${port}`;
  try{
    let healthy=false;
    for(let i=0;i<900;i++){
      if(child.exitCode!==null)throw Error(`managed serve exited ${child.exitCode}: ${logs}`);
      try{healthy=(await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
      if(healthy)break;await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(healthy,`managed serve did not become healthy: ${logs}`);
    const status=await (await fetch(origin+'/api/install/status')).json();assert.equal(status.requiresSetupToken,true);
    const token=fs.readFileSync(path.join(data,'setup-token'),'utf8').trim();assert.match(token,/^[a-f0-9]{64}$/);assert.ok(!logs.includes(token),'private install token must not enter service logs');
    const installed=await fetch(origin+'/api/install',{method:'POST',headers:{'Content-Type':'application/json','X-Install-Token':token},body:JSON.stringify({username:'fixture_admin',password:'fixture123',confirmPassword:'fixture123'})});
    assert.equal(installed.status,201,await installed.text());
    const cookie=installed.headers.get('set-cookie').split(';')[0];
    const imported=await fetch(origin+'/api/config/import-json',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({mode:'merge',rawConfig:JSON.stringify({sites:[{key:'fixture',name:'Fixture',type:1,api:'https://example.invalid/api'}]})})});
    assert.equal(imported.status,200,await imported.text());
    assert.equal((await (await fetch(origin+'/api/install/status')).json()).installed,true);
    assert.ok(fs.existsSync(path.join(data,'dabiao.db')));assert.ok(fs.existsSync(path.join(root,'tvbox.json')));
    console.log('Managed native smoke passed: real serve with dedicated HOME, npm start, Prisma prepare, first install, admin JSON import and private data.');
  }finally{
    try{process.kill(-child.pid,'SIGTERM');}catch{}
    if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);
    try{process.kill(-child.pid,'SIGKILL');}catch{}
  }
}
