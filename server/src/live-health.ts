import type {LiveLine} from './live-catalog.js';

export const liveErrors:Record<string,string>={GEO_BLOCKED:'直播源明确限制了当前服务器所在地区，无法在本站播放',UPSTREAM_DENIED:'直播源拒绝访问，可能需要授权或限定网络',UPSTREAM_HTTP:'直播源暂不可用或地址已失效',UPSTREAM_TIMEOUT:'连接直播源超时，当前服务器可能无法访问该线路',INVALID_PLAYLIST:'直播源没有返回有效的 HLS 播放列表',INVALID_MEDIA:'清单可读取，但视频片段不可用',UNSUPPORTED:'此线路需要特殊播放器，网页暂不支持',NETWORK:'直播源网络连接失败'};
export class LiveError extends Error{constructor(public code:string){super(liveErrors[code]||liveErrors.NETWORK);}}
export const liveError=(error:any)=>error instanceof LiveError?error:new LiveError(/TIMEOUT|TIMEDOUT/.test(String(error?.code))?'UPSTREAM_TIMEOUT':'NETWORK');
export function assertLiveManifest(body:Buffer){
  const text=body.toString('utf8');if(text.trimStart().startsWith('#EXTM3U'))return text;
  if(/(?:not available|unavailable|not allowed).{0,60}(?:area|region|country)|geo.?block|地区.{0,20}(?:不可用|限制|不支持)/i.test(text.slice(0,4096)))throw new LiveError('GEO_BLOCKED');
  throw new LiveError('INVALID_PLAYLIST');
}
type Request=(url:string,max?:number)=>Promise<{body:Buffer;url:string;type?:string}>;
// This checks one real media fragment, not just a possibly stale master playlist.
export async function probeLiveLine(line:LiveLine,request:Request){
  if(line.restricted)throw new LiveError('UNSUPPORTED');let url=line.url,encrypted=false;
  for(let depth=0;depth<5;depth++){
    const result=await request(url,16*1024*1024),text=result.body.subarray(0,64).toString('utf8');
    if(text.trimStart().startsWith('#EXTM3U')){
      const manifest=assertLiveManifest(result.body);encrypted||=/#EXT-X-KEY:METHOD=(?!NONE)/.test(manifest);
      const child=manifest.split(/\r?\n/).find(x=>x.trim()&&!x.startsWith('#'));if(!child)throw new LiveError('INVALID_PLAYLIST');
      url=new URL(child.trim(),result.url).href;continue;
    }
    if(depth===0)assertLiveManifest(result.body);
    if(/^(text\/|application\/json)/i.test(result.type||''))assertLiveManifest(result.body);
    const b=result.body,iso=/^(ftyp|styp|moof)$/.test(b.subarray(4,8).toString());
    if(b.length<188||!encrypted&&b[0]!==0x47&&!iso)throw new LiveError('INVALID_MEDIA');
    return {ok:true as const,message:'已读取视频片段；此结果不等于浏览器画面、声音或解码验证通过'};
  }
  throw new LiveError('INVALID_PLAYLIST');
}
export async function checkLiveChannel(row:any,request:Request){
  const {readLiveLines}=await import('./live-catalog.js');let last=new LiveError('UNSUPPORTED');
  // Limit an interactive probe to three candidates; do not hammer every alternate feed.
  const lines=readLiveLines(row).map((line,index)=>({line,index})).filter(x=>!x.line.restricted).slice(0,3);
  for(const {line,index} of lines){try{return {...await probeLiveLine(line,request),line:index};}catch(error){last=liveError(error);}}
  return {ok:false as const,code:last.code,message:last.message};
}
