import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {save,validateManagementHome} from './core.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-service-home-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const state={version:1,id:'dbtv',mode:'native',source:path.join(home,'app'),node:path.join(home,'tools/node/bin/node'),port:8787,bind:'127.0.0.1',origin:''};
  fs.mkdirSync(state.source,{recursive:true});fs.writeFileSync(path.join(state.source,'.dbtv-source'),'managed source copy\n');
  fs.mkdirSync(path.join(home,'data'),{mode:0o700});save(path.join(home,'data'),state);
  const options={command:'serve',entry:path.join(state.source,'scripts/tv.mjs'),termux:false,userHome:home,uid:1000};
  return {home,state,options,check:(overrides={})=>validateManagementHome(home,{...options,...overrides})};
}

test('a non-root native service may use its dedicated HOME and managed release sources',t=>{
  const f=fixture(t);assert.deepEqual(f.check(),f.state);
  const release={...f.state,source:path.join(f.home,'releases','v1.2.3','app')};
  save(path.join(f.home,'data'),release);
  assert.deepEqual(f.check(),release,'stable app controller may start the selected release');
  assert.deepEqual(f.check({entry:path.join(release.source,'scripts/tv.mjs')}),release);
});

test('the service HOME exception never permits installation or management of an entire user home',t=>{
  const f=fixture(t);
  for(const command of ['install','start','stop','restart','status','port','domain','backup','logs','doctor','update','rollback','menu']){
    assert.throws(()=>f.check({command}),undefined,command);
  }
  assert.throws(()=>f.check({uid:0}),'root must not receive the service exception');
  assert.throws(()=>f.check({termux:true}),'Termux must not receive the native service exception');
});

test('service HOME exception requires a private deployment config and managed source marker',t=>{
  const f=fixture(t),file=path.join(f.home,'data/deployment.json');
  fs.unlinkSync(file);assert.throws(()=>f.check());
  save(path.join(f.home,'data'),f.state);fs.chmodSync(file,0o644);assert.throws(()=>f.check());
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'{broken');assert.throws(()=>f.check());
  fs.unlinkSync(file);const other=path.join(f.home,'other.json');fs.writeFileSync(other,JSON.stringify(f.state),{mode:0o600});fs.symlinkSync(other,file);assert.throws(()=>f.check());
  fs.unlinkSync(file);save(path.join(f.home,'data'),f.state);
  const marker=path.join(f.state.source,'.dbtv-source');
  fs.unlinkSync(marker);assert.throws(()=>f.check());
  fs.writeFileSync(marker,'not a managed source');assert.throws(()=>f.check());
  fs.unlinkSync(marker);fs.symlinkSync(other,marker);assert.throws(()=>f.check());
  fs.unlinkSync(marker);fs.writeFileSync(marker,'managed source copy\n');
  const data=path.join(f.home,'data'),moved=path.join(f.home,'moved-data');
  fs.renameSync(data,moved);fs.symlinkSync(moved,data);assert.throws(()=>f.check());
});

test('service HOME exception rejects other runtimes, external paths and untrusted entrypoints',t=>{
  const f=fixture(t);
  for(const patch of [{mode:'docker'},{mode:'termux'},{node:process.execPath},{source:'/tmp/external-app'},
    {source:path.join(f.home,'releases-other/app')},{source:path.join(f.home,'releases/../outside')},
    {source:path.join(f.home,'releases')}]){
    save(path.join(f.home,'data'),{...f.state,...patch});assert.throws(()=>f.check(),undefined,JSON.stringify(patch));
  }
  save(path.join(f.home,'data'),f.state);
  assert.throws(()=>f.check({entry:'/tmp/untrusted/scripts/tv.mjs'}));
});

test('system roots and the source checkout remain forbidden even for serve',t=>{
  const f=fixture(t);
  for(const home of ['/','/opt','/usr','/var','/var/lib','/home','/root','/tmp']){
    assert.throws(()=>validateManagementHome(home,{...f.options,userHome:home}));
  }
  fs.writeFileSync(path.join(f.home,'package.json'),'{}');
  assert.throws(()=>f.check({entry:path.join(f.home,'scripts/tv.mjs')}));
  assert.equal(validateManagementHome(f.home,{...f.options,userHome:path.join(f.home,'different-user'),command:'install'}),undefined);
});

test('actual serve subprocess works when systemd sets HOME to the managed directory',t=>{
  if(process.platform==='win32'){t.skip('native service regression requires POSIX HOME and executable symlinks');return;}
  const f=fixture(t);
  fs.cpSync(path.join(root,'scripts'),path.join(f.state.source,'scripts'),{recursive:true});
  fs.mkdirSync(path.dirname(f.state.node),{recursive:true});fs.symlinkSync(process.execPath,f.state.node);
  const npm=path.join(f.home,'tools/node/lib/node_modules/npm/bin/npm-cli.js');fs.mkdirSync(path.dirname(npm),{recursive:true});
  fs.writeFileSync(npm,`if(process.argv[2]!=='start'||process.env.NODE_ENV!=='production'||process.env.HOME!==${JSON.stringify(f.home)}||process.env.DBTV_DATA_DIR!==${JSON.stringify(path.join(f.home,'data'))}||process.cwd()!==${JSON.stringify(f.state.source)})process.exit(17);console.log('managed-service-fixture-started');\n`);
  const env={...process.env,HOME:f.home};delete env.PREFIX;delete env.NODE_OPTIONS;
  // Root CI can exercise the same non-root branch without changing any account
  // or system service. Only this disposable fixture receives the nobody UID.
  const identity=process.getuid?.()===0?{uid:65534,gid:65534}:{};
  if(identity.uid!==undefined){
    const own=file=>{fs.lchownSync(file,identity.uid,identity.gid);if(fs.lstatSync(file).isDirectory())for(const child of fs.readdirSync(file))own(path.join(file,child));};own(f.home);
  }
  const result=spawnSync(f.state.node,[f.options.entry,'serve','--home',f.home],{env,encoding:'utf8',timeout:15000,...identity});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/managed-service-fixture-started/);
  assert.equal(fs.existsSync(path.join(f.home,'data/dabiao.db')),false,'fake npm never starts or migrates a database');
  for(const command of ['install','status']){
    const denied=spawnSync(f.state.node,[f.options.entry,command,'--home',f.home,'--yes'],{env,encoding:'utf8',timeout:15000,...identity});
    assert.ifError(denied.error);assert.equal(denied.status,1,denied.stdout+denied.stderr);
    assert.doesNotMatch(denied.stdout,/managed-service-fixture-started/);
  }
});
