#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageSignedRelease,planIncremental,applyIncremental,programManifest} from './incremental.mjs';
import {validateRequest} from './updates.mjs';

const entry=fileURLToPath(import.meta.url);
const dataDirectory=root=>path.resolve(process.env.DBTV_DATA_DIR||path.join(root,'data'));
function privateJSON(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>2*1024*1024)throw Error('更新请求或程序清单权限不安全');
    const bytes=fs.readFileSync(fd);return JSON.parse(bytes.toString('utf8'));
  }finally{fs.closeSync(fd);}
}
function atomicJSON(file,value){
  const temp=`${file}.${process.pid}.tmp`;let fd;
  try{fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}
  finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
async function runningVersion(port,version,contract,{fetcher=fetch,attempts=20}={}){
  for(let i=0;i<attempts;i++){
    try{
      const response=await fetcher(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1500),redirect:'error'});
      const value=await response.json();
      if(response.ok&&value.service==='web-tvbox'&&value.version===version&&value.dataContract===contract)return true;
    }catch{}
    if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return false;
}
export async function runOneShot(root,{stage=stageSignedRelease,apply=applyIncremental,health=runningVersion,fetcher=fetch}={}){
  root=path.resolve(root);
  if(!fs.existsSync(path.join(root,'package.json')))throw Error('更新源目录不存在');
  const directory=path.join(dataDirectory(root),'updates');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('更新队列目录权限不安全');
  const requestFile=path.join(directory,'request.json'),active=path.join(directory,'incremental-active.json'),status=path.join(directory,'status.json');
  if(fs.existsSync(active))throw Error('上次增量更新尚未完成；请检查状态，不自动覆盖或清理');
  const request=validateRequest(privateJSON(requestFile));
  if(request.action!=='update')throw Error('一次性增量任务只接受正式版更新，不提供无备份自动回退');
  const marker={id:request.id,target:request.target,at:new Date().toISOString()};
  fs.writeFileSync(active,JSON.stringify(marker),{flag:'wx',mode:0o600});fs.unlinkSync(requestFile);
  let dependencyChanges=[],dependencyChangeTotal=0;
  const report=(state,message,extra={})=>atomicJSON(status,{enabled:true,mode:'incremental',history:[],job:{id:request.id,version:request.target,state,message,at:new Date().toISOString()},dependencyChanges,dependencyChangeTotal,...extra});
  let staged,applying=false;
  try{
    report('running','正在校验签名发行版、数据库兼容标识和本地程序修改');
    staged=await stage(root,request.target,{fetcher});
    const prior=path.join(directory,'program-manifest.json');
    const previous=fs.existsSync(prior)?privateJSON(prior):null;
    const plan=planIncremental(root,staged.source,previous);
    const added=plan.packages.filter(item=>!item.from).length,removed=plan.packages.filter(item=>!item.to).length,changed=plan.packages.length-added-removed;
    dependencyChanges=plan.packages.slice(0,30);dependencyChangeTotal=plan.packages.length;
    atomicJSON(path.join(directory,'dependency-report.json'),{version:request.target,at:new Date().toISOString(),packages:plan.packages,direct:plan.dependencies,installScripts:plan.lifecycle});
    report('running',`程序变更 ${plan.changes.length}、安全清理 ${plan.removals.length}；依赖新增 ${added}、变更 ${changed}、移除 ${removed}；${plan.dependenciesChanged?`npm 增量同步，已审核安装脚本 ${plan.lifecycle.length} 项`:'依赖图未变，跳过安装'}`);
    applying=true;
    const result=apply(root,plan);
    atomicJSON(prior,programManifest(plan,request.target));
    // The supported target is the local tsx-watch development service. Touching its
    // entrypoint requests a normal watcher reload without killing a user process.
    const entrypoint=path.join(root,'server/src/index.ts');
    if(fs.existsSync(entrypoint)&&fs.lstatSync(entrypoint).isFile())fs.utimesSync(entrypoint,new Date(),new Date());
    const port=Number(process.env.PORT||8787);
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('后端端口无效，无法确认新版本运行状态');
    if(!await health(port,request.target,staged.remote.manifest.dataContract,{fetcher})){
      report('blocked','程序差异已写入，但后端未确认运行新版本；需要检查并重启原有开发服务。未恢复旧程序或数据库。');
      return {state:'blocked',...result};
    }
    fs.unlinkSync(active);report('complete','增量程序文件已更新并通过版本检查；原数据库、直播 JSON 和账号配置未触碰');
    return {state:'complete',...result};
  }catch(error){
    const message=applying?'程序更新已部分执行；原数据未触碰，需人工检查程序与依赖状态':'校验或预检失败，未改动程序或用户数据';
    if(!applying&&fs.existsSync(active))fs.unlinkSync(active);
    report(applying?'blocked':'failed',`${message}。${String(error.message||'操作失败').slice(0,180)}`);
    return {state:applying?'blocked':'failed'};
  }finally{if(staged?.staging)fs.rmSync(staged.staging,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===entry){
  const root=path.resolve(process.argv[2]||'');
  if(process.platform!=='darwin'||process.env.DBTV_LOCAL_DIFF_UPDATES!=='1'||process.env.DBTV_DEV_WATCH!=='1'||root!==process.cwd())process.exitCode=1;
  else runOneShot(root).then(result=>{if(result.state!=='complete')process.exitCode=1;}).catch(()=>{process.exitCode=1;});
}
