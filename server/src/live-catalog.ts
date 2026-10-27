import {createHash} from 'node:crypto';
import {isIP,BlockList} from 'node:net';

export const LIVE_CATALOG='https://iptv-org.github.io/iptv/index.m3u';
export const LIVE_METADATA='https://iptv-org.github.io/api/channels.json';
export const liveCategories:Record<string,string>={general:'综合',news:'新闻',sports:'体育',movies:'电影',series:'电视剧',animation:'动画',kids:'少儿',documentary:'纪录片',music:'音乐',entertainment:'娱乐',education:'教育',culture:'文化',business:'财经',science:'科学',travel:'旅行',cooking:'美食',lifestyle:'生活',auto:'汽车',outdoor:'户外',classic:'经典',comedy:'喜剧',family:'家庭',legislative:'政务',religious:'宗教',shop:'购物',weather:'天气',relax:'休闲',undefined:'未分类'};
export type LiveLine={url:string;name:string;restricted:boolean};
export type ImportedChannel={id:string;name:string;country:string;tags:string;cover:string|null;rawConfig:string;available:boolean};
const specialV6=new BlockList();for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)specialV6.addSubnet(address,prefix,'ipv6');
const specialV4=new BlockList();for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)specialV4.addSubnet(address,prefix,'ipv4');
export function publicHttpUrl(value:unknown):string|null{
  if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f]/.test(value))return null;
  try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!u.hostname||u.port&&!['80','443'].includes(u.port))return null;
    const host=u.hostname.replace(/^\[|\]$/g,'');if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||isIP(host)&&!isPublicAddress(host))return null;return u.href;
  }catch{return null;}
}
export function isPublicAddress(address:string){
  if(isIP(address)===4)return !specialV4.check(address,'ipv4');
  // Accept only ordinary global IPv6 unicast; reject mapped/transition and special-use space.
  if(isIP(address)===6)return /^[23]/i.test(address)&&!specialV6.check(address,'ipv6');
  return false;
}
export function readLiveLines(row:{rawConfig:string}):LiveLine[]{try{const a=JSON.parse(row.rawConfig);return Array.isArray(a)?a.filter(x=>x&&publicHttpUrl(x.url)&&typeof x.name==='string').slice(0,30):[];}catch{return [];}}
export function buildLiveCatalog(playlist:string,metadata:unknown):ImportedChannel[]{
  if(!playlist.trimStart().startsWith('#EXTM3U')||!Array.isArray(metadata))throw Error('直播目录格式不正确');
  const info=new Map(metadata.filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
  const groups=new Map<string,{row:ImportedChannel;lines:LiveLine[]}>();let pending:any=null;
  for(const raw of playlist.split(/\r?\n/)){
    const line=raw.trim();if(line.startsWith('#EXTINF:')){
      const attrs:Record<string,string>={};for(const m of line.matchAll(/([\w-]+)="([^"\r\n]*)"/g))attrs[m[1]]=m[2];
      const comma=line.replace(/"[^"]*"/g,m=>' '.repeat(m.length)).indexOf(',');
      pending={...attrs,title:comma>=0?line.slice(comma+1).trim():'',restricted:!!attrs['http-user-agent']||!!attrs['http-referrer']};continue;
    }
    if(line.startsWith('#EXTVLCOPT:')||line.startsWith('#KODIPROP:')){if(pending)pending.restricted=true;continue;}
    if(!line||line.startsWith('#'))continue;
    const entry=pending;pending=null;if(!entry?.title)continue;const url=publicHttpUrl(line);if(!url)continue;
    const [external,rawFeed='']=String(entry['tvg-id']||'').split('@'),meta=info.get(external);
    if(meta?.is_nsfw===true)continue;
    // Quality variants are alternatives; different language/regional feeds are not.
    const feed=rawFeed.replace(/(?:UHD|FHD|HD|SD|4K|8K)$/i,'');
    const feedNames:Record<string,string>={English:'英语',Arabic:'阿拉伯语',French:'法语',Spanish:'西班牙语',Chinese:'中文',Mandarin:'普通话',Portuguese:'葡萄牙语',Russian:'俄语',German:'德语',Japanese:'日语'};
    const name=String(meta?.name?meta.name+(feed?' · '+(feedNames[feed]||feed):''):entry.title.replace(/\s*\(\d+p\).*$/,'')).slice(0,250),key=external?external+(feed?'@'+feed:''):name.toLowerCase();
    let group=groups.get(key);
    if(!group){const cats=Array.isArray(meta?.categories)?meta.categories.filter((x:any)=>typeof x==='string'&&liveCategories[x]):[];const fallback=String(entry['group-title']||'').toLowerCase().split(';').filter(x=>liveCategories[x]);
      group={row:{id:createHash('sha256').update(key).digest('hex').slice(0,32),name,country:/^[A-Z]{2}$/.test(meta?.country)?meta.country:'ZZ',tags:JSON.stringify(cats.length?cats:fallback.length?fallback:['undefined']),cover:publicHttpUrl(entry['tvg-logo']),rawConfig:'[]',available:true},lines:[]};groups.set(key,group);}
    if(group.lines.length<30&&!group.lines.some(x=>x.url===url))group.lines.push({url,name:String(entry.title).slice(0,250),restricted:entry.restricted});
  }
  return [...groups.values()].map(({row,lines})=>({...row,rawConfig:JSON.stringify(lines)}));
}
