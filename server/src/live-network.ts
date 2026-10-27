import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isPublicAddress,publicHttpUrl} from './live-catalog.js';
import {LiveError} from './live-health.js';

// Resolve and pin every hop, including redirects. Never use a generic open URL proxy.
export async function liveFetch(input:string,maxBytes=1024*1024,redirects=0,range?:string):Promise<{body:Buffer;type:string;url:string;range?:string}>{
  const normalized=publicHttpUrl(input);if(!normalized||redirects>4)throw Error('不允许的直播地址');
  const url=new URL(normalized),hostname=url.hostname.replace(/^\[|\]$/g,'');
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  const addresses=await Promise.race([lookup(hostname,{all:true}),new Promise<never>((_ok,fail)=>{dnsTimer=setTimeout(()=>fail(Error('直播 DNS 查询超时')),5000);})]).finally(()=>clearTimeout(dnsTimer));
  if(!addresses.length||addresses.some(x=>!isPublicAddress(x.address)))throw Error('不允许访问内网地址');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).get(url,{headers:{Accept:'*/*',...range?{Range:range}:{}},lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,addresses):cb(null,pinned.address,pinned.family)) as any},response=>{
      response.on('error',reject);
      if([301,302,303,307,308].includes(response.statusCode||0)&&response.headers.location){response.resume();try{liveFetch(new URL(response.headers.location,url).href,maxBytes,redirects+1,range).then(resolve,reject);}catch{reject(Error('直播重定向地址无效'));}return;}
      if(response.statusCode!==200&&!(range&&response.statusCode===206)){response.resume();reject(new LiveError([401,403,451].includes(response.statusCode||0)?'UPSTREAM_DENIED':'UPSTREAM_HTTP'));return;}
      if(Number(response.headers['content-length'])>maxBytes){response.destroy();reject(Error('直播响应过大'));return;}
      const chunks:Buffer[]=[];let size=0;response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){response.destroy(Error('直播响应过大'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve({body:Buffer.concat(chunks),type:String(response.headers['content-type']||'application/octet-stream'),url:url.href,...response.statusCode===206&&/^bytes \d+-\d+\/(\d+|\*)$/.test(String(response.headers['content-range']))?{range:String(response.headers['content-range'])}:{}}));
    });
    const timer=setTimeout(()=>request.destroy(new LiveError('UPSTREAM_TIMEOUT')),15000);request.on('close',()=>clearTimeout(timer));request.on('error',reject);
  });
}
