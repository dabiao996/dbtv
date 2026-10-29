import React,{useEffect,useRef,useState} from 'react';
import {readSourceJsonFile,replacedSourceKeys,sourceImportPayload,type SourceImportMode,type SourceImportPreview} from './source-json-import';
import './source-json-import.css';

type Props={existingSites:{key:string;name?:string}[];disabled?:boolean;beforeImport?:()=>boolean;onBusyChange?:(busy:boolean)=>void;onInvalidated:()=>void;onImported:()=>Promise<void>};
const endpoint=(import.meta.env.VITE_API_URL||'')+'/api/config/import-json';
export default function SourceJsonImport({existingSites,disabled=false,beforeImport,onBusyChange,onInvalidated,onImported}:Props){
  const [preview,setPreview]=useState<SourceImportPreview|null>(null),[filename,setFilename]=useState(''),[reading,setReading]=useState(false),[busy,setBusy]=useState(false),[mode,setMode]=useState<SourceImportMode>('merge'),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const input=useRef<HTMLInputElement>(null),sequence=useRef(0),submitting=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++}},[]);
  async function select(file?:File){
    const id=++sequence.current;setPreview(null);setFilename(file?.name||'');setError('');setMessage('');setMode('merge');setConfirmed(false);setReading(!!file);
    if(!file)return;
    try{const parsed=await readSourceJsonFile(file);if(mounted.current&&id===sequence.current)setPreview(parsed)}catch(e:any){if(mounted.current&&id===sequence.current)setError(e.message)}finally{if(mounted.current&&id===sequence.current)setReading(false)}
  }
  function clear(){sequence.current++;setPreview(null);setFilename('');setReading(false);setMode('merge');setConfirmed(false);setError('');setMessage('');if(input.current)input.current.value=''}
  async function upload(event:React.FormEvent){
    event.preventDefault();if(!preview||disabled||submitting.current||reading)return;
    if(beforeImport&&!beforeImport())return;
    let payload;try{payload=sourceImportPayload(preview,mode,confirmed)}catch(e:any){setError(e.message);return}
    submitting.current=true;setBusy(true);onBusyChange?.(true);setError('');setMessage('');
    let parsedResponse=false;
    try{
      onInvalidated();
      const response=await fetch(endpoint,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json();parsedResponse=true;if(!response.ok)throw Error(result.error||'导入失败，请检查配置后重试');
      if(mounted.current){clear();setMessage(`已${mode==='merge'?'合并导入':'替换导入'} ${result.sites} 个源。`)}
      try{await onImported()}catch(e:any){if(mounted.current)setError('导入已成功，但当前配置刷新失败，请刷新页面后再编辑：'+e.message)}
    }catch(e:any){if(mounted.current){setConfirmed(false);setError(parsedResponse?e.message:'未能确认服务器返回结果，导入可能已经生效。请先刷新页面核对当前源配置，再决定是否重新导入。')}}finally{submitting.current=false;if(mounted.current)setBusy(false);onBusyChange?.(false)}
  }
  const removed=preview?replacedSourceKeys(existingSites,preview.sites):[];
  return <section className="source-json-import" aria-label="上传 JSON 源配置"><h2>上传 JSON 源配置</h2><p>选择本机的 JSON 文件，先检查预览，再确认导入。最大 1 MiB；仅解析 sites，不下载文件内的接口或脚本。</p>
    <label className="source-json-picker">选择 JSON 文件<input ref={input} type="file" accept=".json,application/json" aria-label="选择 JSON 源配置文件" disabled={busy||disabled} onChange={event=>void select(event.target.files?.[0])}/></label>
    {filename&&<div className="source-json-selection"><span>{filename}</span><button type="button" disabled={busy||disabled} onClick={clear}>取消选择</button></div>}
    {reading&&<p role="status">正在本地检查文件…</p>}{error&&<p role="alert" className="source-json-error">{error}</p>}{message&&<p role="status" className="source-json-success">{message}</p>}
    {preview&&<form onSubmit={upload}><div className="source-json-preview"><h3>预览：{preview.sites.length} 个源{preview.name?` · ${preview.name}`:''}</h3><p>仅显示名称与标识，不公开可能含凭据的接口地址。</p><div className="source-json-table"><table><thead><tr><th>名称</th><th>key</th><th>类型</th></tr></thead><tbody>{preview.sites.slice(0,50).map(site=><tr key={site.key}><td>{site.name}</td><td><code>{site.key}</code></td><td>{site.type}</td></tr>)}</tbody></table></div>{preview.sites.length>50&&<small>预览前 50 个源；将导入全部 {preview.sites.length} 个源。</small>}</div>
      <fieldset disabled={busy||disabled}><legend>导入方式</legend><label className="source-json-choice"><input type="radio" name="source-import-mode" checked={mode==='merge'} onChange={()=>{setMode('merge');setConfirmed(false)}}/><span><b>安全合并（推荐）</b><small>新增文件中的源，更新相同 key 的源；保留文件外的其他源。不会删除其他源。</small></span></label><label className="source-json-choice"><input type="radio" name="source-import-mode" checked={mode==='replace'} onChange={()=>{setMode('replace');setConfirmed(false)}}/><span><b>替换现有源</b><small>只保留文件中的源。此操作可能删除其他源及其关联数据，请先备份。</small></span></label></fieldset>
      {mode==='replace'&&<div className="source-json-warning" role="note"><strong>替换有删除风险</strong><p>按当前已加载配置，预计移除 {removed.length} 个源{removed.length?`：${removed.slice(0,12).join('、')}${removed.length>12?'…':''}`:''}。这些源的影片、分类绑定及账号源授权会被删除；剧集、收藏和历史中的旧记录可能仍保留，但对应内容链接会失效。实际范围以提交时服务器配置为准。</p><label><input type="checkbox" checked={confirmed} disabled={busy||disabled} onChange={event=>setConfirmed(event.target.checked)}/>我已备份，并确认删除文件中未包含的源及受影响的关联数据</label></div>}
      <p className="source-json-note">导入成功后会刷新下面的配置编辑器。导入前请先保存仍需保留的页面修改。</p><button className="primary" type="submit" disabled={busy||disabled||reading||(mode==='replace'&&!confirmed)}>{busy?'正在导入…':mode==='replace'?'确认替换导入':'确认合并导入'}</button>
    </form>}
  </section>;
}
