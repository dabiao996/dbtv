import {buildLiveCatalog,readLiveLines,type ImportedChannel} from './live-catalog.js';

// Public broadcaster endpoints, manually played in the browser on 2026-10-22.
// Discovery: https://github.com/anaer/Meow/blob/main/meow.json
// No credentials or playback guarantee; refreshes retain manual publication choices.
export const liveSupplements=[
  {externalId:'HebeiTV.cn',name:'河北卫视',url:'https://event.pull.hebtv.com/jishi/weishi_tingyun.m3u8',lineName:'河北广电公开线路 · 540p'},
  {externalId:'ZhejiangSatelliteTV.cn',name:'浙江卫视',url:'http://ali-xwl.cztv.com/live/channel011080Plxw.m3u8',lineName:'浙江广电公开线路 · 1080p'},
];

export function mergeLiveSupplements(rows:ImportedChannel[]):ImportedChannel[]{
  const merged=new Map(rows.map(row=>[row.id,{...row}]));
  for(const source of liveSupplements){
    const [extra]=buildLiveCatalog(`#EXTM3U\n#EXTINF:-1 tvg-id="${source.externalId}",${source.lineName}\n${source.url}\n`,[{id:source.externalId,name:source.name,country:'CN',categories:['general']}]);
    const previous=merged.get(extra.id);
    const lines=[...readLiveLines(extra),...previous?readLiveLines(previous):[]].filter((line,index,all)=>all.findIndex(x=>x.url===line.url)===index).slice(0,30);
    merged.set(extra.id,{...extra,...previous,name:source.name,available:true,rawConfig:JSON.stringify(lines)});
  }
  return [...merged.values()];
}
