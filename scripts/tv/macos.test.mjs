import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import database from '../web-database.cjs';
import {save,read,restoreLiveCatalog} from './core.mjs';
import {transition} from './updates.mjs';
import {macAgentFile,macLabel,macPlist,macRunning,macService,registerMacApp,enableMacAgent} from './macos.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const temporary=t=>{const value=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-macos-test-'));t.after(()=>fs.rmSync(value,{recursive:true,force:true}));return value;};
const state=home=>({version:1,id:'dbtv',mode:'macos',source:path.join(home,'app'),node:process.execPath,port:8787,bind:'127.0.0.1',origin:'',release:{version:'1.0.1',channel:'development',dataContract:'a'.repeat(64)}});
const catalog=name=>JSON.stringify({version:1,sources:[{id:'fixture',name:'Fixture',playlistUrl:'https://example.org/list.m3u',metadataUrl:null}],autoUpdate:false,lastUpdatedAt:null,channels:[{id:'a'.repeat(32),name,country:'CN',categories:['general'],cover:null,lines:[{url:'https://example.org/live.m3u8?token=synthetic',name:'Primary',restricted:false}],enabled:true,available:true}]});

test('Mac user agents use separate labels and fixed argv, stay loopback-only and never touch a real LaunchAgent in tests',t=>{
  const home=temporary(t),agentsDirectory=path.join(home,'agents'),selected=state(home),events=[];
  const execute=(command,args,options={})=>{events.push([command,...args]);return {ok:true,text:options.capture?'state = running\n pid = 4242\n':''};};
  assert.notEqual(macLabel(home,'app'),macLabel(home,'updates'));
  assert.throws(()=>macPlist(home,{...selected,bind:'0.0.0.0'},'app','/tmp/app'),/回环/);
  registerMacApp(home,selected,{agentsDirectory});
  const app=macAgentFile(home,'app',agentsDirectory);
  assert.equal(fs.statSync(app).mode&0o777,0o600);
  assert.equal(fs.existsSync(macAgentFile(home,'updates',agentsDirectory)),false);
  assert.ok(macPlist(`${home}/a & <b>`,{...selected,source:`${home}/a & <b>`},'app','/tmp/app').includes('a &amp; &lt;b&gt;'));
  assert.throws(()=>registerMacApp(home,selected,{agentsDirectory}),/拒绝覆盖/);
  macService(home,selected,'start',execute,{agentsDirectory});
  assert.equal(macRunning(home,'app',execute),true);
  macService(home,selected,'stop',execute,{agentsDirectory});
  const manager=path.join(home,'manager','tv.mjs');
  enableMacAgent(home,selected,manager,execute,{agentsDirectory});
  const updater=macAgentFile(home,'updates',agentsDirectory);
  assert.ok(fs.readFileSync(updater,'utf8').includes(manager));
  assert.ok(!fs.readFileSync(updater,'utf8').includes('<key>KeepAlive</key>'));
  assert.deepEqual(events.filter(item=>item[1]==='bootstrap').length,2);
  assert.ok(events.every(item=>item[0]==='launchctl'));
  if(process.platform==='darwin')for(const file of [app,updater])execFileSync('/usr/bin/plutil',['-lint',file]);
  fs.unlinkSync(app);fs.symlinkSync(updater,app);
  assert.throws(()=>macService(home,selected,'start',execute,{agentsDirectory}),/拒绝覆盖/);
});

test('Mac isolated SQLite WAL snapshot and private live JSON survive a failed compatible update', {skip:process.platform!=='darwin'},async t=>{
  const home=temporary(t),data=path.join(home,'data'),live=path.join(data,'live-tv.json'),dbFile=path.join(data,'dabiao.db');
  fs.mkdirSync(data,{mode:0o700});fs.writeFileSync(live,catalog('Before'),{mode:0o600});
  fs.writeFileSync(path.join(home,'app.env'),'fixture only\n',{mode:0o600});
  const selected={...state(home),source:root};save(home,selected);
  assert.equal(read(home).mode,'macos');
  const PrismaClient=database.clientConstructor('sqlite'),db=new PrismaClient({datasourceUrl:`file:${dbFile}`});
  t.after(()=>db.$disconnect());
  await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await db.$executeRawUnsafe('CREATE TABLE marker (value TEXT NOT NULL)');
  await db.$executeRawUnsafe("INSERT INTO marker(value) VALUES ('before')");
  assert.equal(fs.existsSync(`${dbFile}-wal`),true);
  let backupPath;const events=[];
  const next={...selected,release:{...selected.release,version:'1.0.2'}};
  const ops={
    report:async()=>{},stop:async version=>events.push(`stop:${version.release.version}`),
    backup:async()=>{
      events.push('backup');
      const output=execFileSync(process.execPath,[path.join(root,'scripts/tv.mjs'),'backup','--home',home,'--json'],{encoding:'utf8'});
      backupPath=JSON.parse(output).path;return backupPath;
    },
    record:async()=>{},persist:async()=>{},
    start:async version=>{
      events.push(`start:${version.release.version}`);
      if(version.release.version==='1.0.2'){
        await db.$executeRawUnsafe("UPDATE marker SET value='after'");
        fs.writeFileSync(live,catalog('After'),{mode:0o600});
      }
    },
    healthy:async version=>{if(version.release.version==='1.0.2')throw Error('synthetic failed health');},
    restoreLiveCatalog:async folder=>{events.push('restore:live');restoreLiveCatalog(data,folder);}
  };
  const result=await transition({before:selected,next,job:{id:'synthetic'},ops});
  assert.equal(result.state,'rolled-back');
  assert.ok(events.indexOf('backup')<events.indexOf('start:1.0.2'));
  assert.ok(events.indexOf('restore:live')<events.indexOf('start:1.0.1'));
  assert.equal(JSON.parse(fs.readFileSync(live,'utf8')).channels[0].name,'Before');
  assert.equal(fs.statSync(live).mode&0o777,0o600);
  assert.equal((await db.$queryRawUnsafe('SELECT value FROM marker'))[0].value,'after');
  const snapshot=fs.readdirSync(backupPath).find(name=>name.endsWith('.db'));
  const original=new PrismaClient({datasourceUrl:`file:${path.join(backupPath,snapshot)}`});
  try{assert.equal((await original.$queryRawUnsafe('SELECT value FROM marker'))[0].value,'before');}
  finally{await original.$disconnect();}
  assert.equal(fs.statSync(path.join(backupPath,'live-tv.json')).mode&0o777,0o600);
  assert.ok(!fs.readFileSync(path.join(backupPath,'backup.json'),'utf8').includes('synthetic'));
});
