import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import releases from '../releases.cjs';
const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../release-build.mjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-release-build-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['scripts','server/src','client','prisma','deploy'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),'{"version":"0.2.0"}');fs.writeFileSync(path.join(root,'release.json'),'{"version":"0.2.0","channel":"development"}');
  fs.writeFileSync(path.join(root,'server/src/index.ts'),'server');fs.writeFileSync(path.join(root,'prisma/schema.prisma'),'schema');fs.writeFileSync(path.join(root,'scripts/database.mjs'),'migration');
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  fs.writeFileSync(path.join(root,'deploy/update-public.pem'),keys.publicKey);
  const env={...process.env,RELEASE_TAG:'v0.2.0',GITHUB_SHA:'b'.repeat(40),RELEASE_SIGNING_KEY:keys.privateKey};
  return {root,keys,env};
}
test('data contract changes for migration/backend edits, not frontend-only edits',t=>{
  const {root}=fixture(t),before=releases.dataContract(root);fs.writeFileSync(path.join(root,'client/ui.tsx'),'new look');assert.equal(releases.dataContract(root),before);
  fs.writeFileSync(path.join(root,'scripts/database.mjs'),'new migration');assert.notEqual(releases.dataContract(root),before);
});
test('actual release tooling stamps, filters a git source archive and verifies its signature',t=>{
  const {root,keys,env}=fixture(t);
  fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'.env'),'private-password');fs.writeFileSync(path.join(root,'prisma/private.sqlite'),'private-db');fs.writeFileSync(path.join(root,'scripts/secret.pem'),'private-key');
  fs.writeFileSync(path.join(root,'data/live-tv.json'),'private-channel');fs.writeFileSync(path.join(root,'live-tv.example.json'),'{}');
  execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  execFileSync(process.execPath,[script,'prepare'],{cwd:root,env});const metadata=JSON.parse(fs.readFileSync(path.join(root,'release.json')));assert.equal(metadata.channel,'stable');assert.match(metadata.dataContract,/^[a-f0-9]{64}$/);
  execFileSync(process.execPath,[script,'archive'],{cwd:root,env});
  const archive=path.join(root,'release-artifacts/dbtv-source.tar.gz'),names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'});
  assert.ok(names.includes('deploy/update-public.pem'));assert.ok(names.includes('live-tv.example.json'));
  for(const secret of ['.env\n','private.sqlite','secret.pem','data/live-tv.json','._'])assert.ok(!names.includes(secret));
  execFileSync(process.execPath,[script,'sign'],{cwd:root,env:{...env,IMAGE_DIGEST:'sha256:'+'c'.repeat(64)}});
  const bytes=fs.readFileSync(path.join(root,'release-artifacts/release-manifest.json')),sig=fs.readFileSync(path.join(root,'release-artifacts/release-manifest.sig'),'utf8');assert.equal(releases.verifyManifest(bytes,sig,keys.publicKey).version,'0.2.0');
});
test('tag mismatch and wrong signing key abort before any publication',t=>{
  const {root,env}=fixture(t);assert.throws(()=>execFileSync(process.execPath,[script,'prepare'],{cwd:root,env:{...env,RELEASE_TAG:'v9.9.9'},stdio:'pipe'}));
  const wrong=generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});assert.throws(()=>execFileSync(process.execPath,[script,'prepare'],{cwd:root,env:{...env,RELEASE_SIGNING_KEY:wrong.privateKey},stdio:'pipe'}));
});
