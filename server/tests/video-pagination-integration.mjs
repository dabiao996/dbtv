import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {PrismaClient} from '@prisma/client';

test('real HTTP source and category pages handle fixed JSON/XML upstream sizes and local data at 24/48/96',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'dbtv-video-pages-')),url='file:'+join(folder,'test.db'),db=new PrismaClient({datasourceUrl:url});let child;
  const upstream=createServer((req,res)=>{
    const query=new URL(req.url,'http://fixture.invalid'),xml=query.pathname==='/xml',page=Number(query.searchParams.get('pg')||1),limit=xml?7:20,type=query.searchParams.get('t');
    let ids=Array.from({length:137},(_,i)=>i+1);if(type==='2')ids=ids.filter(id=>id<=90);if(type==='3')ids=ids.filter(id=>id>90);
    const rows=ids.slice((page-1)*limit,page*limit),classes=[{type_id:'1',type_pid:'0',type_name:'电影'},{type_id:'2',type_pid:'1',type_name:'动作片'},{type_id:'3',type_pid:'1',type_name:'喜剧片'}];
    res.setHeader('Content-Type',xml?'application/xml':'application/json');
    if(xml)res.end('<rss><class><ty id="1">电影</ty><ty id="2" pid="1">动作片</ty><ty id="3" pid="1">喜剧片</ty></class><list pagecount="'+Math.ceil(ids.length/limit)+'" pagesize="'+limit+'" recordcount="'+ids.length+'">'+rows.map(id=>'<video><id>'+id+'</id><name>测试影片'+id+'</name><type>'+(id<=90?'动作片':'喜剧片')+'</type><year>2026</year><area>中国大陆</area><lang>汉语普通话</lang></video>').join('')+'</list></rss>');
    else res.end(JSON.stringify({class:classes,limit,total:ids.length,pagecount:Math.ceil(ids.length/limit),list:rows.map(id=>({vod_id:id,vod_name:'测试影片'+id,type_name:id<=90?'动作片':'喜剧片',type_id:id<=90?'2':'3',vod_year:'2026',vod_area:'中国大陆',vod_lang:'汉语普通话'}))}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const origin='http://127.0.0.1:'+upstream.address().port;
  const portProbe=createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const env={...process.env,DBTV_DATA_DIR:join(folder,'state'),INSTALL_TOKEN:'fixture-install-token-0123456789abcdef',DATABASE_PROVIDER:'sqlite',DATABASE_URL:url,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production'};
  let cookie='';const call=async path=>{const response=await fetch('http://127.0.0.1:'+port+'/api'+path,{headers:{Cookie:cookie}});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body};
  try{
    const pushed=spawnSync(process.execPath,['scripts/database.mjs','push'],{env,encoding:'utf8'});assert.equal(pushed.status,0,pushed.stdout+pushed.stderr);
    child=spawn(process.execPath,['server/dist/index.js'],{env,stdio:'ignore'});
    for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+port+'/api/health')).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
    const installed=await fetch('http://127.0.0.1:'+port+'/api/install',{method:'POST',headers:{'Content-Type':'application/json','X-Install-Token':env.INSTALL_TOKEN},body:JSON.stringify({username:'fixture_admin',password:'abc123',confirmPassword:'abc123'})});assert.equal(installed.status,201);cookie=installed.headers.get('set-cookie').split(';')[0];
    await db.source.createMany({data:[{key:'json',name:'固定20条JSON源',type:'tvbox-json',api:origin+'/json'},{key:'xml',name:'固定7条XML源',type:'tvbox-json',api:origin+'/xml'},{key:'local',name:'本地片库',type:'local',api:'local'}]});
    await db.video.createMany({data:Array.from({length:137},(_,index)=>({id:'local:'+index,sourceKey:'local',title:'本地测试影片'+index,category:'动作片',area:'中国大陆',language:'汉语普通话',year:2026}))});
    for(const source of ['json','xml','local'])for(const pageSize of [24,48,96])for(const browse of [false,true]){
      const ids=[];
      for(let page=1;page<=Math.ceil(137/pageSize);page++){
        const result=await call('/sources/'+source+(browse?'/browse?group='+encodeURIComponent('电影')+'&':'/videos?')+'pageSize='+pageSize+'&page='+page);
        assert.equal(result.pageSize,pageSize);assert.equal(result.items.length,Math.min(pageSize,137-(page-1)*pageSize));assert.equal(result.hasMore,page<Math.ceil(137/pageSize));ids.push(...result.items.map(item=>String(item.id)));
      }
      assert.equal(ids.length,137);assert.equal(new Set(ids).size,137,source+' repeats across '+pageSize+' pages');
    }
    const filtered=await call('/sources/local/videos?pageSize=96&language='+encodeURIComponent('国语'));assert.equal(filtered.items.length,96);
    const invalid=await fetch('http://127.0.0.1:'+port+'/api/sources/json/browse?pageSize=999',{headers:{Cookie:cookie}});assert.equal(invalid.status,400);
  }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}await new Promise(resolve=>upstream.close(resolve));await db.$disconnect();rmSync(folder,{recursive:true,force:true})}
});
