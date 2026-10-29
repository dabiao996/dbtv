import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const script=fileURLToPath(new URL('./copy-source.mjs',import.meta.url));
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-copy-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),app=path.join(root,'app');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'package.json'),'{}');
  return {root,source,app};
}
test('fresh managed source includes tvbox config but excludes private files',t=>{
  const {source,app}=fixture(t),config=JSON.stringify({sites:[{key:'fixture',name:'Fixture',api:'https://example.invalid/api'}]});
  fs.writeFileSync(path.join(source,'tvbox.json'),config);
  fs.writeFileSync(path.join(source,'.env'),'private');fs.mkdirSync(path.join(source,'data'));fs.writeFileSync(path.join(source,'data','setup-token'),'private');
  execFileSync(process.execPath,[script,source,app]);
  assert.equal(fs.readFileSync(path.join(app,'tvbox.json'),'utf8'),config);
  assert.equal(fs.statSync(path.join(app,'tvbox.json')).mode&0o444,0o444);
  assert.ok(!fs.existsSync(path.join(app,'.env')));assert.ok(!fs.existsSync(path.join(app,'data')));
  fs.writeFileSync(path.join(app,'tvbox.json'),'custom existing config');
  execFileSync(process.execPath,[script,source,app],{stdio:'pipe'});
  assert.equal(fs.readFileSync(path.join(app,'tvbox.json'),'utf8'),'custom existing config');
});
test('source tvbox symlink is not copied',t=>{
  const {root,source,app}=fixture(t);fs.writeFileSync(path.join(root,'private'),'secret');
  fs.symlinkSync(path.join(root,'private'),path.join(source,'tvbox.json'));
  execFileSync(process.execPath,[script,source,app]);
  assert.ok(!fs.existsSync(path.join(app,'tvbox.json')));
});
test('Docker runtime stage includes the same tvbox configuration',()=>{
  // Docker is optional locally; clean native build and archive tests validate
  // the actual file. This assertion guards the runtime-stage COPY separately.
  const dockerfile=fs.readFileSync(new URL('../../Dockerfile',import.meta.url),'utf8');
  const runtime=dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.match(runtime,/^COPY --from=build \/app\/tvbox\.json \.\/tvbox\.json$/m);
});
