import type {Express} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const releases=require('../../scripts/releases.cjs');
const database=require('../../scripts/web-database.cjs');

export function createUpdates({root=process.cwd(),fetcher=fetch,key=releases.publicKey(root)}:{root?:string;fetcher?:typeof fetch;key?:string|null}={}){
  const directory=path.join(database.stateDirectory(root),'updates');
  const local=releases.current(root);
  let checkedAt=0,result:any=null,inflight:Promise<any>|null=null;
  function state(){
    const file=path.join(directory,'status.json');
    if(!fs.existsSync(file))return {enabled:false,history:[],job:null};
    try{
      if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>131072)throw Error();
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      return {enabled:value.enabled===true,history:Array.isArray(value.history)?value.history.slice(0,10).map((x:any)=>({id:String(x.id||''),version:String(x.version||''),at:String(x.at||''),canRollback:x.canRollback===true,hasBackup:x.hasBackup===true})):[],job:value.job?{id:String(value.job.id||''),state:String(value.job.state||''),message:String(value.job.message||'').slice(0,400),version:String(value.job.version||''),at:String(value.job.at||'')}:null};
    }catch{return {enabled:false,history:[],job:{state:'error',message:'更新状态无法读取，请检查主机代理'}};}
  }
  async function check(force=false){
    if(inflight)return inflight;
    if(checkedAt&&Date.now()-checkedAt<(force?15000:1800000))return result;
    checkedAt=Date.now();
    inflight=(async()=>{
      try{
        const remote=await releases.release({key,fetcher});
        const comparison=releases.compare(remote.manifest.version,local.version);
        result={state:'checked',checkedAt:new Date().toISOString(),available:comparison>0||comparison===0&&local.channel==='development',latest:{version:remote.manifest.version,url:remote.url,notes:remote.notes,dataCompatible:remote.manifest.dataContract===local.dataContract}};
      }catch(error:any){result={state:key?'error':'unconfigured',checkedAt:new Date().toISOString(),available:false,error:error.message};}
      return result;
    })().finally(()=>{inflight=null;});
    return inflight;
  }
  function info(){return {current:local,trustConfigured:!!key,check:result,agent:state()};}
  function queue(action:string,target:string,actor:number){
    if(!key)throw Error('尚未配置发行签名公钥');
    const host=state();if(!host.enabled)throw Error('主机更新代理未启用，请先在主机运行enable-updates');
    if(['running','queued','blocked'].includes(host.job?.state||''))throw Error('另一个更新任务正在处理或需要人工恢复');
    if(action==='update'){
      releases.version(target);
      if(!result?.available||result.latest.version!==target||Date.now()-checkedAt>1800000)throw Error('请先重新检查并确认最新正式版本');
    } else if(action==='rollback'){
      if(!/^[a-f0-9-]{36}$/.test(target)||!host.history.some((x:any)=>x.id===target&&x.canRollback))throw Error('该记录不允许自动回退，可能存在数据兼容性差异');
    }else throw Error('无效操作');
    if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('更新队列目录不安全');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const id=randomUUID(),file=path.join(directory,'request.json'),temp=path.join(directory,`.${id}.tmp`);
    try{fs.writeFileSync(temp,JSON.stringify({id,action,target,actor,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});fs.linkSync(temp,file);}
    catch(error:any){if(error.code==='EEXIST')throw Error('已有待处理更新请求');throw error;}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return {id,state:'queued',message:'请求已提交；主机代理将独立执行，重启期间页面可能短暂断开'};
  }
  return {info,check,queue};
}
export function registerUpdates(app:Express,deps:{requireAdmin:(req:any,res:any)=>Promise<any>;checkPassword:(password:string,hash:string)=>boolean},service=createUpdates()){
  const attempts=new Map<number,{at:number;count:number}>();
  const handle=(work:any)=>async(req:any,res:any)=>{
    const user=await deps.requireAdmin(req,res);if(!user)return;
    res.setHeader('Cache-Control','private, no-store');
    // Explicit same-origin requirement for mutations, independent of a router's outer CSRF gate.
    if(req.method!=='GET'){
      let accepted=false;try{const origin=new URL(String(req.headers.origin||''));accepted=origin.host===req.get('host')||origin.origin===process.env.APP_ORIGIN;}catch{}
      if(!accepted)return res.status(403).json({error:'更新操作必须从受信任的网站后台发起'});
    }
    try{await work(req,res,user);}catch(error:any){res.status(400).json({error:error.message});}
  };
  app.get('/api/admin/updates',handle(async(_req:any,res:any)=>{await service.check();res.json(service.info());}));
  app.post('/api/admin/updates/check',handle(async(_req:any,res:any)=>res.json(await service.check(true))));
  app.post('/api/admin/updates/request',handle(async(req:any,res:any,user:any)=>{
    let attempt=attempts.get(user.id);if(!attempt||attempt.at+900000<Date.now()){if(attempts.size>1000)attempts.clear();attempt={at:Date.now(),count:0};attempts.set(user.id,attempt);}
    if(++attempt.count>5)return res.status(429).json({error:'敏感操作尝试过多，请15分钟后重试'});
    const {action,target,password,confirmed}=req.body||{};
    if(confirmed!==true||typeof password!=='string'||password.length>128||!deps.checkPassword(password,user.passwordHash))return res.status(403).json({error:'请确认操作并验证当前管理员密码'});
    if(typeof target!=='string'||!['update','rollback'].includes(action)||Object.keys(req.body).some(x=>!['action','target','password','confirmed'].includes(x)))return res.status(400).json({error:'请求包含不允许的操作或参数'});
    res.status(202).json(service.queue(action,target,user.id));
  }));
}
