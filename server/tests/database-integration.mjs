// Run after npm run build: node --test server/tests/database-integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {parseEnv} from 'node:util';
import {updateEnv} from '../../scripts/setup-database.mjs';
import {prepareMemberIdentity} from '../../scripts/prepare-member-identity.mjs';

test('legacy member identity preflight is additive, repeatable and stops on duplicates',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-identity-upgrade-'));
  const {PrismaClient}=await import('@prisma/client');
  const db=new PrismaClient({datasourceUrl:`file:${join(folder,'old.db')}`});
  try{
    await db.$executeRawUnsafe('CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "passwordHash" TEXT, "points" INTEGER)');
    await db.$executeRawUnsafe("INSERT INTO User VALUES (1,'existing_account','unchanged-test-hash',420)");
    await prepareMemberIdentity(db,'sqlite');
    await prepareMemberIdentity(db,'sqlite');
    const [row]=await db.$queryRawUnsafe('SELECT * FROM User');
    assert.deepEqual(row,{id:1,username:'existing_account',passwordHash:'unchanged-test-hash',points:420,memberNo:null});
    await db.$executeRawUnsafe("UPDATE User SET memberNo='DTV-FIXTURE' WHERE id=1");
    await assert.rejects(db.$executeRawUnsafe("INSERT INTO User VALUES (2,'other','test-hash',0,'DTV-FIXTURE')"));
    await db.$executeRawUnsafe('DROP INDEX "User_memberNo_key"');
    await db.$executeRawUnsafe("INSERT INTO User VALUES (2,'other','test-hash',0,'DTV-FIXTURE')");
    await assert.rejects(prepareMemberIdentity(db,'sqlite'),/重复/);
    assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM User'))[0].n,2n);
  }finally{await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});

test('setup preserves unrelated secrets and replaces database fields once',()=>{
  const source='PORT=8787\nTMDB_READ_ACCESS_TOKEN="fixture-only"\nDATABASE_URL="file:./dev.db"\nexport DATABASE_PROVIDER=sqlite\nDATABASE_URL="file:other.db"\n';
  const url='mysql://user:p%40ss%23word@db:3306/dabiao';
  const text=updateEnv(source,'mysql',url), parsed=parseEnv(text);
  assert.equal(parsed.TMDB_READ_ACCESS_TOKEN,'fixture-only');
  assert.equal(parsed.DATABASE_URL,url);assert.equal(parsed.DATABASE_PROVIDER,'mysql');
  assert.equal([...text.matchAll(/^DATABASE_URL=/gm)].length,1);
});

test('fresh SQLite deploy installs once, keeps credentials private and survives a restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-db-choice-test-'));
  const address=createServer();address.listen(0,'127.0.0.1');await once(address,'listening');
  const port=address.address().port;await new Promise(resolve=>address.close(resolve));
  const env={...process.env,DBTV_DATA_DIR:join(folder,'state'),INSTALL_TOKEN:'fixture-install-token-0123456789abcdef',DATABASE_PROVIDER:'sqlite',DATABASE_URL:`file:${join(folder,'fresh.db')}`,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port)};
  let child;
  async function start(){
    child=spawn(process.execPath,['server/dist/index.js'],{env,stdio:'ignore'});
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error('测试服务提前退出');
      try{const response=await fetch(`http://127.0.0.1:${port}/api/install/status`);if(response.ok)return await response.json();}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('测试服务启动超时');
  }
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
  try{
    const result=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const status=await start();
    assert.equal(status.installed,false);assert.equal(status.database.provider,'sqlite');
    assert.equal(status.database.connected,true);assert.equal('url' in status.database,false);
    assert.equal(JSON.stringify(status).includes(folder),false);
    const send=body=>fetch(`http://127.0.0.1:${port}/api/install`,{method:'POST',headers:{'Content-Type':'application/json','X-Install-Token':env.INSTALL_TOKEN},body:JSON.stringify(body)});
    assert.equal((await send({username:'admin',password:'short',confirmPassword:'short'})).status,400);
    const installed=await send({username:'fixture_admin',password:'fixture-password-123',confirmPassword:'fixture-password-123',DATABASE_URL:'mysql://attacker:secret@attacker.invalid/other'});
    assert.equal(installed.status,201);
    const cookie=installed.headers.get('set-cookie').split(';')[0];
    assert.equal((await send({username:'other_admin',password:'fixture-password-123',confirmPassword:'fixture-password-123'})).status,409);
    const settings=await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
    assert.equal(JSON.stringify(settings).includes('DATABASE_URL'),false);
    const favorites=await fetch(`http://127.0.0.1:${port}/api/favorites`,{headers:{Cookie:cookie}});
    assert.equal(favorites.status,200);
    const backupDirectory=join(folder,'backups');
    const backup=spawnSync(process.execPath,['scripts/backup-database.mjs'],{env:{...env,BACKUP_DIR:backupDirectory},encoding:'utf8'});
    assert.equal(backup.status,0,backup.stdout+backup.stderr);
    const backupFile=join(backupDirectory,readdirSync(backupDirectory)[0]);
    assert.equal(statSync(backupFile).mode&0o777,0o600);
    const {PrismaClient}=await import('@prisma/client');
    const snapshot=new PrismaClient({datasourceUrl:`file:${backupFile}`});
    try{assert.equal(await snapshot.user.count(),1);}finally{await snapshot.$disconnect();}
    await stop();
    const restored=await start();assert.equal(restored.installed,true);assert.equal(restored.database.provider,'sqlite');
    assert.equal((await send({username:'admin',password:'fixture-password-123',confirmPassword:'fixture-password-123'})).status,409);
    // The install request cannot change the chosen connector or create another database.
    assert.ok(readFileSync(join(folder,'fresh.db')).length>0);
  }finally{await stop();rmSync(folder,{recursive:true,force:true});}
});
