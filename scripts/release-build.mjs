import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,createPublicKey,sign} from 'node:crypto';
import releases from './releases.cjs';
const command=process.argv[2],root=process.cwd();
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const pkg=json('package.json'),metadata=json('release.json');
if(pkg.version!==metadata.version)throw Error('package.json与release.json版本不一致');
releases.version(pkg.version);
if(command==='prepare'){
  if(process.env.RELEASE_TAG!==`v${pkg.version}`||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''))throw Error('标签必须与源码版本一致且为正式版本');
  if(!releases.publicKey(root)||!process.env.RELEASE_SIGNING_KEY)throw Error('请先配置已提交的更新公钥及RELEASE_SIGNING_KEY Secret');
  const actual=createPublicKey(process.env.RELEASE_SIGNING_KEY).export({type:'spki',format:'pem'}).toString();
  if(actual.trim()!==releases.publicKey(root).trim())throw Error('发布私钥与提交的公钥不匹配');
  metadata.channel='stable';metadata.revision=process.env.GITHUB_SHA;
}
if(['stamp','prepare'].includes(command)){
  metadata.dataContract=releases.dataContract(root);fs.writeFileSync('release.json',JSON.stringify(metadata,null,2)+'\n');
  if(command==='prepare'&&process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`version=${pkg.version}\ncontract=${metadata.dataContract}\n`);
}else if(command==='archive'){
  const result=spawnSync('git',['ls-files','-z'],{encoding:'utf8'});if(result.status!==0)throw Error('无法枚举正式源码');
  const allowed=new Set(['client','server','prisma','scripts','deploy','docs','README.md','CHANGELOG.md','Dockerfile','compose.yaml','package.json','package-lock.json','release.json','live-tv.example.json','.env.example','.dockerignore','tsconfig.json']);
  const names=result.stdout.split('\0').filter(Boolean).filter(name=>allowed.has(name.split('/')[0])&&!/(^|\/)(?:node_modules|dist|build|coverage|cache|data|backups|\.generated)(\/|$)|\.(?:db|sqlite3?)(?:-|$)|\.log$|\.(?:pem|key)$/.test(name)||name==='deploy/update-public.pem');
  for(const name of names)if(/[\r\n\x00]/.test(name)||fs.lstatSync(name).isSymbolicLink()||!fs.statSync(name).isFile())throw Error('源码包不允许链接或特殊文件');
  fs.mkdirSync('release-artifacts',{recursive:true});
  const tar=spawnSync('tar',['-czf','release-artifacts/dbtv-source.tar.gz','--null','-T','-'],{input:names.join('\0')+'\0',env:{...process.env,COPYFILE_DISABLE:'1'}});if(tar.status!==0)throw Error('源码打包失败');
}else if(command==='sign'){
  const digest=process.env.IMAGE_DIGEST;if(!/^sha256:[a-f0-9]{64}$/.test(digest||''))throw Error('需要真实构建完成的镜像摘要');
  const key=process.env.RELEASE_SIGNING_KEY;if(!key)throw Error('未配置签名私钥');
  if(createPublicKey(key).export({type:'spki',format:'pem'}).toString().trim()!==releases.publicKey(root)?.trim())throw Error('签名密钥不匹配');
  const manifest={schemaVersion:1,repository:releases.REPOSITORY,version:pkg.version,revision:metadata.revision,dataContract:metadata.dataContract,image:`ghcr.io/dabiao996/dbtv@${digest}`,source:{url:`https://github.com/dabiao996/dbtv/releases/download/v${pkg.version}/dbtv-source.tar.gz`,sha256:createHash('sha256').update(fs.readFileSync('release-artifacts/dbtv-source.tar.gz')).digest('hex')}};
  releases.validateManifest(manifest);const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync('release-artifacts/release-manifest.json',bytes);fs.writeFileSync('release-artifacts/release-manifest.sig',sign(null,bytes,key).toString('base64')+'\n');
}else throw Error('支持prepare / stamp / archive / sign');
