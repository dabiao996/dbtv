import React,{useEffect,useState} from 'react';
import {Link,useLocation} from 'react-router-dom';
import AdminUpdateCheck from './AdminUpdateCheck';
import './admin-shell.css';

const groups=[{name:'工作台',paths:['/admin']},{name:'内容与片库',paths:['/admin/resource-center','/admin/sources','/admin/collection','/admin/categories','/admin/videos','/admin/editor']},{name:'会员与运营',paths:['/admin/users','/admin/membership','/admin/history','/admin/danmaku']},{name:'系统',paths:['/admin/settings','/admin/updates','/admin/errors','/admin/logs']}];
const descriptions:Record<string,string>={'/admin/resource-center':'源码内置资源目录，由你决定哪些源上架使用','/admin':'掌握站点运行与内容动态','/admin/users':'管理账号身份、会员号与额外授权','/admin/membership':'让会员权益、积分与授权井然有序','/admin/sources':'维护你的内容入口与资源可用性','/admin/settings':'配置品牌、注册与网站体验','/admin/collection':'将授权内容整理到自己的片库','/admin/videos':'精细管理内容、分类与展示状态'};
export default function AdminShell({title,links,children}:{title:string;links:string[][];children:React.ReactNode}){
  const location=useLocation();const [open,setOpen]=useState(false),[account,setAccount]=useState<any>();
  useEffect(()=>{const controller=new AbortController();fetch((import.meta.env.VITE_API_URL||'')+'/api/auth/me',{credentials:'include',signal:controller.signal}).then(response=>response.ok?response.json():null).then(setAccount).catch(()=>{});return()=>controller.abort()},[]);
  useEffect(()=>setOpen(false),[location.pathname]);
  useEffect(()=>{if(!open)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false)};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[open]);
  return <div className="console-layout">{open&&<button className="console-scrim" aria-label="关闭侧边导航" onClick={()=>setOpen(false)}/>}
    <aside className={'console-sidebar '+(open?'is-open':'')}><Link className="console-brand" to="/admin"><img className="console-brand-icon" src="/images/dabiao-icon.svg" alt="" width="38" height="38"/><span><b>大彪 TV</b><small>WORKSPACE / 管理中心</small></span></Link><nav aria-label="后台导航">{groups.map(group=><section key={group.name}><span className="console-group-label">{group.name}</span>{group.paths.map(path=>{const item=links.find(link=>link[0]===path);return item&&<Link to={path} key={path} aria-current={location.pathname===path?'page':undefined}><span className="console-nav-symbol">{item[2]}</span>{item[1]}{location.pathname===path&&<i/>}</Link>})}</section>)}</nav><div className="console-account"><span>{(account?.displayName||account?.username||'A').slice(0,1).toUpperCase()}</span><div><b>{account?.displayName||account?.username||'管理控制台'}</b><small>{account?.memberNo||'仅管理员可访问'}</small></div><i aria-label="管理员会话"/></div><Link className="console-exit" to="/">← 返回视频站</Link></aside>
    <div className="console-main"><div className="console-topbar"><button className="console-menu" aria-expanded={open} aria-label="打开后台导航" onClick={()=>setOpen(!open)}>☰</button><div className="console-breadcrumb"><Link to="/admin">工作台</Link><span>/</span><b>{title}</b></div><div className="console-top-actions"><span className="console-status"><i/>管理员工作区</span><Link to="/">前台预览 ↗</Link><AdminUpdateCheck/></div></div>
      <main className="console-content"><div className="console-page-heading"><div><span>DABIAO CONSOLE</span><h1>{title}</h1><p>{descriptions[location.pathname]||'清晰、从容地管理你的网站'}</p></div><div className="console-date"><small>今天</small><b>{new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'})}</b></div></div><div className="console-body">{children}</div></main><footer className="console-footer"><span>大彪 TV · 管理中心</span><span>权限在服务器端校验 · 所有敏感操作留有记录</span></footer>
    </div>
  </div>;
}
