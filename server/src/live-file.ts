import {randomBytes} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {liveCategories,publicHttpUrl,type LiveLine} from './live-catalog.js';
const database=require('../../scripts/web-database.cjs');

export type LiveFileChannel = {
  id:string; name:string; country:string; categories:string[]; cover:string|null;
  lines:LiveLine[]; enabled:boolean; available:boolean;
};
export type LiveFileSource = {id:string;name:string;playlistUrl:string;metadataUrl:string|null};
export type LiveFile = {
  version:1; sources:LiveFileSource[]; autoUpdate:boolean; lastUpdatedAt:string|null;
  channels:LiveFileChannel[];
};

export const liveFilePath=(root=process.cwd())=>path.join(database.stateDirectory(root),'live-tv.json');
const invalid=():never=>{throw Error('直播 JSON 格式无效；原有频道缓存未改动，请修复 live-tv.json');};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const string=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max;

export function validateLiveFile(value:unknown):LiveFile {
  if(!object(value))invalid();
  const data=value as Record<string,any>;
  if(data.version!==1||!Array.isArray(data.sources)||!data.sources.length||data.sources.length>8||
    !Array.isArray(data.channels)||data.channels.length>100000||typeof data.autoUpdate!=='boolean'||
    data.lastUpdatedAt!==null&&!(typeof data.lastUpdatedAt==='string'&&!Number.isNaN(Date.parse(data.lastUpdatedAt)))) invalid();
  const sources:LiveFileSource[]=data.sources.map((item:unknown)=>{
    const source=item as Record<string,any>;
    if(!object(item)||!string(source.id,64)||!string(source.name,120)||!publicHttpUrl(source.playlistUrl)||
      source.metadataUrl!==null&&!publicHttpUrl(source.metadataUrl))invalid();
    return {id:source.id,name:source.name,playlistUrl:source.playlistUrl,metadataUrl:source.metadataUrl};
  });
  if(new Set(sources.map(item=>item.id)).size!==sources.length)invalid();
  const ids=new Set<string>();
  const channels:LiveFileChannel[]=data.channels.map((item:unknown)=>{
    const channel=item as Record<string,any>;
    if(!object(item)||typeof channel.id!=='string'||!/^[a-f0-9]{32}$/.test(channel.id)||ids.has(channel.id)||
      !string(channel.name,250)||typeof channel.country!=='string'||!/^[A-Z]{2}$/.test(channel.country)||
      !Array.isArray(channel.categories)||!channel.categories.length||channel.categories.length>20||
      channel.categories.some((category:unknown)=>typeof category!=='string'||!Object.hasOwn(liveCategories,category))||
      channel.cover!==null&&(!string(channel.cover,4096)||!publicHttpUrl(channel.cover))||
      !Array.isArray(channel.lines)||!channel.lines.length||channel.lines.length>30||
      typeof channel.enabled!=='boolean'||typeof channel.available!=='boolean') invalid();
    ids.add(channel.id);
    const lines:LiveLine[]=channel.lines.map((line:unknown)=>{
      const candidate=line as Record<string,any>;
      if(!object(line)||!publicHttpUrl(candidate.url)||!string(candidate.name,250)||typeof candidate.restricted!=='boolean')invalid();
      return {url:candidate.url,name:candidate.name,restricted:candidate.restricted};
    });
    return {id:channel.id,name:channel.name,country:channel.country,
      categories:channel.categories,cover:channel.cover,lines,
      enabled:channel.enabled,available:channel.available};
  });
  return {version:1,sources,autoUpdate:data.autoUpdate,lastUpdatedAt:data.lastUpdatedAt,channels};
}

export function readLiveFile(root=process.cwd()):LiveFile|null {
  const file=liveFilePath(root);
  const directory=path.dirname(file);
  if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())invalid();
  if(!existsSync(file))return null;
  if(lstatSync(file).isSymbolicLink()||statSync(file).size>30*1024*1024)invalid();
  try{return validateLiveFile(JSON.parse(readFileSync(file,'utf8')));}catch{return invalid();}
}

export function writeLiveFile(value:LiveFile,root=process.cwd()):void {
  const checked=validateLiveFile(value),directory=database.privateDirectory(root),file=liveFilePath(root);
  if(existsSync(file)&&lstatSync(file).isSymbolicLink())invalid();
  const temp=path.join(directory,`.live-tv.json.${process.pid}.${randomBytes(6).toString('hex')}`);
  let descriptor:number|undefined;
  try{
    descriptor=openSync(temp,'wx',0o600);
    writeFileSync(descriptor,JSON.stringify(checked,null,2)+'\n');
    fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
    renameSync(temp,file);
    const parent=openSync(directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  }finally{if(descriptor!==undefined)closeSync(descriptor);if(existsSync(temp))unlinkSync(temp);}
}

export function liveFileRows(file:LiveFile){return file.channels.map(channel=>({
  id:channel.id,name:channel.name,country:channel.country,tags:JSON.stringify(channel.categories),
  cover:channel.cover,rawConfig:JSON.stringify(channel.lines),enabled:channel.enabled,available:channel.available,
}));}

export async function replaceLiveCache(db:any,file:LiveFile,audit?:{userId:number|null;action:string;detail:string}){
  const rows=liveFileRows(file);
  if(!rows.length&&await db.liveChannel.count())throw Error('空直播 JSON 不能覆盖已有频道缓存');
  await db.$transaction(async(tx:any)=>{
    await tx.liveChannel.deleteMany();
    for(let index=0;index<rows.length;index+=100)await tx.liveChannel.createMany({data:rows.slice(index,index+100)});
    const value=JSON.stringify({autoUpdate:file.autoUpdate,lastUpdatedAt:file.lastUpdatedAt,imported:file.channels.length});
    await tx.setting.upsert({where:{key:'live:subscription'},create:{key:'live:subscription',value},update:{value}});
    if(audit)await tx.adminLog.create({data:audit});
  },{timeout:180000,maxWait:10000});
}
