import React,{useEffect,useState} from 'react';
import {requestUpdate as request} from './update-api';
import './updates.css';
export default function SystemUpdates(){
  const [info,setInfo]=useState<any>(),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState(''),[confirmed,setConfirmed]=useState(false),[submitted,setSubmitted]=useState(false);
  const refresh=async()=>{try{setInfo(await request());}catch{setMessage('暂时无法连接后台。如果正在更新，服务重启后会自动重新连接。');}};
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},5000);const checked=()=>void refresh();window.addEventListener('dbtv:updates-checked',checked);return()=>{clearInterval(timer);window.removeEventListener('dbtv:updates-checked',checked);};},[]);
  async function act(action:string,target:string){
    if(!confirmed||!password){setMessage('请先确认已了解停站与数据风险，并验证当前管理员密码。');return;}
    if(!window.confirm(action==='update'?`增量更新到 ${target}？不会自动备份；依赖变化时会按锁文件同步，更新失败可能需要人工修复程序。`:'确认仅回退程序？不会把旧数据库覆盖回来；不兼容的记录不能自动回退。'))return;
    setBusy(true);setMessage('');try{const value=await request('/request',{action,target,password,confirmed:true});setMessage(value.message);setSubmitted(true);setPassword('');setConfirmed(false);await refresh();}catch(error:any){setMessage(error.message);}finally{setBusy(false);}
  }
  async function selectVersion(target:string){
    setBusy(true);setMessage('');setSubmitted(false);
    try{const check=await request('/check',{target});setInfo((current:any)=>({...current,check}));}
    catch(error:any){setMessage(error.message);}
    finally{setBusy(false);}
  }
  if(!info)return <div className="update-panel"><p>正在检查版本和主机状态…</p>{message&&<p role="status">{message}</p>}</div>;
  const latest=info.check?.latest,selected=info.check?.selected||latest,job=info.agent?.job,incremental=info.agent?.mode==='incremental';
  const running=['running','queued','blocked'].includes(job?.state);
  const disabled=busy||running||!info.agent.enabled||!info.trustConfigured||!confirmed||!password||submitted;
  return <div className="system-updates">
    <section className="update-hero"><div><small>RELEASE CENTER</small><h2>仅同步程序差异</h2><p>只接受经过签名验证的正式版本；账号、数据库、直播 JSON 与本地配置保持原样。没有自动备份时，失败可能需要人工修复程序。</p></div></section>
    <div className="update-stats"><section><small>当前版本</small><strong>{info.current.version}</strong><span>{info.current.channel==='stable'?'正式版':'开发版 · 尚未正式发布'}</span></section><section><small>最新正式版</small><strong>{latest?.version||'—'}</strong><span>{info.check?.state==='checked'?(info.check.available?'可选择正式版本':'当前已是最新正式版'):'尚未成功检查'}</span></section><section><small>更新方式</small><strong>{incremental?'一次性增量任务':info.agent.enabled?'托管更新':'未启用'}</strong><span>无需网页运行高权限命令</span></section></div>
    {info.check?.error&&<div className="update-notice" role="status">{info.check.error}。检查失败不代表已经是最新版本。</div>}
    {!info.agent.enabled&&<div className="update-notice">当前只可检查正式版。一次性增量任务必须由本机开发站明确启用；已有旧站不会被自动接管。</div>}
    {latest&&selected&&<section className="update-panel"><header><h3>选择正式版本</h3><a href={selected.url} target="_blank" rel="noreferrer">查看所选发行 ↗</a></header><label>GitHub 正式 Release<select value={selected.version} disabled={busy||running} onChange={event=>void selectVersion(event.target.value)}>{(info.check.choices||[latest]).map((item:any)=><option key={item.version} value={item.version}>{item.version}{item.version===info.current.version?'（当前版本）':''}</option>)}</select></label><pre>{selected.notes||'发行方未填写更新说明。'}</pre><p className="update-muted">{selected.dataCompatible?'所选版本的签名已验证，数据库兼容标识一致；本地修改会阻止覆盖。':'数据库兼容标识不同：已阻止切换，需另行决定迁移方式；不会自动修改数据库。'}</p><button className="primary" disabled={disabled||!selected.dataCompatible||selected.version===info.current.version&&info.current.channel==='stable'} onClick={()=>void act('update',selected.version)}>切换到所选版本的程序文件</button></section>}
    <section className="update-panel"><h3>敏感操作确认</h3><label className="update-consent"><input type="checkbox" checked={confirmed} onChange={event=>{setConfirmed(event.target.checked);setSubmitted(false);}}/>我了解不会自动备份；更新中断可能需要人工修复程序，数据不作自动回退。</label><label>验证当前管理员密码<input type="password" value={password} onChange={event=>{setPassword(event.target.value);setSubmitted(false);}} maxLength={128} autoComplete="current-password" placeholder="仅提交本次操作，不保存到浏览器"/></label></section>
    {(job||message)&&<section className="update-panel" aria-live="polite"><h3>操作进度</h3><p>{message}</p>{job&&<p>{job.state} · {job.message}</p>}{job?.state==='blocked'&&<p className="update-warning">更新任务已锁定。请检查程序文件和依赖状态；不要删除任务标记来强行重试。</p>}</section>}
    {!incremental&&<section className="update-panel"><h3>历史程序版本</h3><p className="update-muted">无备份时仅能评估兼容的程序回退，数据库和直播 JSON 不会自动恢复。</p>{!info.agent.history?.length?<p>尚无成功更新记录。</p>:<div className="update-history">{info.agent.history.map((item:any)=><article key={item.id}><div><b>{item.version}</b><small>{new Date(item.at).toLocaleString()} · {item.hasBackup?'历史备份存在':'无自动备份'}</small></div><button disabled={disabled||!item.canRollback} onClick={()=>void act('rollback',item.id)}>{item.canRollback?'仅回退程序':'需人工检查数据兼容性'}</button></article>)}</div>}</section>}
  </div>;
}
