import React,{useEffect,useState} from 'react';
import './ai-settings.css';

type Status={configured:boolean;model:string;credentialSource:string};
const url=(import.meta.env.VITE_API_URL||'')+'/api/admin/ai';
export default function AiSettings(){
  const [status,setStatus]=useState<Status>(),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{fetch(url,{credentials:'include',cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'无法读取 AI 配置');return body}).then(setStatus).catch(e=>setMessage(e.message))},[]);
  async function save(event:React.FormEvent){event.preventDefault();if(!key.trim()||busy)return;setBusy(true);setMessage('');try{const response=await fetch(url,{method:'PUT',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,model:'gpt-6.1-sol'})});const body=await response.json();if(!response.ok)throw Error(body.error||'保存失败');setStatus({...body,credentialSource:'database'});setKey('');setMessage('AI 密钥已保存在服务器，网页不回显密钥。')}catch(error:any){setMessage(error.message)}finally{setBusy(false)}}
  return <section className="ai-settings"><h2>AI 找片 · GPT-6.1 Sol</h2><p>密钥只保存在服务器；普通用户无法读取。每个账号每天最多 20 次、全站每天最多 60 次 AI 调用，超过限额时普通搜索仍可使用。</p><p role="status">{!status?'正在读取 AI 配置…':status.configured?'已配置，可在 AI 找片页面使用':'尚未配置 AI 密钥'}{status?.credentialSource==='environment'?'（服务器环境变量管理）':''}</p><form onSubmit={save}><label>OpenAI 项目 API 密钥<input type="password" autoComplete="new-password" aria-label="OpenAI 项目 API 密钥" value={key} onChange={event=>setKey(event.target.value)} disabled={!status||status.credentialSource==='environment'} placeholder={status?.configured?'留空保留现有密钥；填写新密钥可替换':'粘贴项目密钥，保存后不回显'}/></label><button className="primary" type="submit" disabled={busy||!status||status.credentialSource==='environment'||!key.trim()}>{busy?'正在保存…':'保存 AI 配置'}</button></form>{message&&<p role="status">{message}</p>}</section>;
}
