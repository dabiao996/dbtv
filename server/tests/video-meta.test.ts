import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanVideoTitle,resolveVideoMeta} from '../src/video-meta.js';

function fixture(local:any=null,remote:any=null,source:any={key:'one',type:'tvbox-json',enabled:true}){
  const calls={local:0,source:0,remote:0};
  const db:any={video:{findUnique:async()=>{calls.local++;return local}},source:{findUnique:async()=>{calls.source++;return source}}};
  const detail=async()=>{calls.remote++;if(remote instanceof Error)throw remote;return remote};
  return {calls,resolve:(title?:unknown,cover?:unknown)=>resolveVideoMeta(db,detail,'one','one:1',title,cover)};
}

test('missing browser title uses a visible matching local title and cover',async()=>{
  const f=fixture({sourceKey:'one',visible:true,title:' 本地片名 ',cover:' /cover.jpg '});
  assert.deepEqual(await f.resolve(),{title:'本地片名',cover:'/cover.jpg'});
  assert.equal(f.calls.remote,0);
});
test('remote detail fills a missing title, and an empty remote title stays empty',async()=>{
  const good=fixture(null,{vod_id:'1',vod_name:'远程片名',vod_pic:'remote.jpg'});
  assert.deepEqual(await good.resolve(),{title:'远程片名',cover:'remote.jpg'});
  const missing=fixture(null,{vod_id:'1',vod_name:' ',vod_pic:'remote.jpg'});
  assert.deepEqual(await missing.resolve(),{title:'',cover:'remote.jpg'});
});
test('explicit valid metadata is preserved without lookups; literal undefined is discarded',async()=>{
  const f=fixture(null,{vod_id:'1',vod_name:'remote'});
  assert.deepEqual(await f.resolve(' Explicit title ',' cover.jpg '),{title:'Explicit title',cover:'cover.jpg'});
  assert.deepEqual(f.calls,{local:0,source:0,remote:0});
  assert.equal(cleanVideoTitle(' undefined '),'');
  assert.equal(cleanVideoTitle('   '),'');
});
test('remote failure retains existing metadata and never leaks a hidden or mismatched local title',async()=>{
  const failed=fixture(null,Error('upstream secret URL'));
  const warn=console.warn;console.warn=()=>{};
  try{assert.deepEqual(await failed.resolve('Stored title'),{title:'Stored title',cover:null});}
  finally{console.warn=warn;}
  for(const local of [{sourceKey:'one',visible:false,title:'Hidden'}, {sourceKey:'two',visible:true,title:'Other source'}]){
    const f=fixture(local,{vod_id:'1',vod_name:'Remote'});
    assert.deepEqual(await f.resolve(),{title:'',cover:null});
    assert.equal(f.calls.remote,0);
  }
});
test('disabled source and mismatched remote IDs cannot supply metadata',async()=>{
  const disabled=fixture(null,{vod_id:'1',vod_name:'Remote'},{key:'one',type:'tvbox-json',enabled:false});
  assert.deepEqual(await disabled.resolve(),{title:'',cover:null});
  const wrong=fixture(null,{vod_id:'2',vod_name:'Wrong record'});
  assert.deepEqual(await wrong.resolve(),{title:'',cover:null});
});
