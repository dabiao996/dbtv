import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {cinemaRequest,usePreview,type CinemaVideo} from './Preview';
import Icon from './Icon';
import {RatingBadge} from '../ratings';

export default function CinemaCard({video:summary,progress}:{video:CinemaVideo;progress?:number}){
  const preview=usePreview(),card=useRef<HTMLElement>(null),[failed,setFailed]=useState('');
  const [hydrated,setHydrated]=useState<CinemaVideo>();
  const video={...summary,...hydrated?.id===summary.id?hydrated:{}};
  useEffect(()=>{setHydrated(undefined);if(summary.cover||!card.current)return;const controller=new AbortController();
    const observer=new IntersectionObserver(entries=>{if(!entries.some(x=>x.isIntersecting))return;observer.disconnect();cinemaRequest<CinemaVideo>(`/sources/${encodeURIComponent(summary.sourceKey)}/videos/${encodeURIComponent(summary.id)}`,controller.signal).then(detail=>{if(!controller.signal.aborted)setHydrated(detail)}).catch(()=>{})},{rootMargin:'120px'});
    observer.observe(card.current);return()=>{observer.disconnect();controller.abort()};
  },[summary.id,summary.sourceKey,summary.cover]);
  const src=video.cover||'',detail=`/detail/${encodeURIComponent(video.sourceKey)}/${encodeURIComponent(video.id)}`;
  const names=video.variants?[...new Set(video.variants.map(x=>x.sourceName))].join(' · '):video.category||video.area||video.sourceName||'影视';
  return <article ref={card} className="movie-card cinema-card" onPointerEnter={e=>{if(e.pointerType==='mouse'&&matchMedia('(hover:hover)').matches)preview.open(video,e.currentTarget)}} onPointerLeave={e=>{if(e.pointerType==='mouse')preview.leave()}}>
    <Link className="movie-poster" to={detail} aria-label={`查看《${video.title}》`}>
      {src&&failed!==src?<img src={src} alt={video.title} loading="lazy" decoding="async" onError={()=>setFailed(src)}/>:<span className="cinema-cover-placeholder">{video.title.slice(0,1)}</span>}
      <div className="cinema-card-shade"/>{video.variants&&<em className="source-count">{new Set(video.variants.map(x=>x.sourceKey)).size} 个源</em>}{video.year&&<small>{video.year}</small>}
      <span className="cinema-card-play"><Icon name="play" size={25}/></span>
      {progress!==undefined&&<span className="progress"><i style={{width:`${Math.min(100,Math.max(0,progress))}%`}}/></span>}
    </Link>
    <Link className="cinema-card-title" to={detail} title={video.title}><strong>{video.title}</strong></Link><span className="cinema-card-meta" title={names}>{names}</span>
    {video.uploader?.virtual&&<span className="cinema-card-uploader" title="虚拟展示身份，不代表实际上传记录"><img src={video.uploader.avatarUrl||'/images/default-avatar.svg'} referrerPolicy="no-referrer" alt="" loading="lazy" onError={e=>{e.currentTarget.src='/images/default-avatar.svg'}}/><em>{video.uploader.name}</em> · 虚拟展示</span>}
    <span className="cinema-card-rating"><RatingBadge video={video} compact/></span>
    <button className="cinema-card-preview-toggle" aria-label={`预览《${video.title}》`} onClick={e=>{preview.open(video,e.currentTarget,true,e.detail===0)}}><Icon name="info" size={17}/></button>
  </article>;
}
