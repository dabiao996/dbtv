import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as helpers from '../src/source-json-import.js';
const site={key:'test',name:'测试源',type:1,api:'https://example.invalid/api?secret=private-token'};
const config=(sites:any[]=[site])=>JSON.stringify({name:'测试配置',sites});

test('local parsing supports BOM, remote/local/manual types and does not leak api into preview',()=>{
  const preview=helpers.parseSourceJson('\uFEFF '+config([site,{...site,key:'local',type:'local',api:'local'},{...site,key:'manual',type:'manual',api:'manual'}]));
  assert.equal(preview.sites.length,3);assert.equal(preview.sites[1].type,'本地源');assert.equal(preview.sites[2].type,'手动源');
  assert.equal(JSON.stringify(preview.sites).includes('private-token'),false);assert.equal(preview.rawConfig.includes('private-token'),true);
});
test('invalid structures and unsupported source entries fail before upload',()=>{
  for(const raw of ['{','null','[]','{}','{"sites":[]}',config([null]),config([{key:'a',name:'x'}]),config([{...site,key:'with space'}]),config([{...site,key:'with:colon'}]),config([{...site,name:'x'.repeat(201)}]),config([{...site,type:3}]),config([{...site,type:null}]),config([{...site,api:'javascript:alert(1)'}]),config([{...site,api:'file:///tmp/test'}]),config([{...site,enabled:'false'}]),config([site,{...site,key:' test '}])])assert.throws(()=>helpers.parseSourceJson(raw));
  for(const name of [null,12,'','  ','x'.repeat(201),'bad\nname'])assert.throws(()=>helpers.parseSourceJson(JSON.stringify({name,sites:[site]})),/配置 name/);
  assert.equal(helpers.parseSourceJson(JSON.stringify({name:'  测试  ',sites:[site]})).name,'测试');
  assert.throws(()=>helpers.parseSourceJson(config(Array.from({length:501},(_,i)=>({...site,key:'key'+i})))),/500/);
});
test('one MiB applies to UTF8 bytes and rejects oversize files before reading',async()=>{
  let read=false;await assert.rejects(helpers.readSourceJsonFile({size:helpers.MAX_SOURCE_JSON_BYTES+1,text:async()=>{read=true;return config()}}),/1 MiB/);assert.equal(read,false);
  assert.throws(()=>helpers.parseSourceJson(JSON.stringify({sites:[site],padding:'中'.repeat(350000)})),/1 MiB/);
  const base=config();assert.doesNotThrow(()=>helpers.parseSourceJson(base+' '.repeat(helpers.MAX_SOURCE_JSON_BYTES-new TextEncoder().encode(base).length)));
});
test('safe merge retains omitted source keys and destructive replacement requires confirmation',()=>{
  const preview=helpers.parseSourceJson(config());
  assert.deepEqual(helpers.sourceImportPayload(preview,'merge',false),{rawConfig:preview.rawConfig,mode:'merge'});
  assert.throws(()=>helpers.sourceImportPayload(preview,'replace',false),/确认/);
  assert.deepEqual(helpers.sourceImportPayload(preview,'replace',true),{rawConfig:preview.rawConfig,mode:'replace',confirmReplace:true});
  assert.deepEqual(helpers.replacedSourceKeys([{key:'test'},{key:'keep'},{key:'keep'}],preview.sites),['keep']);
});

const source=readFileSync(new URL('../src/SourceJsonImport.tsx',import.meta.url),'utf8').replaceAll('import.meta.env.VITE_API_URL',"''");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness(options:{fetch?:(...args:any[])=>any;onImported?:()=>Promise<void>;onInvalidated?:()=>void}={}){
  const values:any[]=[],refs:any[]=[];let cursor=0,refCursor=0;const exports:any={};
  runInNewContext(compiled,{exports,fetch:options.fetch||(()=>{throw Error('unexpected fetch')}),require:(name:string)=>{
    if(name==='react')return {...React,useState:(initial:any)=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],(next:any)=>{values[i]=typeof next==='function'?next(values[i]):next}]},useRef:(initial:any)=>{const i=refCursor++;return refs[i]||=( {current:initial})},useEffect:()=>{}};
    if(name==='./source-json-import')return helpers;
    if(name.endsWith('.css'))return {};
    throw Error('Unexpected import '+name);
  }});
  const render=()=>{cursor=0;refCursor=0;return exports.default({existingSites:[{key:'old',name:'旧源'}],onInvalidated:options.onInvalidated||(()=>{}),onImported:options.onImported||(async()=>{})})};
  const nodes=(node:any):any[]=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const find=(predicate:(node:any)=>boolean)=>{const element=nodes(render()).find(predicate);assert.ok(element,'expected element');return element};
  const select=(file:any)=>find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[file]}});
  return {render,find,select,html:()=>renderToStaticMarkup(render())};
}
test('real upload UI defaults to merge, hides api secrets and requires explicit replacement confirmation',async()=>{
  const ui=harness();ui.select({name:'test.json',size:config().length,text:async()=>config()});await tick();
  let html=ui.html();assert.match(html,/安全合并（推荐）/);assert.match(html,/确认合并导入/);assert.doesNotMatch(html,/private-token/);
  ui.find(node=>node.type==='input'&&node.props.type==='radio'&&!node.props.checked).props.onChange();
  html=ui.html();assert.match(html,/预计移除 1 个源/);assert.match(html,/账号源授权会被删除/);assert.match(html,/type="submit" disabled=""/);
  ui.find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});assert.equal(ui.find(node=>node.type==='button'&&node.props.type==='submit').props.disabled,false);
});
test('new selection wins over a slow previous file read; cancel cannot resurrect the old preview',async()=>{
  const ui=harness();let finish!:(raw:string)=>void;
  ui.select({name:'slow.json',size:100,text:()=>new Promise<string>(resolve=>{finish=resolve})});
  ui.select({name:'new.json',size:100,text:async()=>config([{...site,key:'new',name:'新文件源'}])});await tick();finish(config());await tick();
  assert.match(ui.html(),/新文件源/);assert.doesNotMatch(ui.html(),/测试源/);
  ui.select({name:'slow-again.json',size:100,text:()=>new Promise<string>(resolve=>{finish=resolve})});
  ui.find(node=>node.type==='button'&&node.props.children==='取消选择').props.onClick();finish(config());await tick();assert.doesNotMatch(ui.html(),/预览：|确认合并导入/);
});
test('reselect resets destructive confirmation and double submit sends one request',async()=>{
  let resolveFetch!:(response:any)=>void;const calls:any[]=[];let refreshed=0;
  const ui=harness({fetch:(...args)=>{calls.push(args);return new Promise(resolve=>{resolveFetch=resolve})},onImported:async()=>{refreshed++}});
  ui.select({name:'test.json',size:100,text:async()=>config()});await tick();
  ui.find(node=>node.type==='input'&&node.props.type==='radio'&&!node.props.checked).props.onChange();ui.find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});
  ui.select({name:'new.json',size:100,text:async()=>config()});await tick();assert.match(ui.html(),/确认合并导入/);assert.doesNotMatch(ui.html(),/我已备份/);
  const form=ui.find(node=>node.type==='form');const first=form.props.onSubmit({preventDefault(){}});await form.props.onSubmit({preventDefault(){}});assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0][1].body),{rawConfig:config(),mode:'merge'});
  resolveFetch({ok:true,json:async()=>({ok:true,sites:1})});await first;assert.equal(refreshed,1);assert.match(ui.html(),/已合并导入 1 个源/);assert.doesNotMatch(ui.html(),/预览：/);
});

test('ambiguous network failure asks to verify server state and removes replacement confirmation',async()=>{
  const ui=harness({fetch:async()=>{throw Error('Failed to fetch')}});
  ui.select({name:'test.json',size:100,text:async()=>config()});await tick();
  ui.find(node=>node.type==='input'&&node.props.type==='radio'&&!node.props.checked).props.onChange();ui.find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});
  await ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  assert.match(ui.html(),/导入可能已经生效/);assert.match(ui.html(),/请先刷新页面核对当前源配置/);
  assert.equal(ui.find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  assert.equal(ui.find(node=>node.type==='button'&&node.props.type==='submit').props.disabled,true);
});

const appSource=readFileSync(new URL('../src/app.tsx',import.meta.url),'utf8');
const editorSource='export '+appSource.slice(appSource.indexOf('function SourceEditor(){'),appSource.indexOf('\nexport default function App()'));
const editorCompiled=ts.transpileModule(editorSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
function editorHarness(){
  const values:any[]=[],refs:any[]=[],effects:(()=>void)[]=[];let cursor=0,refCursor=0,effectRegistered=false;
  const requests:any[]=[];let fail=false;const sourceJsonImport=()=>null;const exports:any={};
  const api=async(path:string,options?:any)=>{requests.push({path,options});if(fail)throw Error('fixture refresh failed');return {name:'配置',sites:[{key:requests.length>2?'new':'old',name:'源',api:'https://example.invalid'}]}};
  runInNewContext(editorCompiled,{exports,React,SourceJsonImport:sourceJsonImport,AdminFrame:({children}:any)=>children,window:{confirm:()=>true},api,json:(value:any)=>({method:'POST',body:JSON.stringify(value)}),useState:(initial:any)=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],(next:any)=>{values[i]=typeof next==='function'?next(values[i]):next}]},useRef:(initial:any)=>{const i=refCursor++;return refs[i]||=({current:initial})},useEffect:(effect:()=>void)=>{if(!effectRegistered){effects.push(effect);effectRegistered=true}}});
  const render=()=>{cursor=0;refCursor=0;return exports.SourceEditor()};
  const nodes=(node:any):any[]=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const find=(predicate:(node:any)=>boolean)=>{const found=nodes(render()).find(predicate);assert.ok(found);return found};
  const button=(name:string)=>find(node=>node.type==='button'&&node.props.children===name);
  render();effects.forEach(effect=>effect());
  return {button,requests,fail:(value:boolean)=>{fail=value},importProps:()=>find(node=>node.type===sourceJsonImport).props,fields:()=>nodes(render()).filter(node=>node.type==='input')};
}
for(const scenario of ['successful import followed by failed config refresh','ambiguous network result'])test(`${scenario} keeps the old editor locked until a successful explicit reload`,async()=>{
  const editor=editorHarness();await tick();assert.equal(editor.button('保存配置').props.disabled,false);
  const callbacks=editor.importProps();callbacks.onBusyChange(true);callbacks.onInvalidated();
  editor.fail(true);
  if(scenario.startsWith('successful'))await assert.rejects(callbacks.onImported(),/refresh failed/);
  callbacks.onBusyChange(false);
  assert.equal(editor.button('保存配置').props.disabled,true);assert.equal(editor.button('从 tvbox.json 恢复').props.disabled,true);assert.equal(editor.importProps().disabled,true);assert.ok(editor.fields().every(field=>field.props.disabled));
  const before=editor.requests.length;editor.button('保存配置').props.onClick();await tick();assert.equal(editor.requests.length,before,'even stale editor handler cannot send a destructive save');
  editor.button('重新读取当前配置').props.onClick();await tick();assert.equal(editor.button('保存配置').props.disabled,true,'failed reload does not unlock old config');
  editor.fail(false);editor.button('重新读取当前配置').props.onClick();await tick();assert.equal(editor.button('保存配置').props.disabled,false);assert.equal(editor.importProps().disabled,false);
});
test('upload invalidates the parent before dispatch even if the response is lost',async()=>{
  let invalid=false;const ui=harness({onInvalidated:()=>{invalid=true},fetch:async()=>{assert.equal(invalid,true);throw Error('lost response')}});
  ui.select({name:'test.json',size:100,text:async()=>config()});await tick();await ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});assert.equal(invalid,true);
});
