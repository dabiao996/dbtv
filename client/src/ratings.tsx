import React,{createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';

type Film={title:string;year?:number;category?:string};
type Result={status:string;rating?:{provider:string;score:number;votes:number;url:string;matchedTitle:string;year?:number;updatedAt:string}};
const keyOf=(film:Film)=>JSON.stringify([film.title,film.year||0,film.category||'']);
const base=(import.meta.env.VITE_API_URL||'')+'/api';
const RatingContext=createContext<{ready:boolean;enabled:boolean;configured:boolean;revision:number;lookup:(film:Film)=>Promise<Result>}>({ready:false,enabled:false,configured:false,revision:0,lookup:async()=>({status:'disabled'})});
export function RatingProvider({children}:{children:React.ReactNode}){
  const [status,setStatus]=useState({ready:false,enabled:false,configured:false,revision:0});
  const cache=useRef(new Map<string,Result>()),queue=useRef(new Map<string,{film:Film;resolve:((value:Result)=>void)[]}>()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),busy=useRef(false),generation=useRef(0),mounted=useRef(true);
  const drain=useCallback(async function drain(){
    if(busy.current||!queue.current.size)return;busy.current=true;const version=generation.current;
    const entries=[...queue.current.entries()].slice(0,20);for(const [key] of entries)queue.current.delete(key);
    let results:Result[]=[];
    try{const response=await fetch(base+'/ratings/lookup',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:entries.map(([,x])=>x.film)}),signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();results=(await response.json()).items||[]}catch{}
    entries.forEach(([key,item],i)=>{const result=results[i]||{status:'unavailable'};if(version===generation.current){if(cache.current.size>=2000)cache.current.clear();cache.current.set(key,result)}item.resolve.forEach(resolve=>resolve(version===generation.current?result:{status:'disabled'}))});
    busy.current=false;if(mounted.current&&queue.current.size)timer.current=setTimeout(()=>void drain(),80);
  },[]);
  const lookup=useCallback((film:Film):Promise<Result>=>{const key=keyOf(film),hit=cache.current.get(key);if(hit)return Promise.resolve(hit);return new Promise(resolve=>{const current=queue.current.get(key);if(current)current.resolve.push(resolve);else queue.current.set(key,{film,resolve:[resolve]});clearTimeout(timer.current);timer.current=setTimeout(()=>void drain(),80)})},[drain]);
  useEffect(()=>{mounted.current=true;let controller:AbortController;
    const refresh=()=>{controller?.abort();controller=new AbortController();generation.current++;cache.current.clear();for(const item of queue.current.values())item.resolve.forEach(resolve=>resolve({status:'disabled'}));queue.current.clear();fetch(base+'/ratings/status',{credentials:'include',signal:controller.signal}).then(r=>r.ok?r.json():{enabled:false,configured:false}).then(value=>{if(!controller.signal.aborted)setStatus(old=>({ready:true,enabled:!!value.enabled,configured:!!value.configured,revision:old.revision+1}))}).catch(()=>{})};
    refresh();addEventListener('dbtv:ratings-changed',refresh);return()=>{mounted.current=false;controller?.abort();clearTimeout(timer.current);removeEventListener('dbtv:ratings-changed',refresh);for(const item of queue.current.values())item.resolve.forEach(resolve=>resolve({status:'disabled'}));queue.current.clear()};
  },[]);
  return <RatingContext.Provider value={{...status,lookup}}>{children}</RatingContext.Provider>;
}
export function RatingBadge({video,compact=false}:{video:Film;compact?:boolean}){
  const context=useContext(RatingContext),[result,setResult]=useState<Result>(),host=useRef<HTMLSpanElement>(null);
  useEffect(()=>{setResult(undefined);if(!context.ready||!context.enabled||!context.configured||!host.current)return;let cancelled=false;
    const observer=new IntersectionObserver(entries=>{if(!entries.some(x=>x.isIntersecting))return;observer.disconnect();void context.lookup({title:video.title,year:video.year,category:video.category}).then(value=>{if(!cancelled)setResult(value)})},{rootMargin:'30px'});observer.observe(host.current);return()=>{cancelled=true;observer.disconnect()};
  },[video.title,video.year,video.category,context.ready,context.enabled,context.configured,context.revision,context.lookup]);
  let message='正在读取评分';if(!context.configured)message='评分服务待配置';else if(!context.enabled)message='评分已关闭';else if(result?.status==='unavailable')message='评分暂时不可用';else if(result&&!result.rating)message='暂无可靠匹配评分';
  const rating=context.enabled&&context.configured?result?.rating:undefined;
  return <span ref={host} className={`rating-badge ${compact?'rating-compact':''}`} aria-live={compact?undefined:'polite'}>{rating?<a href={rating.url} target="_blank" rel="noopener noreferrer" title={`${rating.matchedTitle}${rating.year?' · '+rating.year:''}；${rating.votes} 人评分；更新于 ${new Date(rating.updatedAt).toLocaleString()}`} aria-label={`TMDB 评分 ${rating.score.toFixed(1)} 分（满分 10），${rating.votes} 人评分`}><b>★ {rating.score.toFixed(1)}</b><span>TMDB</span>{!compact&&<small>{rating.votes.toLocaleString()} 人评分 · 10 分制</small>}</a>:!compact&&<span className="rating-empty">{message}</span>}</span>;
}
export function RatingStatusNotice(){const status=useContext(RatingContext);if(!status.ready||status.enabled&&status.configured)return null;return <p className="rating-status-notice" role="status">{!status.configured?'TMDB 评分尚未配置，所以影片卡片暂不显示评分。管理员可在「后台 → 网站设置 → 影片评分」配置。':'TMDB 评分已在后台关闭，所以影片卡片暂不显示评分。'}</p>}
export function RatingCredits(){const context=useContext(RatingContext);if(!context.enabled||!context.configured)return null;return <section className="rating-credits" aria-label="关于评分数据"><a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer"><img src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg" width="80" height="12" alt="TMDB" loading="lazy"/></a><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>评分来自 TMDB 用户，不是豆瓣评分；热门榜使用 TMDB 热度与趋势，不是本站播放次数。</p></section>}
