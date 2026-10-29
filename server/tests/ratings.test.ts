import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createRatingService,matchRating,publicSettingsRows,registerRatings} from '../src/ratings.js';

function memoryDB(){
  const rows=new Map<string,string>();
  const db:any={setting:{
    findUnique:async({where}:any)=>rows.has(where.key)?{key:where.key,value:rows.get(where.key)}:null,
    findMany:async({where}:any={})=>[...rows].filter(([key])=>!where?.key?.in||where.key.in.includes(key)).filter(([key])=>!where?.key?.startsWith||key.startsWith(where.key.startsWith)).map(([key,value])=>({key,value})),
    upsert:async({where,create,update}:any)=>{const value=rows.has(where.key)?update.value:create.value;rows.set(where.key,value);return {key:where.key,value}},
    deleteMany:async({where}:any)=>{let count=0;for(const key of rows.keys())if(where.key.startsWith?key.startsWith(where.key.startsWith):where.key.in.includes(key)){rows.delete(key);count++}return {count}},
  },$transaction:async(operations:any[])=>Promise.all(operations)};return {db,rows};
}
const movie={id:100,media_type:'movie',title:'同名电影',release_date:'2020-01-01',vote_average:8.123,vote_count:123};
test('ratings match exact title, year and type; reject remakes, ambiguity and missing votes',()=>{
  assert.equal(matchRating({title:'同名 电影',year:2020,category:'电影'},[movie])?.score,8.1);
  assert.equal(matchRating({title:'同名电影',year:2021},[movie]),undefined);
  assert.equal(matchRating({title:'同名电影',category:'电视剧'},[movie]),undefined);
  assert.equal(matchRating({title:'同名电影'},[movie,{...movie,id:101,release_date:'1999-01-01'}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[{...movie,vote_count:0}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[{...movie,vote_average:99}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[{...movie,adult:true}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[{...movie,title:'同名电影续集'}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[{...movie,media_type:'person'}]),undefined);
  assert.equal(matchRating({title:'同名电影'},[movie,movie])?.votes,123);
});
test('ratings persist across restarts, deduplicate work and keep credentials server-side',async()=>{
  const {db}=memoryDB();let calls=0;
  const request:any=async(url:URL,options:any)=>{calls++;assert.equal(url.origin,'https://api.themoviedb.org');assert.equal(url.searchParams.get('include_adult'),'false');assert.equal(options.headers.Authorization,'Bearer test-secret');assert.ok(!String(url).includes('test-secret'));return Response.json({results:[movie]})};
  const service=createRatingService(db,request,{});
  await service.save({enabled:true,token:'test-secret'});
  const film={title:'同名电影',year:2020,category:'电影'};
  const results=await Promise.all([service.lookup(film),service.lookup(film)]);
  assert.equal(calls,1);assert.equal(results[0].rating?.score,8.1);
  assert.equal(JSON.stringify(await service.status()).includes('test-secret'),false);
  const fresh=createRatingService(db,request,{});await fresh.lookup(film);assert.equal(calls,1);
  assert.deepEqual(publicSettingsRows([{key:'siteName',value:'TV'},{key:'rating:token',value:'test-secret'},{key:'rating:cache:abc',value:'private'},{key:'ai:key',value:'private'}]),[{key:'siteName',value:'TV'}]);
  await service.save({enabled:true,token:''});assert.equal((await service.status()).configured,true);
  await service.save({enabled:true,clearToken:true});assert.equal((await service.status()).configured,false);
});
test('ratings fail safely, respect enable switch and skip explicitly adult categories',async()=>{
  const {db}=memoryDB();let calls=0;
  const request:any=async()=>{calls++;return new Response('credentials must never be echoed',{status:401})};
  const service=createRatingService(db,request,{}),film={title:'同名电影',category:'电影'};
  assert.equal((await service.lookup(film)).status,'unconfigured');assert.equal(calls,0);
  await service.save({enabled:false,token:'test-secret'});assert.equal((await service.lookup(film)).status,'disabled');assert.equal(calls,0);
  await service.save({enabled:true});assert.equal((await service.lookup({...film,category:'成人伦理'})).status,'unmatched');assert.equal(calls,0);
  const failed=await service.lookup(film);assert.equal(failed.status,'unavailable');assert.ok(!JSON.stringify(failed).includes('credentials'));await service.lookup(film);assert.equal(calls,1);
  assert.equal((await service.testConnection()).ok,false);
  const envService=createRatingService(db,request,{TMDB_READ_ACCESS_TOKEN:'environment-secret'});assert.equal((await envService.status()).credentialSource,'environment');assert.ok(!JSON.stringify(await envService.status()).includes('environment-secret'));
});
test('rating outbound concurrency is bounded and unmatched results are cached',async()=>{
  const {db}=memoryDB();let running=0,peak=0,calls=0;
  const request:any=async()=>{calls++;running++;peak=Math.max(peak,running);await new Promise(resolve=>setTimeout(resolve,3));running--;return Response.json({results:[]})};
  const service=createRatingService(db,request,{TMDB_READ_ACCESS_TOKEN:'test'});
  const results=await Promise.all(Array.from({length:12},(_,i)=>service.lookup({title:'影片'+i})));
  assert.ok(peak<=4);assert.equal(calls,12);assert.ok(results.every(x=>x.status==='unmatched'));await service.lookup({title:'影片0'});assert.equal(calls,12);
});
test('rating routes protect administrator configuration, validate input and limit requests',async()=>{
  const {db}=memoryDB(),app=express();app.use(express.json());
  const deps={requireUser:async(req:any,res:any)=>{if(!req.headers['x-user']){res.status(401).json({error:'login required'});return null}return {id:1}},requireAdmin:async(req:any,res:any)=>{if(req.headers['x-user']!=='admin'){res.status(403).json({error:'admin required'});return null}return {id:1}}};
  const request:any=async()=>Response.json({success:true,results:[movie]});registerRatings(app,db,deps,request,{});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const send=(url:string,method='GET',body?:any,user?:string)=>fetch(origin+url,{method,headers:{'Content-Type':'application/json',...user?{'x-user':user}:{}},...body?{body:JSON.stringify(body)}:{}});
  try{
    assert.equal((await send('/api/ratings/status')).status,401);
    assert.equal((await send('/api/admin/ratings','GET',undefined,'user')).status,403);
    assert.equal((await send('/api/admin/ratings','PUT',{enabled:true,token:'secret'},'user')).status,403);
    assert.equal((await send('/api/admin/ratings','PUT',{enabled:true,token:'secret\nunsafe'},'admin')).status,400);
    const saved=await send('/api/admin/ratings','PUT',{enabled:true,token:'secret'},'admin');assert.equal(saved.status,200);assert.equal((await saved.text()).includes('secret'),false);
    assert.equal((await send('/api/admin/ratings/test','POST',{},'user')).status,403);
    assert.equal((await (await send('/api/admin/ratings/test','POST',{},'admin')).json()).ok,true);
    assert.equal((await send('/api/ratings/lookup','POST',{items:[{title:'x'}]})).status,401);
    assert.equal((await send('/api/ratings/lookup','POST',{items:[{title:'x',year:2}]},'user')).status,400);
    assert.equal((await send('/api/ratings/lookup','POST',{items:Array(21).fill({title:'x'})},'user')).status,400);
    const scored=await (await send('/api/ratings/lookup','POST',{items:[{title:'同名电影',year:2020,category:'电影'}]},'user')).json();assert.equal(scored.items[0].rating.score,8.1);assert.equal(JSON.stringify(scored).includes('secret'),false);
    const batch={items:Array(20).fill({title:'无匹配'})};for(let i=0;i<5;i++)assert.equal((await send('/api/ratings/lookup','POST',batch,'user')).status,200);assert.equal((await send('/api/ratings/lookup','POST',batch,'user')).status,429);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
