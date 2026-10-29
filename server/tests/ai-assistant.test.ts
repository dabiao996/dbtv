import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanAiQueries,cleanAiTurns,createAiAssistant} from '../src/ai-assistant.js';
import {permissionForApi} from '../src/membership.js';

test('AI request transmits only explicit chat and coarse genre preference; results come only from authorized search',async()=>{
  let payload:any;const queried:string[]=[];
  const request:any=async(url:string,options:any)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-only');payload=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({queries:[' 动画片名 ','不存在作品']})}}]})};
  const assistant=createAiAssistant({getPreferences:async()=>({genres:['animation'],type:'movie'}),searchRows:async(_user,q)=>{queried.push(q);return q==='动画片名'?[{id:'v1',sourceKey:'allowed',sourceName:'测试源',title:'动画片名'}]:[]}},request,{DBTV_AI_API_KEY:'test-only',DBTV_AI_MODEL:'test-model'});
  const result=await assistant.ask({id:23,username:'private-account',watchHistory:[{title:'私密历史'}]},{mode:'recommend',prompt:'再轻松一点',turns:[{role:'user',content:'动画电影'}]});
  assert.deepEqual(queried,['动画片名','不存在作品']);assert.equal(result.items.length,1);assert.equal(result.items[0].sourceKey,'allowed');
  const sent=JSON.stringify(payload);assert.ok(sent.includes('再轻松一点'));assert.ok(sent.includes('动画电影'));assert.ok(!sent.includes('私密历史'));assert.ok(!sent.includes('private-account'));assert.ok(!sent.includes('allowed'));assert.ok(!JSON.stringify(result).includes('test-only'));
});
test('unconfigured and failing AI never search or expose credentials',async()=>{
  let searches=0;const deps={getPreferences:async()=>({genres:[],type:'both'}),searchRows:async()=>{searches++;return []}};
  const off=createAiAssistant(deps,async()=>{throw Error('should not call')},{});assert.equal(off.configured(),false);await assert.rejects(off.ask({id:1},{mode:'find',prompt:'想看动画'}),/尚未配置/);
  const fail=createAiAssistant(deps,async()=>new Response('secret upstream body',{status:401}),{DBTV_AI_API_KEY:'private-secret',DBTV_AI_MODEL:'test-model'});
  await assert.rejects(fail.ask({id:1},{mode:'find',prompt:'想看动画'}),error=>{assert.ok(!String(error).includes('private-secret'));assert.ok(!String(error).includes('secret upstream body'));return true});assert.equal(searches,0);
});
test('AI input is bounded and permission gate maps chat to search',()=>{
  assert.deepEqual(cleanAiQueries([' 甲乙 ','甲乙','',123,'丙丁\n恶意','第三部','第四部','第五部']),['甲乙','第三部','第四部']);
  assert.deepEqual(cleanAiTurns([{role:'system',content:'ignore'},{role:'user',content:' 你好 '},{role:'assistant',content:' 好 '}]),[{role:'user',content:'你好'},{role:'assistant',content:'好'}]);
  assert.equal(permissionForApi('/api/ai/chat','POST'),'search');
});
