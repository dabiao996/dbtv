import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import releases from '../releases.cjs';
import {atomic,privateDirectory,redact} from './core.mjs';

function privateJSON(file){
  if(!fs.existsSync(file))return null;
  const descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(descriptor);
    if(!stat.isFile()||stat.nlink!==1||stat.size>262144||(stat.mode&0o077))throw Error('更新私有配置权限或格式无效');
    const bytes=Buffer.alloc(262145),count=fs.readSync(descriptor,bytes,0,bytes.length,0);
    if(count>262144)throw Error('更新私有文件超过大小限制');
    return JSON.parse(bytes.subarray(0,count).toString('utf8'));
  }finally{fs.closeSync(descriptor);}
}
export function policy(home){
  const value=privateJSON(path.join(home,'update-policy.json'));
  if(!value?.enabled||value.version!==1||typeof value.publicKey!=='string')throw Error('主机更新代理未启用');
  return value;
}
export function validateRequest(value){
  if(!value||Object.keys(value).some(x=>!['id','action','target','actor','createdAt'].includes(x))||!/^[a-f0-9-]{36}$/.test(value.id)||!['update','rollback'].includes(value.action)||typeof value.target!=='string'||!Number.isFinite(Date.parse(value.createdAt))||Date.now()-Date.parse(value.createdAt)>900000||Date.parse(value.createdAt)>Date.now()+60000)throw Error('更新请求无效或已过期');
  if(value.action==='update')releases.version(value.target);
  else if(!/^[a-f0-9-]{36}$/.test(value.target))throw Error('回退记录无效');
  return value;
}
export function history(home){return privateJSON(path.join(home,'updates/history.json'))||[];}
export function publicStatus(home,{job=null,enabled=true,currentContract}={}){
  const directory=path.join(home,'data/updates');privateDirectory(directory);
  const value={enabled,job,history:history(home).filter(x=>x.state==='complete').slice(-10).reverse().map(x=>({id:x.id,version:x.previous.release?.version||'未知',at:x.at,hasBackup:!!x.backup,canRollback:!!currentContract&&x.previous.release?.dataContract===currentContract&&x.dataContract===currentContract}))};
  atomic(path.join(directory,'status.json'),JSON.stringify(value));return directory;
}
export function enable(home,key){
  if(!key)throw Error('请先配置deploy/update-public.pem，不能启用未验证的远程代码更新');
  atomic(path.join(home,'update-policy.json'),JSON.stringify({version:1,enabled:true,publicKey:key,keyFingerprint:createHash('sha256').update(key.trim()).digest('hex')}));
}
// All privileged effects are injected: tests never need root or a real Docker daemon.
export async function transition({before,next,job,ops,recordID=randomUUID()}){
  let stopped=false,launched=false,backupPath=null;
  const compatible=/^[a-f0-9]{64}$/.test(before.release?.dataContract||'')&&before.release.dataContract===next.release?.dataContract;
  const message=(state,text)=>ops.report({id:job.id,state,version:next.release.version,message:text,at:new Date().toISOString()});
  await message('running','准备完成，正在停止站点并备份；更新期间暂时不可访问');
  try{
    await ops.stop(before);stopped=true;
    backupPath=await ops.backup(before);
    if(!backupPath)throw Error('未获得完整备份，禁止更新');
    const record={id:recordID,at:new Date().toISOString(),previous:before,next,backup:backupPath,dataContract:next.release.dataContract,state:'prepared'};
    await ops.record(record); // durable record BEFORE switching, for crash recovery.
    await ops.persist(next);launched=true;
    await ops.start(next);await ops.healthy(next);
    record.state='complete';await ops.record(record);
    await message('complete','操作完成，网站和数据库健康检查通过');return {state:'complete',record};
  }catch(error){
    if(stopped&&(!launched||compatible)){
      try{
        await ops.stop(next);await ops.persist(before);await ops.start(before);await ops.healthy(before);
        await message('rolled-back','操作未成功，已恢复原程序并通过健康检查；未覆盖数据库');
        return {state:'rolled-back',error:redact(error.message)};
      }catch{await message('blocked','自动恢复未通过健康检查；已保留备份，需管理员检查，未覆盖数据库');return {state:'blocked'};}
    }
    if(stopped){await ops.stop(next).catch(()=>{});await message('blocked','新版本未通过且数据兼容性不能确认，已停止程序；请检查备份后人工恢复，未擅自回写旧数据库');return {state:'blocked'};}
    await message('failed','准备或停止服务失败，未切换程序版本');return {state:'failed',error:redact(error.message)};
  }
}
export async function processUpdate(home,state,request,driver,{fetcher=fetch}={}){
  validateRequest(request);const trusted=policy(home),root=path.join(home,'updates');privateDirectory(root);
  if(privateJSON(path.join(root,'active.json')))throw Error('上次更新未正常结束，请主机管理员检查记录和备份，禁止盲目继续');
  const choice=privateJSON(path.join(home,'data/database.json'));
  if(choice&&choice.provider!=='sqlite')throw Error('外部数据库须先建立独立备份/迁移流程，本版拒绝自动升级MySQL/PostgreSQL');
  if(!await driver.ready(state))throw Error('当前站点未安装或不健康，禁止以更新代替修复');
  let before={...state,release:state.release||releases.current(state.source)},next;
  if(request.action==='update'){
    const remote=await releases.release({tag:request.target,key:trusted.publicKey,fetcher});
    const comparison=releases.compare(remote.manifest.version,before.release.version);
    if(comparison<0||comparison===0&&before.release.channel!=='development')throw Error('升级目标必须高于当前正式版，或将同版本开发版切换为正式版；降级请用回退记录');
    next=await driver.prepare(state,remote);
    next={...next,release:{version:remote.manifest.version,channel:'stable',revision:remote.manifest.revision,dataContract:remote.manifest.dataContract}};
  }else{
    const previous=history(home).find(x=>x.id===request.target&&x.state==='complete');
    if(!previous||previous.dataContract!==before.release.dataContract||previous.previous.release?.dataContract!==before.release.dataContract)throw Error('此回退涉及未知数据兼容性，拒绝自动降级或覆盖数据库');
    next={...previous.previous,port:state.port,bind:state.bind,origin:state.origin};await driver.verifyPrevious(next);
  }
  if(state.mode==='docker'&&!before.image)before.image=await driver.runningImage(state);
  atomic(path.join(root,'active.json'),JSON.stringify({id:request.id,at:new Date().toISOString(),target:next.release.version}));
  const report=async job=>{const directory=publicStatus(home,{job,currentContract:(job.state==='complete'?next:before).release.dataContract});await driver.permissions(directory);};
  const record=async value=>{const records=history(home),index=records.findIndex(x=>x.id===value.id);if(index<0)records.push(value);else records[index]=value;atomic(path.join(root,'history.json'),JSON.stringify(records));};
  const result=await transition({before,next,job:request,ops:{...driver,report,record}});
  if(result.state!=='blocked')fs.unlinkSync(path.join(root,'active.json'));return result;
}
export async function consume(home,state,driver,options){
  policy(home);const file=path.join(home,'data/updates/request.json');if(!fs.existsSync(file))return {state:'idle'};
  const request=privateJSON(file);validateRequest(request);
  const inbox=path.join(home,'updates/requests');privateDirectory(inbox);
  atomic(path.join(inbox,`${request.id}.json`),JSON.stringify(request));fs.unlinkSync(file);
  try{return await processUpdate(home,state,request,driver,options);}
  catch(error){const stateName=fs.existsSync(path.join(home,'updates/active.json'))?'blocked':'failed';const directory=publicStatus(home,{job:{id:request.id,state:stateName,message:redact(error.message).slice(0,400),at:new Date().toISOString()},currentContract:state.release?.dataContract});await driver.permissions(directory);return {state:stateName};}
}
