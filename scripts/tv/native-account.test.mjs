import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {planNativeAccount,createNativeAccount,verifyNativeAccount,reservedNativeIds} from './native-account.mjs';
import {nativeServiceUser,systemdUnit,read,save} from './core.mjs';
function backend(){
  const calls=[],passwd=new Map(),groups=new Map();
  const run=(command,args)=>{calls.push([command,args]);
    if(command==='getent'){const map=args[0]==='passwd'?passwd:groups,value=map.get(String(args[1]));return {status:value?0:2,stdout:value||''};}
    if(command==='groupadd'){const user=args.at(-1),gid=args[args.indexOf('--gid')+1],row=`${user}:x:${gid}:`;groups.set(user,row);groups.set(gid,row);return {status:0};}
    if(command==='useradd'){const user=args.at(-1),uid=args[args.indexOf('--uid')+1],gid=args[args.indexOf('--gid')+1],row=`${user}:x:${uid}:${gid}::/opt/dbtv-test:/usr/sbin/nologin`;passwd.set(user,row);passwd.set(uid,row);return {status:0};}
    throw Error('unexpected system mutation '+command);
  };return {calls,run,passwd,groups};
}
const empty=()=>({ids:new Set([0,999]),ranges:[]});
test('new native install never reuses existing users, root or groups',()=>{
  for(const kind of ['passwd','groups']){const b=backend();b[kind].set('dabiaotv',kind==='passwd'?'dabiaotv:x:999:999::/opt/dabiao-tv:/usr/sbin/nologin':'dabiaotv:x:999:');assert.throws(()=>planNativeAccount({user:'dabiaotv',home:'/opt/dabiao-tv',run:b.run,scan:empty}),/拒绝复用/);assert.ok(b.calls.every(([command])=>command==='getent'));}
  for(const user of ['root','Root','a\nUser=root','-r','','a/b','x'.repeat(32)])assert.throws(()=>nativeServiceUser({serviceUser:user}));
  assert.equal(nativeServiceUser({}),'dabiaotv');assert.equal(nativeServiceUser({serviceUser:'dbtv-app'}),'dbtv-app');
});
test('allocation skips host process IDs, mapped ranges and numeric NSS conflicts',()=>{
  const b=backend();b.groups.set('60003','another:x:60003:');
  const plan=planNativeAccount({user:'dbtv-app',home:'/opt/dabiao-tv',run:b.run,scan:()=>({ids:new Set([999,60000]),ranges:[[60001,60003]]})});
  assert.deepEqual(plan,{user:'dbtv-app',home:'/opt/dabiao-tv',uid:60004,gid:60004});
  assert.throws(()=>planNativeAccount({user:'dbtv-app',home:'/opt/dabiao-tv',run:b.run,scan:()=>({ids:new Set(),ranges:[[0,100000]]})}),/没有可验证/);
  assert.throws(()=>planNativeAccount({user:'dbtv-app',home:'/opt/dabiao-tv',run:()=>({status:3}),scan:empty}),/无法可靠/);
});
test('creation uses explicit fresh IDs, never modifies or kills other users, and refuses races',()=>{
  const b=backend(),plan=planNativeAccount({user:'dbtv-app',home:'/opt/dabiao-tv',run:b.run,scan:empty});
  createNativeAccount(plan,{run:b.run,scan:empty});
  assert.deepEqual(b.calls.filter(([cmd])=>cmd!=='getent').map(([cmd])=>cmd),['groupadd','useradd']);
  assert.ok(b.calls.find(([cmd])=>cmd==='useradd')[1].includes('--no-create-home'));
  verifyNativeAccount({mode:'native',serviceUser:plan.user,serviceUid:plan.uid,serviceGid:plan.gid},{run:b.run});
  b.passwd.set(plan.user,`${plan.user}:x:999:999::/:/bin/sh`);
  assert.throws(()=>verifyNativeAccount({mode:'native',serviceUser:plan.user,serviceUid:plan.uid,serviceGid:plan.gid},{run:b.run}),/发生变化/);
  const other=backend();assert.throws(()=>createNativeAccount(plan,{run:other.run,scan:()=>({ids:new Set([60000]),ranges:[]})}),/状态变化/);assert.ok(other.calls.every(([cmd])=>cmd==='getent'));
});
test('post-create process collision and command failure stop without destructive rollback',()=>{
  const b=backend(),plan={user:'dbtv-app',home:'/opt/dabiao-tv',uid:60000,gid:60000};let scans=0;
  assert.throws(()=>createNativeAccount(plan,{run:b.run,scan:()=>({ids:new Set(++scans>1?[60000]:[]),ranges:[]})}),/冲突/);
  assert.ok(b.calls.every(([cmd])=>!['usermod','userdel','groupdel','kill','chown'].includes(cmd)));
  const broken=backend();assert.throws(()=>createNativeAccount(plan,{run:(cmd,args)=>cmd==='useradd'?{status:1}:broken.run(cmd,args),scan:empty}),/创建未完成/);
});
test('proc reservation includes thread fs IDs, supplementary groups, subordinate and namespace mappings',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [pid,ns,map] of [['1','user:[1]','0 0 4294967295'],['2','user:[2]','0 62000 1000']]){
    fs.mkdirSync(path.join(root,pid,'ns'),{recursive:true});fs.symlinkSync(ns,path.join(root,pid,'ns/user'));
    for(const kind of ['uid_map','gid_map'])fs.writeFileSync(path.join(root,pid,kind),map);
    fs.mkdirSync(path.join(root,pid,'task',pid),{recursive:true});fs.writeFileSync(path.join(root,pid,'task',pid,'status'),'Uid:\t999 999 1001 60000\nGid:\t999 999 999 60001\nGroups:\t60002 60003\n');
  }
  const sub=path.join(root,'subuid');fs.writeFileSync(sub,'container:63000:1000\n');
  const reserved=reservedNativeIds({procRoot:root,subidFiles:[sub]});for(const id of [999,1001,60000,60001,60002,60003])assert.ok(reserved.ids.has(id));assert.deepEqual(reserved.ranges,[[63000,64000],[62000,63000],[62000,63000]]);
  fs.writeFileSync(path.join(root,'1/uid_map'),'0 100000 65536');assert.throws(()=>reservedNativeIds({procRoot:root,subidFiles:[]}),/初始用户命名空间/);
});
test('custom identity persists in state and actual systemd verification; old state stays compatible',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-identity-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state={version:1,id:'dbtv',mode:'native',source:root,node:process.execPath,bind:'127.0.0.1',port:8787,origin:'',serviceUser:'dbtv-app',serviceUid:60000,serviceGid:60000};
  save(root,state);assert.deepEqual(read(root),state);const unit=systemdUnit(root,state);assert.match(unit,/\nUser=dbtv-app\n/);assert.ok(!unit.includes('User=dabiaotv'));
  fs.mkdirSync(path.join(root,'runtime'),{mode:0o700});fs.writeFileSync(path.join(root,'app.service'),unit);
  const result=spawnSync('systemd-analyze',['--user','verify',path.join(root,'app.service')],{encoding:'utf8',env:{...process.env,XDG_RUNTIME_DIR:path.join(root,'runtime')}});
  if(result.error?.code==='ENOENT')t.skip('systemd-analyze unavailable');else assert.equal(result.status,0,result.stderr);
});
test('independent update controller includes every imported management module',()=>{
  const script=fs.readFileSync(new URL('../tv.mjs',import.meta.url),'utf8');assert.match(script,/\['core\.mjs','updates\.mjs','update-driver\.mjs','build\.mjs','native-account\.mjs'\]/);
});
