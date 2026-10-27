type VideoMeta={title:string;cover:string|null};

export function cleanVideoTitle(value:unknown){
  if(typeof value!=='string')return '';
  const title=value.trim();
  return title&&title.toLowerCase()!=='undefined'?title:'';
}

export function cleanVideoCover(value:unknown){
  if(typeof value!=='string')return null;
  const cover=value.trim();
  return cover&&cover.toLowerCase()!=='undefined'?cover:null;
}

// Only trusted local or upstream records may fill missing browser metadata. The
// route's source and content-access gates run before this helper is called.
export async function resolveVideoMeta(db:any,remoteDetail:(source:any,id:string)=>Promise<any>,sourceKey:string,videoId:string,suppliedTitle?:unknown,suppliedCover?:unknown):Promise<VideoMeta>{
  let title=cleanVideoTitle(suppliedTitle),cover=cleanVideoCover(suppliedCover);
  if(title&&cover)return {title,cover};

  const local=await db.video.findUnique({where:{id:videoId}});
  // A hidden or differently sourced record must never be used as a fallback.
  if(local){
    if(local.sourceKey!==sourceKey||!local.visible)return {title,cover};
    title ||= cleanVideoTitle(local.title);
    cover ||= cleanVideoCover(local.cover);
  }
  if(title&&cover)return {title,cover};

  // Remote IDs are namespaced by source; never look up the same ID in another source.
  if(!videoId.startsWith(`${sourceKey}:`)||!videoId.slice(sourceKey.length+1))return {title,cover};
  const source=await db.source.findUnique({where:{key:sourceKey}});
  if(!source?.enabled||source.type!=='tvbox-json')return {title,cover};
  try{
    const remote=await remoteDetail(source,videoId);
    const remoteId=videoId.slice(sourceKey.length+1);
    if(remote&&(!remote.vod_id||String(remote.vod_id)===remoteId)){
      title ||= cleanVideoTitle(remote.vod_name);
      cover ||= cleanVideoCover(remote.vod_pic);
    }
  }catch{
    // remoteDetail uses a 10-second fetch timeout. Keep stored metadata intact.
    console.warn('Video metadata lookup unavailable; retaining existing metadata');
  }
  return {title,cover};
}
