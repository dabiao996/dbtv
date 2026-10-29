import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import releases from '../releases.cjs';
import {createDriver} from './update-driver.mjs';

test('update status permissions use the persisted native account, with a legacy default',async()=>{
  for(const serviceUser of [undefined,'dbtv_vm104']){
    const calls=[],driver=createDriver('/unused',{mode:'native',serviceUser,execute:(...args)=>calls.push(args)});
    await driver.permissions('/unused/data/updates');
    const expected=serviceUser||'dabiaotv';
    assert.deepEqual(calls,[['chown',['-R',`${expected}:${expected}`,'/unused/data/updates']]]);
  }
  for(const mode of ['docker','termux']){
    const calls=[],driver=createDriver('/unused',{mode,serviceUser:'dbtv_vm104',execute:(...args)=>calls.push(args)});
    await driver.permissions('/unused/data/updates');assert.deepEqual(calls,[]);
  }
});

test('native release preparation and rollback retain the selected account without chowning the legacy user',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-driver-account-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const staged=path.join(home,'fixture-source');fs.mkdirSync(path.join(staged,'deploy'),{recursive:true});
  fs.mkdirSync(path.join(staged,'server/dist'),{recursive:true});fs.writeFileSync(path.join(staged,'server/dist/index.js'),'fixture');
  const key=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}).publicKey;
  fs.writeFileSync(path.join(staged,'deploy/update-public.pem'),key);
  const dataContract=releases.dataContract(staged),metadata={version:'1.2.3',channel:'stable',dataContract};
  fs.writeFileSync(path.join(staged,'release.json'),JSON.stringify(metadata));
  const archive=Buffer.from('mock verified archive'),original=releases.download;
  releases.download=async()=>archive;t.after(()=>{releases.download=original;});
  const remote={manifest:{...metadata,source:{url:'https://example.invalid/source.tar.gz',sha256:createHash('sha256').update(archive).digest('hex')}}};
  for(const serviceUser of [undefined,'dbtv_vm104']){
    const calls=[],operations=[],before={mode:'native',source:staged,node:'/fixture/node',serviceUser,release:metadata};
    const driver=createDriver(home,{mode:'native',serviceUser,key,
      execute:(command,args)=>{
        calls.push([command,args]);
        if(command==='tar'&&args[0]==='-tzf')return {text:'release.json\ndeploy/update-public.pem\nserver/dist/index.js\n'};
        if(command==='tar'&&args[0]==='-tvzf')return {text:'-rw-r--r-- fixture\n'};
        if(command==='tar'&&args[0]==='-xzf')fs.cpSync(staged,args[3],{recursive:true});
        return {text:''};
      },
      application:(_home,state)=>{assert.equal(state.serviceUser,serviceUser);},npmPath:()=>'/fixture/npm',
      persist:(_home,state)=>operations.push(['persist',state]),service:(_home,state,action)=>operations.push([action,state]),
    });
    const next=await driver.prepare(before,remote),owner=`${serviceUser||'dabiaotv'}:${serviceUser||'dabiaotv'}`;
    assert.equal(next.serviceUser,serviceUser);
    assert.deepEqual(calls.filter(([command])=>command==='chown').map(([,args])=>args),[
      ['-R',owner,path.dirname(next.source)],['-R','root:root',path.dirname(next.source)],
      ['-R',owner,path.join(next.source,'.generated')],['-R',owner,path.join(next.source,'node_modules')],
    ]);
    await driver.verifyPrevious(before);await driver.stop(next);await driver.persist(before);await driver.start(before);
    assert.deepEqual(operations,[['stop',next],['persist',before],['start',before]],'rollback passes original persisted identity intact');
    assert.equal(fs.existsSync(path.join(path.dirname(next.source),'source.tar.gz')),false);
  }
});

test('invalid persisted native identities fail before any permission or release operation',async()=>{
  for(const serviceUser of ['other:group','../other','--reference=/tmp/other']){
    const calls=[],driver=createDriver('/unused',{mode:'native',serviceUser,execute:(...args)=>calls.push(args)});
    await assert.rejects(driver.permissions('/unused/data/updates'));
    await assert.rejects(driver.prepare({mode:'native',serviceUser},{manifest:{}}));
    assert.deepEqual(calls,[]);
  }
});
