import React,{useEffect,useRef,useState} from 'react';
import {generationStorageKey,readGenerationRequest,nextGenerationRequest,type GenerationRequest} from './virtual-uploader-state';
import './virtual-uploaders.css';

type VirtualUploader={id:string;name:string;avatarUrl:string|null;enabled:boolean};
const endpoint=(import.meta.env.VITE_API_URL||'')+'/api/admin/virtual-uploaders';
async function request(path='',body?:unknown,method='POST'){
  const response=await fetch(endpoint+path,{credentials:'include',cache:'no-store',...body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}});
  const data=await response.json();if(!response.ok)throw Error(data.error||'操作失败，请稍后重试');return data;
}
function savedGeneration(){try{return readGenerationRequest(sessionStorage.getItem(generationStorageKey))}catch{return null}}
function rememberGeneration(value:GenerationRequest|null){try{if(value)sessionStorage.setItem(generationStorageKey,JSON.stringify(value));else sessionStorage.removeItem(generationStorageKey)}catch{/* In-memory request key still protects retries if storage is unavailable. */}}

export default function VirtualUploaders(){
  const pending=useRef<GenerationRequest|null>(savedGeneration());
  const lock=useRef(false);
  const [items,setItems]=useState<VirtualUploader[]>([]),[loaded,setLoaded]=useState(false),[count,setCount]=useState(pending.current?.count||20),[busy,setBusy]=useState(false),[retrying,setRetrying]=useState(!!pending.current),[draft,setDraft]=useState<VirtualUploader|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function load(){const data=await request();setItems(data.items);setLoaded(true)}
  useEffect(()=>{let alive=true;request().then(data=>{if(alive){setItems(data.items);setLoaded(true)}}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[]);
  async function refresh(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await load()}catch(e:any){setError(e.message)}finally{lock.current=false;setBusy(false)}}
  async function generate(event:React.FormEvent){
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{
      const operation=nextGenerationRequest(pending.current,count,()=>crypto.randomUUID());pending.current=operation;rememberGeneration(operation);setRetrying(true);
      await request('/generate',operation);
      pending.current=null;rememberGeneration(null);setRetrying(false);setMessage(`已确认生成 ${operation.count} 个虚拟展示用户。已有视频匹配保持不变。`);
      try{await load()}catch(e:any){setError('生成已成功，但列表刷新失败：'+e.message)}
    }catch(e:any){setError(e.message+'；重试会继续确认同一批次，不会另生成一批。')}
    finally{lock.current=false;setBusy(false)}
  }
  async function save(event:React.FormEvent){
    event.preventDefault();if(lock.current||!draft)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{
      await request('/'+encodeURIComponent(draft.id),{name:draft.name.trim(),avatarUrl:draft.avatarUrl?.trim()||null,enabled:draft.enabled},'PUT');setDraft(null);setMessage('虚拟展示资料已保存。');
      try{await load()}catch(e:any){setError('保存已成功，但列表刷新失败：'+e.message)}
    }catch(e:any){setError(e.message)}finally{lock.current=false;setBusy(false)}
  }
  return <div className="virtual-uploaders">
    <section className="virtual-explainer"><span className="virtual-badge">独立展示资料</span><h2>虚拟展示用户</h2><p>这些资料仅用于影片的虚拟展示署名，不是登录账号，也不代表真实上传记录。与真实用户、管理员、会员权限和积分完全分开。</p><p>生成后会自动匹配影片，已有匹配会保留；新增用户不会重新分配旧影片。停用会暂时隐藏关联署名，重新启用后恢复。</p></section>
    {error&&<p className="virtual-error" role="alert">{error}</p>}{message&&<p className="virtual-success" role="status">{message}</p>}
    <form className="virtual-generate" onSubmit={generate}><div><h3>批量生成</h3><p>每批 1–100 个，之后可以分别修改展示名称与头像。</p></div><label>生成数量<input aria-label="生成数量" type="number" min={1} max={100} step={1} required value={count} disabled={busy||retrying} onChange={event=>setCount(Number(event.target.value))}/></label><button className="primary" type="submit" disabled={busy}>{busy?'正在处理…':retrying?'重试确认同一批次':'生成虚拟用户'}</button>{retrying&&<small>有一批生成结果待确认。重试不会重复生成。</small>}</form>
    <section className="virtual-roster"><header><h3>展示资料 · {items.length}</h3><button type="button" disabled={busy} onClick={()=>void refresh()}>刷新列表</button></header>
      {!loaded?<p>正在读取展示资料；若读取失败，请点“刷新列表”重试。</p>:!items.length?<p className="virtual-empty">还没有虚拟展示用户。生成后才会显示虚拟署名，不会从真实账号中分配。</p>:<div className="virtual-grid">{items.map(item=><article key={item.id} className={'virtual-person '+(!item.enabled?'is-disabled':'')}><div className="virtual-person-heading"><span className="virtual-avatar">{item.avatarUrl?<img src={item.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>:item.name.slice(0,1)||'虚'}</span><div><h4>{item.name}</h4><span>{item.enabled?'展示中':'已停用'} · 虚拟展示身份</span></div></div><button type="button" disabled={busy} onClick={()=>{setDraft({...item});setError('');setMessage('')}}>编辑资料</button></article>)}</div>}
    </section>
    {draft&&<section className="virtual-editor" aria-label="编辑虚拟展示资料"><form onSubmit={save}><h3>编辑虚拟展示资料</h3><label>展示名称<input aria-label="展示名称" autoFocus required maxLength={40} value={draft.name} disabled={busy} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label>头像地址（可留空）<input aria-label="头像地址" type="text" inputMode="url" maxLength={2048} placeholder="https://… 或 /images/…" value={draft.avatarUrl||''} disabled={busy} onChange={event=>setDraft({...draft,avatarUrl:event.target.value})}/></label><small>仅填写公开的 HTTPS 图片地址或站内 /images/… 路径；留空使用文字头像。浏览器会向该图片服务请求头像。</small><label className="virtual-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/>启用虚拟展示署名</label><p>停用不删除已有匹配，也不会影响任何真实账号。</p><div className="virtual-editor-actions"><button type="button" disabled={busy} onClick={()=>setDraft(null)}>取消</button><button className="primary" type="submit" disabled={busy||!draft.name.trim()}>{busy?'正在保存…':'保存资料'}</button></div></form></section>}
  </div>;
}
