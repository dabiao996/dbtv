export const MAX_SOURCE_JSON_BYTES=1024*1024;
export type SourceImportMode='merge'|'replace';
export type SourceImportPreview={rawConfig:string;name:string;sites:{key:string;name:string;type:string}[]};

export function parseSourceJson(raw:string):SourceImportPreview{
  if(new TextEncoder().encode(raw).byteLength>MAX_SOURCE_JSON_BYTES)throw Error('JSON 文件不能超过 1 MiB（1,048,576 字节）');
  let config:any;const rawConfig=raw.replace(/^\uFEFF/,'').trim();
  try{config=JSON.parse(rawConfig)}catch{throw Error('文件不是有效的 JSON，请检查格式后重新选择')}
  if(!config||typeof config!=='object'||Array.isArray(config)||!Array.isArray(config.sites)||!config.sites.length)throw Error('配置必须包含非空的 sites 数组');
  if(config.name!==undefined&&(typeof config.name!=='string'||!config.name.trim()||config.name.trim().length>200||/[\x00-\x1f\x7f]/.test(config.name)))throw Error('配置 name 必须为 1–200 字符且不能包含控制字符');
  if(config.sites.length>500)throw Error('每次最多导入 500 个源');
  const seen=new Set<string>();
  const sites=config.sites.map((site:any,index:number)=>{
    if(!site||typeof site!=='object'||Array.isArray(site)||typeof site.key!=='string'||!site.key.trim()||typeof site.name!=='string'||!site.name.trim())throw Error(`第 ${index+1} 个源必须填写非空的字符串 key 和 name`);
    const key=site.key.trim(),name=site.name.trim();
    if(key.length>191||/[\s\x00-\x1f\x7f/\\?:#]/.test(key))throw Error(`第 ${index+1} 个源的 key 无效：最多 191 字符，不能包含空白、控制字符或 /\\?:#`);
    if(name.length>200||/[\x00-\x1f\x7f]/.test(name))throw Error(`第 ${index+1} 个源的 name 最多 200 字符，不能包含控制字符`);
    if(![undefined,'tvbox-json','local','manual',0,1].includes(site.type))throw Error(`第 ${index+1} 个源的 type 不受支持`);
    if(typeof site.api!=='string'||!site.api.trim()||site.api.trim().length>2048||/[\s\x00-\x1f\x7f]/.test(site.api.trim()))throw Error(`第 ${index+1} 个源需要有效的 api（非空、最多 2048 字符且不含空白）`);
    if(!['local','manual'].includes(site.type)){try{const url=new URL(site.api.trim());if(!['http:','https:'].includes(url.protocol))throw Error('protocol')}catch{throw Error(`第 ${index+1} 个远程源的 api 必须是 HTTP 或 HTTPS 地址`)}}
    for(const flag of ['enabled','searchable','quickSearch','filterable'])if(site[flag]!==undefined&&![true,false,0,1,'0','1'].includes(site[flag]))throw Error(`第 ${index+1} 个源的 ${flag} 仅支持布尔值或 0/1`);
    if(seen.has(key))throw Error(`源 key 重复：${key}`);seen.add(key);
    return {key,name,type:site.type==='local'?'本地源':site.type==='manual'?'手动源':'TVBox 源'};
  });
  return {rawConfig,name:typeof config.name==='string'?config.name.trim():'',sites};
}
export async function readSourceJsonFile(file:{size:number;text:()=>Promise<string>}):Promise<SourceImportPreview>{
  if(file.size>MAX_SOURCE_JSON_BYTES)throw Error('JSON 文件不能超过 1 MiB（1,048,576 字节）');
  return parseSourceJson(await file.text());
}
export function sourceImportPayload(preview:SourceImportPreview,mode:SourceImportMode,confirmed:boolean){
  if(mode!=='merge'&&mode!=='replace')throw Error('请选择有效的导入方式');
  if(mode==='replace'&&!confirmed)throw Error('请先确认替换会删除文件中未包含的现有源');
  return {rawConfig:preview.rawConfig,mode,...mode==='replace'?{confirmReplace:true}:{}};
}
export function replacedSourceKeys(existing:{key:string}[],incoming:{key:string}[]){const keep=new Set(incoming.map(site=>site.key));return [...new Set(existing.map(site=>site.key))].filter(key=>!keep.has(key))}
