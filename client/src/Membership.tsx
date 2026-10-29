import React,{useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import './membership.css';
import AccountPicker,{type PickerAccount} from './AccountPicker';
import ContentRulesEditor,{readRules} from './ContentRulesEditor';
import {PermissionChooser,SourceGrantPicker,AccessGroupManager,readList} from './GrantEditors';

const base=(import.meta.env.VITE_API_URL||'')+'/api';
async function request(path:string,body?:any,method='POST'){
  const response=await fetch(base+path,{credentials:'include',cache:'no-store',...body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}});
  const data=await response.json();if(!response.ok)throw Error(data.error||'操作失败');return data;
}
const parse=readList;
const date=(value:string)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const kind=(value:string)=>({admin_grant:'管理员赠送',admin_adjust:'管理员调整',membership_redeem:'兑换会员'}[value]||value);
const updated=()=>window.dispatchEvent(new Event('dbtv:account-updated'));

function Ledger({items,users=[]}:{items:any[];users?:any[]}){return <div className="member-ledger"><p className="member-muted">最近100条记录；正数为入账，负数为支出。流水不可直接修改或删除。</p><div className="member-ledger-scroll"><table><thead><tr><th>时间 / 类型</th>{!!users.length&&<th>用户</th>}<th>变动</th><th>变动后余额</th><th>说明</th></tr></thead><tbody>{items.map(row=><tr key={row.id}><td>{date(row.createdAt)}<small>{kind(row.kind)}</small></td>{!!users.length&&<td>{users.find(u=>u.id===row.userId)?.username||'历史账号'}<small className="member-number">{users.find(u=>u.id===row.userId)?.memberNo||'—'}</small></td>}<td className={row.delta>0?'member-credit':'member-debit'}>{row.delta>0?'+':''}{row.delta}</td><td>{row.balanceAfter}</td><td>{row.reason}{row.expiresAfter&&<small>会员到期：{date(row.expiresAfter)}</small>}</td></tr>)}</tbody></table>{!items.length&&<p className="member-muted">暂无积分变动</p>}</div></div>}

export default function Membership(){
  const [data,setData]=useState<any>(),[error,setError]=useState(''),[message,setMessage]=useState(''),[selected,setSelected]=useState<any>(),[busy,setBusy]=useState(false);
  const operation=useRef('');
  const load=()=>request('/membership').then(setData);
  useEffect(()=>{void load().catch(e=>setError(e.message))},[]);
  async function redeem(){if(!selected||busy)return;setBusy(true);setError('');try{await request('/membership/redeem',{planId:selected.id,expectedVersion:selected.version,requestId:operation.current});setSelected(undefined);setMessage('兑换成功，会员权限已生效。');await load();updated()}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  const account=data?.account;
  return <main className="content-page member-page"><div className="member-eyebrow">DABIAO MEMBERSHIP</div><header className="member-heading"><div><h1>会员与积分</h1><p>用积分开启你的专属观影权益</p></div><button onClick={()=>{setError('');void load().then(updated).catch(e=>setError(e.message))}}>刷新账户</button></header>
    {error&&<p role="alert" className="member-error">{error}</p>}{message&&<p role="status" className="member-success">{message}</p>}
    {!data?<p className="member-muted">正在读取账户…</p>:<>
      <section className="member-summary"><div><span>我的积分</span><code className="member-number">会员号：{account.memberNo}</code><strong>{account.points.toLocaleString()}</strong><small>{data.payment.message}</small></div><div><span>当前身份</span><h2>{account.membership.name}</h2><small>{account.membership.active?`有效期至 ${date(account.membership.expiresAt)}`:account.membership.expired?'会员已到期，当前按普通用户权限访问':'普通用户无会员有效期限制'}</small>{account.guest&&<small>你正在以游客身份浏览，<Link to="/login">登录</Link>后可兑换会员并使用收藏、历史等个人功能。</small>}{account.role==='admin'&&<Link to="/admin/membership">管理会员套餐和积分 →</Link>}</div></section>
      <section className="member-current"><h2>我的当前权限</h2><div className="member-chips">{account.permissions.map((key:string)=><span key={key}>{data.permissionLabels[key]}</span>)}</div><p className="member-muted">可用源：{account.sourceKeys.includes('*')?'全部启用的数据源':`${account.sourceKeys.length} 个授权数据源`}。已保存的等级以勾选范围为准；全站关闭的数据源不可访问。</p></section>
      <section><div className="member-section-title"><h2>积分兑换会员</h2><span>同等级可续费 · 不自动扣费</span></div><p className="member-muted">续费从当前到期时间延长；过期后从兑换时间开始。有效期内暂不支持不同等级间折算。套餐权限调整会影响该等级的现有会员。</p>
        {!data.plans.length?<div className="member-empty">暂未上架会员套餐，请联系管理员配置。</div>:<div className="member-plans">{data.plans.map((plan:any)=><article className="member-plan" key={plan.id}><span className="member-eyebrow">MEMBERSHIP</span><h3>{plan.name}</h3><p>{plan.description||'专属会员权限'}</p><div className="member-price"><strong>{plan.pricePoints}</strong> 积分 <small>/ {plan.durationDays} 天</small></div><ul>{parse(plan.permissions).map((key:string)=><li key={key}>{data.permissionLabels[key]}</li>)}</ul><small className="member-muted">{plan.allSources?'全部启用的数据源':`${parse(plan.sourceKeys).length} 个会员授权源`}</small><button disabled={busy||account.guest||account.points<plan.pricePoints} onClick={()=>{setError('');operation.current=crypto.randomUUID();setSelected(plan)}}>{account.guest?'登录后兑换':account.points<plan.pricePoints?'积分不足':account.membership.active&&account.membership.planId===plan.id?'续费此会员':'选择此会员'}</button></article>)}</div>}
      </section><section><h2>我的积分流水</h2><Ledger items={data.ledger}/></section>
    </>}
    {selected&&<div className="member-modal-backdrop"><section className="member-modal" role="dialog" aria-modal="true" aria-labelledby="redeem-title"><h2 id="redeem-title">确认积分兑换</h2><p>为当前账号兑换「{selected.name}」{selected.durationDays}天，需要扣除 <b>{selected.pricePoints} 积分</b>。</p><p>当前余额 {account.points}，兑换后 {account.points-selected.pricePoints}。不涉及现金付款，不会自动续费。</p>{error&&<p role="alert" className="member-error">{error}</p>}<div className="member-actions"><button disabled={busy} onClick={()=>setSelected(undefined)}>取消</button><button className="primary" disabled={busy} onClick={()=>void redeem()}>{busy?'正在兑换…':`确认扣除 ${selected.pricePoints} 积分`}</button></div></section></div>}
  </main>;
}

const blankPlan=()=>({id:'',name:'',description:'',pricePoints:300,durationDays:30,enabled:false,permissions:['home','sources','search','playback','favorites','history','recommendations','discover','danmaku'],sourceKeys:[] as string[],accessGroupIds:[] as string[],allSources:false,contentRules:readRules(null),version:0});
const planDraft=(plan:any)=>({...plan,permissions:parse(plan.permissions),sourceKeys:parse(plan.sourceKeys),accessGroupIds:parse(plan.accessGroupIds),contentRules:readRules(plan.contentRules)});
export function MembershipAdmin(){
  const [data,setData]=useState<any>(),[draft,setDraft]=useState<any>(blankPlan),[tab,setTab]=useState('plans'),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[gift,setGift]=useState({userId:'',delta:100,reason:''}),[recipient,setRecipient]=useState<PickerAccount|null>(null);
  const operation=useRef({signature:'',id:''});
  const load=()=>request('/admin/membership').then(data=>{setData(data);return data});
  useEffect(()=>{void load().then(data=>{const first=data.plans.find((plan:any)=>plan.id==='free')||data.plans[0];if(first)setDraft(planDraft(first))}).catch(e=>setError(e.message))},[]);
  const edit=(plan:any)=>{setError('');setMessage('');setDraft(planDraft(plan));};
  async function save(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');
    try{const saved=await request('/admin/membership/plans'+(draft.id?'/'+draft.id:''),{...draft,contentRules:{...draft.contentRules,sourceSelection:'grade'}},draft.id?'PUT':'POST');await load();setDraft(planDraft(saved));setMessage('已保存，源选择和分类限制已生效。');updated()}catch(e:any){setError(e.message)}finally{setBusy(false)}
  }
  async function give(event:React.FormEvent){
    event.preventDefault();if(busy||!recipient||String(recipient.id)!==gift.userId)return;setBusy(true);setError('');setMessage('');
    const signature=JSON.stringify(gift);if(operation.current.signature!==signature)operation.current={signature,id:crypto.randomUUID()};
    try{const result=await request('/admin/membership/users/'+gift.userId+'/points',{delta:Number(gift.delta),reason:gift.reason,requestId:operation.current.id});setRecipient(current=>current?{...current,points:result.entry.balanceAfter}:null);await load();setMessage('积分操作已完成并记入流水。');operation.current={signature:'',id:''};setGift(current=>({...current,reason:''}));updated()}catch(e:any){setError(e.message)}finally{setBusy(false)}
  }
  return <div className="member-admin">
    <div className="member-compact-stats"><span>账号 {data?.stats?.totalUsers??'—'}</span><span>有效会员 {data?.stats?.activeMembers??'—'}</span><span>套餐 {data?.stats?.enabledPlans??'—'}</span></div>
    <div className="member-tabs">{[['plans','套餐与权限'],['points','赠送 / 调整积分'],['groups','源分组'],['ledger','积分流水']].map(([key,label])=><button key={key} aria-pressed={tab===key} onClick={()=>{setTab(key);setError('');setMessage('')}}>{label}</button>)}</div>
    {error&&<p role="alert" className="member-error">{error}</p>}{message&&<p role="status" className="member-success">{message}</p>}
    {!data?<p>正在读取会员设置…</p>:tab==='plans'?<div className="member-admin-grid">
      <section className="member-panel"><div className="member-section-title"><h2>会员等级</h2><button disabled={busy} onClick={()=>setDraft(blankPlan())}>＋ 新建套餐</button></div><p className="member-muted">先配置普通等级，再为不同会员安排专属权益。</p>{data.plans.map((plan:any)=><button className={'member-plan-row '+(draft.id===plan.id?'selected':'')} key={plan.id} onClick={()=>edit(plan)}><b>{plan.name}</b><small>{plan.id==='free'?'普通用户默认等级':plan.pricePoints+'积分 / '+plan.durationDays+'天'} · {plan.enabled?'已启用':'未上架'}</small><small>{parse(plan.permissions).length}项单独权限 · {parse(plan.accessGroupIds).length}个源分组</small></button>)}</section>
      <form className="member-panel member-form" onSubmit={save}><h2>{draft.id==='free'?'编辑普通用户权限':draft.id?'编辑会员套餐':'新建会员套餐'}</h2>
        <label>等级名称<input required maxLength={40} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <details className="grant-advanced"><summary>套餐说明 <span>选填</span></summary><label>说明<textarea maxLength={500} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label></details>
        {draft.id!=='free'&&<div className="member-form-pair"><label>兑换积分<input type="number" min={1} max={1000000} step={1} required value={draft.pricePoints} onChange={e=>setDraft({...draft,pricePoints:Number(e.target.value)})}/></label><label>会员天数<input type="number" min={1} max={3650} step={1} required value={draft.durationDays} onChange={e=>setDraft({...draft,durationDays:Number(e.target.value)})}/></label></div>}
        <PermissionChooser labels={data.permissionLabels} value={draft.permissions} disabled={busy} onChange={permissions=>setDraft({...draft,permissions})}/>
        <SourceGrantPicker sources={data.sources} groups={data.groups} value={draft.sourceKeys} groupIds={draft.accessGroupIds} disabled={busy} onChange={sourceKeys=>setDraft({...draft,sourceKeys})} selection={{keys:draft.sourceKeys,groupIds:draft.accessGroupIds,excluded:draft.contentRules.deniedSourceKeys,all:draft.allSources}} onSelection={selection=>setDraft((current:any)=>({...current,sourceKeys:selection.keys,accessGroupIds:selection.groupIds,allSources:selection.all,contentRules:{...current.contentRules,deniedSourceKeys:selection.excluded}}))}/>
        <ContentRulesEditor sources={data.sources} value={draft.contentRules} disabled={busy} onChange={contentRules=>setDraft({...draft,contentRules})}/>
        {draft.id!=='free'&&<label className="member-check"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>启用并上架兑换</label>}
        <div className="member-savebar"><small>保存后，对当前等级的所有账号生效；未勾选的源不可看。</small><button className="primary" disabled={busy}>{busy?'正在保存…':'保存设置'}</button></div>
      </form>
    </div>:tab==='points'?<form className="member-panel member-form member-gift" onSubmit={give}>
      <h2>赠送或调整用户积分</h2><p className="member-muted">支持搜索用户名、昵称、完整或部分会员号。从结果中选定账号后才能操作。</p>
      <AccountPicker value={recipient} disabled={busy} onChange={account=>{setRecipient(account);setGift(current=>({...current,userId:account?String(account.id):''}));setMessage('')}}/>
      <label>积分变动（正数赠送，负数扣减）<input required type="number" step={1} min={-1000000} max={1000000} value={gift.delta} onChange={e=>setGift({...gift,delta:Number(e.target.value)})}/></label>
      <label>操作原因<input required minLength={2} maxLength={120} placeholder="例如：活动奖励、客服补偿" value={gift.reason} onChange={e=>setGift({...gift,reason:e.target.value})}/></label>
      {recipient&&<p className="member-warning">操作对象：{recipient.username}（{recipient.memberNo}）；本次{gift.delta>0?'增加':'扣减'} {Math.abs(gift.delta)} 积分。请核对会员号后确认。</p>}
      <button className="primary" disabled={busy||!gift.delta||!recipient}>{busy?'正在处理…':gift.delta>0?'确认赠送积分':'确认扣减积分'}</button>
    </form>:tab==='groups'?<AccessGroupManager groups={data.groups} sources={data.sources} save={async group=>{await request('/admin/access-groups'+(group.id?'/'+group.id:''),group,group.id?'PUT':'POST');await load();updated()}}/>:<Ledger items={data.ledger} users={data.users}/>}
  </div>;
}

export function Register({settings}:{settings:Record<string,string>}){
  const [form,setForm]=useState({username:'',password:'',confirmPassword:''}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  return <div className="login-screen"><div className="login-backdrop"/><form className="login-panel" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await request('/auth/register',form);setDone(true);setForm({username:'',password:'',confirmPassword:''})}catch(e:any){setError(e.message)}finally{setBusy(false)}}}><Link className="login-logo" to="/login"><img src={settings.logoUrl||'/images/dabiao-logo.svg'} alt={settings.siteName||'大彪TV'}/></Link><h1>创建账号</h1>{done?<><p role="status">注册成功，初始积分为0，请登录后查看会员权益。</p><Link to="/login">前往登录 →</Link></>:settings.allowRegister!=='true'?<><p>暂未开放注册，请联系管理员。</p><Link to="/login">返回登录</Link></>:<><label>用户名<input required pattern="[A-Za-z0-9_-]{3,32}" minLength={3} maxLength={32} autoComplete="username" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label>密码<input required type="password" minLength={6} maxLength={128} autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><label>确认密码<input required type="password" minLength={6} maxLength={128} autoComplete="new-password" value={form.confirmPassword} onChange={e=>setForm({...form,confirmPassword:e.target.value})}/></label><button className="primary wide" disabled={busy}>{busy?'正在注册…':'注册普通账号'}</button><p><Link to="/login">已有账号？登录</Link></p></>}{error&&<p role="alert" className="member-error">{error}</p>}</form></div>;
}

export function UserAdmin(){
  const [users,setUsers]=useState<any[]>([]),[sources,setSources]=useState<any[]>([]),[groups,setGroups]=useState<any[]>([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState<any>();
  const [form,setForm]=useState({username:'',password:'',role:'user'});
  const load=()=>request('/admin/users?q='+encodeURIComponent(query)).then(setUsers);
  useEffect(()=>{request('/admin/access-groups').then(data=>{setGroups(data.groups);setSources(data.sources)}).catch(e=>setError(e.message))},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);
    const timer=window.setTimeout(()=>fetch(base+'/admin/users?q='+encodeURIComponent(query),{credentials:'include',cache:'no-store',signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error||'搜索失败');if(!controller.signal.aborted)setUsers(data)}).catch(e=>{if(e.name!=='AbortError')setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)}),200);
    return()=>{window.clearTimeout(timer);controller.abort()};
  },[query]);
  async function create(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await request('/admin/users',{...form,sourceKeys:[]});setForm({username:'',password:'',role:'user'});setMessage('账号已创建并分配唯一会员号，初始积分0。');await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}
  }
  async function save(){
    if(!edit||busy)return;setBusy(true);setError('');
    try{await request('/admin/users/'+edit.id,{role:edit.role,enabled:edit.enabled,sourceKeys:edit.sourceKeys,accessGroupIds:edit.accessGroupIds},'PUT');setEdit(undefined);setMessage('账号授权已保存。');await load();updated()}catch(e:any){setError(e.message)}finally{setBusy(false)}
  }
  return <div className="member-admin"><div className="member-section-title"><p className="member-muted">每个账号拥有不可重复的会员号。积分、身份与授权独立管理。</p><Link to="/admin/membership">会员套餐 / 赠送积分 →</Link></div>
    {error&&<p role="alert" className="member-error">{error}</p>}{message&&<p role="status" className="member-success">{message}</p>}
    <form className="member-create" onSubmit={create}><input aria-label="新用户名" required pattern="[A-Za-z0-9_-]{3,32}" placeholder="用户名" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><input aria-label="初始密码" required minLength={6} maxLength={128} type="password" placeholder="初始密码（至少6位）" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><select aria-label="账号角色" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="user">普通用户</option><option value="admin">管理员</option></select><button disabled={busy}>创建账号</button></form>
    <div className="member-search-bar"><input aria-label="搜索用户或会员号" placeholder="搜索用户名、昵称或会员号…" value={query} onChange={e=>setQuery(e.target.value)}/><span>{loading?'正在搜索…':'本次展示 '+users.length+' 个账号 · 最多200个，可继续输入缩小范围'}</span></div>
    <div className="member-user-list">{users.map(user=><article className="member-user-row" key={user.id}><div><b>{user.displayName||user.username}</b><small className="member-number">{user.memberNo}</small><small>{user.username} · {user.role==='admin'?'管理员':'用户'} · {user.enabled?'正常':'已禁用'}</small></div><div><strong>{user.points} 积分</strong><small>{user.membershipPlanId?'会员到期：'+date(user.membershipExpiresAt):'普通用户'} · {parse(user.accessGroupIds).length}个额外授权组</small></div><button disabled={busy} onClick={()=>{setError('');setEdit({...user,sourceKeys:user.sourceAccess.map((x:any)=>x.sourceKey),accessGroupIds:parse(user.accessGroupIds)})}}>管理账号授权</button></article>)}</div>
    {edit&&<section className="member-panel member-form"><h2>管理账号：{edit.username}</h2><p className="member-number">会员号：{edit.memberNo}</p>
      {edit.role!=='admin'&&<label className="member-check"><input type="checkbox" checked={edit.enabled} onChange={e=>setEdit({...edit,enabled:e.target.checked})}/>启用账号（禁用将注销其登录会话）</label>}
      <p className="member-muted">已保存的等级以等级勾选范围为准；以下额外授权仅适用于尚未重新保存的旧版等级。</p>
      <SourceGrantPicker sources={sources} groups={groups} value={edit.sourceKeys} groupIds={edit.accessGroupIds} disabled={busy} onChange={sourceKeys=>setEdit((current:any)=>({...current,sourceKeys}))} onGroups={accessGroupIds=>setEdit((current:any)=>({...current,accessGroupIds}))}/>
      <div className="member-actions"><button disabled={busy} onClick={()=>setEdit(undefined)}>取消</button><button className="primary" disabled={busy} onClick={()=>void save()}>保存账号授权</button></div>
    </section>}
  </div>;
}
