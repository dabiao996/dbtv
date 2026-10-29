import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {cleanAiQueries,cleanAiTurns,createAiAssistant,registerAiAssistant} from '../src/ai-assistant.js';
import {permissionForApi} from '../src/membership.js';

test('AI request transmits only explicit chat and coarse genre preference; results come only from authorized search',async()=>{
  let payload:any;const queried:string[]=[];
  const request:any=async(url:string,options:any)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-only');payload=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({queries:[' 动画片名 ','不存在作品']})}}]})};
  const assistant=createAiAssistant({getPreferences:async()=>({genres:['animation'],type:'movie'}),searchRows:async(_user,q)=>{queried.push(q);return q==='动画片名'?[{id:'v1',sourceKey:'allowed',sourceName:'测试源',title:'动画片名'}]:[]}},request,{DBTV_AI_API_KEY:'test-only',DBTV_AI_MODEL:'test-model'});
  const result=await assistant.ask({id:23,username:'private-account',watchHistory:[{title:'私密历史'}]},{mode:'recommend',prompt:'再轻松一点',turns:[{role:'user',content:'动画电影'}]});
  assert.deepEqual(queried,['动画片名','不存在作品']);assert.equal(result.items.length,1);assert.equal(result.items[0].sourceKey,'allowed');
  const sent=JSON.stringify(payload);assert.equal(payload.model,'test-model');assert.equal(payload.reasoning_effort,'low');assert.equal(payload.max_completion_tokens,400);assert.equal('temperature' in payload,false);assert.ok(sent.includes('再轻松一点'));assert.ok(sent.includes('动画电影'));assert.ok(!sent.includes('私密历史'));assert.ok(!sent.includes('private-account'));assert.ok(!sent.includes('allowed'));assert.ok(!JSON.stringify(result).includes('test-only'));
});
test('admin AI settings are write-only, reject non-admins, and never enter public settings',async()=>{
  const values=new Map<string,string>(),app=express();app.use(express.json());
  const db:any={setting:{findMany:async()=>[...values].map(([key,value])=>({key,value})),upsert:async({where,create,update}:any)=>{values.set(where.key,values.has(where.key)?update.value:create.value)}}};
  registerAiAssistant(app,db,{requireUser:async()=>({id:1}),requireAdmin:async(req:any,res:any)=>req.headers['x-test-admin']==='yes'?{id:1}:(res.status(403).json({error:'admin only'}),null),searchRows:async()=>[],getPreferences:async()=>({genres:[],type:'both'})},async()=>Response.json({choices:[{message:{content:'{"queries":["测试片"]}'}}]}),{});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  try{
    const denied=await fetch(url+'/api/admin/ai',{headers:{'x-test-admin':'no'}});assert.equal(denied.status,403);
    const invalid=await fetch(url+'/api/admin/ai',{method:'PUT',headers:{'x-test-admin':'yes','content-type':'application/json'},body:JSON.stringify({key:'fake',model:'gpt-6.1-sol'})});assert.equal(invalid.status,400);
    const secret='sk-test-only-'+('x'.repeat(32));const saved=await fetch(url+'/api/admin/ai',{method:'PUT',headers:{'x-test-admin':'yes','content-type':'application/json'},body:JSON.stringify({key:secret,model:'gpt-6.1-sol'})});assert.equal(saved.status,200);assert.ok(!JSON.stringify(await saved.json()).includes(secret));
    const status=await (await fetch(url+'/api/admin/ai',{headers:{'x-test-admin':'yes'}})).json();assert.equal(status.configured,true);assert.ok(!JSON.stringify(status).includes(secret));assert.equal((await (await fetch(url+'/api/ai/status')).json()).configured,true);
  }finally{server.close()}
});
test('AI request budget stops excess calls per account and site-wide',async()=>{
  const app=express();app.use(express.json());let upstream=0;
  registerAiAssistant(app,{setting:{findMany:async()=>[]}}, {requireUser:async(req:any)=>({id:Number(req.headers['x-test-user']||1)}),requireAdmin:async()=>null,searchRows:async()=>[],getPreferences:async()=>({genres:[],type:'both'})},async()=>{upstream++;return Response.json({choices:[{message:{content:'{"queries":["测试片"]}'}}]})},{DBTV_AI_API_KEY:'sk-test-budget',DBTV_AI_MODEL:'gpt-6.1-sol'});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}/api/ai/chat`;
  try{
    for(let user=1;user<=10;user++)for(let index=0;index<6;index++)assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-test-user':String(user)},body:JSON.stringify({mode:'find',prompt:'动画电影'})})).status,200);
    assert.equal(upstream,60);
    const exceeded=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-test-user':'11'},body:JSON.stringify({mode:'find',prompt:'动画电影'})});assert.equal(exceeded.status,429);assert.equal(upstream,60);
  }finally{server.close()}
});
test('unconfigured and failing AI never search or expose credentials',async()=>{
  let searches=0;const deps={getPreferences:async()=>({genres:[],type:'both'}),searchRows:async()=>{searches++;return []}};
  const off=createAiAssistant(deps,async()=>{throw Error('should not call')},{});assert.equal(await off.configured(),false);await assert.rejects(off.ask({id:1},{mode:'find',prompt:'想看动画'}),/尚未配置/);
  const fail=createAiAssistant(deps,async()=>new Response('secret upstream body',{status:401}),{DBTV_AI_API_KEY:'private-secret',DBTV_AI_MODEL:'test-model'});
  await assert.rejects(fail.ask({id:1},{mode:'find',prompt:'想看动画'}),error=>{assert.ok(!String(error).includes('private-secret'));assert.ok(!String(error).includes('secret upstream body'));return true});assert.equal(searches,0);
});
test('AI input is bounded and permission gate maps chat to search',()=>{
  assert.deepEqual(cleanAiQueries([' 甲乙 ','甲乙','',123,'丙丁\n恶意','第三部','第四部','第五部']),['甲乙','第三部','第四部']);
  assert.deepEqual(cleanAiTurns([{role:'system',content:'ignore'},{role:'user',content:' 你好 '},{role:'assistant',content:' 好 '}]),[{role:'user',content:'你好'},{role:'assistant',content:'好'}]);
  assert.equal(permissionForApi('/api/ai/chat','POST'),'search');
});
