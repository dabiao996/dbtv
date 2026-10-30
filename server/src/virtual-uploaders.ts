import type {Express} from 'express';
import {createHash} from 'node:crypto';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
class VirtualUploaderError extends Error {constructor(public status:number,message:string){super(message)}}
const fail=(status:number,message:string):never=>{throw new VirtualUploaderError(status,message)};
const batchId=(requestId:string)=>hash(['virtual-uploader-batch',requestId]);
const profileId=(batch:string,index:number)=>hash([batch,index]);
const DISPLAY_NAMES=['花开富贵','月下听风','星河漫游','清风徐来','山海有期','青梅煮酒','南风知我意','CinemaSoul','BlueOrbit','MidnightCat','PixelVoyager','LuckySeven'];
export function virtualVideoKey(item:any):string|null{
  if(!item||typeof item.title!=='string'||typeof item.sourceKey!=='string'||!item.sourceKey||item.sourceKey.length>191)return null;
  let id=item.videoId??item.id;
  if(typeof id!=='string'&&typeof id!=='number')return null;
  id=String(id);if(!id||id.length>2048)return null;
  // Remote IDs are often returned source-prefixed, while history uses the raw ID.
  if(id.startsWith(item.sourceKey+':'))id=id.slice(item.sourceKey.length+1);
  return hash([item.sourceKey,id]);
}
export function virtualProfileInput(body:any){
  const name=typeof body?.name==='string'?body.name.trim():'';
  if(!name||name.length>40||/[\x00-\x1f\x7f]/.test(name)||typeof body?.enabled!=='boolean')return fail(400,'请填写 1–40 字展示名称和有效的启用状态');
  const avatarUrl=body.avatarUrl===null||body.avatarUrl===undefined?'':typeof body.avatarUrl==='string'?body.avatarUrl.trim():null;
  if(avatarUrl===null||avatarUrl.length>2048)return fail(400,'头像地址无效');
  // Images are rendered in a browser, never fetched by this server. Restrict to HTTPS
  // or same-origin absolute paths; reject credentials, protocol-relative and control URLs.
  if(avatarUrl){
    if(/[\s\\\x00-\x1f\x7f]/.test(avatarUrl))return fail(400,'头像地址无效');
    if(avatarUrl.startsWith('/')){if(avatarUrl.startsWith('//'))return fail(400,'头像地址无效');}
    else {let url:URL;try{url=new URL(avatarUrl)}catch{return fail(400,'头像仅支持 HTTPS 或站内路径')}if(url.protocol!=='https:'||url.username||url.password)return fail(400,'头像仅支持 HTTPS 或站内路径');}
  }
  return {name,avatarUrl:avatarUrl||null,enabled:body.enabled};
}

export function createVirtualUploaderService(db:any){
  const list=()=>db.virtualUploader.findMany({orderBy:[{createdAt:'asc'},{id:'asc'}]});
  async function clear(){
    return db.$transaction(async(tx:any)=>{
      const attributions=await tx.videoAttribution.deleteMany({});
      const profiles=await tx.virtualUploader.deleteMany({});
      return {attributions:attributions.count,profiles:profiles.count};
    });
  }
  async function generate(body:any){
    if(!Number.isInteger(body?.count)||body.count<1||body.count>100||typeof body.requestId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId))return fail(400,'每批生成 1–100 个虚拟展示用户，并提供有效请求标识');
    const id=batchId(body.requestId),count=body.count,ids=Array.from({length:count},(_,i)=>profileId(id,i));
    const replay=async()=>{const batch=await db.virtualUploaderBatch.findUnique({where:{id}});if(!batch)return null;if(batch.count!==count)return fail(409,'同一请求标识不能用于不同生成数量');const items=await db.virtualUploader.findMany({where:{id:{in:ids}},orderBy:{id:'asc'}});return {items,replayed:true,cleared:items.length===0};};
    const previous=await replay();if(previous)return previous;
    try{return await db.$transaction(async(tx:any)=>{
      await tx.virtualUploaderBatch.create({data:{id,count}});
      // Stable IDs make the transaction safe to recover after an uncertain commit.
      await tx.virtualUploader.createMany({data:ids.map((profile,index)=>({id:profile,name:DISPLAY_NAMES[index%DISPLAY_NAMES.length]+(index>=DISPLAY_NAMES.length?` · ${profile.slice(0,5)}`:''),avatarUrl:null,enabled:true}))});
      const items=await tx.virtualUploader.findMany({where:{id:{in:ids}},orderBy:{id:'asc'}});
      return {items,replayed:false};
    });}catch(error:any){
      // Do not repeat writes here. Only read back a committed batch, including a
      // concurrent duplicate request or a response lost after commit.
      const committed=await replay();if(committed)return committed;throw error;
    }
  }
  async function update(id:string,body:any){
    if(!/^[a-f0-9]{64}$/.test(id))return fail(404,'虚拟展示用户不存在');
    const data=virtualProfileInput(body);
    try{return await db.virtualUploader.update({where:{id},data});}catch(error:any){if(error.code==='P2025')return fail(404,'虚拟展示用户不存在');throw error;}
  }
  async function enrich(body:any){
    const videos=new Map<string,any[]>(),seen=new Set<any>();
    const visit=(value:any)=>{
      if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
      if(Array.isArray(value)){value.forEach(visit);return;}
      const key=virtualVideoKey(value);
      if(key){
        // Clear legacy/account-derived or upstream claims even if enrichment fails.
        // Only this independent presentation service may emit the uploader field.
        delete value.uploader;const rows=videos.get(key)||[];rows.push(value);videos.set(key,rows);
      }
      for(const field of ['items','list','variants'])if(Array.isArray(value[field]))visit(value[field]);
    };
    visit(body);if(!videos.size)return body;
    const keys=[...videos.keys()];
    const saved=await db.videoAttribution.findMany({where:{videoKey:{in:keys}},include:{uploader:true}});
    const assigned=new Map<string,any>(saved.map((row:any)=>[row.videoKey,row]));
    const missing=keys.filter(key=>!assigned.has(key));
    if(missing.length){
      const enabled=await db.virtualUploader.findMany({where:{enabled:true},orderBy:{id:'asc'}});
      if(enabled.length)for(const key of missing){
        const chosen=enabled[Number(BigInt('0x'+key.slice(0,12))%BigInt(enabled.length))];
        let assignment;
        try{assignment=await db.videoAttribution.upsert({where:{videoKey:key},update:{},create:{videoKey:key,uploaderId:chosen.id},include:{uploader:true}})}
        catch(error:any){if(error.code!=='P2002')throw error;assignment=await db.videoAttribution.findUnique({where:{videoKey:key},include:{uploader:true}});if(!assignment)throw error;}
        assigned.set(key,assignment);
      }
    }
    for(const [key,rows] of videos){const profile=assigned.get(key)?.uploader;if(profile?.enabled)for(const item of rows)item.uploader={name:profile.name,avatarUrl:profile.avatarUrl,virtual:true};}
    return body;
  }
  return {list,generate,update,clear,enrich};
}

export function registerVirtualUploaders(app:Express,db:any,auth:{requireAdmin:(req:any,res:any)=>Promise<any>},service=createVirtualUploaderService(db)){
  const route=(operation:(req:any)=>Promise<any>)=>async(req:any,res:any)=>{
    if(!await auth.requireAdmin(req,res))return;
    try{res.json(await operation(req));}catch(error:any){if(error instanceof VirtualUploaderError)return res.status(error.status).json({error:error.message});throw error;}
  };
  app.get('/api/admin/virtual-uploaders',route(async()=>({items:await service.list()})));
  app.post('/api/admin/virtual-uploaders/generate',route(req=>service.generate(req.body)));
  app.put('/api/admin/virtual-uploaders/:id',route(req=>service.update(String(req.params.id),req.body)));
  if(typeof (app as any).delete==='function')(app as any).delete('/api/admin/virtual-uploaders',route(()=>service.clear()));
  return service;
}
