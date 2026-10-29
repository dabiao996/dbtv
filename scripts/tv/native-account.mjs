import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {nativeServiceUser} from './core.mjs';
const systemRun=(command,args)=>spawnSync(command,args,{encoding:'utf8',stdio:'pipe'});
const conflict=()=>Error('所选服务账号或组已存在，新装拒绝复用；请用 --service-user 指定全新专属名称。不会修改、删除账号或终止其他进程。');
function query(run,kind,key){
  const result=run('getent',[kind,String(key)]);
  if(result.error||![0,2].includes(result.status))throw Error('无法可靠查询系统账号/组，已停止安装');
  return result.status===0?String(result.stdout||'').trim():null;
}
export function assertUnusedAccount(user,run=systemRun){
  nativeServiceUser({serviceUser:user});
  if(query(run,'passwd',user)!==null||query(run,'group',user)!==null)throw conflict();
}
function parseRange(text,subordinate=false){
  return text.split('\n').filter(line=>line.trim()).map(line=>{
    const fields=line.trim().split(subordinate?':':/\s+/),start=Number(fields[1]),length=Number(fields[2]);
    if(fields.length!==3||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<1)throw Error('身份映射范围无效，已停止安装');
    return [start,start+length];
  });
}
export function reservedNativeIds({procRoot='/proc',subidFiles=['/etc/subuid','/etc/subgid']}={}){
  const ids=new Set([0]),ranges=[];
  const read=file=>fs.readFileSync(file,'utf8');
  // Reject remapped containers. The operator must still use the VM host: an
  // identity user mapping alone cannot prove that the PID view is complete.
  const initial=read(path.join(procRoot,'1/uid_map')).trim().split(/\s+/).map(Number);
  if(initial.length!==3||initial[0]!==0||initial[1]!==0||initial[2]<4294967295)throw Error('请在VM宿主初始用户命名空间安装，不在映射容器内分配服务账号');
  const hostNamespace=fs.readlinkSync(path.join(procRoot,'1/ns/user'));
  for(const file of subidFiles){try{ranges.push(...parseRange(read(file),true));}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(const pid of fs.readdirSync(procRoot).filter(name=>/^\d+$/.test(name))){
    const directory=path.join(procRoot,pid);
    try{
      if(fs.readlinkSync(path.join(directory,'ns/user'))!==hostNamespace){
        ranges.push(...parseRange(read(path.join(directory,'uid_map'))),...parseRange(read(path.join(directory,'gid_map'))));
      }
      for(const tid of fs.readdirSync(path.join(directory,'task')).filter(name=>/^\d+$/.test(name))){
        try{const status=read(path.join(directory,'task',tid,'status'));
          for(const line of status.split('\n'))if(/^(Uid|Gid|Groups):/.test(line))for(const item of line.split(':')[1].trim().split(/\s+/).filter(Boolean)){
            const id=Number(item);if(!Number.isSafeInteger(id)||id<0)throw Error('进程身份格式无效');ids.add(id);
          }
        }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
      }
    }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw Error('无法完整读取宿主进程/映射身份，已停止安装');}
  }
  return {ids,ranges};
}
export function planNativeAccount({user,home,run=systemRun,scan=reservedNativeIds}){
  assertUnusedAccount(user,run);
  if(!path.isAbsolute(home))throw Error('账号目录必须是绝对路径');
  const {ids,ranges}=scan();
  // A high, bounded host-service range avoids common container IDs such as 999.
  // This is a current-state check, not a replacement for Kubernetes UID policy.
  for(let id=60000;id<65000;id++){
    if(ids.has(id)||ranges.some(([start,end])=>id>=start&&id<end))continue;
    if(query(run,'passwd',id)!==null||query(run,'group',id)!==null)continue;
    return {user,home,uid:id,gid:id};
  }
  throw Error('60000–64999范围没有可验证的独立UID/GID；请检查容器映射和宿主身份分配策略，不会强制复用');
}
export function createNativeAccount(plan,{run=systemRun,scan=reservedNativeIds}={}){
  // Re-plan just before mutation. A concurrent owner always wins; never adopt it.
  const current=planNativeAccount({...plan,run,scan});
  if(current.uid!==plan.uid||current.gid!==plan.gid)throw Error('服务身份分配期间系统状态变化，请重新检查后重试');
  for(const [command,args] of [['groupadd',['--system','--gid',String(plan.gid),plan.user]],['useradd',['--system','--uid',String(plan.uid),'--gid',String(plan.gid),'--home-dir',plan.home,'--no-create-home','--shell','/usr/sbin/nologin',plan.user]]]){
    const result=run(command,args);if(result.error||result.status!==0)throw Error('专属账号创建未完成；已停止，未修改既有账号。请检查可能新建的同名组，不会自动删除或接管');
  }
  verifyNativeAccount({mode:'native',serviceUser:plan.user,serviceUid:plan.uid,serviceGid:plan.gid},{run});
  const {ids,ranges}=scan();if(ids.has(plan.uid)||ids.has(plan.gid)||ranges.some(([start,end])=>plan.uid>=start&&plan.uid<end||plan.gid>=start&&plan.gid<end))throw Error('新分配身份出现进程/映射冲突，停止授权目录；不会终止其他进程');
}
export function verifyNativeAccount(state,{run=systemRun}={}){
  if(state.mode!=='native'||state.serviceUid===undefined&&state.serviceGid===undefined)return; // legacy deployments
  const user=nativeServiceUser(state),uid=state.serviceUid,gid=state.serviceGid;
  if(!Number.isInteger(uid)||uid<=0||!Number.isInteger(gid)||gid<=0)throw Error('部署服务UID/GID无效');
  const passwd=query(run,'passwd',user)?.split(':'),group=query(run,'group',user)?.split(':');
  if(!passwd||passwd[0]!==user||Number(passwd[2])!==uid||Number(passwd[3])!==gid||!group||group[0]!==user||Number(group[2])!==gid)throw Error('服务账号UID/GID发生变化，拒绝继续授权或启动；不会修改账号');
}
