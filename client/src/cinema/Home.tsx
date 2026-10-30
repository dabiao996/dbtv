import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import CinemaCard from './MovieCard';
import {cinemaRequest,type CinemaVideo} from './Preview';
import Icon from './Icon';
import Recommendations from '../Recommendations';

type Source={key:string;name:string};
function Shelf({title,subtitle,items,source,progress}:{title:string;subtitle?:string;items:CinemaVideo[];source:string;progress?:Record<string,number>}){
  const track=useRef<HTMLDivElement>(null);
  if(!items.length)return null;
  const shift=(direction:number)=>{const el=track.current;if(el)el.scrollBy({left:direction*el.clientWidth*.85,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})};
  return <section className="cinema-shelf"><header><div><small>{subtitle}</small><h2>{title}</h2></div><div className="cinema-shelf-tools"><Link to={`/source/${encodeURIComponent(source)}`}>浏览全部<Icon name="right" size={15}/></Link><button onClick={()=>shift(-1)} aria-label={`向前浏览${title}`}><Icon name="left" size={17}/></button><button onClick={()=>shift(1)} aria-label={`向后浏览${title}`}><Icon name="right" size={17}/></button></div></header><div ref={track} className="cinema-shelf-track">{items.map(video=><CinemaCard key={video.sourceKey+video.id} video={video} progress={progress?.[video.id]}/>)}</div></section>;
}
export default function CinemaHome({settings,permissions}:{settings:Record<string,string>;permissions?:string[]}){
  const [sources,setSources]=useState<Source[]>([]),[selected,setSelected]=useState(''),[videos,setVideos]=useState<CinemaVideo[]>([]),[history,setHistory]=useState<any[]>([]);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[slide,setSlide]=useState(0),[detail,setDetail]=useState<CinemaVideo>();
  const [paused,setPaused]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{const controller=new AbortController();
    Promise.all([cinemaRequest<Source[]>('/library',controller.signal),cinemaRequest<any[]>('/history',controller.signal).catch(()=>[])]).then(([rows,records])=>{if(controller.signal.aborted)return;setSources(rows);setHistory(records);const key=localStorage.getItem('tvbox.homeSource')||settings.homeSource||'';setSelected(rows.some(x=>x.key===key)?key:'');setLoading(false)}).catch(e=>{if(e.name!=='AbortError'){setError(e.message);setLoading(false)}});
    return()=>controller.abort();
  },[settings.homeSource]);
  useEffect(()=>{setVideos([]);setDetail(undefined);setSlide(0);setError('');if(!selected)return;const controller=new AbortController();setLoading(true);
    cinemaRequest<any>(`/library/videos?${new URLSearchParams({sourceKey:selected,page:'1',pageSize:'100'})}`,controller.signal).then(result=>{if(!controller.signal.aborted)setVideos((result.items||[]).map((x:any)=>({...x,sourceName:sources.find(s=>s.key===selected)?.name||x.source?.name||selected})))}).catch(e=>{if(e.name!=='AbortError')setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    return()=>controller.abort();
  },[selected,retry]);
  const featured=videos.slice(0,5),hero=featured[slide]||featured[0];
  useEffect(()=>{setDetail(undefined);if(!hero)return;const controller=new AbortController();cinemaRequest<CinemaVideo>(`/sources/${encodeURIComponent(hero.sourceKey)}/videos/${encodeURIComponent(hero.id)}`,controller.signal).then(setDetail).catch(()=>{});return()=>controller.abort()},[hero?.id,selected]);
  useEffect(()=>{if(paused||featured.length<2||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const timer=setInterval(()=>setSlide(x=>(x+1)%featured.length),10000);return()=>clearInterval(timer)},[paused,featured.length,selected]);
  const active=hero?{...hero,...detail?.id===hero.id?detail:{}}:undefined;
  const watching=history.filter(x=>x.sourceKey===selected&&x.duration>0&&x.progress/x.duration<.95).slice(0,10).map(x=>({...x,id:x.videoId,sourceName:sources.find(s=>s.key===x.sourceKey)?.name||x.sourceKey}));
  const progress=Object.fromEntries(history.map(x=>[x.videoId,x.duration?x.progress/x.duration*100:0]));
  const categories=[...new Set(videos.map(x=>x.category).filter((x):x is string=>!!x))].slice(0,4);
  function choose(key:string){localStorage.setItem('tvbox.homeSource',key);setSelected(key)}
  const srcName=sources.find(x=>x.key===selected)?.name||'';
  return <div className="cinema-home">
    {settings.noticeEnabled!=='false'&&settings.noticeText&&<div className="cinema-announcement"><span>公告</span>{settings.noticeText}</div>}
    {settings.heroEnabled!=='false'&&<section className={`cinema-hero ${!active?'is-empty':''}`} aria-label="首页影片精选" onPointerEnter={()=>setPaused(true)} onPointerLeave={()=>setPaused(false)} onFocusCapture={()=>setPaused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setPaused(false)}}>
      {active?.cover&&<div className="cinema-hero-art" key={`art-${active.id}`}><img className="cinema-hero-atmosphere" src={active.cover} alt=""/><img className="cinema-hero-poster" src={active.cover} alt={active.title} fetchPriority="high"/></div>}
      <div className="cinema-hero-wash"/>
      <div className="cinema-hero-copy" key={`copy-${active?.id||'empty'}`}><div className="cinema-overline"><span className="cinema-brand-mark"/>大彪 TV<span className="cinema-overline-line"/>{active?'你的私人片库':'每一次打开，都有好故事'}</div>
        {active?<><div className="cinema-hero-label"><Icon name="sparkle" size={16}/>{srcName} · 今日片单</div><h1>{active.title}</h1><div className="cinema-metadata">{[active.year,active.category,active.area,active.language].filter(Boolean).map((x,i)=><span key={i}>{x}</span>)}</div><p>{(active.desc||'').replace(/<[^>]*>/g,'').replace(/[\u00a0\u2007\u202f]/g,' ').replace(/\s+/g,' ').trim()||'挑一个舒服的姿势，让故事带你去远方。进入详情，查看这部影片的剧集与播放源。'}</p><div className="cinema-hero-actions"><Link className="cinema-button cinema-button-primary" to={`/detail/${active.sourceKey}/${encodeURIComponent(active.id)}`}><Icon name="play" size={23}/>开始观看</Link><Link className="cinema-circle" to={`/detail/${active.sourceKey}/${encodeURIComponent(active.id)}`} aria-label="查看当前影片详情"><Icon name="info" size={24}/></Link></div><span className="cinema-hero-caption">在喜欢的故事里，停留一会儿。</span></>:<><h1>把好故事，<br/><span>留给此刻。</span></h1><p>{loading?'正在为你准备片库…':'选择一个数据源，开始探索属于你的电影、剧集与更多精彩。'}</p><Link className="cinema-button cinema-button-primary" to="/category/电影"><Icon name="play"/>探索电影</Link></>}
      </div>
      {featured.length>1&&<div className="cinema-hero-controls"><div className="cinema-slide-dots">{featured.map((x,i)=><button key={x.id} className={slide===i?'active':''} aria-label={`查看精选影片 ${i+1}：${x.title}`} aria-pressed={slide===i} onClick={()=>setSlide(i)}/>)}</div><div className="cinema-slide-arrows"><span>{String(slide+1).padStart(2,'0')}<i>/ {String(featured.length).padStart(2,'0')}</i></span><button className="cinema-circle" aria-label="上一部精选影片" onClick={()=>setSlide(x=>(x-1+featured.length)%featured.length)}><Icon name="left"/></button><button className="cinema-circle" aria-label="下一部精选影片" onClick={()=>setSlide(x=>(x+1)%featured.length)}><Icon name="right"/></button></div></div>}
    </section>}
    <main className={`cinema-home-content ${settings.heroEnabled==='false'?'no-hero':''}`}>
      <section className="cinema-source-dock" aria-label="首页数据源"><div><span className="cinema-live-dot"/><b>你的片库</b><small>{selected?srcName:'选择数据源'}</small></div><div className="cinema-source-buttons">{sources.map(x=><button key={x.key} className={selected===x.key?'active':''} aria-pressed={selected===x.key} onClick={()=>choose(x.key)}>{x.name}</button>)}</div><Link to="/sources" aria-label="查看全部数据源"><Icon name="right"/></Link></section>
      <div className="cinema-category-links">{['电影','电视剧','动漫','综艺','纪录片','短剧','体育'].map(x=><Link key={x} to={`/category/${x}${selected?'?source='+encodeURIComponent(selected):''}`}>{x}<Icon name="right" size={14}/></Link>)}</div>
      {(!permissions||permissions.includes('recommendations'))&&<Recommendations compact/>}
      {error&&<div className="cinema-load-error" role="alert"><b>这个源暂时没有响应</b><p>{error}</p><button className="cinema-button" onClick={()=>setRetry(x=>x+1)}>重新加载</button><span>也可以在上方切换其他数据源。</span></div>}
      {loading&&selected?<div className="cinema-skeleton-shelf" aria-label="正在读取影片">{Array.from({length:5},(_,i)=><i key={i}/>)}</div>:<>
        <Shelf title="继续观看" subtitle="接着上次的故事" items={watching} source={selected} progress={progress}/>
        <Shelf title="现在，发现新故事" subtitle="从你的片库出发" items={videos.slice(0,15)} source={selected}/>
        {categories.map(category=><Shelf key={category} title={category} subtitle="换一种心情" items={videos.filter(x=>x.category===category).slice(0,15)} source={selected}/>)}
        {!videos.length&&selected&&!error&&<div className="cinema-load-error"><h2>这个源暂时没有内容</h2><p>试试切换数据源，或去分类片库探索更多影片。</p></div>}
      </>}
      <Link className="cinema-discover-strip" to="/discover"><div><span className="cinema-overline">TMDB 全球热门</span><h2>发现全球热门与高分佳作</h2><p>电影、电视剧、每周趋势与高分榜，发现下一部想看的影片。</p></div><span className="cinema-circle"><Icon name="right" size={25}/></span></Link>
    </main>
  </div>;
}
