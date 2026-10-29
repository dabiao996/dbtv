import React,{useEffect,useState} from 'react';
import './ai-settings.css';

type Status={configured:boolean;model:string;credentialSource:string};
const url=(import.meta.env.VITE_API_URL||'')+'/api/admin/ai';
export default function AiSettings(){
  const [status,setStatus]=useState<Status>(),[key,setKey]=useState(''),[model,setModel]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{fetch(url,{credentials:'include',cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'无法读取 AI 配置');return body}).then(body=>{setStatus(body);setModel(body.model||'')}).catch(e=>setMessage(e.message))},[]);
  const envManaged=status?.credentialSource==='environment';
  const dirty=key.trim()!==''||(status&&model.trim()!==''&&model.trim()!==status.model);
  async function save(event:React.FormEvent){event.preventDefault();if(busy||!dirty)return;setBusy(true);setMessage('');try{const response=await fetch(url,{method:'PUT',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key.trim(),model:model.trim()})});const body=await response.json();if(!response.ok)throw Error(body.error||'保存失败');setStatus({...body,credentialSource:'database'});setModel(body.model||model);setKey('');setMessage('AI 配置已保存在服务器，网页不回显密钥。')}catch(error:any){setMessage(error.message)}finally{setBusy(false)}}
  return <section className="ai-settings"><h2>AI 找片</h2><p>密钥只保存在服务器；普通用户无法读取。支持 OpenAI 及兼容网关的密钥（不再限制 sk- 开头）。每个账号每天最多 20 次、全站每天最多 60 次 AI 调用，超过限额时普通搜索仍可使用。</p><p role="status">{!status?'正在读取 AI 配置…':status.configured?'已配置，可在 AI 找片页面使用':'尚未配置 AI 密钥'}{envManaged?'（服务器环境变量管理）':''}</p><form onSubmit={save}><label>API 密钥<input type="password" autoComplete="new-password" aria-label="API 密钥" value={key} onChange={event=>setKey(event.target.value)} disabled={!status||envManaged} placeholder={status?.configured?'留空保留现有密钥；填写新密钥可替换':'粘贴 API 密钥，保存后不回显'}/></label><label>模型名<input type="text" autoComplete="off" aria-label="模型名" value={model} onChange={event=>setModel(event.target.value)} disabled={!status||envManaged} placeholder="例如 gpt-6.1-sol 或网关提供的模型名"/></label><button className="primary" type="submit" disabled={busy||!status||envManaged||!dirty}>{busy?'正在保存…':'保存 AI 配置'}</button></form>{message&&<p role="status">{message}</p>}</section>;
}
