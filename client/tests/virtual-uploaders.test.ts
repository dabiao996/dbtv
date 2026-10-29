import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as state from '../src/virtual-uploader-state.js';

const requestId='test-generation-request-0001';
test('generation retries and reloads retain the same batch identifier and count',()=>{
  const initial=state.nextGenerationRequest(null,20,()=>requestId);
  assert.deepEqual(initial,{count:20,requestId});
  const restored=state.readGenerationRequest(JSON.stringify(initial));
  assert.deepEqual(restored,initial);
  assert.equal(state.nextGenerationRequest(restored,70,()=>{throw Error('must not create another batch')}),restored);
  assert.deepEqual(state.nextGenerationRequest(null,70,()=>requestId+'2'),{count:70,requestId:requestId+'2'});
});
test('generation requests reject corrupt storage and invalid batch sizes',()=>{
  for(const raw of [null,'invalid','null','{}',JSON.stringify({count:0,requestId}),JSON.stringify({count:101,requestId}),JSON.stringify({count:1.5,requestId}),JSON.stringify({count:20,requestId:'bad'})])assert.equal(state.readGenerationRequest(raw),null);
  for(const count of [0,101,1.5,NaN])assert.throws(()=>state.nextGenerationRequest(null,count,()=>requestId));
  for(const count of [1,100])assert.equal(state.nextGenerationRequest(null,count,()=>requestId).count,count);
});
const source=readFileSync(new URL('../src/VirtualUploaders.tsx',import.meta.url),'utf8').replaceAll('import.meta.env.VITE_API_URL',"''");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
function render(pending=false,editing=false){
  const person={id:'virtual-1',name:'虚拟影友一号',avatarUrl:null,enabled:true};
  const states:any[]=[[person],true,20,false,pending,editing?person:null,'',''];let cursor=0;
  const exports:any={};runInNewContext(compiled,{exports,sessionStorage:{getItem:()=>pending?JSON.stringify({count:20,requestId}):null},require:(name:string)=>{
    if(name==='react')return {...React,useState:()=>[states[cursor++],()=>{}],useEffect:()=>{},useRef:(value:any)=>({current:value})};
    if(name==='./virtual-uploader-state')return state;
    if(name.endsWith('.css'))return {};
    throw Error('Unexpected import '+name);
  }});
  return renderToStaticMarkup(React.createElement(exports.default));
}
test('management screen explicitly separates fictional presentation from accounts and real uploads',()=>{
  const html=render(false,true);
  assert.match(html,/不代表真实上传记录/);assert.match(html,/不是登录账号/);assert.match(html,/已有匹配会保留/);assert.match(html,/停用不删除已有匹配/);
  assert.match(html,/编辑虚拟展示资料/);assert.match(html,/maxLength="40"/);assert.match(html,/type="checkbox" checked=""/);
  assert.doesNotMatch(html,/type="password"|用户名|会员号|兑换积分/);
});
test('an unresolved batch disables quantity changes and exposes safe retry',()=>{
  const html=render(true);
  assert.match(html,/aria-label="生成数量"[^>]*disabled=""/);
  assert.match(html,/重试确认同一批次/);assert.match(html,/重试不会重复生成/);
});
test('normal batch form bounds the count and keeps the page separate in admin navigation',()=>{
  const html=render();assert.match(html,/min="1" max="100" step="1" required=""/);
  const navigation=readFileSync(new URL('../src/AdminShell.tsx',import.meta.url),'utf8');assert.match(navigation,/\/admin\/virtual-uploaders/);
});
