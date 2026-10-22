import React,{useEffect,useId,useRef,useState} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {requestUpdate} from './update-api';
import './admin-updates.css';

export default function AdminUpdateCheck(){
  const location=useLocation(),id=useId(),container=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [info,setInfo]=useState<any>(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void requestUpdate('',undefined,controller.signal).then(setInfo).catch(()=>{});return()=>controller.abort();},[]);
  useEffect(()=>setOpen(false),[location.pathname]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!container.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  async function check(){
    if(busy)return;setOpen(true);setBusy(true);setError('');
    try{const result=await requestUpdate('/check',{});setInfo((value:any)=>({...value,check:result}));window.dispatchEvent(new Event('dbtv:updates-checked'));}
    catch(reason:any){setError(reason.message||'暂时无法检查更新，请稍后重试。');}
    finally{setBusy(false);}
  }
  const result=info?.check,available=!error&&result?.state==='checked'&&result.available;
  const message=error||result?.error||(result?.state==='checked'?(available?`发现新版本 ${result.latest?.version||''}`:'未发现更高正式版本'):'尚未成功检查版本。');
  return <div className="console-update" ref={container}>
    <button ref={trigger} type="button" className="console-update-trigger" aria-expanded={open} aria-controls={open?id:undefined} aria-busy={busy} disabled={busy} onClick={()=>void check()}><span aria-hidden="true">↻</span>{busy?'正在检查…':'检查更新'}{available&&<i aria-label="有新版本可用"/>}</button>
    {open&&<section id={id} className="console-update-popover" aria-label="版本检查结果"><div className="console-update-heading"><b>版本检查</b><button type="button" aria-label="关闭版本检查" onClick={()=>{setOpen(false);trigger.current?.focus();}}>×</button></div>{info?.current&&<small>当前版本 {info.current.version}{info.current.channel==='development'?' · 开发版':''}</small>}<p role="status">{busy?'正在查询正式发行版本…':message}</p>{!busy&&(error||result?.state!=='checked')&&<small>检查未成功，不代表已经是最新版本。</small>}<Link to="/admin/updates" onClick={()=>setOpen(false)}>查看更新详情与回退 →</Link></section>}
  </div>;
}
