import type {Express} from 'express';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {unlinkSync} from 'node:fs';
import {buildLiveCatalog,LIVE_CATALOG,LIVE_METADATA,liveCategories,readLiveLines,publicHttpUrl} from './live-catalog.js';
import {liveFetch} from './live-network.js';
import {LiveError,liveError,assertLiveManifest,checkLiveChannel} from './live-health.js';
import {mergeLiveSupplements} from './live-supplements.js';
import {liveFilePath,readLiveFile,replaceLiveCache,writeLiveFile,type LiveFile,type LiveFileChannel} from './live-file.js';

const stateKey='live:subscription';
export const countryName=(code:string)=>{try{return code==='ZZ'?'未标注地区':new Intl.DisplayNames(['zh-CN'],{type:'region'}).of(code)||code;}catch{return code;}};
export function liveWhere(query:any,admin=false){
  const where:any=admin?{}:{enabled:true,available:true};
  if(typeof query.country==='string'&&/^[A-Z]{2}$/.test(query.country))where.country=query.country;
  if(typeof query.category==='string'&&liveCategories[query.category])where.tags={contains:JSON.stringify(query.category)};
  if(typeof query.q==='string'&&query.q.trim())where.name={contains:query.q.trim().slice(0,100)};
  if(query.health==='reachable')Object.assign(where,{lastCheckedAt:{not:null},lastError:null});
  if(query.health==='failed')where.lastError={not:null};
  if(query.health==='unchecked')where.lastCheckedAt=null;
  if(admin&&query.state==='published')Object.assign(where,{enabled:true,available:true});
  if(admin&&query.state==='hidden')where.enabled=false;
  if(admin&&query.state==='missing')where.available=false;
  return where;
}
export function rewriteLiveManifest(text:string,base:string,link:(url:string)=>string){
  if(!text.trimStart().startsWith('#EXTM3U'))throw Error('线路不是可识别的 HLS 直播');
  const rewrite=(value:string)=>{const url=publicHttpUrl(new URL(value,base).href);if(!url)throw Error('直播包含不安全地址');return link(url);};
  return text.split(/\r?\n/).map(line=>line.startsWith('#')?line.replace(/URI="([^"\r\n]+)"/g,(_m,value)=>`URI="${rewrite(value)}"`):line.trim()?rewrite(line.trim()):line).join('\n');
}
export function createLiveService(db:any,request=liveFetch,root:string|null=request===liveFetch?process.cwd():null){
  let running:Promise<void>|null=null,phase='idle',error='';
  let file:LiveFile|null=null,fileError='',modifying=false;
  const ready=(async()=>{try{if(root)file=readLiveFile(root);if(file)await replaceLiveCache(db,file);}catch{fileError='直播 JSON 无效或无法载入；频道缓存未改动，请检查 live-tv.json';phase='error';}})();
  const ensureFile=()=>{if(fileError)throw Object.assign(Error(fileError),{status:503});};
  const state=async()=>{try{return JSON.parse((await db.setting.findUnique({where:{key:stateKey}}))?.value||'{}');}catch{return {};}};
  async function updateFile(next:LiveFile,change:()=>Promise<void>){
    const previous=file!;
    writeLiveFile(next,root!);
    try{await change();file=next;}
    catch(error){try{writeLiveFile(previous,root!);}catch{fileError='直播 JSON 写入后数据库更新失败，请重启服务从 JSON 恢复';}throw error;}
  }
  async function sync(actorId?:number){
    await ready;ensureFile();
    if(running||modifying)throw Object.assign(Error('直播目录正在更新'),{status:409});
    error='';phase='downloading';
    running=(async()=>{
      const sources=file?.sources||[{id:'iptv-org',name:'IPTV-org',playlistUrl:LIVE_CATALOG,metadataUrl:LIVE_METADATA}];
      const imported=(await Promise.all(sources.map(async source=>{
        const [list,info]=await Promise.all([request(source.playlistUrl,12*1024*1024),source.metadataUrl?request(source.metadataUrl,16*1024*1024):Promise.resolve(null)]);
        return buildLiveCatalog(list.body.toString('utf8'),info?JSON.parse(info.body.toString('utf8')):[]);
      }))).flat();
      if(!imported.length)throw Error('目录为空，保留原频道');
      const merged=new Map<string,(typeof imported)[number]>();
      for(const row of imported){const previous=merged.get(row.id);if(!previous){merged.set(row.id,row);continue;}
        const lines=readLiveLines(previous),seen=new Set(lines.map(line=>line.url));
        for(const line of readLiveLines(row))if(lines.length<30&&!seen.has(line.url)){lines.push(line);seen.add(line.url);}
        previous.rawConfig=JSON.stringify(lines);
      }
      const rows=mergeLiveSupplements([...merged.values()]);
      phase='saving';const previous=await state();
      if(file||root&&request===liveFetch&&await db.liveChannel.count()===0){
        const base:LiveFile=file||{version:1,sources,autoUpdate:false,lastUpdatedAt:null,channels:[]};
        const existing=new Map(base.channels.map(channel=>[channel.id,channel]));
        const channels=new Map(base.channels.map(channel=>[channel.id,{...channel,available:false}]));
        for(const row of rows){const old=existing.get(row.id);const channel:LiveFileChannel={
          id:row.id,name:row.name,country:row.country,categories:JSON.parse(row.tags),cover:row.cover,
          lines:readLiveLines(row),enabled:old?.enabled??true,available:true,
        };channels.set(row.id,channel);}
        const next:LiveFile={...base,lastUpdatedAt:new Date().toISOString(),channels:[...channels.values()]};
        const change=async()=>replaceLiveCache(db,next,{userId:actorId||null,action:'live.sync',detail:JSON.stringify({imported:rows.length,provider:sources.map(source=>source.id)})});
        if(file)await updateFile(next,change);
        else{writeLiveFile(next,root!);try{await change();file=next;}catch(error){unlinkSync(liveFilePath(root!));throw error;}}
        return;
      }
      await db.$transaction(async(tx:any)=>{
        const previousLines=new Map((await tx.liveChannel.findMany({select:{id:true,rawConfig:true}})).map((row:any)=>[row.id,row.rawConfig]));
        await tx.liveChannel.updateMany({data:{available:false}});
        // Existing publication choices and probe results survive every refresh.
        for(let i=0;i<rows.length;i+=100)await Promise.all(rows.slice(i,i+100).map(row=>tx.liveChannel.upsert({where:{id:row.id},create:row,update:{...row,...previousLines.get(row.id)===row.rawConfig?{}:{lastCheckedAt:null,lastError:null}}})));
        const value=JSON.stringify({...previous,lastUpdatedAt:new Date().toISOString(),imported:rows.length,autoUpdate:previous.autoUpdate!==false});
        await tx.setting.upsert({where:{key:stateKey},create:{key:stateKey,value},update:{value}});
        await tx.adminLog.create({data:{userId:actorId||null,action:'live.sync',detail:JSON.stringify({imported:rows.length,provider:'iptv-org'})}});
      },{timeout:180000,maxWait:10000});
    })().then(()=>{phase='idle';}).catch(()=>{error='更新失败，原有频道和上下架设置已保留，请稍后重试';phase='error';}).finally(()=>{running=null;});
    return {ok:true};
  }
  async function status(){await ready;return {...await state(),...file?{autoUpdate:file.autoUpdate,lastUpdatedAt:file.lastUpdatedAt}:fileError?{autoUpdate:false}:{},phase:fileError?'error':phase,error:fileError||error,fileError:!!fileError,busy:!!running,provider:file?.sources.map(source=>source.name).join('、')||'IPTV-org',fileConfigured:!!file,total:await db.liveChannel.count(),published:await db.liveChannel.count({where:{enabled:true,available:true}})};}
  async function scheduled(){await ready;if(fileError)return;const config=file||await state();if(running||!config.lastUpdatedAt||config.autoUpdate===false||Date.now()-Date.parse(config.lastUpdatedAt)<86400000)return;await sync();}
  async function updateSubscription(autoUpdate:boolean){await ready;ensureFile();if(running||modifying)throw Object.assign(Error('直播目录正在更新'),{status:409});
    modifying=true;try{if(file){const next={...file,autoUpdate};await updateFile(next,async()=>{const value=JSON.stringify({autoUpdate,lastUpdatedAt:next.lastUpdatedAt,imported:next.channels.length});await db.setting.upsert({where:{key:stateKey},create:{key:stateKey,value},update:{value}});});}
      else{const current=await state(),value=JSON.stringify({...current,autoUpdate});await db.setting.upsert({where:{key:stateKey},create:{key:stateKey,value},update:{value}});}}
    finally{modifying=false;}}
  async function publish(where:any,enabled:boolean,actorId?:number){await ready;ensureFile();if(running||modifying)throw Object.assign(Error('直播目录正在更新'),{status:409});
    modifying=true;try{if(file){const ids=new Set<string>((await db.liveChannel.findMany({where,select:{id:true}})).map((row:any)=>row.id));
        const next={...file,channels:file.channels.map(channel=>ids.has(channel.id)?{...channel,enabled}:channel)};
        let count=0;await updateFile(next,async()=>{await db.$transaction(async(tx:any)=>{const result=await tx.liveChannel.updateMany({where,data:{enabled}});count=result.count;await tx.adminLog.create({data:{userId:actorId||null,action:'live.publication',detail:JSON.stringify({enabled,count})}});});});return count;}
      const result=await db.$transaction(async(tx:any)=>{const changed=await tx.liveChannel.updateMany({where,data:{enabled}});await tx.adminLog.create({data:{userId:actorId||null,action:'live.publication',detail:JSON.stringify({enabled,count:changed.count})}});return changed;});return result.count;
    }finally{modifying=false;}}
  return {sync,status,scheduled,ready,updateSubscription,publish,settled:()=>running};
}

export function registerLive(app:Express,db:any,deps:{requireUser:any;requireAdmin:any},request=liveFetch,root:string|null=request===liveFetch?process.cwd():null){
  const service=createLiveService(db,request,root),secret=randomBytes(32);let active=0;
  const userActive=new Map<number,number>(),checkTimes=new Map<string,number>();
  const handle=(fn:any)=>async(req:any,res:any)=>{try{await fn(req,res);}catch(error:any){if(!res.headersSent){const safe=liveError(error);res.status(error.status||502).json({error:error.status?error.message:safe.message,code:error.status?'REQUEST_REJECTED':safe.code});}}};
  const access=async(req:any,res:any)=>{const user=await deps.requireUser(req,res);if(!user)return null;if(user.role!=='admin'&&!user.permissions?.includes('playback')){res.status(403).json({error:'当前会员没有播放权限'});return null;}return user;};
  const getChannel=async(id:string,admin=false)=>{await service.ready;return db.liveChannel.findFirst({where:{id,...admin?{}:{enabled:true,available:true}}});};
  const summary=(row:any,admin=false)=>{const lines=readLiveLines(row);return {id:row.id,name:row.name,country:row.country,countryName:countryName(row.country),categories:JSON.parse(row.tags),cover:row.cover,lineCount:lines.length,browserLines:lines.filter(x=>!x.restricted).length,lastCheckedAt:row.lastCheckedAt,lastError:row.lastError,health:!row.lastCheckedAt?'unchecked':row.lastError?'failed':'reachable',...admin?{enabled:row.enabled,available:row.available}:{}};};
  async function listing(req:any,res:any,admin=false){
    await service.ready;
    const where=liveWhere(req.query,admin),page=Math.max(1,Math.min(100000,Number.parseInt(String(req.query.page))||1)),pageSize=Math.max(1,Math.min(96,Number.parseInt(String(req.query.pageSize))||48));
    const [total,rows]=await Promise.all([db.liveChannel.count({where}),db.liveChannel.findMany({where,orderBy:[{country:'asc'},{name:'asc'},{id:'asc'}],skip:(page-1)*pageSize,take:pageSize})]);
    res.json({items:rows.map((row:any)=>summary(row,admin)),total,page,pageSize,pages:Math.ceil(total/pageSize)});
  }
  app.use('/api/admin/live',async(req,res,next)=>{if(await deps.requireAdmin(req,res))next();});
  app.get('/api/admin/live/status',handle(async(_req:any,res:any)=>res.json(await service.status())));
  app.post('/api/admin/live/sync',handle(async(req:any,res:any)=>res.status(202).json(await service.sync(req.authUser?.id))));
  app.put('/api/admin/live/subscription',handle(async(req:any,res:any)=>{
    if((await service.status()).busy)return res.status(409).json({error:'请等待当前目录更新完成后修改订阅'});
    if(typeof req.body?.autoUpdate!=='boolean'||Object.keys(req.body).some(key=>key!=='autoUpdate'))return res.status(400).json({error:'订阅设置无效'});
    await service.updateSubscription(req.body.autoUpdate);res.json({ok:true});
  }));
  app.get('/api/admin/live/channels',handle((req:any,res:any)=>listing(req,res,true)));
  app.put('/api/admin/live/publication',handle(async(req:any,res:any)=>{
    const body=req.body||{};if(typeof body.enabled!=='boolean'||Object.keys(body).some(key=>!['enabled','ids','filter'].includes(key))||body.ids!==undefined&&(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>96||body.ids.some((id:any)=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))||body.ids===undefined&&(!body.filter||typeof body.filter!=='object'||Array.isArray(body.filter)))return res.status(400).json({error:'请选择频道或确认筛选范围'});
    const where=body.ids?{id:{in:body.ids}}:liveWhere(body.filter,true);
    const count=await service.publish(where,body.enabled,req.authUser?.id);res.json({ok:true,count});
  }));
  app.post('/api/admin/live/channels/:id/check',handle(async(req:any,res:any)=>{
    const row=await getChannel(req.params.id,true);if(!row)return res.status(404).json({error:'频道不存在'});
    const last=checkTimes.get(row.id)||0;if(Date.now()-last<10000)return res.status(429).json({error:'请稍后再检测'});if(checkTimes.size>1000)checkTimes.clear();checkTimes.set(row.id,Date.now());
    const result=await checkLiveChannel(row,request);
    await db.liveChannel.update({where:{id:row.id},data:{lastCheckedAt:new Date(),lastError:result.ok?null:result.message}});res.json(result);
  }));
  app.get('/api/live/filters',handle(async(req:any,res:any)=>{
    if(!await access(req,res))return;const admin=req.query.admin==='true'&&req.authUser?.role==='admin';
    const rows=await db.liveChannel.findMany({where:admin?{}:{enabled:true,available:true},select:{country:true,tags:true}}),countries=new Map<string,number>(),categories=new Map<string,number>();
    for(const row of rows){countries.set(row.country,(countries.get(row.country)||0)+1);for(const key of JSON.parse(row.tags))categories.set(key,(categories.get(key)||0)+1);}
    res.json({countries:[...countries].map(([id,count])=>({id,name:countryName(id),count})).sort((a,b)=>a.id==='CN'?-1:b.id==='CN'?1:a.name.localeCompare(b.name,'zh-CN')),categories:[...categories].map(([id,count])=>({id,name:liveCategories[id]||id,count}))});
  }));
  app.get('/api/live/channels',handle(async(req:any,res:any)=>{if(await access(req,res))await listing(req,res);}));
  app.get('/api/live/channels/:id',handle(async(req:any,res:any)=>{
    if(!await access(req,res))return;const row=await getChannel(req.params.id);if(!row)return res.status(404).json({error:'频道已下架或不存在'});
    res.json({...summary(row),lines:readLiveLines(row).map((line,index)=>({index,name:line.name,restricted:line.restricted}))});
  }));
  function sign(user:number,id:string,url:string,expires:string){return createHmac('sha256',secret).update(JSON.stringify([user,id,url,expires])).digest('hex');}
  async function relay(req:any,res:any){
    const user=await access(req,res);if(!user)return;const row=await getChannel(req.params.id);if(!row)return res.status(404).json({error:'频道已下架或不存在'});
    let url:string,expires:string;
    if(req.params.line!==undefined){const index=Number(req.params.line);const line=Number.isInteger(index)&&index>=0?readLiveLines(row)[index]:null;if(!line||line.restricted)return res.status(422).json({error:'此线路需要特殊播放器或请求头，网页暂不支持'});url=line.url;expires=String(Date.now()+6*3600000);}
    else{url=String(req.query.url||'');expires=String(req.query.expires||'');const supplied=String(req.query.sig||'');if(!/^\d{13}$/.test(expires)||Number(expires)<Date.now()||Number(expires)>Date.now()+6*3600000||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(sign(user.id,row.id,url,expires),'hex'),Buffer.from(supplied,'hex')))return res.status(403).json({error:'直播地址签名已失效，请重新打开频道'});}
    if(active>=16||(userActive.get(user.id)||0)>=4)return res.status(429).json({error:'直播并发请求过多，请稍后'});
    active++;userActive.set(user.id,(userActive.get(user.id)||0)+1);
    try{
      const range=req.get('Range');if(range&&!/^bytes=\d{1,12}-\d{0,12}$/.test(range))return res.status(416).json({error:'不支持的分段范围'});
      const result=await request(url,16*1024*1024,0,range);const text=result.body.subarray(0,64).toString('utf8');
      if(req.params.line!==undefined||/\.m3u8$/i.test(new URL(url).pathname)||/mpegurl|text\/html/i.test(result.type))assertLiveManifest(result.body);
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(text.trimStart().startsWith('#EXTM3U')){
        const link=(child:string)=>`/api/live/channels/${row.id}/relay?${new URLSearchParams({url:child,expires,sig:sign(user.id,row.id,child,expires)})}`;
        res.type('application/vnd.apple.mpegurl').send(rewriteLiveManifest(result.body.toString('utf8'),result.url,link));
      }else{const type=/^(video\/|audio\/|application\/(octet-stream|mp4))/.test(result.type)?result.type:'application/octet-stream';if(result.range)res.status(206).setHeader('Content-Range',result.range);res.type(type).send(result.body);}
    }catch(error){
      const safe=liveError(error);
      // A failed alternate does not prove the whole multi-line channel is unavailable.
      if(error instanceof LiveError&&readLiveLines(row).filter(line=>!line.restricted).length===1)await db.liveChannel.update({where:{id:row.id},data:{lastCheckedAt:new Date(),lastError:safe.message}}).catch(()=>{});
      throw error;
    }finally{active--;const n=(userActive.get(user.id)||1)-1;if(n)userActive.set(user.id,n);else userActive.delete(user.id);}
  }
  app.get('/api/live/channels/:id/stream/:line',handle(relay));
  app.get('/api/live/channels/:id/relay',handle(relay));
  const timer=setInterval(()=>void service.scheduled().catch(()=>{}),60000);timer.unref();
  return service;
}
