import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveCatalog,isPublicAddress,publicHttpUrl,readLiveLines} from '../src/live-catalog.js';
import {liveWhere,rewriteLiveManifest} from '../src/live.js';
import {liveFetch} from '../src/live-network.js';
import {permissionForApi} from '../src/membership.js';
import {publicSettingsRows} from '../src/ratings.js';
import {assertLiveManifest,probeLiveLine,checkLiveChannel,LiveError} from '../src/live-health.js';
import {livePlaybackError,officialLivePage} from '../../client/src/live-playback.js';
import {mergeLiveSupplements,liveSupplements} from '../src/live-supplements.js';

test('browser-checked supplements merge by stable channel ID, prefer tested lines and never duplicate',()=>{
  const source=liveSupplements[0];
  const rows=buildLiveCatalog(`#EXTM3U\n#EXTINF:-1 tvg-id="${source.externalId}",old\nhttps://example.com/old.m3u8\n`,[{id:source.externalId,name:'Original',country:'CN',categories:['general']}]);
  const merged=mergeLiveSupplements(rows),channel=merged.find(row=>row.id===rows[0].id)!;
  assert.equal(channel.name,source.name);assert.equal(readLiveLines(channel)[0].url,source.url);assert.equal(readLiveLines(channel)[1].url,'https://example.com/old.m3u8');
  assert.deepEqual(mergeLiveSupplements(merged),merged);assert.equal(rows[0].name,'Original');
  for(const row of mergeLiveSupplements([])){assert.equal(row.country,'CN');assert.deepEqual(JSON.parse(row.tags),['general']);for(const line of readLiveLines(row)){assert.ok(publicHttpUrl(line.url));assert.equal(new URL(line.url).search,'');}}
});

test('live import groups feeds, enriches country/category and filters unsafe/adult entries',()=>{
  const metadata=[{id:'Demo.cn',name:'测试频道',country:'CN',categories:['news','general']},{id:'Adult.us',name:'Adult',country:'US',is_nsfw:true}];
  const m3u='#EXTM3U\n#EXTINF:-1 tvg-id="Demo.cn@HD" tvg-logo="https://example.com/logo.png",Demo HD\nhttps://example.com/live/master.m3u8\n#EXTINF:-1 tvg-id="Demo.cn@SD",Demo SD\nhttps://example.com/live/sd.m3u8\n#EXTINF:-1 tvg-id="Demo.cn@SD",Duplicate\nhttps://example.com/live/sd.m3u8\n#EXTINF:-1 tvg-id="Adult.us",Adult\nhttps://example.com/adult.m3u8\n#EXTINF:-1,private\nhttp://127.0.0.1/private.m3u8\n#EXTINF:-1 group-title="Music",Unlisted\n#EXTVLCOPT:http-user-agent=Special\nhttps://example.com/music.m3u8\n';
  const rows=buildLiveCatalog(m3u,metadata);assert.equal(rows.length,2);assert.equal(rows[0].name,'测试频道');assert.equal(rows[0].country,'CN');assert.deepEqual(JSON.parse(rows[0].tags),['news','general']);assert.equal(readLiveLines(rows[0]).length,2);assert.equal(rows[1].country,'ZZ');assert.deepEqual(JSON.parse(rows[1].tags),['music']);assert.equal(readLiveLines(rows[1])[0].restricted,true);assert.equal(buildLiveCatalog(m3u,metadata)[0].id,rows[0].id);
  assert.throws(()=>buildLiveCatalog('<html>error</html>',metadata));assert.throws(()=>buildLiveCatalog('#EXTM3U',{}));
  const languages=buildLiveCatalog('#EXTM3U\n#EXTINF:-1 tvg-id="Demo.cn@English",English\nhttps://example.com/en.m3u8\n#EXTINF:-1 tvg-id="Demo.cn@EnglishHD",English HD\nhttps://example.com/enhd.m3u8\n#EXTINF:-1 tvg-id="Demo.cn@Arabic",Arabic\nhttps://example.com/ar.m3u8\n',metadata);assert.equal(languages.length,2);assert.equal(readLiveLines(languages[0]).length,2);assert.match(languages[0].name,/英语/);
});
test('live URL validation blocks private, credentialled, special protocol and unsafe ports',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.2','192.168.1.1','169.254.169.254','100.64.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2001:0db8:0:0::1','2001:0000:0:0::1','3fff::1'])assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','192.2.4.4','198.51.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
  for(const u of ['file:///etc/passwd','ftp://example.com/x','http://localhost/x','http://thing.local/x','http://127.1/x','http://2130706433/x','http://user:secret@example.com/x','http://example.com:22/x','http://[::ffff:127.0.0.1]/x','https://example.com/\nx'])assert.equal(publicHttpUrl(u),null,u);
  await assert.rejects(()=>liveFetch('http://127.0.0.1/secret'));
  assert.equal(publicHttpUrl('https://example.com/live.m3u8?token=demo'),'https://example.com/live.m3u8?token=demo');
});
test('HLS relay rewrites variant, segment, init and encryption-key URLs; rejects private URI',()=>{
  const urls:string[]=[];const text=rewriteLiveManifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhd/index.m3u8\nseg.ts\n','https://example.com/live/master.m3u8',u=>{urls.push(u);return '/signed/'+urls.length;});
  assert.deepEqual(urls,['https://example.com/live/init.mp4','https://example.com/key','https://example.com/live/hd/index.m3u8','https://example.com/live/seg.ts']);assert.ok(text.includes('URI="/signed/1"'));assert.ok(text.includes('\n/signed/3\n'));
  assert.throws(()=>rewriteLiveManifest('#EXTM3U\nhttp://169.254.169.254/latest\n','https://example.com/',x=>x));assert.throws(()=>rewriteLiveManifest('<html/>','https://example.com/',x=>x));
});
test('live filtering cannot bypass publication or playback membership and does not leak private state',()=>{
  assert.deepEqual(liveWhere({country:'CN',state:'hidden',enabled:false}),{enabled:true,available:true,country:'CN'});assert.deepEqual(liveWhere({category:'news'},true),{tags:{contains:'"news"'}});
  for(const p of ['/api/live/channels','/api/live/filters','/api/live/channels/id/stream/0','/api/live/channels/id/relay'])assert.equal(permissionForApi(p),'playback');
  assert.deepEqual(publicSettingsRows([{key:'siteName',value:'TV'},{key:'live:subscription',value:'private'}]),[{key:'siteName',value:'TV'}]);
  assert.deepEqual(liveWhere({country:'CN',health:'reachable'}),{enabled:true,available:true,country:'CN',lastCheckedAt:{not:null},lastError:null});
});
test('an HTTP 200 geo restriction or HTML page is never treated as HLS video',()=>{
  assert.throws(()=>assertLiveManifest(Buffer.from('the content is not available in your area')),e=>(e as LiveError).code==='GEO_BLOCKED');
  assert.throws(()=>assertLiveManifest(Buffer.from('<html>login: private-token</html>')),e=>(e as LiveError).code==='INVALID_PLAYLIST'&&!String(e).includes('private-token'));
  assert.match(assertLiveManifest(Buffer.from('#EXTM3U\n#EXTINF:6,\n1.ts')),/^#EXTM3U/);
});
test('live health must retrieve media, and can use a second line when the first fails',async()=>{
  const line={url:'https://example.com/master.m3u8',name:'test',restricted:false};let calls=0;
  const request=async(url:string)=>{calls++;if(url.endsWith('bad.m3u8'))throw new LiveError('UPSTREAM_DENIED');if(url.endsWith('.m3u8'))return {url,type:'application/vnd.apple.mpegurl',body:Buffer.from('#EXTM3U\n#EXTINF:6,\nsegment.ts\n')};const b=Buffer.alloc(188);b[0]=0x47;return {url,type:'video/mp2t',body:b};};
  assert.equal((await probeLiveLine(line,request)).ok,true);assert.equal(calls,2);
  await assert.rejects(()=>probeLiveLine(line,async url=>url.endsWith('.m3u8')?request(url):Promise.reject(new LiveError('UPSTREAM_HTTP'))),e=>(e as LiveError).code==='UPSTREAM_HTTP');
  const result=await checkLiveChannel({rawConfig:JSON.stringify([{...line,url:'https://example.com/bad.m3u8'},line])},request);assert.equal(result.ok,true);assert.equal(result.line,1);
});
test('the player shows only known safe error messages and tolerates binary XHR objects',()=>{
  assert.match(livePlaybackError({response:{data:JSON.stringify({code:'GEO_BLOCKED',error:'private-token'})}})||'',/地区/);
  assert.equal(livePlaybackError({response:{data:JSON.stringify({code:'UNKNOWN',error:'private-token'})}}),undefined);
  assert.equal(livePlaybackError({networkDetails:{get responseText(){throw Error('InvalidStateError');}}}),undefined);
  assert.equal(officialLivePage('CCTV-1'),'https://tv.cctv.com/live/cctv1/');assert.equal(officialLivePage('https://evil.example/CCTV-1'),null);
});
