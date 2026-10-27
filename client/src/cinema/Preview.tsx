import React,{createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import Icon from './Icon';
import {matchingEpisode} from '../playback';
import {RatingBadge} from '../ratings';
import {shouldOpenPreviewDetails} from './preview-navigation';

export type CinemaVideo={id:string;sourceKey:string;sourceName?:string;title:string;cover?:string;year?:number;category?:string;area?:string;language?:string;desc?:string;episodes?:any[];variants?:{sourceKey:string;sourceName:string}[]};
const base=import.meta.env.VITE_API_URL||'';
export async function cinemaRequest<T>(path:string,signal?:AbortSignal,options?:RequestInit):Promise<T>{const r=await fetch(base+'/api'+path,{credentials:'include',signal,...options});const body=await r.json();if(!r.ok)throw new Error(body.error||'暂时无法读取内容');return body;}
function plainText(value:string){return value.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();}
type PreviewState={video:CinemaVideo;anchor:HTMLElement;rect:DOMRect;keyboard:boolean};
type PreviewAPI={open:(video:CinemaVideo,anchor:HTMLElement,immediate?:boolean,keyboard?:boolean)=>void;leave:()=>void;keep:()=>void};
const PreviewContext=createContext<PreviewAPI>({open:()=>{},leave:()=>{},keep:()=>{}});
export const usePreview=()=>useContext(PreviewContext);
export function PreviewProvider({children}:{children:React.ReactNode}){
  const [state,setState]=useState<PreviewState>();
  const openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const location=useLocation();
  const clearTimers=useCallback(()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current)},[]);
  const dismiss=useCallback(()=>{clearTimers();setState(undefined)},[clearTimers]);
  const keep=useCallback(()=>clearTimeout(closeTimer.current),[]);
  const leave=useCallback(()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);closeTimer.current=setTimeout(()=>setState(undefined),240)},[]);
  const open=useCallback((video:CinemaVideo,anchor:HTMLElement,immediate=false,keyboard=false)=>{
    clearTimers();const show=()=>{if(anchor.isConnected)setState({video,anchor,rect:anchor.getBoundingClientRect(),keyboard})};
    if(immediate)show();else openTimer.current=setTimeout(show,320);
  },[clearTimers]);
  useEffect(()=>{dismiss()},[location.key,dismiss]);
  useEffect(()=>()=>clearTimers(),[clearTimers]);
  useEffect(()=>{if(!state)return;const resize=()=>dismiss(),scroll=(event:Event)=>{if(event.target instanceof Element&&event.target.closest('.cinema-preview'))return;dismiss()};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();if(state.keyboard)state.anchor.focus();dismiss()}};
    const outside=(event:PointerEvent)=>{if(event.target instanceof Element&&(event.target.closest('.cinema-preview')||state.anchor.contains(event.target)))return;dismiss()};
    addEventListener('resize',resize);addEventListener('scroll',scroll,true);addEventListener('keydown',key);document.addEventListener('pointerdown',outside,true);
    return()=>{removeEventListener('resize',resize);removeEventListener('scroll',scroll,true);removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside,true)};
  },[state,dismiss]);
  return <PreviewContext.Provider value={{open,leave,keep}}>{children}{state&&createPortal(<PreviewPanel key={state.video.sourceKey+state.video.id} state={state} keep={keep} leave={leave} dismiss={dismiss}/>,document.body)}</PreviewContext.Provider>;
}
function PreviewPanel({state,keep,leave,dismiss}:{state:PreviewState;keep:()=>void;leave:()=>void;dismiss:()=>void}){
  const navigate=useNavigate();
  const [video,setVideo]=useState(state.video),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [favorite,setFavorite]=useState<any>(),[saving,setSaving]=useState(false);
  const closeRef=useRef<HTMLButtonElement>(null);
  const width=Math.min(410,window.innerWidth-24),height=Math.min(505,window.innerHeight-24);
  const left=Math.max(12,Math.min(state.rect.left+(state.rect.width-width)/2,window.innerWidth-width-12));
  const top=Math.max(12,Math.min(state.rect.top-18,window.innerHeight-height-12));
  useEffect(()=>{const controller=new AbortController();
    cinemaRequest<CinemaVideo>(`/sources/${encodeURIComponent(state.video.sourceKey)}/videos/${encodeURIComponent(state.video.id)}`,controller.signal).then(detail=>{if(!controller.signal.aborted)setVideo({...state.video,...detail})}).catch(()=>{}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    cinemaRequest<any[]>('/favorites',controller.signal).then(rows=>{if(!controller.signal.aborted)setFavorite(rows.find(x=>x.sourceKey===state.video.sourceKey&&x.videoId===state.video.id)||null)}).catch(()=>{});
    if(state.keyboard)closeRef.current?.focus();return()=>controller.abort();
  },[state]);
  async function toggleFavorite(){if(saving)return;setSaving(true);setError('');try{
    if(favorite){await cinemaRequest('/favorites/'+favorite.id,undefined,{method:'DELETE'});setFavorite(null)}
    else {const saved=await cinemaRequest('/favorites',undefined,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceKey:video.sourceKey,videoId:video.id,title:video.title,cover:video.cover})});setFavorite(saved)}
    dispatchEvent(new Event('dbtv:favorites-changed'));
  }catch(e:any){setError(e.message)}finally{setSaving(false)}}
  const episode=matchingEpisode(video.episodes||[]),detail=`/detail/${encodeURIComponent(video.sourceKey)}/${encodeURIComponent(video.id)}`;
  const play=episode?`/player/${encodeURIComponent(video.sourceKey)}/${encodeURIComponent(video.id)}/${encodeURIComponent(episode.id)}`:detail;
  const openDetails=(event:React.MouseEvent<HTMLElement>)=>{
    const target=event.target instanceof Element?event.target:null;
    const fromControl=!!target?.closest('a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable]');
    if(shouldOpenPreviewDetails({button:event.button,defaultPrevented:event.defaultPrevented,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,altKey:event.altKey,fromControl,hasSelection:!!window.getSelection()?.toString().trim()}))navigate(detail);
  };
  return <section className="cinema-preview" role="dialog" aria-label={`${video.title} · 影片预览`} style={{left,top,width,maxHeight:height}} onClick={openDetails} onPointerEnter={keep} onPointerLeave={event=>{if(event.pointerType==='mouse'&&(!state.keyboard||!event.currentTarget.contains(document.activeElement)))leave()}} onFocusCapture={keep} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)&&!e.currentTarget.matches(':hover'))leave()}}>
    <div className="cinema-preview-image"><Link className="cinema-preview-poster-link" to={detail} aria-label={`查看《${video.title}》的详情`} tabIndex={-1}>{video.cover?<img src={video.cover} alt={video.title}/>:<div className="cinema-cover-placeholder">{video.title.slice(0,1)}</div>}<div className="cinema-preview-shade"/><span className="cinema-preview-tag">影片预览</span><span className="cinema-preview-hint" aria-hidden="true">查看详情 <Icon name="right" size={13}/></span></Link><button ref={closeRef} className="cinema-circle preview-close" aria-label="关闭影片预览" onClick={()=>{if(state.keyboard)state.anchor.focus();dismiss()}}><Icon name="close" size={17}/></button></div>
    <div className="cinema-preview-body"><div className="cinema-overline">{video.sourceName||video.sourceKey}</div><h3><Link className="cinema-preview-title-link" to={detail}>{video.title}</Link></h3><div className="cinema-metadata">{[video.year,video.category,video.area].filter(Boolean).map((x,i)=><span key={i}>{x}</span>)}</div>
      <RatingBadge video={video}/>
      <p className="cinema-preview-description">{plainText(video.desc||'')||(loading?'正在读取影片资料…':'还没有这部影片的简介，进入详情查看播放源与剧集。')}</p>
      <div className="cinema-preview-actions"><Link className="cinema-play-small" to={play}><Icon name="play" size={20}/>{episode?'立即播放':'查看影片'}</Link><button className="cinema-circle" disabled={favorite===undefined} aria-disabled={saving||favorite===undefined} aria-busy={saving} aria-label={favorite?'取消收藏':'加入收藏'} aria-pressed={!!favorite} onClick={()=>void toggleFavorite()}><Icon name={favorite?'check':'plus'}/></button><Link className="cinema-circle" to={detail} aria-label="查看影片详情"><Icon name="info"/></Link></div>
      {video.variants&&<small>{new Set(video.variants.map(x=>x.sourceKey)).size} 个播放源可供选择</small>}{error&&<p className="cinema-action-error" role="alert">{error}</p>}
    </div>
  </section>;
}
