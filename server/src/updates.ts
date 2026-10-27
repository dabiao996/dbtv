import type {Express} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {trustedBrowserOrigin} from './origin.js';
const releases=require('../../scripts/releases.cjs');
const database=require('../../scripts/web-database.cjs');

export function createUpdates({root=process.cwd(),fetcher=fetch,key=releases.publicKey(root),oneShot=process.platform==='darwin'&&process.env.DBTV_LOCAL_DIFF_UPDATES==='1'&&process.env.DBTV_DEV_WATCH==='1'&&process.env.NODE_ENV!=='production',launch}:{root?:string;fetcher?:typeof fetch;key?:string|null;oneShot?:boolean;launch?:()=>Promise<void>}={}){
  const directory=path.join(database.stateDirectory(root),'updates');
  const local=releases.current(root);
  let checkedAt=0,result:any=null,inflight:Promise<any>|null=null;
  const verified=new Map<string,{at:number;compatible:boolean}>();
  const writeLocalStatus=(value:any)=>{const file=path.join(directory,'status.json'),temp=path.join(directory,`.status-${randomUUID()}.tmp`);try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}};
  function state(){
    const file=path.join(directory,'status.json');
    if(!fs.existsSync(file))return {enabled:oneShot,mode:oneShot?'incremental':'managed',history:[],job:null};
    try{
      if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>131072)throw Error();
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      const job=value.job?{id:String(value.job.id||''),state:String(value.job.state||''),message:String(value.job.message||'').slice(0,400),version:String(value.job.version||''),at:String(value.job.at||'')}:null;
      if(oneShot&&job?.state==='queued'&&Date.now()-Date.parse(job.at)>60000){job.state='blocked';job.message='一次性任务未开始或没有报告进度；请在本机检查任务标记，未自动重试';}
      return {enabled:oneShot||value.enabled===true,mode:oneShot?'incremental':'managed',history:oneShot?[]:Array.isArray(value.history)?value.history.slice(0,10).map((x:any)=>({id:String(x.id||''),version:String(x.version||''),at:String(x.at||''),canRollback:x.canRollback===true,hasBackup:x.hasBackup===true})):[],job};
    }catch{return {enabled:false,mode:oneShot?'incremental':'managed',history:[],job:{state:'error',message:'更新状态无法读取，请检查本机更新任务'}};}
  }
  async function check(force=false,target?:string){
    if(target){
      releases.version(target);
      const selected=await releases.release({tag:target,key,fetcher});
      const compatible=selected.manifest.dataContract===local.dataContract;
      verified.set(target,{at:Date.now(),compatible});
      const choice={version:target,url:selected.url,notes:selected.notes,dataCompatible:compatible};
      result={...result,state:'checked',checkedAt:new Date().toISOString(),selected:choice};
      return result;
    }
    if(inflight)return inflight;
    if(checkedAt&&Date.now()-checkedAt<(force?15000:1800000))return result;
    checkedAt=Date.now();
    inflight=(async()=>{
      try{
        const remote=await releases.release({key,fetcher});
        const comparison=releases.compare(remote.manifest.version,local.version);
        const compatible=remote.manifest.dataContract===local.dataContract;
        verified.set(remote.manifest.version,{at:Date.now(),compatible});
        const choices=await releases.versions({fetcher}).catch(()=>[]);
        if(!choices.some((item:any)=>item.version===remote.manifest.version))choices.unshift({version:remote.manifest.version,url:remote.url});
        result={state:'checked',checkedAt:new Date().toISOString(),available:comparison!==0||local.channel==='development',latest:{version:remote.manifest.version,url:remote.url,notes:remote.notes,dataCompatible:compatible},selected:{version:remote.manifest.version,url:remote.url,notes:remote.notes,dataCompatible:compatible},choices};
      }catch(error:any){result={state:key?'error':'unconfigured',checkedAt:new Date().toISOString(),available:false,error:error.message};}
      return result;
    })().finally(()=>{inflight=null;});
    return inflight;
  }
  function info(){return {current:local,trustConfigured:!!key,check:result,agent:state()};}
  async function queue(action:string,target:string,actor:number){
    if(!key)throw Error('尚未配置发行签名公钥');
    const host=state();if(!host.enabled)throw Error('主机更新代理未启用，请先在主机运行enable-updates');
    if(['running','queued','blocked'].includes(host.job?.state||''))throw Error('另一个更新任务正在处理或需要人工恢复');
    if(oneShot&&(action!=='update'||fs.existsSync(path.join(directory,'incremental-active.json'))))throw Error('一次性增量任务仅支持正式版更新；未完成的任务须先人工检查');
    if(action==='update'){
      releases.version(target);
      const selected=verified.get(target);
      if(!selected||Date.now()-selected.at>1800000||target===local.version&&local.channel==='stable')throw Error('请先验证所选正式版本，不能重复安装当前正式版');
      if(!selected.compatible)throw Error('数据库兼容标识不同；未启动更新，需要单独决定迁移方式');
    } else if(action==='rollback'){
      if(!/^[a-f0-9-]{36}$/.test(target)||!host.history.some((x:any)=>x.id===target&&x.canRollback))throw Error('该记录不允许自动回退，可能存在数据兼容性差异');
    }else throw Error('无效操作');
    if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('更新队列目录不安全');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const id=randomUUID(),file=path.join(directory,'request.json'),temp=path.join(directory,`.${id}.tmp`);
    try{fs.writeFileSync(temp,JSON.stringify({id,action,target,actor,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});fs.linkSync(temp,file);}
    catch(error:any){if(error.code==='EEXIST')throw Error('已有待处理更新请求');throw error;}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    if(oneShot){
      writeLocalStatus({enabled:true,mode:'incremental',history:[],job:{id,state:'queued',version:target,message:'一次性任务已提交，正在启动签名校验',at:new Date().toISOString()}});
      try{
        if(launch)await launch();
        else await new Promise<void>((resolve,reject)=>{
          const env={HOME:process.env.HOME,PATH:process.env.PATH,DBTV_DATA_DIR:database.stateDirectory(root),PORT:process.env.PORT||'8787',NODE_ENV:'development',DBTV_LOCAL_DIFF_UPDATES:'1',DBTV_DEV_WATCH:'1'};
          const child=spawn(process.execPath,[path.join(root,'scripts/tv/incremental-worker.mjs'),root],{cwd:root,detached:true,stdio:'ignore',env});
          child.once('spawn',()=>{child.unref();resolve();});child.once('error',reject);
        });
      }catch{
        if(fs.existsSync(file))fs.unlinkSync(file);
        writeLocalStatus({enabled:true,mode:'incremental',history:[],job:{id,state:'failed',version:target,message:'一次性任务未能启动，程序和数据未修改',at:new Date().toISOString()}});
        throw Error('一次性更新任务未能启动，程序和数据未修改');
      }
    }
    return {id,state:'queued',message:oneShot?'一次性增量任务已启动；程序重载期间页面可能短暂断开':'请求已提交；主机代理将独立执行，重启期间页面可能短暂断开'};
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
      if(!trustedBrowserOrigin(req.headers.origin,req.get('host')))return res.status(403).json({error:'更新操作必须从受信任的网站后台发起'});
    }
    try{await work(req,res,user);}catch(error:any){res.status(400).json({error:error.message});}
  };
  app.get('/api/admin/updates',handle(async(_req:any,res:any)=>{await service.check();res.json(service.info());}));
  app.post('/api/admin/updates/check',handle(async(req:any,res:any)=>{
    if(req.body&&Object.keys(req.body).some(x=>x!=='target'))return res.status(400).json({error:'仅允许选择正式版本号'});
    res.json(await service.check(true,req.body?.target));
  }));
  app.post('/api/admin/updates/request',handle(async(req:any,res:any,user:any)=>{
    let attempt=attempts.get(user.id);if(!attempt||attempt.at+900000<Date.now()){if(attempts.size>1000)attempts.clear();attempt={at:Date.now(),count:0};attempts.set(user.id,attempt);}
    if(++attempt.count>5)return res.status(429).json({error:'敏感操作尝试过多，请15分钟后重试'});
    const {action,target,password,confirmed}=req.body||{};
    if(confirmed!==true||typeof password!=='string'||password.length>128||!deps.checkPassword(password,user.passwordHash))return res.status(403).json({error:'请确认操作并验证当前管理员密码'});
    if(typeof target!=='string'||!['update','rollback'].includes(action)||Object.keys(req.body).some(x=>!['action','target','password','confirmed'].includes(x)))return res.status(400).json({error:'请求包含不允许的操作或参数'});
    res.status(202).json(await service.queue(action,target,user.id));
  }));
}
