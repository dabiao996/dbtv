import {createHash} from 'node:crypto';
import type {Express} from 'express';

type Film={title:string;year?:number;category?:string};
export type Rating={provider:'TMDB';score:number;votes:number;url:string;matchedTitle:string;year?:number;updatedAt:string};
type Result={status:'matched'|'unmatched'|'unavailable'|'disabled'|'unconfigured';rating?:Rating};
const prefix='rating:',cachePrefix=prefix+'cache:';
const DAY=86400000;
export const publicSettingsRows=(rows:{key:string;value:string}[])=>rows.filter(row=>!row.key.startsWith(prefix)&&!row.key.startsWith('recommend:')&&!row.key.startsWith('live:')&&!row.key.startsWith('ai:'));
export async function readRatingConfig(db:any,env:NodeJS.ProcessEnv=process.env){const rows=await db.setting.findMany({where:{key:{in:[prefix+'enabled',prefix+'token']}}});const settings=Object.fromEntries(rows.map((x:any)=>[x.key,x.value]));return {enabled:settings[prefix+'enabled']!=='false',token:String(env.TMDB_READ_ACCESS_TOKEN||settings[prefix+'token']||'').trim()};}
const normal=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
function mediaType(category=''):'movie'|'tv'|undefined{
  if(/动漫电影|动画电影|电影|片$/.test(category)&&!/纪录片/.test(category))return 'movie';
  if(/剧|综艺|连续|番剧/.test(category))return 'tv';
}
function eligible(film:Film){return !/成人|情色|色情|福利|伦理|av\b|三级|无码|有碼|有码|黑料|杏吧|香奶/i.test(film.category||'');}
export function matchRating(film:Film,rows:any[],now=new Date()):Rating|undefined{
  const type=mediaType(film.category),title=normal(film.title);
  const matches=rows.filter(row=>{
    if(!['movie','tv'].includes(row.media_type)||row.adult===true||type&&row.media_type!==type)return false;
    if(![row.title,row.name,row.original_title,row.original_name].some(name=>typeof name==='string'&&normal(name)===title))return false;
    const year=Number(String(row.release_date||row.first_air_date||'').slice(0,4));
    return (!film.year||year===film.year)&&Number.isInteger(row.id)&&row.id>0;
  });
  const unique=[...new Map(matches.map(row=>[row.media_type+':'+row.id,row])).values()];
  if(unique.length!==1)return;
  const row=unique[0],score=Number(row.vote_average),votes=Number(row.vote_count);
  if(!Number.isFinite(score)||score<0||score>10||!Number.isInteger(votes)||votes<1)return;
  return {provider:'TMDB',score:Math.round(score*10)/10,votes,url:`https://www.themoviedb.org/${row.media_type}/${row.id}`,matchedTitle:row.title||row.name,year:Number(String(row.release_date||row.first_air_date||'').slice(0,4))||undefined,updatedAt:now.toISOString()};
}
export function createRatingService(db:any,request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const pending=new Map<string,Promise<Result>>(),failures=new Map<string,number>();
  let revision=0,nextPrune=0,active=0;
  const waiting:(()=>void)[]=[];
  async function limited<T>(task:()=>Promise<T>):Promise<T>{
    if(active>=4)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
    try{return await task()}finally{const next=waiting.shift();if(next)next();else active--}
  }
  async function config(){return readRatingConfig(db,env);}
  async function status(){const c=await config();return {enabled:c.enabled,configured:!!c.token,credentialSource:env.TMDB_READ_ACCESS_TOKEN?'environment':'database',provider:'TMDB'};}
  async function testConnection(){const c=await config();if(!c.token)return {ok:false,message:'尚未配置 TMDB 读取令牌'};try{const response=await request('https://api.themoviedb.org/3/authentication',{headers:{Authorization:`Bearer ${c.token}`,accept:'application/json'},signal:AbortSignal.timeout(6000),redirect:'error'});if(response.status===401||response.status===403)return {ok:false,message:'令牌无效或无权访问，请填写 API Read Access Token'};if(!response.ok)return {ok:false,message:'TMDB 暂时不可用，请稍后重试'};const body=await response.json();return body.success===true?{ok:true,message:'TMDB 连接正常，令牌有效'}:{ok:false,message:'TMDB 未确认授权成功'}}catch{return {ok:false,message:'无法连接 TMDB，请检查服务器网络后重试'}}}
  async function save(body:any){
    const entries=[{key:prefix+'enabled',value:String(body.enabled===true)}];
    if(body.token!==undefined){if(typeof body.token!=='string'||body.token.length>4096||/[\r\n]/.test(body.token))throw Error('invalid');const token=body.token.trim();if(token)entries.push({key:prefix+'token',value:token});}
    if(body.clearToken===true)entries.push({key:prefix+'token',value:''});
    const unique=[...new Map(entries.map(x=>[x.key,x])).values()];
    await db.$transaction([...unique.map(x=>db.setting.upsert({where:{key:x.key},create:x,update:{value:x.value}})),db.setting.deleteMany({where:{key:{startsWith:cachePrefix}}})]);
    revision++;pending.clear();failures.clear();return status();
  }
  async function lookup(film:Film):Promise<Result>{
    const c=await config();if(!c.enabled)return {status:'disabled'};if(!c.token)return {status:'unconfigured'};if(!eligible(film))return {status:'unmatched'};
    const key=cachePrefix+createHash('sha256').update(JSON.stringify([normal(film.title),film.year||0,mediaType(film.category)||'any'])).digest('hex');
    if((failures.get(key)||0)>Date.now())return {status:'unavailable'};
    const existing=pending.get(key);if(existing)return existing;
    if(pending.size>=160)return {status:'unavailable'};
    const version=revision;
    const task=(async():Promise<Result>=>{
      const cached=await db.setting.findUnique({where:{key}});try{const value=JSON.parse(cached?.value||'null');if(value?.expires>Date.now())return value.result}catch{}
      return limited(async()=>{
        const url=new URL('https://api.themoviedb.org/3/search/multi');url.search=new URLSearchParams({query:film.title,language:'zh-CN',include_adult:'false',page:'1'}).toString();
        const response=await request(url,{headers:{Authorization:`Bearer ${c.token}`,accept:'application/json'},signal:AbortSignal.timeout(6000),redirect:'error'});
        if(!response.ok)throw Error('provider unavailable');
        const body=await response.json();if(!Array.isArray(body.results))throw Error('invalid response');
        const rating=matchRating(film,body.results),result:Result=rating?{status:'matched',rating}:{status:'unmatched'};
        if(version===revision){
          const value=JSON.stringify({expires:Date.now()+DAY,result});await db.setting.upsert({where:{key},create:{key,value},update:{value}});
          if(nextPrune<Date.now()){nextPrune=Date.now()+600000;const rows=await db.setting.findMany({where:{key:{startsWith:cachePrefix}},select:{key:true,value:true}});const keep=rows.map((x:any)=>{let expires=0;try{expires=JSON.parse(x.value).expires||0}catch{}return {key:x.key,expires}}).sort((a:any,b:any)=>b.expires-a.expires);const remove=keep.filter((x:any,i:number)=>i>=1000||x.expires<Date.now()).map((x:any)=>x.key);if(remove.length)await db.setting.deleteMany({where:{key:{in:remove}}});}
        }
        return result;
      });
    })().catch(()=>{if(failures.size>=1000)failures.clear();failures.set(key,Date.now()+60000);return {status:'unavailable'} as Result}).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  }
  return {status,save,lookup,testConnection};
}
export function registerRatings(app:Express,db:any,deps:{requireUser:any;requireAdmin:any},request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const service=createRatingService(db,request,env),limits=new Map<number,{at:number;count:number}>();
  app.get('/api/ratings/status',async(req,res)=>{if(!await deps.requireUser(req,res))return;const {enabled,configured,provider}=await service.status();res.json({enabled,configured,provider});});
  app.post('/api/ratings/lookup',async(req,res)=>{
    const user=await deps.requireUser(req,res);if(!user)return;
    if(!Array.isArray(req.body?.items)||!req.body.items.length||req.body.items.length>20)return res.status(400).json({error:'每批需包含 1–20 部影片'});
    const items:Film[]=req.body.items.map((x:any)=>({title:typeof x?.title==='string'?x.title.trim():'',year:x?.year?Number(x.year):undefined,category:typeof x?.category==='string'?x.category:''}));
    if(items.some(x=>!x.title||x.title.length>160||String(x.category).length>80||x.year!==undefined&&(!Number.isInteger(x.year)||x.year<1880||x.year>2200)))return res.status(400).json({error:'影片资料无效'});
    let limit=limits.get(user.id);if(!limit||limit.at+60000<Date.now()){limit={at:Date.now(),count:0};if(limits.size>=2000)limits.clear();limits.set(user.id,limit)}limit.count+=items.length;if(limit.count>120)return res.status(429).json({error:'评分请求过多，请稍后再试'});
    res.setHeader('Cache-Control','no-store');res.json({items:await Promise.all(items.map(x=>service.lookup(x)))});
  });
  app.get('/api/admin/ratings',async(req,res)=>{if(!await deps.requireAdmin(req,res))return;res.setHeader('Cache-Control','no-store');res.json(await service.status());});
  app.post('/api/admin/ratings/test',async(req,res)=>{if(!await deps.requireAdmin(req,res))return;res.setHeader('Cache-Control','no-store');res.json(await service.testConnection());});
  app.put('/api/admin/ratings',async(req,res)=>{if(!await deps.requireAdmin(req,res))return;res.setHeader('Cache-Control','no-store');try{res.json(await service.save(req.body||{}))}catch{res.status(400).json({error:'无法保存，请检查令牌格式'})}});
}
