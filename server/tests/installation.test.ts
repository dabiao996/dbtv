import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync,writeFileSync,chmodSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {validateDatabaseChoice,probeDatabase} from '../src/installation.js';
const require=createRequire(resolve('package.json')),files=require('./scripts/web-database.cjs');
const current={provider:'sqlite' as const,url:'file:/existing/legacy.db'};

test('web database choice encodes credentials, restricts local paths and validates provider fields',()=>{
  assert.deepEqual(validateDatabaseChoice({provider:'sqlite'},current,'/state'),current);
  assert.equal(validateDatabaseChoice({provider:'sqlite'},{provider:'mysql',url:'mysql://fixture/fixture'},'/state').url,'file:/state/dabiao.db');
  const selected=validateDatabaseChoice({provider:'postgresql',host:'db-service',port:5432,database:'dbtv',username:'fixture@owner',password:'fixture:p@ss/#',ssl:true},current,'/state');
  const url=new URL(selected.url);assert.equal(decodeURIComponent(url.password),'fixture:p@ss/#');assert.equal(url.searchParams.get('sslmode'),'require');assert.equal(url.hostname,'db-service');
  for(const value of [{provider:'sqlite',url:'file:/etc/config'},{provider:'sqlite',path:'../other.db'},{provider:'mssql'},{provider:'mysql',host:'https://bad/',database:'dbtv',username:'name',password:'secret'},{provider:'mysql',host:'localhost',port:70000,database:'dbtv',username:'name',password:'secret'}])assert.throws(()=>validateDatabaseChoice(value,current,'/state'));
});
test('installation configuration is private, create-once, rolled back only by its owner, and never saved to public settings',()=>{
  const root=mkdtempSync(join(tmpdir(),'dbtv-web-choice-'));const env={DBTV_DATA_DIR:join(root,'state')};
  try{
    const id=files.writeChoice({provider:'mysql',url:'mysql://fixture:private-password@db/test'},root,env);
    assert.equal(statSync(files.configFile(root,env)).mode&0o777,0o600);
    assert.equal(files.readChoice(root,env).provider,'mysql');assert.throws(()=>files.writeChoice(current,root,env));
    files.rollbackChoice('not-owner',root,env);assert.equal(files.readChoice(root,env).id,id);
    files.rollbackChoice(id,root,env);assert.equal(files.readChoice(root,env),null);
    assert.deepEqual(readdirSync(env.DBTV_DATA_DIR),[]);
    const token=files.installToken(root,env);assert.match(token,/^[a-f0-9]{64}$/);assert.equal(files.installToken(root,env),token);
    assert.equal(statSync(join(env.DBTV_DATA_DIR,'setup-token')).mode&0o777,0o600);
    const source=readFileSync('server/src/installation.ts','utf8');assert.doesNotMatch(source,/setting\.upsert\([^\n]*(DATABASE_URL|database\.password)/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('install files fail closed on public permissions, symlinks or malformed configuration',()=>{
  const root=mkdtempSync(join(tmpdir(),'dbtv-web-choice-permissions-'));const env={DBTV_DATA_DIR:join(root,'state')};
  try{
    files.privateDirectory(root,env);const target=join(root,'private');writeFileSync(target,'do-not-overwrite',{mode:0o600});
    symlinkSync(target,files.configFile(root,env));assert.throws(()=>files.readChoice(root,env));assert.equal(readFileSync(target,'utf8'),'do-not-overwrite');
    assert.throws(()=>files.installToken(root,{...env,INSTALL_TOKEN:'short'}));
    chmodSync(target,0o644);assert.throws(()=>files.readPrivate(target));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('all three Prisma connectors are built; failed SQL connection tests never echo credentials',async()=>{
  for(const provider of ['sqlite','mysql','postgresql'])assert.equal(typeof files.clientConstructor(provider),'function');
  for(const provider of ['mysql','postgresql'] as const){
    const candidate=validateDatabaseChoice({provider,host:'127.0.0.1',port:1,database:'fixture',username:'private-fixture-name',password:'private-fixture-password'},current,'/state');
    await assert.rejects(probeDatabase(candidate,false,current),error=>!String(error).includes('private-fixture')&&!String(error).includes(candidate.url));
  }
});
test('database probes reject foreign tables and existing accounts without modifying them',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-web-install-used-')),url=`file:${join(folder,'used.db')}`;
  const Client=files.clientConstructor('sqlite'),db=new Client({datasourceUrl:url});
  try{
    await db.$executeRawUnsafe('CREATE TABLE foreign_data (value TEXT)');await db.$executeRawUnsafe("INSERT INTO foreign_data VALUES ('preserve-me')");
    await assert.rejects(probeDatabase({provider:'sqlite',url},false,current),/不是空库/);
    assert.equal((await db.$queryRawUnsafe('SELECT value FROM foreign_data'))[0].value,'preserve-me');
    await db.$executeRawUnsafe('DROP TABLE foreign_data');await db.$executeRawUnsafe('CREATE TABLE "User" (id INTEGER)');await db.$executeRawUnsafe('INSERT INTO "User" VALUES (1)');
    await assert.rejects(probeDatabase({provider:'sqlite',url},false,{provider:'sqlite',url}),/已有数据/);
    assert.equal((await db.$queryRawUnsafe('SELECT id FROM "User"'))[0].id,1);
  }finally{await db.$disconnect();rmSync(folder,{recursive:true,force:true});}
});
