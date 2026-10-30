import type {Express} from 'express';
import {createHash} from 'node:crypto';
import {readRatingConfig} from './ratings.js';
import {readPagination,fixedPageWindow} from './pagination.js';

export const catalogModes=['rating','popular','year','month','week','new'] as const;
type CatalogMode=typeof catalogModes[number];
const iso=(date:Date)=>date.toISOString().slice(0,10);
export function catalogQuery(input:Record<string,unknown>,now=new Date()){
  const type=input.type==='tv'?'tv':input.type==='movie'||!input.type?'movie':null;
  const mode=(input.mode||'popular') as CatalogMode;
  if(!type||!catalogModes.includes(mode))throw Error('不支持的榜单类型');
  const page=Number(input.page||1);if(!Number.isInteger(page)||page<1||page>500)throw Error('页码需为 1–500');
  const genre=String(input.genre||''),country=String(input.country||''),language=String(input.language||''),year=String(input.year||'');
  if(genre&&!/^\d{1,6}$/.test(genre)||country&&!/^[A-Z]{2}$/.test(country)||language&&!/^[a-z]{2}$/.test(language)||year&&(!/^\d{4}$/.test(year)||+year<1880||+year>2200))throw Error('筛选条件无效');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const [y,m,d]=today.split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));
  if(mode==='week'){
    if(genre||country||language||year)throw Error('本周趋势不支持叠加分类、地区、年份或语言筛选');
    return {type,mode,page,path:`/trending/${type}/week`,params:new URLSearchParams({language:'zh-CN',page:String(page)}),note:'TMDB 最近 7 天趋势；不是实际播放次数。'};
  }
  if((mode==='year'||mode==='month')&&year)throw Error('本年、本月榜使用固定首映日期范围，请清除额外年份筛选');
  const params=new URLSearchParams({language:'zh-CN',page:String(page),include_adult:'false',sort_by:mode==='rating'?'vote_average.desc':mode==='new'?(type==='movie'?'primary_release_date.desc':'first_air_date.desc'):'popularity.desc'});
  if(type==='movie')params.set('include_video','false');
  const dateField=type==='movie'?'primary_release_date':'first_air_date';
  params.set(dateField+'.lte',today);
  if(mode==='rating')params.set('vote_count.gte',type==='movie'?'300':'100');
  if(mode==='new'){params.set(dateField+'.gte',iso(new Date(date.getTime()-90*86400000)));params.set('vote_count.gte','5');}
  if(mode==='year')params.set(dateField+'.gte',`${y}-01-01`);
  if(mode==='month')params.set(dateField+'.gte',`${y}-${String(m).padStart(2,'0')}-01`);
  if(year){params.set(dateField+'.gte',`${year}-01-01`);params.set(dateField+'.lte',+year<y?`${year}-12-31`:today);}
  if(genre)params.set('with_genres',genre);if(country)params.set('with_origin_country',country);if(language)params.set('with_original_language',language);
  const note=mode==='rating'?`按 TMDB 平均分降序；至少 ${type==='movie'?300:100} 人评分，不是豆瓣评分。`:mode==='year'||mode==='month'?`按${mode==='year'?'本年':'本月'}首次${type==='movie'?'上映':'开播'}作品的当前 TMDB 热度排序，不是该时段观看次数。`:mode==='new'?'按首次上映／开播日期降序，默认最近 90 天且至少 5 人评分；不含未来上映作品。':'按 TMDB 当前热度排序，不是播放次数。';
  return {type,mode,page,path:`/discover/${type}`,params,note};
}
export function catalogItems(rows:any[],type:string,page:number){return rows.filter(row=>row&&row.adult!==true&&Number.isInteger(row.id)&&row.id>0&&(row.title||row.name)).map((row,i)=>({
  id:row.id,type,title:String(row.title||row.name),originalTitle:String(row.original_title||row.original_name||''),
  year:Number(String(row.release_date||row.first_air_date||'').slice(0,4))||undefined,date:row.release_date||row.first_air_date||'',
  cover:typeof row.poster_path==='string'&&/^\/[a-zA-Z0-9_.-]+$/.test(row.poster_path)?'https://image.tmdb.org/t/p/w342'+row.poster_path:'',
  desc:String(row.overview||''),score:Number.isFinite(row.vote_average)&&row.vote_count>0?Math.round(row.vote_average*10)/10:null,votes:Math.max(0,Number(row.vote_count)||0),popularity:Number(row.popularity)||0,rank:(page-1)*20+i+1,
  url:`https://www.themoviedb.org/${type}/${row.id}`,
}));}
export function createCatalogClient(db:any,request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const cache=new Map<string,{expires:number;value:any}>(),pending=new Map<string,Promise<any>>();let active=0;const waiting:(()=>void)[]=[];
  async function load(path:string,params:URLSearchParams){
    const config=await readRatingConfig(db,env);if(!config.enabled)throw Error('评分与榜单服务已关闭，请联系管理员');if(!config.token)throw Error('请先在后台配置 TMDB 读取令牌');
    const key=createHash('sha256').update(config.token).digest('hex')+path+'?'+params;
    const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;
    if(pending.has(key))return pending.get(key);if(pending.size>=80)throw Error('榜单请求较多，请稍后再试');
    const task=(async()=>{if(active>=4)await new Promise<void>(resolve=>waiting.push(resolve));else active++;try{
      const response=await request('https://api.themoviedb.org/3'+path+'?'+params,{headers:{Authorization:`Bearer ${config.token}`,accept:'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok)throw Error('TMDB 请求失败');const value=await response.json();if(!Array.isArray(value.results)&&!Array.isArray(value.genres))throw Error('TMDB 数据格式异常');
      if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(key,{expires:Date.now()+900000,value});return value;
    }finally{const next=waiting.shift();if(next)next();else active--}})().finally(()=>pending.delete(key));pending.set(key,task);return task;
  }
  return {load};
}
export function registerCatalog(app:Express,db:any,auth:{requireUser:any},request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const {load}=createCatalogClient(db,request,env),limits=new Map<number,{at:number;count:number}>();
  async function access(req:any,res:any){const user=await auth.requireUser(req,res);if(!user)return false;let limit=limits.get(user.id);if(!limit||limit.at+60000<Date.now()){if(limits.size>=2000)limits.clear();limit={at:Date.now(),count:0};limits.set(user.id,limit)}if(++limit.count>60){res.status(429).json({error:'榜单请求过于频繁，请稍后再试'});return false}res.setHeader('Cache-Control','no-store');return true;}
  app.get('/api/catalog/options',async(req,res)=>{if(!await access(req,res))return;const type=req.query.type==='tv'?'tv':'movie';try{const data=await load(`/genre/${type}/list`,new URLSearchParams({language:'zh-CN'}));res.json({genres:data.genres.filter((x:any)=>Number.isInteger(x.id)&&typeof x.name==='string')})}catch{res.status(503).json({error:'无法读取 TMDB 分类，请检查令牌与服务器网络'})}});
  app.get('/api/catalog',async(req,res)=>{if(!await access(req,res))return;let query,paging,window;try{paging=readPagination(req.query as Record<string,unknown>,20);window=fixedPageWindow(paging.page,paging.pageSize);if(window.first>500)throw Error('已超出 TMDB 可访问的500个上游分页');query=catalogQuery({...req.query,page:String(window.first)} as Record<string,unknown>)}catch(e:any){return res.status(400).json({error:e.message})}try{
    const first=await load(query.path,query.params);if(!Array.isArray(first.results))throw Error('missing results');
    const upstreamPages=Math.min(500,Math.max(0,Number(first.total_pages)||0)),reportedTotal=Math.max(0,Number(first.total_results)||0),total=Math.min(reportedTotal,upstreamPages*20),totalPages=Math.ceil(total/paging.pageSize);
    const pageNumbers=Array.from({length:Math.max(0,Math.min(window.last,upstreamPages)-window.first)},(_,index)=>window.first+index+1);
    const following=await Promise.all(pageNumbers.map(page=>{const params=new URLSearchParams(query.params);params.set('page',String(page));return load(query.path,params)}));
    const raw=[first,...following].flatMap(data=>data.results).slice(window.skip,window.skip+paging.pageSize),seen=new Set<number>();
    const items=raw.flatMap(row=>catalogItems([row],query.type,1)).filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true}).map((item,index)=>({...item,rank:window.offset+index+1}));
    res.json({provider:'TMDB',...query,params:undefined,page:paging.page,pageSize:paging.pageSize,items,total,totalPages,hasMore:paging.page<totalPages,note:query.note+(reportedTotal>total?' TMDB 限制为前500个上游分页，数量为当前可翻页范围。':''),reportedTotal});
  }catch{res.status(503).json({error:'TMDB 榜单暂时不可用，请在后台测试令牌连接，或稍后重试。源内资源仍可正常浏览。'})}});
}
