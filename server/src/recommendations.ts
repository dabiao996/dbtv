import type {Express} from 'express';
import {createHash} from 'node:crypto';
import {catalogItems,catalogQuery,createCatalogClient} from './catalog.js';
import {matchRating,readRatingConfig} from './ratings.js';

const DAY=86400000,VERSION=2;
export const tasteGenres=[
  {key:'scifi',name:'科幻／奇幻',movie:878,tv:10765},{key:'action',name:'动作冒险',movie:28,tv:10759},
  {key:'animation',name:'动画',movie:16,tv:16},{key:'comedy',name:'喜剧',movie:35,tv:35},
  {key:'mystery',name:'悬疑',movie:9648,tv:9648},{key:'drama',name:'剧情',movie:18,tv:18},
  {key:'crime',name:'犯罪',movie:80,tv:80},{key:'documentary',name:'纪录',movie:99,tv:99},
  {key:'romance',name:'爱情',movie:10749,tv:0},{key:'thriller',name:'惊悚',movie:53,tv:0},
];
type Preferences={genres:string[];type:'both'|'movie'|'tv';useHistory:boolean;useFavorites:boolean;blocked:string[]};
type Signal={title:string;year?:number;category?:string;weight:number;favorite:boolean;watched?:boolean;at:string};
type Candidate={id:number;type:'movie'|'tv';title:string;originalTitle:string;year?:number;date:string;cover:string;desc:string;score:number|null;votes:number;url:string;genreKeys:string[];relatedTo:string[]};
const norm=(text:string)=>String(text||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dayOf=(now:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
function defaultPreferences():Preferences{return {genres:[],type:'both',useHistory:true,useFavorites:true,blocked:[]};}
function preferencesFrom(value:string):Preferences{try{const x=JSON.parse(value);return {genres:Array.isArray(x.genres)?x.genres.filter((key:string)=>tasteGenres.some(g=>g.key===key)).slice(0,5):[],type:['movie','tv'].includes(x.type)?x.type:'both',useHistory:x.useHistory!==false,useFavorites:x.useFavorites!==false,blocked:Array.isArray(x.blocked)?x.blocked.filter((key:string)=>/^(movie|tv):\d+$/.test(key)).slice(-300):[]}}catch{return defaultPreferences()}}
export function meaningfulProgress(row:any){const ratio=row.duration>0?Math.min(1,row.progress/row.duration):0;return row.completed===true||row.progress>=180&&ratio>=.1||row.duration>0&&row.duration<=600&&ratio>=.5;}
export function collectSignals(history:any[],favorites:any[],local:any[],now=new Date()):Signal[]{
  const metadata=new Map(local.map(x=>[x.id,x])),signals=new Map<string,Signal>();
  function add(row:any,favorite:boolean){if(!favorite&&!meaningfulProgress(row))return;const film=metadata.get(row.videoId);if(film&&!film.visible)return;
    const title=String(row.title||film?.title||'').trim();if(!title||/成人|情色|色情|福利|伦理|无码|有码|三级/.test(film?.category||''))return;
    const year=film?.year||undefined,key=norm(title)+':'+(year||0),at=new Date(row.updatedAt||row.createdAt||now).toISOString(),age=Math.max(0,(now.getTime()-new Date(at).getTime())/DAY);
    const weight=(favorite?3.5:row.completed?1.7:1)*Math.max(.25,Math.exp(-age/60));
    const old=signals.get(key);signals.set(key,{title,year,category:film?.category||(!favorite&&/第?\d+\s*[集话期]/.test(row.episodeName||'')?'电视剧':undefined),weight:Math.max(weight,old?.weight||0),favorite:favorite||!!old?.favorite,watched:!favorite||!!old?.watched,at:old&&old.at>at?old.at:at});
  }
  history.forEach(x=>add(x,false));favorites.forEach(x=>add(x,true));return [...signals.values()].sort((a,b)=>b.weight-a.weight||b.at.localeCompare(a.at));
}
function genresOf(ids:number[],type:'movie'|'tv'){return tasteGenres.filter(g=>g[type]&&(ids.includes(g[type])||g.key==='scifi'&&type==='movie'&&ids.includes(14))).map(g=>g.key);}
export function rankRecommendations(candidates:Candidate[],signals:Signal[],weights:Record<string,number>,userSeed:string,blocked:string[],limit=18,today=dayOf(new Date())){
  const seen=new Set(signals.map(x=>norm(x.title))),blockedSet=new Set(blocked);
  const maximum=Math.max(1,...Object.values(weights)),unique=new Map<string,Candidate>();
  for(const item of candidates){const key=item.type+':'+item.id;if(seen.has(norm(item.title))||seen.has(norm(item.originalTitle))||blockedSet.has(key)||!item.date||item.date>today||item.score===null||item.score<6.5||item.score>10||item.votes<(item.type==='movie'?100:50))continue;const old=unique.get(key);unique.set(key,old?{...old,relatedTo:[...new Set([...old.relatedTo,...item.relatedTo])]}:item);}
  const scored=[...unique.values()].map(item=>{
    const m=item.type==='movie'?300:100,quality=(item.votes*item.score!+m*6.5)/(item.votes+m);
    const interests=item.genreKeys.map(key=>({key,weight:weights[key]||0})).sort((a,b)=>b.weight-a.weight),affinity=(interests[0]?.weight||0)/maximum;
    const related=item.relatedTo.filter(title=>signals.some(x=>x.title===title));
    const novelty=parseInt(digest([userSeed,item.type,item.id]).slice(0,8),16)/0xffffffff;
    const reasons=[...(affinity>0?[`符合你对${tasteGenres.find(g=>g.key===interests[0].key)?.name}题材的偏好`]:[]),...(related.length?[`TMDB 将它关联到你${signals.find(x=>x.title===related[0])?.favorite?'收藏':'有效播放过'}的《${related[0]}》`]:[]),`TMDB ${item.score!.toFixed(1)} 分，${item.votes.toLocaleString()} 人评分`,...(affinity===0&&!related.length?['优质探索，尝试不同题材']:[])];
    return {...item,quality:Math.round(quality*10)/10,reasons,scoreValue:quality*.47+affinity*2.2+Math.min(1,related.length)*.9+novelty*.7,affinity};
  });
  const selected:typeof scored=[],typeCounts={movie:0,tv:0},genreCounts:Record<string,number>={};
  while(scored.length&&selected.length<limit){
    scored.sort((a,b)=>{const penalty=(item:typeof a)=>Math.max(0,typeCounts[item.type]-5)*.18+(item.genreKeys.length?Math.min(...item.genreKeys.map(key=>genreCounts[key]||0)):0)*.12;return b.scoreValue-penalty(b)-(a.scoreValue-penalty(a))||a.id-b.id});
    const isExplore=(item:typeof scored[number])=>item.affinity===0&&!item.relatedTo.length;
    const missingExploration=Math.max(0,Math.floor(limit*.2)-selected.filter(isExplore).length);
    let choice=limit-selected.length<=missingExploration?scored.findIndex(isExplore):-1;
    if(choice<0)choice=scored.findIndex(item=>typeCounts[item.type]<Math.ceil(limit*.75));
    if(choice<0)choice=0;
    const next=scored.splice(choice,1)[0];selected.push(next);typeCounts[next.type]++;for(const key of next.genreKeys)genreCounts[key]=(genreCounts[key]||0)+1;
  }
  return selected.map(({scoreValue,affinity,...item},i)=>({...item,rank:i+1,fit:affinity>.5?'偏好匹配':item.relatedTo.length?'关联推荐':'品质探索'}));
}
export function createRecommendationService(db:any,auth:{canSource:(user:any,key:string)=>boolean},request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const client=createCatalogClient(db,request,env),pending=new Map<string,Promise<any>>();
  const prefKey=(id:number)=>`recommend:prefs:${id}`,dailyKey=(id:number)=>`recommend:daily:${id}`;
  async function getPreferences(id:number){const row=await db.setting.findUnique({where:{key:prefKey(id)}});return preferencesFrom(row?.value||'{}');}
  async function putPreferences(id:number,body:any){const old=await getPreferences(id);if(!Array.isArray(body.genres)||body.genres.length>5||body.genres.some((key:any)=>!tasteGenres.some(g=>g.key===key))||!['both','movie','tv'].includes(body.type)||typeof body.useHistory!=='boolean'||typeof body.useFavorites!=='boolean')throw Error('请选择最多5种题材和有效的分析选项');const value=JSON.stringify({...old,genres:[...new Set(body.genres)],type:body.type,useHistory:body.useHistory,useFavorites:body.useFavorites});await db.setting.upsert({where:{key:prefKey(id)},create:{key:prefKey(id),value},update:{value}});return getPreferences(id);}
  async function dismiss(id:number,type:string,movieId:number){if(!['movie','tv'].includes(type)||!Number.isInteger(movieId)||movieId<1)throw Error('影片标识无效');const prefs=await getPreferences(id),value=JSON.stringify({...prefs,blocked:[...new Set([...prefs.blocked,`${type}:${movieId}`])].slice(-300)});await db.setting.upsert({where:{key:prefKey(id)},create:{key:prefKey(id),value},update:{value}});}
  async function today(user:any,now=new Date()){
    const config=await readRatingConfig(db,env);if(!config.enabled||!config.token)throw Error('请先在后台启用并配置 TMDB 评分服务');
    const prefs=await getPreferences(user.id),sources=(await db.source.findMany({where:{enabled:true},select:{key:true,name:true}})).filter((x:any)=>auth.canSource(user,x.key)&&!/黑料|杏吧|香奶|成人|情色|色情|福利|伦理/.test(x.name||x.key)),sourceKeys=sources.map((x:any)=>x.key);
    const [history,favorites,hidden]=await Promise.all([prefs.useHistory?db.watchHistory.findMany({where:{userId:user.id,sourceKey:{in:sourceKeys},updatedAt:{gte:new Date(now.getTime()-120*DAY)}},orderBy:{updatedAt:'desc'},take:150}):[],prefs.useFavorites?db.favorite.findMany({where:{userId:user.id,sourceKey:{in:sourceKeys}},orderBy:{createdAt:'desc'},take:60}):[],db.video.findMany({where:{sourceKey:{in:sourceKeys},visible:false},select:{id:true}})]);
    const hiddenIds=new Set(hidden.map((x:any)=>x.id));const allowed=(rows:any[])=>rows.filter(x=>sourceKeys.includes(x.sourceKey)&&!hiddenIds.has(x.videoId));
    const goodHistory=allowed(history),goodFavorites=allowed(favorites),ids=[...new Set([...goodHistory,...goodFavorites].map(x=>x.videoId))];
    const local=ids.length?await db.video.findMany({where:{id:{in:ids},sourceKey:{in:sourceKeys}},select:{id:true,title:true,year:true,category:true,visible:true}}):[];
    const signals=collectSignals(goodHistory,goodFavorites,local,now),date=dayOf(now),fingerprint=digest([VERSION,user.id,date,prefs,sourceKeys,signals.map(x=>[x.title,x.year,x.favorite,Math.round(x.weight*10)])]);
    const cache=await db.setting.findUnique({where:{key:dailyKey(user.id)}});try{const saved=JSON.parse(cache?.value||'null');if(saved?.fingerprint===fingerprint&&saved.data?.date===date)return {...saved.data,cached:true}}catch{}
    const pendingKey=user.id+':'+fingerprint;if(pending.has(pendingKey))return pending.get(pendingKey);if(pending.size>=20)throw Error('推荐分析繁忙，请稍后重试');
    const task=(async()=>{
      const weights:Record<string,number>={};prefs.genres.forEach(key=>weights[key]=4);
      const matched=await Promise.all(signals.slice(0,4).map(async signal=>{try{const data=await client.load('/search/multi',new URLSearchParams({query:signal.title,language:'zh-CN',include_adult:'false'}));const match=matchRating(signal,data.results),row=match?data.results.find((x:any)=>match.url===`https://www.themoviedb.org/${x.media_type}/${x.id}`):undefined;if(!row)return null;return {signal,id:row.id,type:row.media_type as 'movie'|'tv',genres:genresOf(row.genre_ids||[],row.media_type)}}catch{return null}}));
      for(const entry of matched)if(entry)for(const genre of entry.genres)weights[genre]=(weights[genre]||0)+entry.signal.weight;
      const types:('movie'|'tv')[]=prefs.type==='both'?['movie','tv']:[prefs.type];
      const jobs:{path:string;params:URLSearchParams;type:'movie'|'tv';relatedTo:string[]}[]=[];
      for(const type of types){for(const mode of ['rating','popular']){const query=catalogQuery({type,mode},now);query.params.set('page',String(1+parseInt(digest([user.id,date,type,mode]).slice(0,4),16)%3));jobs.push({...query,type,relatedTo:[]});}const top=tasteGenres.filter(g=>g[type]&&(weights[g.key]||0)>0).sort((a,b)=>(weights[b.key]||0)-(weights[a.key]||0))[0];if(top){const query=catalogQuery({type,mode:'rating',genre:String(top[type])},now);if(top.key==='scifi'&&type==='movie')query.params.set('with_genres','878|14');jobs.push({...query,type,relatedTo:[]});}}
      for(const entry of matched.filter((x):x is NonNullable<typeof x>=>!!x&&types.includes(x.type)).slice(0,2))jobs.push({path:`/${entry.type}/${entry.id}/recommendations`,params:new URLSearchParams({language:'zh-CN',page:'1'}),type:entry.type,relatedTo:[entry.signal.title]});
      let failed=0;const batches=await Promise.all(jobs.map(async job=>{try{const data=await client.load(job.path,job.params);return catalogItems(data.results,job.type,1).map((item:any)=>({...item,genreKeys:genresOf((data.results.find((x:any)=>x.id===item.id)?.genre_ids)||[],job.type),relatedTo:job.relatedTo})) as Candidate[]}catch{failed++;return []}}));
      if(failed===jobs.length)throw Error('推荐数据暂时不可用，请稍后重试');
      const items=rankRecommendations(batches.flat(),signals,weights,`${user.id}:${date}`,prefs.blocked,18,date),topGenres=tasteGenres.map(g=>({key:g.key,name:g.name,weight:weights[g.key]||0})).filter(g=>g.weight>0).sort((a,b)=>b.weight-a.weight).slice(0,5).map(({weight,...g})=>g);
      const matchedCount=matched.filter(Boolean).length,coldStart=matchedCount===0&&!prefs.genres.length;
      const data={date,generatedAt:now.toISOString(),engine:'local-content-based-v2',cached:false,partial:failed>0,items,preferences:prefs,analysis:{coldStart,confidence:matchedCount>=3?'较充分':matchedCount||prefs.genres.length?'有限':'待了解',effectiveTitles:signals.filter(x=>x.watched).length,favoriteTitles:signals.filter(x=>x.favorite).length,matchedTitles:matchedCount,topGenres,sourceTitles:matched.filter(Boolean).map(x=>({title:x!.signal.title,kind:x!.signal.favorite?'收藏':'有效播放进度'})),summary:coldStart?'目前没有足够的可靠喜好信号，先提供经评分筛选的每日探索片单。可以选择喜欢的题材，让推荐更贴近你。':`结合${matchedCount}部可靠匹配的兴趣样本${prefs.genres.length?'及主动选择的题材':''}，优先推荐相近题材与关联作品，并保留少量品质探索。`,qualityRule:'至少6.5分；电影至少100人、电视剧至少50人评分，并对低样本评分降权。',privacy:'仅在本地分析本账号的记录；TMDB 只接收匿名片名或作品/题材查询，不接收账号、完整历史或播放链接。',limitations:'本地可解释推荐，不是外部大模型；兴趣相近的账号可能有重合。播放进度不等于实际观看时长，可在偏好中关闭使用记录。'}};
      if(!failed){const value=JSON.stringify({fingerprint,data});await db.setting.upsert({where:{key:dailyKey(user.id)},create:{key:dailyKey(user.id),value},update:{value}});}return data;
    })().finally(()=>pending.delete(pendingKey));pending.set(pendingKey,task);return task;
  }
  return {today,getPreferences,putPreferences,dismiss};
}
export function registerRecommendations(app:Express,db:any,auth:{requireUser:any;canSource:(user:any,key:string)=>boolean},request:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
  const service=createRecommendationService(db,auth,request,env),limits=new Map<number,{at:number;count:number}>();
  async function access(req:any,res:any){const user=await auth.requireUser(req,res);if(!user)return null;res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');let limit=limits.get(user.id);if(!limit||limit.at+60000<Date.now()){if(limits.size>=2000)limits.clear();limit={at:Date.now(),count:0};limits.set(user.id,limit)}if(++limit.count>20){res.status(429).json({error:'推荐请求太频繁，请稍后再试'});return null}return user;}
  app.get('/api/recommendations/today',async(req,res)=>{const user=await access(req,res);if(!user)return;try{res.json(await service.today(user))}catch{res.status(503).json({error:'今日推荐暂时不可用，请检查 TMDB 配置或稍后重试。其他片库功能不受影响。'})}});
  app.get('/api/recommendations/preferences',async(req,res)=>{const user=await access(req,res);if(user)res.json({preferences:await service.getPreferences(user.id),genres:tasteGenres.map(({key,name})=>({key,name}))})});
  app.put('/api/recommendations/preferences',async(req,res)=>{const user=await access(req,res);if(!user)return;try{res.json({preferences:await service.putPreferences(user.id,req.body||{})})}catch(e:any){res.status(400).json({error:e.message||'偏好无效'})}});
  app.post('/api/recommendations/dismiss',async(req,res)=>{const user=await access(req,res);if(!user)return;try{await service.dismiss(user.id,String(req.body?.type||''),Number(req.body?.id));res.json({ok:true})}catch{res.status(400).json({error:'影片标识无效'})}});
  return service;
}
