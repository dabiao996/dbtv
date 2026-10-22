import React,{useEffect,useState} from 'react';
import {requestUpdate as request} from './update-api';
import './updates.css';
export default function SystemUpdates(){
  const [info,setInfo]=useState<any>(),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState(''),[confirmed,setConfirmed]=useState(false),[submitted,setSubmitted]=useState(false);
  const refresh=async()=>{try{setInfo(await request());}catch{setMessage('暂时无法连接后台。如果正在更新，服务重启后会自动重新连接。');}};
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},5000);const checked=()=>void refresh();window.addEventListener('dbtv:updates-checked',checked);return()=>{clearInterval(timer);window.removeEventListener('dbtv:updates-checked',checked);};},[]);
  async function act(action:string,target:string){
    if(!confirmed||!password){setMessage('请先确认已了解停站与数据风险，并验证当前管理员密码。');return;}
    if(!window.confirm(action==='update'?`更新到 ${target}？将先停止网站并备份SQLite，期间暂时不可访问。`:'确认仅回退程序？不会把旧数据库覆盖回来；不兼容的记录不能自动回退。'))return;
    setBusy(true);setMessage('');try{const value=await request('/request',{action,target,password,confirmed:true});setMessage(value.message);setSubmitted(true);setPassword('');setConfirmed(false);await refresh();}catch(error:any){setMessage(error.message);}finally{setBusy(false);}
  }
  if(!info)return <div className="update-panel"><p>正在检查版本和主机状态…</p>{message&&<p role="status">{message}</p>}</div>;
  const latest=info.check?.latest,job=info.agent?.job;
  const running=['running','queued','blocked'].includes(job?.state);
  const disabled=busy||running||!info.agent.enabled||!info.trustConfigured||!confirmed||!password||submitted;
  return <div className="system-updates">
    <section className="update-hero"><div><small>RELEASE CENTER</small><h2>让更新可控，也有退路</h2><p>只安装经过签名验证的正式版本。端口、账号和持久数据保持独立。</p></div></section>
    <div className="update-stats"><section><small>当前版本</small><strong>{info.current.version}</strong><span>{info.current.channel==='stable'?'正式版':'开发版 · 尚未正式发布'}</span></section><section><small>最新正式版</small><strong>{latest?.version||'—'}</strong><span>{info.check?.state==='checked'?(info.check.available?'有新版本可用':'未发现更高正式版本'):'尚未成功检查'}</span></section><section><small>独立更新代理</small><strong>{info.agent.enabled?'已启用':'未启用'}</strong><span>网页不直接操作Docker或root</span></section></div>
    {info.check?.error&&<div className="update-notice" role="status">{info.check.error}。检查失败不代表已经是最新版本。</div>}
    {!info.agent.enabled&&<div className="update-notice">当前可以查看版本。要从后台执行更新，请先在主机按《更新与回退说明》配置签名公钥并运行 enable-updates；手动部署或外部数据库未配置备份时，不开放自动更新。</div>}
    {latest&&<section className="update-panel"><header><h3>版本 {latest.version}</h3><a href={latest.url} target="_blank" rel="noreferrer">查看正式发行 ↗</a></header><pre>{latest.notes||'发行方未填写更新说明。'}</pre><p className="update-muted">{latest.dataCompatible?'当前数据兼容标识一致，可在保留数据库的情况下回退程序。':'数据兼容标识不同：更新前会备份，但新版本启动后不允许自动回退数据库。'}</p><button className="primary" disabled={disabled||!info.check.available} onClick={()=>void act('update',latest.version)}>备份并更新</button></section>}
    <section className="update-panel"><h3>敏感操作确认</h3><label className="update-consent"><input type="checkbox" checked={confirmed} onChange={event=>{setConfirmed(event.target.checked);setSubmitted(false);}}/>我了解更新会短暂停站，程序回退不等于数据库恢复。</label><label>验证当前管理员密码<input type="password" value={password} onChange={event=>{setPassword(event.target.value);setSubmitted(false);}} maxLength={128} autoComplete="current-password" placeholder="仅提交本次操作，不保存到浏览器"/></label></section>
    {(job||message)&&<section className="update-panel" aria-live="polite"><h3>操作进度</h3><p>{message}</p>{job&&<p>{job.state} · {job.message}</p>}{job?.state==='blocked'&&<p className="update-warning">自动操作已锁定。请在主机检查更新记录与备份，不要删除安装锁来重装。</p>}</section>}
    <section className="update-panel"><h3>可回退的历史版本</h3><p className="update-muted">每次操作前都保留快照；仅数据兼容、旧程序仍存在的记录允许回退。恢复旧数据库可能丢失备份后新增的数据，需停站人工处理。</p>{!info.agent.history?.length?<p>尚无成功更新记录。</p>:<div className="update-history">{info.agent.history.map((item:any)=><article key={item.id}><div><b>{item.version}</b><small>{new Date(item.at).toLocaleString()} · {item.hasBackup?'有备份':'无完整备份'}</small></div><button disabled={disabled||!item.canRollback} onClick={()=>void act('rollback',item.id)}>{item.canRollback?'回退到此版':'需人工检查数据兼容性'}</button></article>)}</div>}</section>
  </div>;
}
