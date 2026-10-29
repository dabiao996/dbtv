import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Render the real admin JSX with a loaded plan. Stub only network/effect hooks
// and unrelated editors: this catches required fields that block native submit.
const source=readFileSync(new URL('../src/Membership.tsx',import.meta.url),'utf8').replaceAll('import.meta.env.VITE_API_URL', "''");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
function renderPlan(id:string,enabled=true){
  const plan={id,name:id||'新套餐',description:'',pricePoints:id==='guest'||id==='free'?0:300,durationDays:id==='guest'||id==='free'?0:30,enabled,permissions:[],sourceKeys:[],accessGroupIds:[],allSources:false,contentRules:{deniedSourceKeys:[],deniedCategories:[]},version:0};
  const states:any[]=[{plans:[plan],sources:[],groups:[],permissionLabels:{},stats:{}},plan,'plans','','',false,{userId:'',delta:100,reason:''},null];
  let cursor=0;
  const exports:any={};
  runInNewContext(compiled,{exports,require:(name:string)=>{
    if(name==='react')return {...React,useState:()=>[states[cursor++],()=>{}],useEffect:()=>{},useRef:(value:any)=>({current:value})};
    if(name==='react-router-dom')return {Link:()=>null};
    if(name.endsWith('.css'))return {};
    if(name==='./GrantEditors')return {readList:(value:any)=>Array.isArray(value)?value:JSON.parse(value||'[]'),PermissionChooser:()=>null,SourceGrantPicker:()=>null,AccessGroupManager:()=>null};
    if(name==='./ContentRulesEditor')return {__esModule:true,default:()=>null,readRules:()=>({deniedSourceKeys:[],deniedCategories:[]})};
    if(name==='./AccountPicker')return {__esModule:true,default:()=>null};
    throw Error('Unexpected import '+name);
  }});
  return renderToStaticMarkup(React.createElement(exports.MembershipAdmin));
}

test('guest editor has no invalid paid fields and can be enabled or disabled',()=>{
  for(const enabled of [true,false]){
    const html=renderPlan('guest',enabled);
    assert.match(html,/编辑游客权限/);
    assert.match(html,/未登录访客等级/);
    assert.match(html,/启用游客访问（关闭后须登录）/);
    assert.match(html,/对所有未登录访客生效/);
    assert.doesNotMatch(html,/type="number"|兑换积分|会员天数|上架兑换|0积分/);
    assert.match(html,enabled?/type="checkbox" checked=""/:/type="checkbox"\/>/);
  }
});
test('free editor remains non-purchasable and always enabled',()=>{
  const html=renderPlan('free');
  assert.match(html,/编辑普通用户权限/);
  assert.doesNotMatch(html,/type="number"|type="checkbox"|上架兑换/);
});
for(const id of ['paid-plan',''])test(`${id||'new'} paid editor retains required price, duration and publish control`,()=>{
  const html=renderPlan(id);
  assert.equal((html.match(/type="number"/g)||[]).length,2);
  assert.equal((html.match(/min="1"/g)||[]).length,2);
  assert.match(html,/兑换积分/);assert.match(html,/会员天数/);assert.match(html,/启用并上架兑换/);
});
