// Opt-in, networked regression test. Never builds in the developer's checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {buildDependencyArgs} from './tv/build.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-production-build-'));
const root=path.join(temporary,'app'),state=path.join(temporary,'private-state');
const env={...process.env};
// A real deployment may export database settings. Do not let this test adopt
// those settings, an external private directory, or Node preload scripts.
for(const key of Object.keys(env))if(/^(?:DBTV_|DATABASE_|DB_|PRISMA_|INSTALL_TOKEN|NODE_OPTIONS)/i.test(key))delete env[key];
Object.assign(env,{
  NODE_ENV:'production',npm_config_omit:'dev',npm_config_cache:path.join(temporary,'npm-cache'),
  DATABASE_PROVIDER:'sqlite',DATABASE_URL:`file:${path.join(state,'unused.db')}`,
  DBTV_DATA_DIR:state,DB_AUTO_SYNC:'false',
});
const npm=process.platform==='win32'?'npm.cmd':'npm';
function run(command,args,cwd=root){
  console.log(`\n[production-build] ${command} ${args.join(' ')}`);
  const result=spawnSync(command,args,{cwd,env,stdio:'inherit',timeout:15*60*1000});
  if(result.error)throw result.error;
  assert.equal(result.status,0,`${command} ${args.join(' ')} failed (${result.signal||result.status})`);
}
function file(relative){assert.ok(fs.statSync(path.join(root,relative)).isFile(),`missing ${relative}`);}
try{
  run(process.execPath,[path.join(source,'scripts/tv/copy-source.mjs'),source,root],temporary);
  for(const relative of ['node_modules','.generated','data','.env','server/dist','client/dist']){
    assert.equal(fs.existsSync(path.join(root,relative)),false,`fixture must not inherit ${relative}`);
  }
  file('tvbox.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'tvbox.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(source,'tvbox.json'),'utf8')));
  run(npm,buildDependencyArgs());
  // Catch a production-only install before any generated artifact can hide it.
  for(const relative of ['node_modules/typescript/bin/tsc','node_modules/vite/bin/vite.js',
    'node_modules/@types/node/index.d.ts','node_modules/@types/express/index.d.ts',
    'node_modules/@types/react/index.d.ts','node_modules/@types/react-dom/index.d.ts'])file(relative);
  run(npm,['run','build']);
  run(npm,['run','lint']);
  file('server/dist/index.js');file('client/dist/index.html');
  assert.ok(fs.readdirSync(path.join(root,'client/dist/assets')).some(name=>name.endsWith('.js')));
  const require=createRequire(path.join(root,'package.json'));
  assert.equal(typeof require('@prisma/client').PrismaClient,'function');
  for(const [directory,provider] of [['node_modules/.prisma/client','sqlite'],
    ...['sqlite','mysql','postgresql'].map(provider=>[`.generated/install-clients/${provider}`,provider])]){
    file(`${directory}/index.js`);file(`${directory}/index.d.ts`);
    assert.match(fs.readFileSync(path.join(root,directory,'schema.prisma'),'utf8'),new RegExp(`datasource db\\s*\\{\\s*provider\\s*=\\s*"${provider}"`));
    assert.equal(typeof require(path.join(root,directory,'index.js')).PrismaClient,'function');
  }
  assert.equal(fs.existsSync(path.join(state,'unused.db')),false,'build must not create or migrate a database');
  assert.equal(fs.existsSync(path.join(state,'database.json')),false,'build must not install a database');
  if(process.argv.includes('--start')){
    const {testManagedStart}=await import('./test-managed-start.mjs');await testManagedStart(root,env);
  }
  console.log('\nProduction clean-build regression passed: dev tools, types, server, Vite and four Prisma clients.');
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}
