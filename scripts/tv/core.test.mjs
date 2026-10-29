import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {portNumber,origin,available,choosePort,question,addresses,save,read,environment,compose,systemdUnit,redact,health,secureCopy,backupLiveCatalog,restoreLiveCatalog} from './core.mjs';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cli=path.join(root,'scripts/tv.mjs');
const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-deploy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const listening=async(t,host='127.0.0.1')=>{const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));return server.address().port;};
const run=async(args,env={})=>{try{return {...await exec(process.execPath,[cli,...args],{env:{...process.env,...env}}),code:0};}catch(error){return {...error,code:Number(error.code)};}};
function fixture(t,{port=47879,running=false}={}){
  const home=temporary(t),bin=path.join(home,'bin');fs.mkdirSync(bin);
  fs.copyFileSync(path.join(root,'scripts/tv/fixtures/docker'),path.join(bin,'docker'));fs.chmodSync(path.join(bin,'docker'),0o700);
  const fake=path.join(home,'fake-docker.json');fs.writeFileSync(fake,JSON.stringify({running}));
  const state={version:1,id:'dbtv',mode:'docker',source:path.join(home,'app'),node:process.execPath,port,bind:'127.0.0.1',origin:''};
  fs.mkdirSync(state.source);save(home,state);
  fs.writeFileSync(path.join(home,'app.env'),'');fs.writeFileSync(path.join(home,'compose.json'),compose(home,state));
  return {home,state,fake,env:{PATH:`${bin}:${process.env.PATH}`,DBTV_TEST_DOCKER:fake}};
}

test('port validates full integer range, refuses shell payloads and privileged ports',()=>{
  for(const value of [0,80,1023,65536,'8787abc','1e4','8787;kill','-1',''])assert.throws(()=>portNumber(value));
  for(const value of [1024,8787,65535,'08787'])assert.equal(portNumber(value),Number(value));
});
test('origin accepts only HTTP origins and rejects credentials, paths and injection',()=>{
  assert.equal(origin('tv.cdbhnb.xyz'),'https://tv.cdbhnb.xyz');assert.equal(origin(''),'');
  assert.equal(origin('http://127.0.0.1:8787'),'http://127.0.0.1:8787');
  for(const value of ['javascript:alert(1)','https://name:secret@host','https://host/path','https://host/?token=x','https://host/#x'])assert.throws(()=>origin(value));
});
test('actual IPv4 listener is busy and explicit conflict never silently changes port',async t=>{
  const port=await listening(t);assert.equal(await available(port),false);
  await assert.rejects(choosePort({value:port}),error=>error.code==='PORT_IN_USE');
});
test('IPv6-only occupied port is also detected',async t=>{
  let port;try{port=await listening(t,'::1');}catch{t.skip('IPv6 unavailable');return;}
  assert.equal(await available(port),false);
});
test('interactive invalid port retries; busy default suggests rather than kills service',async t=>{
  const port=await listening(t);let calls=0;const reports=[];
  const selected=await choosePort({defaultPort:port,ask:async()=>['bad','',''][calls++],report:value=>reports.push(value)});
  assert.notEqual(selected,port);assert.equal(calls,3);assert.equal(reports.length,2);assert.equal(await available(port),false);
});
test('configuration is private and hot paths retain one persistent data location',t=>{
  const home=temporary(t),state={version:1,id:'dbtv',mode:'native',source:'/opt/dbtv/app',node:'/opt/dbtv/tools/node/bin/node',port:9911,bind:'127.0.0.1',origin:'https://tv.example.com'};
  save(home,state);assert.equal(fs.statSync(path.join(home,'deployment.json')).mode&0o777,0o600);assert.deepEqual(read(home),state);
  const env=environment(home,state);assert.equal(env.DATABASE_URL,`file:${home}/data/dabiao.db`);assert.equal(env.COOKIE_SECURE,'true');assert.equal(env.INSTALL_TOKEN_LOG,'false');
  assert.equal(environment(home,{...state,port:9912}).DATABASE_URL,env.DATABASE_URL);
  fs.chmodSync(path.join(home,'deployment.json'),0o644);assert.throws(()=>read(home),/600/);
});
test('Docker host port differs from fixed container port and binds locally by default',()=>{
  const state={source:'/opt/dbtv/app',port:9911,bind:'127.0.0.1'},value=JSON.parse(compose('/opt/dbtv',state)).services['dabiao-tv'];
  assert.deepEqual(value.ports,['127.0.0.1:9911:8787']);assert.deepEqual(value.volumes,['/opt/dbtv/data:/app/data']);assert.equal(value.environment.PORT,'8787');
});
test('systemd uses scalar working directory, quoted command arguments and escaped specifiers',()=>{
  const value=systemdUnit('/opt/test %n',{source:'/opt/test %n/app',node:'/opt/test %n/node'});
  assert.match(value,/User=dabiaotv/);assert.match(value,/%\%n/);assert.match(value,/NoNewPrivileges=true/);assert.match(value,/UMask=0077/);
  assert.match(value,/^WorkingDirectory=\/opt\/test %%n\/app$/m);
  assert.match(value,/^ExecStart="\/opt\/test %%n\/node" "\/opt\/test %%n\/app\/scripts\/tv\.mjs" serve --home "\/opt\/test %%n"$/m);
  for(const source of ['relative/path','/tmp/injected\nUser=root','/tmp/carriage\rreturn','/tmp/tab\tpath'])assert.throws(()=>systemdUnit('/opt/test',{source,node:'/usr/bin/node'}),/绝对路径/);
});
test('health does not equate process/HTTP status with database health',async()=>{
  const state={port:8787};
  const values=[{ok:true,service:'other'},{ok:true,service:'web-tvbox'}];
  let checks=0;const fetcher=async()=>({ok:true,json:async()=>values[checks++]});
  assert.deepEqual(await health(state,{fetcher}),{http:false,database:'unknown',installed:null});
  checks=1;values.push({installed:true,database:{connected:false}});
  assert.deepEqual(await health(state,{fetcher}),{http:true,database:'unavailable',installed:true});
});
test('redacts installer token and SQL credentials',()=>{
  const text=redact('首次安装令牌：private-token\npostgresql://admin:secret@server/db\nAuthorization=private-key');
  for(const secret of ['private-token','admin:secret','private-key'])assert.ok(!text.includes(secret));
});
test('privileged backup copy refuses symlinks, hardlinks and preexisting destinations',t=>{
  const dir=temporary(t),source=path.join(dir,'data'),target=path.join(dir,'backup');fs.writeFileSync(source,'snapshot');
  secureCopy(source,target);assert.equal(fs.readFileSync(target,'utf8'),'snapshot');assert.equal(fs.statSync(target).mode&0o777,0o600);assert.throws(()=>secureCopy(source,target));
  fs.symlinkSync(source,path.join(dir,'symlink'));assert.throws(()=>secureCopy(path.join(dir,'symlink'),path.join(dir,'bad-copy')));
  fs.linkSync(source,path.join(dir,'hardlink'));assert.throws(()=>secureCopy(source,path.join(dir,'bad-hard-copy')));
});
const catalog=name=>JSON.stringify({version:1,sources:[{id:'fixture',name:'Fixture',playlistUrl:'https://example.org/list.m3u',metadataUrl:null}],autoUpdate:false,lastUpdatedAt:null,channels:[{id:'a'.repeat(32),name,country:'CN',categories:['general'],cover:null,lines:[{url:'https://example.org/live.m3u8?token=private-fixture',name:'Primary',restricted:false}],enabled:true,available:true}]});
function liveFixture(t){const home=temporary(t),data=path.join(home,'data'),backup=path.join(home,'backup');fs.mkdirSync(data,{mode:0o700});fs.mkdirSync(backup,{mode:0o700});return {data,backup,file:path.join(data,'live-tv.json')};}
const backupRecord=(backup,liveTv)=>fs.writeFileSync(path.join(backup,'backup.json'),JSON.stringify({version:1,id:'dbtv',complete:true,liveTv}),{mode:0o600});
test('absent live catalog has an explicit snapshot and failed rollback retains then removes a newly created file',t=>{
  const {data,backup,file}=liveFixture(t),liveTv=backupLiveCatalog(data,backup);
  assert.deepEqual(liveTv,{present:false});backupRecord(backup,liveTv);
  fs.writeFileSync(file,catalog('Created later'),{mode:0o600});
  assert.deepEqual(restoreLiveCatalog(data,backup),{restored:true});
  assert.equal(fs.existsSync(file),false);
  const retained=fs.readdirSync(backup).filter(name=>name.startsWith('live-tv-before-restore-'));
  assert.equal(retained.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(backup,retained[0]),'utf8')).channels[0].name,'Created later');
  assert.equal(fs.statSync(path.join(backup,retained[0])).mode&0o777,0o600);
  assert.deepEqual(restoreLiveCatalog(data,backup),{restored:false});
});
test('private live catalog snapshot restores atomically and retains the failed version privately',t=>{
  const {data,backup,file}=liveFixture(t),original=catalog('Original'),changed=catalog('Changed after launch');
  fs.writeFileSync(file,original,{mode:0o600});const liveTv=backupLiveCatalog(data,backup);backupRecord(backup,liveTv);
  assert.equal(liveTv.present,true);assert.match(liveTv.sha256,/^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(backup,'live-tv.json'),'utf8'),original);
  assert.equal(fs.statSync(path.join(backup,'live-tv.json')).mode&0o777,0o600);
  assert.ok(!fs.readFileSync(path.join(backup,'backup.json'),'utf8').includes('private-fixture'));
  fs.writeFileSync(file,changed,{mode:0o600});
  assert.deepEqual(restoreLiveCatalog(data,backup),{restored:true});
  assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(fs.statSync(file).uid,fs.statSync(data).uid);
  const retained=fs.readdirSync(backup).filter(name=>name.startsWith('live-tv-before-restore-'));
  assert.equal(retained.length,1);assert.equal(fs.readFileSync(path.join(backup,retained[0]),'utf8'),changed);
  assert.equal(fs.statSync(path.join(backup,retained[0])).mode&0o777,0o600);
  assert.ok(!fs.readdirSync(data).some(name=>name.startsWith('.live-tv-restore-')));
  assert.deepEqual(restoreLiveCatalog(data,backup),{restored:false});
});
test('damaged, public, linked or tampered live catalogs never become a complete backup or overwrite current data',t=>{
  const {data,backup,file}=liveFixture(t);
  for(const invalid of ['{broken',JSON.stringify({version:1,sources:[{}],channels:[{id:'bad'}],autoUpdate:false,lastUpdatedAt:null})]){
    fs.writeFileSync(file,invalid,{mode:0o600});assert.throws(()=>backupLiveCatalog(data,backup),error=>/直播 JSON/.test(error.message)&&!error.message.includes('private-fixture'));
    assert.equal(fs.existsSync(path.join(backup,'live-tv.json')),false);
  }
  fs.truncateSync(file,30*1024*1024+1);assert.throws(()=>backupLiveCatalog(data,backup),/直播 JSON/);
  fs.writeFileSync(file,catalog('Original'),{mode:0o600});fs.chmodSync(file,0o644);assert.throws(()=>backupLiveCatalog(data,backup),/直播 JSON/);
  fs.chmodSync(file,0o600);const linked=path.join(data,'linked');fs.linkSync(file,linked);assert.throws(()=>backupLiveCatalog(data,backup),/直播 JSON/);fs.unlinkSync(linked);
  fs.unlinkSync(file);fs.symlinkSync(path.join(data,'missing'),file);assert.throws(()=>backupLiveCatalog(data,backup),/直播 JSON/);fs.unlinkSync(file);
  fs.writeFileSync(file,catalog('Original'),{mode:0o600});
  fs.chmodSync(backup,0o755);assert.throws(()=>backupLiveCatalog(data,backup),/直播 JSON/);fs.chmodSync(backup,0o700);
  fs.writeFileSync(file,catalog('Original'),{mode:0o600});const liveTv=backupLiveCatalog(data,backup);backupRecord(backup,liveTv);
  fs.writeFileSync(file,catalog('Current'),{mode:0o600});
  fs.chmodSync(path.join(backup,'live-tv.json'),0o644);assert.throws(()=>restoreLiveCatalog(data,backup),/直播 JSON/);
  fs.chmodSync(path.join(backup,'live-tv.json'),0o600);
  fs.writeFileSync(path.join(backup,'live-tv.json'),catalog('Tampered'));
  assert.throws(()=>restoreLiveCatalog(data,backup),/直播 JSON/);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).channels[0].name,'Current');
  assert.ok(!fs.readdirSync(data).some(name=>name.startsWith('.live-tv-restore-')));
});
test('managed backup CLI includes private live JSON, records absence and refuses damaged input',async t=>{
  const {home,env}=fixture(t,{running:true}),data=path.join(home,'data'),file=path.join(data,'live-tv.json');
  fs.mkdirSync(data,{mode:0o700});fs.writeFileSync(file,catalog('Private channel'),{mode:0o600});
  const first=await run(['backup','--home',home,'--json'],env);
  assert.equal(first.code,0,first.stderr);const firstPath=JSON.parse(first.stdout).path;
  const firstRecord=JSON.parse(fs.readFileSync(path.join(firstPath,'backup.json'),'utf8'));
  assert.equal(firstRecord.complete,true);assert.equal(firstRecord.liveTv.present,true);
  assert.equal(fs.readFileSync(path.join(firstPath,'live-tv.json'),'utf8'),fs.readFileSync(file,'utf8'));
  assert.equal(fs.statSync(path.join(firstPath,'live-tv.json')).mode&0o777,0o600);
  assert.ok(!first.stdout.includes('private-fixture'));assert.ok(!JSON.stringify(firstRecord).includes('private-fixture'));
  fs.unlinkSync(file);
  const absent=await run(['backup','--home',home,'--json'],env);assert.equal(absent.code,0,absent.stderr);
  const absentPath=JSON.parse(absent.stdout).path;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(absentPath,'backup.json'),'utf8')).liveTv,{present:false});
  assert.equal(fs.existsSync(path.join(absentPath,'live-tv.json')),false);
  fs.writeFileSync(file,'{broken',{mode:0o600});
  const broken=await run(['backup','--home',home,'--json'],env);
  assert.equal(broken.code,1);assert.ok(!broken.stdout.includes('private-fixture'));
  const folders=fs.readdirSync(path.join(home,'backups')).map(name=>path.join(home,'backups',name));
  assert.equal(folders.filter(folder=>fs.existsSync(path.join(folder,'backup.json'))).length,2);
});
test('dry-run is machine readable and creates no installation files',async t=>{
  const home=path.join(temporary(t),'not-created');const result=await run(['install','--dry-run','--home',home,'--port','39147','--json']);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).dryRun,true);assert.equal(fs.existsSync(home),false);
});
test('explicit occupied port exits 2, creates no service or state',async t=>{
  const port=await listening(t),home=path.join(temporary(t),'not-created');const result=await run(['install','--dry-run','--home',home,'--port',String(port),'--json']);
  assert.equal(result.code,2);assert.equal(JSON.parse(result.stdout).code,'PORT_IN_USE');assert.equal(fs.existsSync(home),false);assert.equal(await available(port),false);
});
test('noninteractive installation never silently picks a port',async t=>{
  const home=path.join(temporary(t),'not-created');const result=await run(['install','--dry-run','--home',home,'--yes','--json']);
  assert.equal(result.code,1);assert.equal(fs.existsSync(home),false);
});
test('interactive preselected port is checked without asking for it twice',async()=>{
  let calls=0;const port=await choosePort({initial:39149,ask:async()=>{calls++;return '';}});
  assert.equal(port,39149);assert.equal(calls,0);
});
test('same-port operation still produces JSON without restarting the service',async t=>{
  const {home,state,env,fake}=fixture(t);const result=await run(['port','--home',home,'--port',String(state.port),'--yes','--json'],env);
  assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).port,state.port);assert.equal(JSON.parse(fs.readFileSync(fake)).running,false);
});
test('stop provides JSON acknowledgment and affects only its application',async t=>{
  const {home,env,fake}=fixture(t,{running:true});const result=await run(['stop','--home',home,'--json'],env);
  assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).ok,true);assert.equal(JSON.parse(fs.readFileSync(fake)).running,false);
});
test('bootstrap help and invalid port require no root or package installation',async()=>{
  const help=await exec('bash',[path.join(root,'scripts/install.sh'),'--help']);assert.match(help.stdout,/8787/);
  await assert.rejects(exec('bash',[path.join(root,'scripts/install.sh'),'--yes']),error=>/--port/.test(error.stderr));
  await assert.rejects(exec('bash',[path.join(root,'scripts/install.sh'),'--port','80']),error=>/1024/.test(error.stderr));
});
test('adapter status has stable JSON, health and domain verification are separate',async t=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/health'?{ok:true,service:'web-tvbox'}:{installed:true,database:{connected:true}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {home,env}=fixture(t,{port:server.address().port,running:true});const result=await run(['status','--home',home,'--json'],env);
  assert.equal(result.code,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.healthy,true);assert.equal(value.domainVerified,false);assert.equal(value.publicIP,null);
});
test('stopped app status is exit 3 rather than false success',async t=>{
  const {home,env}=fixture(t);const result=await run(['status','--home',home,'--json'],env);assert.equal(result.code,3);assert.equal(JSON.parse(result.stdout).running,false);
});
test('port change persists without changing database location or unrelated files',async t=>{
  const {home,env}=fixture(t);const sentinel=path.join(home,'keep.db');fs.writeFileSync(sentinel,'do-not-touch');
  const result=await run(['port','--home',home,'--port','39148','--yes','--json'],env);
  assert.equal(result.code,0,result.stderr);assert.equal(read(home).port,39148);assert.equal(fs.readFileSync(sentinel,'utf8'),'do-not-touch');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'compose.json'))).services['dabiao-tv'].ports[0],'127.0.0.1:39148:8787');
});
test('busy port change fails before stopping the currently running app',async t=>{
  const {home,state,env,fake}=fixture(t,{running:true}),port=await listening(t);
  const result=await run(['port','--home',home,'--port',String(port),'--yes','--json'],env);
  assert.equal(result.code,2);assert.equal(read(home).port,state.port);assert.equal(JSON.parse(fs.readFileSync(fake)).running,true);
});
test('failed configuration restart rolls back origin and restarts original service',async t=>{
  const {home,state,env,fake}=fixture(t,{running:true});
  const result=await run(['domain','--home',home,'--origin','https://fail.example','--yes','--json'],{...env,DBTV_TEST_FAIL_ORIGIN:'https://fail.example'});
  assert.equal(result.code,1);assert.equal(read(home).origin,state.origin);assert.equal(JSON.parse(fs.readFileSync(fake)).running,true);assert.match(JSON.parse(result.stdout).error,/恢复原配置/);
});
test('duplicate installation preserves original settings and does not rebuild',async t=>{
  const {home,state,env}=fixture(t);const result=await run(['install','--home',home,'--port','39999','--yes','--json'],env);
  assert.equal(result.code,0,result.stderr);assert.deepEqual(read(home),state);
});
test('concurrent operations refuse the lock rather than deleting it',async t=>{
  const {home,env}=fixture(t);fs.writeFileSync(path.join(home,'operation.lock'),'other-operation');
  const result=await run(['stop','--home',home,'--json'],env);assert.equal(result.code,1);assert.equal(fs.readFileSync(path.join(home,'operation.lock'),'utf8'),'other-operation');
});
test('CLI logs redact secrets and machine-readable output stays JSON',async t=>{
  const {home,env}=fixture(t);const result=await run(['logs','--home',home,'--json'],env);assert.equal(result.code,0);const value=JSON.parse(result.stdout);assert.ok(!value.logs.includes('not-for-public-logs'));assert.ok(!value.logs.includes('private-password'));
});
test('public source copy omits databases, credentials, generated output and symlinks',async t=>{
  const dir=temporary(t),source=path.join(dir,'source'),destination=path.join(dir,'home/app');fs.mkdirSync(path.join(source,'prisma'),{recursive:true});
  fs.writeFileSync(path.join(source,'package.json'),'{}');fs.writeFileSync(path.join(source,'.env.example'),'public');fs.writeFileSync(path.join(source,'.env'),'secret');
  fs.writeFileSync(path.join(source,'prisma/dev.db'),'private');fs.writeFileSync(path.join(source,'prisma/schema.prisma'),'schema');
  fs.symlinkSync(path.join(source,'.env'),path.join(source,'prisma/linked-secret'));
  fs.mkdirSync(path.join(source,'deploy'));fs.writeFileSync(path.join(source,'deploy/update-public.pem'),'public-key');fs.writeFileSync(path.join(source,'deploy/private.key'),'private-key');
  const result=await exec(process.execPath,[path.join(root,'scripts/tv/copy-source.mjs'),source,destination]);assert.equal(result.stderr,'');
  assert.equal(fs.existsSync(path.join(destination,'.env')),false);assert.equal(fs.existsSync(path.join(destination,'prisma/dev.db')),false);assert.equal(fs.existsSync(path.join(destination,'prisma/linked-secret')),false);assert.equal(fs.readFileSync(path.join(destination,'.env.example'),'utf8'),'public');
  assert.equal(fs.readFileSync(path.join(destination,'deploy/update-public.pem'),'utf8'),'public-key');assert.equal(fs.existsSync(path.join(destination,'deploy/private.key')),false);
});

test('EOF answer is a controlled cancellation, never a trim TypeError',async()=>{
  for(const answer of [null,undefined])await assert.rejects(choosePort({ask:async()=>answer}),error=>error.code==='INPUT_CLOSED');
});
test('readline EOF cancels an outstanding question and removes close listener',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const rl=createInterface({input,output});
  const pending=question(rl,'Port: ');
  input.end();
  await assert.rejects(pending,error=>error.code==='INPUT_CLOSED');
  assert.equal(rl.listenerCount('close'),0);
  await assert.rejects(question(rl,'Again: '),error=>error.code==='INPUT_CLOSED');
});
test('exhausted port range terminates instead of asking forever',async t=>{
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(65535,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  let asks=0;
  await assert.rejects(choosePort({defaultPort:65535,host:'127.0.0.1',ask:async()=>{asks++;return '';}}),error=>error.code==='NO_AVAILABLE_PORT');
  assert.equal(asks,1);
  await assert.rejects(choosePort({value:65535,host:'127.0.0.1'}),error=>error.code==='PORT_IN_USE');
});
test('Linux bind probe does not depend on intercepted outbound TCP or interface enumeration',async t=>{
  if(process.platform!=='linux'){t.skip('Linux exclusive bind semantics');return;}
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  t.mock.method(net,'connect',()=>{throw Error('outbound TCP must not be used');});
  t.mock.method(os,'networkInterfaces',()=>{throw Error('restricted network interfaces');});
  assert.equal(await available(port),true);
});

test('status keeps loopback URL when interface enumeration is restricted',t=>{
  t.mock.method(os,'networkInterfaces',()=>{throw Error('restricted');});
  assert.deepEqual(addresses({port:8787,bind:'0.0.0.0',origin:''}),{local:'http://127.0.0.1:8787',lan:[],domain:null,publicIP:null});
});
