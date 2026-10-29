import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {systemdUnit} from './core.mjs';

const quote=value=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')}"`;
const line=(unit,key)=>unit.split('\n').find(value=>value.startsWith(`${key}=`));

test('WorkingDirectory uses an unquoted absolute path while ExecStart quotes each argument',()=>{
  for(const home of ['/opt/dabiao-tv','/opt/test space %n']){
    const state={source:path.join(home,'app'),node:path.join(home,'tools/node/bin/node')};
    const unit=systemdUnit(home,state);
    assert.equal(line(unit,'WorkingDirectory'),`WorkingDirectory=${state.source.replaceAll('%','%%')}`);
    assert.equal(line(unit,'ExecStart'),`ExecStart=${quote(state.node)} ${quote(path.join(state.source,'scripts/tv.mjs'))} serve --home ${quote(home)}`);
  }
});

test('real systemd parser rejects the old quoted WorkingDirectory and accepts generated units',t=>{
  const available=spawnSync('systemd-analyze',['--version'],{encoding:'utf8'});
  if(available.error?.code==='ENOENT'){
    t.skip('systemd-analyze is not installed on this platform; string-level generator tests still run');return;
  }
  assert.ifError(available.error);
  assert.equal(available.status,0,available.stderr);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-systemd-verify-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const runtime=path.join(temporary,'runtime');fs.mkdirSync(runtime,{mode:0o700});
  // Verification parses only fixture unit arguments; it never starts a manager,
  // installs a service, invokes systemctl, or executes the unit's ExecStart.
  const env={...process.env,XDG_RUNTIME_DIR:runtime,LC_ALL:'C',SYSTEMD_COLORS:'0'};
  delete env.SYSTEMD_UNIT_PATH;
  delete env.SYSTEMD_LOG_LEVEL;
  const verify=file=>spawnSync('systemd-analyze',['--user','verify',file],{env,encoding:'utf8',timeout:30000});
  for(const [name,home] of [['default','/opt/dabiao-tv'],['space-percent',path.join(temporary,'home space %n')]]){
    const state={source:path.join(home,'app'),node:process.execPath};
    const fixed=systemdUnit(home,state);
    // Deliberately reintroduce the historical generator bug, rather than merely
    // checking that some arbitrary malformed service fails validation.
    const broken=fixed.replace(/^WorkingDirectory=.*$/m,`WorkingDirectory=${quote(state.source)}`);
    const badFile=path.join(temporary,`${name}-broken.service`);
    fs.writeFileSync(badFile,broken);
    const bad=verify(badFile);assert.ifError(bad.error);
    assert.equal(bad.status,1,`historical bug must fail: ${bad.stdout}${bad.stderr}`);
    assert.match(bad.stderr,/WorkingDirectory=.*path is not absolute/);
    // Remove the broken fixture before checking the fixed one, so the parser
    // cannot accidentally load it through another unit's dependency search.
    fs.unlinkSync(badFile);
    const goodFile=path.join(temporary,`${name}-fixed.service`);
    fs.writeFileSync(goodFile,fixed);
    const good=verify(goodFile);assert.ifError(good.error);
    assert.equal(good.status,0,`generated ${name} unit must verify: ${good.stdout}${good.stderr}`);
  }
});
