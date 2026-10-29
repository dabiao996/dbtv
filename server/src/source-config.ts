import type {Express} from 'express';

export const MAX_SOURCE_CONFIG_BYTES=1024*1024;
export class SourceConfigError extends Error {constructor(public status:number,message:string){super(message)}}
const fail=(message:string,status=400):never=>{throw new SourceConfigError(status,message)};
const object=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
function flag(value:any,label:string):boolean|undefined{
  if(value===undefined)return undefined;
  if(value===true||value===1||value==='1')return true;
  if(value===false||value===0||value==='0')return false;
  return fail(`${label} 只能是布尔值或 0/1`);
}
export function parseSourceConfig(rawConfig:unknown){
  if(typeof rawConfig!=='string')return fail('rawConfig 必须是 JSON 文本');
  if(Buffer.byteLength(rawConfig,'utf8')>MAX_SOURCE_CONFIG_BYTES)return fail('配置文件不能超过 1 MiB',413);
  const raw=rawConfig.replace(/^\uFEFF/,'').trim();
  let config:any;try{config=JSON.parse(raw)}catch{return fail('JSON 格式无效')}
  if(!object(config)||!Array.isArray(config.sites)||!config.sites.length||config.sites.length>500)return fail('配置必须包含 1–500 项的 sites 数组');
  let name:string|undefined;
  if(config.name!==undefined){if(typeof config.name!=='string'||!config.name.trim()||config.name.trim().length>200||/[\x00-\x1f\x7f]/.test(config.name))return fail('配置名称必须为 1–200 字');name=config.name.trim();}
  const keys=new Set<string>();
  const sites=config.sites.map((item:any,index:number)=>{
    const label=`第 ${index+1} 个源`;
    if(!object(item))return fail(`${label} 必须是对象`);
    const key=typeof item.key==='string'?item.key.trim():'';
    if(!key||key.length>191||/[\s/\\?:#\x00-\x1f\x7f]/.test(key))return fail(`${label} 的 key 无效：长度 1–191，不能包含空白或路径分隔符`);
    if(keys.has(key))return fail(`${label} 的 key 重复`);keys.add(key);
    const name=typeof item.name==='string'?item.name.trim():'';
    if(!name||name.length>200||/[\x00-\x1f\x7f]/.test(name))return fail(`${label} 的 name 必须为 1–200 字`);
    const inputType=item.type===undefined?'tvbox-json':item.type;
    if(!['tvbox-json','local','manual',0,1].includes(inputType))return fail(`${label} 的 type 只支持 local、manual、tvbox-json 或数字 0/1`);
    const type=typeof inputType==='number'?'tvbox-json':inputType as string;
    const api=typeof item.api==='string'?item.api.trim():'';
    if(!api||api.length>2048||/[\s\x00-\x1f\x7f]/.test(api))return fail(`${label} 的 api 必须是 1–2048 字且不含空白的地址`);
    if(type==='tvbox-json'){let parsed:URL;try{parsed=new URL(api)}catch{return fail(`${label} 的 api 必须是 HTTP/HTTPS 地址`)}if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname)return fail(`${label} 的 api 必须是 HTTP/HTTPS 地址`);}
    const enabled=flag(item.enabled,`${label} enabled`),searchable=flag(item.searchable,`${label} searchable`),quickSearch=flag(item.quickSearch,`${label} quickSearch`),filterable=flag(item.filterable,`${label} filterable`);
    // Keep only this source's raw record, not N copies of the entire uploaded file.
    return {key,name,type,api,rawConfig:JSON.stringify(item),...enabled===undefined?{}:{enabled},...searchable===undefined?{}:{searchable},...quickSearch===undefined?{}:{quickSearch},...filterable===undefined?{}:{filterable}};
  });
  return {name,sites};
}

export function createSourceConfigService(db:any){
  async function importJson(body:any){
    if(!object(body)||Object.keys(body).some(key=>!['rawConfig','mode','confirmReplace'].includes(key)))return fail('导入请求包含无效字段');
    const mode=body.mode===undefined?'merge':body.mode;if(mode!=='merge'&&mode!=='replace')return fail('导入模式必须是 merge 或 replace');
    if(body.confirmReplace!==undefined&&typeof body.confirmReplace!=='boolean')return fail('confirmReplace 必须是布尔值');
    if(mode==='replace'&&body.confirmReplace!==true)return fail('替换会删除未包含的源及关联影片、分类绑定、账号源授权，请先明确确认');
    const config=parseSourceConfig(body.rawConfig),keys=config.sites.map((site:any)=>site.key);
    return db.$transaction(async(tx:any)=>{
      const existing=await tx.source.findMany({where:{key:{in:keys}},select:{key:true}}),known=new Set(existing.map((row:any)=>row.key));
      const removed=mode==='replace'?await tx.source.deleteMany({where:{key:{notIn:keys}}}):{count:0};
      for(const site of config.sites){
        const {key,...data}=site;const saved=await tx.source.upsert({where:{key},update:data,create:{key,...data}});
        // MySQL collations may equate keys which JavaScript regards as distinct.
        // Never silently adopt or overwrite a differently spelled source identity.
        if(saved.key!==key)return fail('源 key 与数据库现有标识存在大小写或排序规则冲突，未保存任何更改',409);
      }
      // A source-only upload must not reset the site's existing branding.
      if(config.name!==undefined)await tx.setting.upsert({where:{key:'siteName'},update:{value:config.name},create:{key:'siteName',value:config.name}});
      return {ok:true,mode,sites:config.sites.length,created:keys.filter((key:string)=>!known.has(key)).length,updated:known.size,removed:removed.count};
    },{maxWait:5000,timeout:30000});
  }
  return {importJson};
}

export function registerSourceConfigImport(app:Express,db:any,deps:{requireAdmin:(req:any,res:any)=>Promise<any>;invalidate:()=>void},service=createSourceConfigService(db)){
  app.post('/api/config/import-json',async(req,res)=>{
    if(!await deps.requireAdmin(req,res))return;
    try{const result=await service.importJson(req.body);deps.invalidate();res.json(result)}
    catch(error:any){res.status(error instanceof SourceConfigError?error.status:500).json({error:error instanceof SourceConfigError?error.message:'配置导入未完成，请刷新后核对配置；请勿重复执行替换操作'});}
  });
  return service;
}
