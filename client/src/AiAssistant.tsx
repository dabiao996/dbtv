import React,{useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import CinemaCard from './cinema/MovieCard';
import './ai-assistant.css';

type Mode='find'|'recommend';
type Message={role:'user'|'assistant';content:string;items?:any[]};
const base=(import.meta.env.VITE_API_URL||'')+'/api/ai';
export default function AiAssistant(){
  const [params]=useSearchParams(),mode:Mode=params.get('mode')==='recommend'?'recommend':'find';
  const [configured,setConfigured]=useState<boolean|null>(null),[draft,setDraft]=useState(''),[messages,setMessages]=useState<Message[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setMessages([]);setError('');fetch(base+'/status',{credentials:'include',cache:'no-store'}).then(r=>r.json()).then(x=>setConfigured(!!x.configured)).catch(()=>setConfigured(false))},[mode]);
  async function submit(event:React.FormEvent){event.preventDefault();const prompt=draft.trim();if(!prompt||busy||!configured)return;setDraft('');setBusy(true);setError('');const turns=messages.slice(-4).map(({role,content})=>({role,content}));setMessages(old=>[...old,{role:'user',content:prompt}]);
    try{const response=await fetch(base+'/chat',{method:'POST',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,prompt,turns})});const body=await response.json();if(!response.ok)throw Error(body.error||'AI 暂时不可用');setMessages(old=>[...old,{role:'assistant',content:body.reply,items:body.items}])}catch(e:any){setError(e.message);setDraft(prompt);setMessages(old=>old.slice(0,-1))}finally{setBusy(false)}
  }
  return <main className="content-page ai-assistant"><div className="page-heading"><small>AI · 只从现有可访问片源找片</small><h1>{mode==='find'?'AI 找片':'对话推荐'}</h1></div><div className="ai-mode-tabs"><Link className={mode==='find'?'active':''} to="/ai?mode=find">自然语言找片</Link><Link className={mode==='recommend'?'active':''} to="/ai?mode=recommend">对话推荐</Link><Link to="/search">普通搜索</Link></div>
    <p className="ai-privacy">你输入的对话会发送至 AI 服务；对话推荐只附带已保存的题材偏好，不发送账号、观看历史、收藏或播放地址。结果仅来自你当前有权访问的片源。</p>
    {configured===false?<div className="ai-unavailable" role="status"><b>AI 服务尚未配置</b><p>管理员需在服务器端配置 DBTV_AI_API_KEY 和 DBTV_AI_MODEL。普通搜索与片库仍可使用。</p><Link to="/search">使用普通搜索 →</Link></div>:<><div className="ai-conversation" aria-live="polite">{messages.length?messages.map((message,index)=><div key={index} className={`ai-message ai-${message.role}`}><p>{message.content}</p>{!!message.items?.length&&<div className="movie-grid">{message.items.map(item=><CinemaCard key={`${index}:${item.sourceKey}:${item.id}`} video={item}/>)}</div>}</div>):<p className="ai-prompt">{mode==='find'?'例如：想看轻松治愈的日本动画电影':'例如：我喜欢悬疑，但今天想看节奏轻快一点的片'}</p>}</div><form className="ai-compose" onSubmit={submit}><label htmlFor="ai-request">描述你想看的影片</label><div><input id="ai-request" value={draft} onChange={event=>setDraft(event.target.value)} maxLength={300} disabled={!configured||busy} placeholder="说说题材、心情，或你喜欢的类似作品"/><button type="submit" disabled={!configured||busy||!draft.trim()}>{busy?'正在找片…':'发送'}</button></div></form>{error&&<p role="alert" className="ai-error">{error}</p>}</>}
  </main>;
}
