// One-shot, same-user program updater. Never reads or writes the site's persistent data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import releases from '../releases.cjs';

const allowed=new Set(['client','server','prisma','scripts','deploy','docs','README.md','CHANGELOG.md','Dockerfile','compose.yaml','package.json','package-lock.json','release.json','live-tv.example.json','.env.example','.dockerignore','tsconfig.json']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeName=name=>typeof name==='string'&&/^[A-Za-z0-9_./-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(part=>!part||part==='.'||part==='..')&&allowed.has(name.split('/')[0]);
const privateError=message=>Error(message);
function command(program,args,{cwd,input}={}){
  const result=spawnSync(program,args,{cwd,input,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
  if(result.error||result.status!==0)throw privateError(`增量更新步骤失败：${path.basename(program)}；数据未清理，程序可能已部分变更`);
  return result.stdout||'';
}
function localFile(root,name){
  if(!safeName(name))throw privateError('发行包包含不允许的路径');
  let current=root;
  for(const segment of name.split('/')){
    current=path.join(current,segment);
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(stat.isSymbolicLink()||stat.nlink!==1&&stat.isFile()||!stat.isFile()&&!stat.isDirectory())throw privateError('本地程序路径不安全或不是普通文件');
  }
  return path.join(root,name);
}
function listProgramFiles(root){
  const files=new Map();
  function walk(folder,prefix){
    for(const name of fs.readdirSync(folder).sort()){
      const relative=prefix?`${prefix}/${name}`:name;
      if(!safeName(relative))throw privateError('发行包包含不允许的路径');
      const file=path.join(folder,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw privateError('发行包包含链接或特殊文件');
      if(stat.isDirectory())walk(file,relative);
      else {const bytes=fs.readFileSync(file);files.set(relative,{hash:digest(bytes),bytes,mode:stat.mode&0o777});}
    }
  }
  walk(root,'');return files;
}
function baselineHash(root,name,manifest){
  if(manifest)return manifest.files[name]||null;
  const result=spawnSync('git',['-C',root,'rev-parse','--verify',`HEAD:${name}`],{encoding:'utf8'});
  return result.status===0?result.stdout.trim():null;
}
function fileHash(file){return fs.existsSync(file)?digest(fs.readFileSync(file)):null;}
function gitHash(bytes){return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
export function planIncremental(root,staged,previous=null){
  const target=listProgramFiles(staged),changes=[],removals=[],expected={};
  if(previous&&(!previous||previous.version!==1||typeof previous.files!=='object'||Array.isArray(previous.files)))throw privateError('既有程序清单无效，未改动程序');
  for(const [name,item] of target){
    const local=localFile(root,name),exists=fs.existsSync(local),bytes=exists?fs.readFileSync(local):null;
    if(bytes&&digest(bytes)===item.hash)continue;
    const baseline=baselineHash(root,name,previous);
    if(exists&&(!baseline||(previous?baseline!==digest(bytes):baseline!==gitHash(bytes)))||!exists&&baseline)throw privateError(`本地程序文件有修改，已停止以保留内容：${name}`);
    changes.push(name);expected[name]=bytes?digest(bytes):null;
  }
  if(previous)for(const [name,hash] of Object.entries(previous.files)){
    if(!safeName(name)||!/^[a-f0-9]{64}$/.test(hash))throw privateError('既有程序清单无效，未改动程序');
    if(target.has(name))continue;
    const file=localFile(root,name);
    if(fs.existsSync(file)){
      if(fileHash(file)!==hash)throw privateError(`旧程序文件已有本地修改，拒绝清理：${name}`);
      removals.push(name);expected[name]=hash;
    }
  }
  const oldPackage=JSON.parse(fs.readFileSync(localFile(root,'package.json'),'utf8'));
  const newPackage=JSON.parse(target.get('package.json')?.bytes?.toString('utf8')||'null');
  if(!newPackage||!target.has('package-lock.json')||!target.has('release.json'))throw privateError('发行包缺少必需清单');
  const previousDependencies={...oldPackage.dependencies,...oldPackage.devDependencies};
  const nextDependencies={...newPackage.dependencies,...newPackage.devDependencies};
  const dependencies=[...new Set([...Object.keys(previousDependencies),...Object.keys(nextDependencies)])].sort().flatMap(name=>previousDependencies[name]===nextDependencies[name]?[]:[{name,from:previousDependencies[name]||null,to:nextDependencies[name]||null}]);
  const lockChanged=fileHash(localFile(root,'package-lock.json'))!==target.get('package-lock.json').hash;
  if(dependencies.length&&!lockChanged)throw privateError('依赖声明已变更但锁文件未变，未改动程序');
  const oldLock=JSON.parse(fs.readFileSync(localFile(root,'package-lock.json'),'utf8'));
  const newLock=JSON.parse(target.get('package-lock.json').bytes.toString('utf8'));
  const packageGraph=lock=>{const value=structuredClone(lock);delete value.version;if(value.packages?.[''])delete value.packages[''].version;return JSON.stringify(value);};
  const dependenciesChanged=packageGraph(oldLock)!==packageGraph(newLock);
  const packages=[...new Set([...Object.keys(oldLock.packages||{}),...Object.keys(newLock.packages||{})])].filter(Boolean).sort().flatMap(name=>{
    const before=oldLock.packages?.[name],after=newLock.packages?.[name];
    return before?.version===after?.version&&before?.integrity===after?.integrity?[]:[{name,from:before?.version||null,to:after?.version||null}];
  });
  const lifecycle=[];
  if(dependenciesChanged)for(const [name,value] of Object.entries(newLock.packages||{}))if(name&&value?.hasInstallScript&&JSON.stringify(value)!==JSON.stringify(oldLock.packages?.[name]))lifecycle.push(name);
  if(lifecycle.some(name=>!['node_modules/@prisma/client','node_modules/@prisma/engines','node_modules/esbuild'].includes(name)))throw privateError('新增依赖含未审核安装脚本，未自动执行；请单独审查');
  return {target,changes,removals,expected,lockChanged,dependenciesChanged,dependencies,packages,lifecycle};
}
function writeProgram(root,name,item){
  const file=localFile(root,name),directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true});
  const temp=path.join(directory,`.dbtv-update-${randomUUID()}.tmp`);let fd;
  try{
    fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,item.mode&0o111?0o700:0o600);
    fs.writeFileSync(fd,item.bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,file);
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function applyIncremental(root,plan,{run=command}={}){
  const unchanged=name=>{if(fileHash(localFile(root,name))!==plan.expected[name])throw privateError(`更新期间本地文件发生变化，已停止：${name}`);};
  const packageFiles=plan.changes.filter(name=>['package.json','package-lock.json'].includes(name));
  for(const name of packageFiles){unchanged(name);writeProgram(root,name,plan.target.get(name));}
  if(plan.dependenciesChanged){
    run(process.execPath,[path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'install','--no-save','--ignore-scripts','--no-audit','--no-fund'],{cwd:root});
    if(fileHash(path.join(root,'package-lock.json'))!==plan.target.get('package-lock.json').hash)throw privateError('npm 改写了签名锁文件，暂停更新并等待人工检查');
    if(plan.lifecycle.some(name=>name.includes('prisma')))run(process.execPath,[path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'run','db:generate'],{cwd:root});
    if(plan.lifecycle.includes('node_modules/esbuild'))run(process.execPath,[path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'rebuild','esbuild'],{cwd:root});
  }
  for(const name of plan.changes)if(!packageFiles.includes(name)){unchanged(name);writeProgram(root,name,plan.target.get(name));}
  for(const name of plan.removals){unchanged(name);fs.unlinkSync(localFile(root,name));}
  const build=plan.changes.some(name=>['client','server','prisma','scripts'].includes(name.split('/')[0])||['package.json','package-lock.json','release.json'].includes(name));
  if(build)run(process.execPath,[path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'run','build'],{cwd:root});
  return {changed:plan.changes.length,removed:plan.removals.length,dependencies:plan.dependencies,packages:plan.packages,lifecycle:plan.lifecycle,lockChanged:plan.lockChanged,dependenciesChanged:plan.dependenciesChanged,build};
}
export async function stageSignedRelease(root,target,{fetcher=fetch}={}){
  const key=releases.publicKey(root),remote=await releases.release({tag:target,key,fetcher});
  const current=releases.current(root),actual=releases.dataContract(root);
  if(remote.manifest.dataContract!==current.dataContract||actual!==current.dataContract)throw privateError('数据库兼容标识不同；未改动程序或数据，需要单独决定迁移方式');
  if(releases.compare(remote.manifest.version,current.version)===0&&current.channel!=='development')throw privateError('当前已是所选正式版');
  const archive=await releases.download(remote.manifest.source.url,{fetcher,limit:32*1024*1024,timeout:120000});
  if(digest(archive)!==remote.manifest.source.sha256)throw privateError('发行包校验失败');
  const staging=fs.mkdtempSync(path.join(os.tmpdir(),'dbtv-program-stage-'));
  try{
    fs.chmodSync(staging,0o700);const tar=path.join(staging,'source.tar.gz'),source=path.join(staging,'source');
    fs.writeFileSync(tar,archive,{mode:0o600});fs.mkdirSync(source,{mode:0o700});
    const names=command('tar',['-tzf',tar]).trim().split('\n');
    if(names.length>10000||names.some(name=>!safeName(name.replace(/\/$/,''))))throw privateError('发行包包含不允许的路径');
    const types=command('tar',['-tvzf',tar]).trim().split('\n');
    if(types.some(line=>!/^[-d]/.test(line)))throw privateError('发行包包含链接或特殊文件');
    command('tar',['-xzf',tar,'-C',source]);
    const files=listProgramFiles(source);
    const release=JSON.parse(files.get('release.json')?.bytes?.toString('utf8')||'null');
    if(release?.version!==remote.manifest.version||release.channel!=='stable'||release.dataContract!==remote.manifest.dataContract)throw privateError('发行包版本或兼容标识不符');
    if(files.get('deploy/update-public.pem')?.bytes.toString('utf8').trim()!==key.trim())throw privateError('发行包更换信任公钥，需要单独决定');
    return {remote,staging,source};
  }catch(error){fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
export function programManifest(plan,version){return {version:1,release:version,files:Object.fromEntries([...plan.target].map(([name,item])=>[name,item.hash]))};}
