const messages:Record<string,string>={GEO_BLOCKED:'直播源明确限制了当前服务器所在地区，无法在本站播放。',UPSTREAM_DENIED:'直播源拒绝访问，可能需要授权或限定网络。',UPSTREAM_HTTP:'直播源暂不可用或地址已失效，请尝试其他频道。',UPSTREAM_TIMEOUT:'连接直播源超时，当前服务器可能无法访问该线路。',INVALID_PLAYLIST:'这个地址没有返回有效直播，不能作为视频播放。',INVALID_MEDIA:'直播清单能读取，但视频片段已经失效。',NETWORK:'直播源网络连接失败，请稍后重试。'};
export function livePlaybackError(data:any):string|undefined{
  // Only recognize our error codes. Never display an upstream page, URL, token or raw log.
  const values=[data?.response?.data];try{values.push(data?.networkDetails?.responseText);}catch{} // Binary XHR responseText can throw.
  for(const value of values){try{const body=typeof value==='string'?JSON.parse(value):value;if(body&&typeof body.code==='string'&&Object.prototype.hasOwnProperty.call(messages,body.code))return messages[body.code];}catch{}}
  return undefined;
}
export function officialLivePage(name:string){const n=name.match(/^CCTV-(\d{1,2})$/)?.[1];return n&&Number(n)>=1&&Number(n)<=17?`https://tv.cctv.com/live/cctv${n}/`:null;}
