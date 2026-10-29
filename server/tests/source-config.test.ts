import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSourceConfig,MAX_SOURCE_CONFIG_BYTES,createSourceConfigService,registerSourceConfigImport} from '../src/source-config.js';
const source={key:'fixture',name:'Fixture',type:1,api:'https://example.test/api'};
const raw=(sites:any=[source],name?:any)=>JSON.stringify({sites,...name===undefined?{}:{name}});

test('source config parses supported JSON/XML/local sources and flags strictly',()=>{
  const result=parseSourceConfig('\ufeff'+raw([{...source,key:' fixture ',enabled:0,searchable:true,quickSearch:'0',filterable:1},{key:'本地源',name:'Local',type:'local',api:'local'}],' My TV '));
  assert.equal(result.name,'My TV');assert.equal(result.sites[0].key,'fixture');assert.equal(result.sites[0].type,'tvbox-json');
  assert.equal(result.sites[0].enabled,false);assert.equal(result.sites[0].searchable,true);assert.equal(result.sites[0].quickSearch,false);assert.equal(result.sites[1].enabled,undefined);
  assert.equal(parseSourceConfig(readFileSync('tvbox.json','utf8')).sites.length,JSON.parse(readFileSync('tvbox.json','utf8')).sites.length);
  for(const type of [0,1,'tvbox-json','local','manual'])assert.equal(parseSourceConfig(raw([{...source,type}])).sites.length,1);
});
test('invalid or ambiguous source files are rejected instead of silently dropping entries',()=>{
  for(const value of [null,{},1,'','{','[]','null','{}',raw([]),raw([source,{...source,key:' fixture '}]),raw([null]),raw([{...source,key:'a/b'}]),raw([{...source,key:'a:b'}]),raw([{...source,key:'a b'}]),raw([{...source,key:'a'.repeat(192)}]),raw([{...source,name:''}]),raw([{...source,name:1}]),raw([{...source,name:'a'.repeat(201)}]),raw([{...source,api:''}]),raw([{...source,api:'https://example.test/with space'}]),raw([{...source,api:'file:///tmp/private'}]),raw([{...source,api:'javascript:alert(1)'}]),raw([{...source,type:3}]),raw([{...source,type:null}]),raw([source],null),raw(Array.from({length:501},(_,i)=>({...source,key:String(i)})))])assert.throws(()=>parseSourceConfig(value),undefined,JSON.stringify(value).slice(0,100));
  for(const field of ['enabled','searchable','quickSearch','filterable'])for(const value of ['true',2,-1,null,{},[]])assert.throws(()=>parseSourceConfig(raw([{...source,[field]:value}])));
});
test('upload limit counts UTF-8 bytes before parsing and does not echo credentials',()=>{
  const exact=raw()+' '.repeat(MAX_SOURCE_CONFIG_BYTES-Buffer.byteLength(raw()));assert.equal(parseSourceConfig(exact).sites.length,1);
  assert.throws(()=>parseSourceConfig(exact+' '),(error:any)=>error.status===413);
  assert.throws(()=>parseSourceConfig('影'.repeat(Math.ceil(MAX_SOURCE_CONFIG_BYTES/3))),(error:any)=>error.status===413);
  assert.throws(()=>parseSourceConfig(raw([{...source,api:'secret credential'}])),(error:any)=>!error.message.includes('secret credential'));
});
test('mode validation and failed administrator checks perform no database writes',async()=>{
  let writes=0;const service=createSourceConfigService({$transaction:()=>{writes++;throw Error('must not write')}});
  for(const body of [null,{}, {rawConfig:raw(),mode:'replace'},{rawConfig:raw(),mode:'replace',confirmReplace:'true'},{rawConfig:raw(),mode:null},{rawConfig:raw(),mode:'unknown'},{rawConfig:raw(),extra:true}])await assert.rejects(service.importJson(body));
  let handler:any;registerSourceConfigImport({post:(_path:any,fn:any)=>{handler=fn}} as any,{}, {requireAdmin:async(_req,res)=>{res.status(403).json({error:'blocked'});return null},invalidate:()=>{writes++}},service);
  let status=0;await handler({body:{rawConfig:raw()}},{status(code:number){status=code;return this},json(){return this}});assert.equal(status,403);assert.equal(writes,0);
});

test('database collation aliases cannot silently overwrite another source identity',async()=>{
  const tx={source:{findMany:async()=>[{key:'ABC'}],upsert:async()=>({key:'ABC'})},setting:{upsert:async()=>{throw Error('must not update settings')}}};
  const service=createSourceConfigService({$transaction:async(operation:any)=>operation(tx)});
  await assert.rejects(service.importJson({rawConfig:raw([{...source,key:'abc'}])}),(error:any)=>error.status===409);
});
