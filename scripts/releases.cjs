// Shared trust/metadata code. No database credentials, shell evaluation or writable update URLs.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const REPOSITORY='dabiao996/dbtv';
const BASE=`https://api.github.com/repos/${REPOSITORY}/releases`;
function version(value){
  if(typeof value!=='string'||!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value))throw Error('只接受正式版版本号，例如1.2.3');
  return value;
}
function compare(a,b){const x=version(a).split('.').map(Number),y=version(b).split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;}
function dataContract(root){
  // Database shape and explicit migration helpers define automatic version compatibility.
  // Older releases used a broader backend hash; those hashes remain incompatible by default.
  const hash=crypto.createHash('sha256');
  for(const rel of ['prisma/schema.prisma','scripts/database.mjs','scripts/database-config.cjs','scripts/prepare-member-identity.mjs','scripts/web-database-worker.cjs','scripts/web-database.cjs','server/src/installation.ts']){
    const file=path.join(root,rel);
    if(!fs.existsSync(file))continue;
    if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('发行包不能包含符号链接或特殊文件');
    hash.update(rel+'\0').update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}
function current(root=process.cwd()){
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'release.json'),'utf8'));
  return {version:version(metadata.version),channel:metadata.channel==='stable'?'stable':'development',revision:String(metadata.revision||'local').slice(0,40),dataContract:/^[a-f0-9]{64}$/.test(metadata.dataContract)?metadata.dataContract:dataContract(root)};
}
function publicKey(root=process.cwd()){
  const file=path.join(root,'deploy/update-public.pem');
  if(!fs.existsSync(file))return null;
  const key=fs.readFileSync(file,'utf8');
  if(crypto.createPublicKey(key).asymmetricKeyType!=='ed25519')throw Error('更新公钥必须是Ed25519');
  return key;
}
function validateManifest(value){
  version(value?.version);
  if(value.schemaVersion!==1||value.repository!==REPOSITORY||!/^[a-f0-9]{64}$/.test(value.dataContract)||!/^ghcr\.io\/dabiao996\/dbtv@sha256:[a-f0-9]{64}$/.test(value.image)||value.source?.url!==`https://github.com/${REPOSITORY}/releases/download/v${value.version}/dbtv-source.tar.gz`||!/^[a-f0-9]{64}$/.test(value.source?.sha256)||!/^[a-f0-9]{40}$/.test(value.revision))throw Error('正式发行清单无效，未允许更新');
  return value;
}
function verifyManifest(bytes,signature,key){
  if(!key||bytes.length>65536||!crypto.verify(null,bytes,key,Buffer.from(String(signature).trim(),'base64')))throw Error('更新签名校验失败，未允许安装');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('发行清单不是有效JSON');}
  return validateManifest(value);
}
async function download(url,{fetcher=fetch,limit=65536,timeout=15000}={}){
  const response=await fetcher(url,{signal:AbortSignal.timeout(timeout),headers:{Accept:String(url).startsWith('https://api.github.com/')?'application/vnd.github+json':'application/octet-stream','User-Agent':'DabiaoTV-Updater'}});
  if(!response.ok){const error=Error(response.status===404?'尚未找到正式发行版或完整发布包':response.status===403||response.status===429?'GitHub访问受限，请稍后重试':`发行服务器返回HTTP ${response.status}`);error.status=response.status;throw error;}
  if(Number(response.headers.get('content-length')||0)>limit)throw Error('发行文件超过大小限制');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body.cancel().catch(()=>{});throw Error('发行文件超过大小限制');}chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function release({tag,key,fetcher=fetch}={}){
  if(!key)throw Error('尚未配置发行签名公钥，请先完成正式发布配置');
  const suffix=tag?`tags/v${version(tag)}`:'latest';
  const raw=await download(`${BASE}/${suffix}`,{fetcher});
  let value;try{value=JSON.parse(raw);}catch{throw Error('GitHub发行响应无效');}
  const selected=String(value.tag_name||'').replace(/^v/,'');version(selected);
  if(value.draft||value.prerelease||value.tag_name!==`v${selected}`||tag&&selected!==tag)throw Error('此版本不是可安装的正式发行版');
  const base=`https://github.com/${REPOSITORY}/releases/download/v${selected}`;
  const bytes=await download(`${base}/release-manifest.json`,{fetcher});
  const signature=await download(`${base}/release-manifest.sig`,{fetcher,limit:1024});
  const manifest=verifyManifest(bytes,signature.toString('utf8'),key);
  if(manifest.version!==selected)throw Error('签名清单与发行版本不一致');
  return {manifest,bytes,signature,url:`https://github.com/${REPOSITORY}/releases/tag/v${selected}`,notes:typeof value.body==='string'?value.body.slice(0,8000):''};
}
async function versions({fetcher=fetch}={}){
  const raw=await download(`${BASE}?per_page=20`,{fetcher,limit:256*1024});
  let values;try{values=JSON.parse(raw);}catch{throw Error('GitHub版本列表无效');}
  if(!Array.isArray(values))throw Error('GitHub版本列表无效');
  return [...new Set(values.filter(item=>item&&!item.draft&&!item.prerelease&&typeof item.tag_name==='string'&&/^v(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(item.tag_name)).map(item=>item.tag_name.slice(1)))].slice(0,20).map(value=>({version:value,url:`https://github.com/${REPOSITORY}/releases/tag/v${value}`}));
}
module.exports={REPOSITORY,version,compare,current,dataContract,publicKey,verifyManifest,validateManifest,release,versions,download};
