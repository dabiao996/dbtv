import type {Express} from 'express';
import type {PrismaClient} from '@prisma/client';

export type SearchVideo={id:string;sourceKey:string;sourceName:string;title:string;year?:number|null;category?:string;cover?:string;[key:string]:any};
export function titleKey(value:string){return String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'').trim();}
export function sameVideo(a:SearchVideo,b:SearchVideo){return titleKey(a.title)===titleKey(b.title)&&(!a.year||!b.year||a.year===b.year);}
export function groupVideos(rows:SearchVideo[]){
  const byTitle=new Map<string,SearchVideo[]>();
  for(const row of rows){const title=titleKey(row.title);if(!title)continue;byTitle.set(title,[...(byTitle.get(title)||[]),row]);}
  const groups:any[]=[];
  for(const family of byTitle.values()){
    const years=new Set(family.map(x=>x.year).filter(Boolean));
    const buckets=new Map<string,SearchVideo[]>();
    for(const row of family){const key=String(row.year||(years.size===1?[...years][0]:'unknown'));const bucket=buckets.get(key)||[];if(!bucket.some(x=>x.id===row.id&&x.sourceKey===row.sourceKey))bucket.push(row);buckets.set(key,bucket);}
    for(const variants of buckets.values()){
      const first=variants[0];groups.push({...first,year:variants.find(x=>x.year)?.year,cover:variants.find(x=>x.cover)?.cover,variants:variants.map(x=>({id:x.id,sourceKey:x.sourceKey,sourceName:x.sourceName,title:x.title,year:x.year,cover:x.cover}))});
    }
  }
  return groups;
}

type Dependencies={canVideo?:(user:any,key:string,id:string,item?:any)=>Promise<boolean>;requireUser:(req:any,res:any)=>Promise<any>;canSource:(user:any,key:string)=>boolean;remoteList:(source:any,page?:number,size?:number,keyword?:string)=>Promise<any>;localList:(source:any,page?:number,size?:number,keyword?:string)=>Promise<any>;publicVideo:(source:any,item:any,full?:boolean)=>any;remoteDetail:(source:any,id:string)=>Promise<any>;localPublic:(source:any,items:any[],full?:boolean)=>Promise<any[]>};
export function registerSearch(app:Express,db:PrismaClient,deps:Dependencies){
  async function searchRows(user:any,q:string){
    const sources=(await db.source.findMany({where:{enabled:true,searchable:true},orderBy:[{priority:'desc'},{key:'asc'}]})).filter(x=>deps.canSource(user,x.key));
    const pages=await Promise.all(sources.map(async source=>{
      try{
        const local=await db.video.count({where:{sourceKey:source.key}});
        const result=local?await deps.localList(source,1,50,q):await deps.remoteList(source,1,50,q);
        return result.list.map((x:any)=>({...local?x:deps.publicVideo(source,x),sourceName:source.name}));
      }catch{return []}
    }));const rows=pages.flat() as SearchVideo[];if(!deps.canVideo)return rows;
    const filtered:SearchVideo[]=[];for(const row of rows)if(await deps.canVideo(user,row.sourceKey,row.id,row))filtered.push(row);return filtered;
  }
  app.get('/api/search',async(req,res)=>{
    const user=await deps.requireUser(req,res);if(!user)return;
    const q=String(req.query.q||'').trim().slice(0,80);if(!q)return res.json([]);
    await db.searchStat.create({data:{userId:user.id,keyword:q}});
    res.json(groupVideos(await searchRows(user,q)));
  });
  app.get('/api/playback-options',async(req,res)=>{
    const user=await deps.requireUser(req,res);if(!user)return;
    const sourceKey=String(req.query.sourceKey||''),id=String(req.query.videoId||'');
    const source=await db.source.findUnique({where:{key:sourceKey}});
    if(!source||!source.enabled||!deps.canSource(user,sourceKey))return res.status(403).json({error:'该数据源不可用或没有访问权限'});
    const local=await db.video.findUnique({where:{id}});
    if(local&&(!local.visible||local.sourceKey!==sourceKey))return res.status(404).json({error:'影片不存在'});
    const detail=local?(await deps.localPublic(source,[local]))[0]:await deps.remoteDetail(source,id);
    if(!detail)return res.status(404).json({error:'影片不存在'});
    if(deps.canVideo&&!await deps.canVideo(user,sourceKey,id,detail))return res.status(403).json({error:'当前会员不能观看此分类',code:'CONTENT_RESTRICTED'});
    const anchor:SearchVideo={...local?detail:deps.publicVideo(source,detail),sourceName:source.name};
    const candidates=(await searchRows(user,anchor.title)).filter(x=>sameVideo(x,anchor));
    // List endpoints often omit years; check detail metadata before offering those matches.
    const verified=await Promise.all(candidates.map(async item=>{
      if(item.sourceKey===source.key&&item.id===anchor.id)return anchor;
      if(!anchor.year||item.year)return item;
      try{
        const s=await db.source.findUnique({where:{key:item.sourceKey}});if(!s||!s.enabled||!s.searchable||!deps.canSource(user,s.key))return null;
        const saved=await db.video.findUnique({where:{id:item.id}});
        const raw=saved?null:await deps.remoteDetail(s,item.id);
        const full=saved?{...saved,sourceName:s.name}:raw?deps.publicVideo(s,raw):null;
        return full&&sameVideo(anchor,full)?{...item,...full,sourceName:s.name}:null;
      }catch{return null}
    }));
    const variants=new Map<string,SearchVideo>();
    variants.set(JSON.stringify([anchor.sourceKey,anchor.id]),anchor);
    for(const item of verified)if(item)variants.set(JSON.stringify([item.sourceKey,item.id]),item);
    res.json({items:[...variants.values()].map(x=>({id:x.id,sourceKey:x.sourceKey,sourceName:x.sourceName,title:x.title,year:x.year,cover:x.cover})),currentSourceName:source.name});
  });
  return {searchRows};
}
