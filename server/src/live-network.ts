import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {isPublicAddress,publicHttpUrl} from './live-catalog.js';
import {LiveError} from './live-health.js';

// Optional outbound proxy for deployments whose network can only reach the
// internet through one (corporate/campus gateways, some NAS setups). It is
// strictly opt-in via DBTV_LIVE_PROXY (an http:// proxy URL, optionally with
// credentials) and never changes the default direct behavior. In proxy mode
// the proxy resolves DNS — local resolution is exactly what is broken in
// those networks — so the direct mode's resolve-and-pin check cannot apply;
// protection rests on the URL form rules (http/https only, no IP-literal
// hosts, ports 80/443) plus the proxy being an operator-configured, trusted
// gateway. Only enable it with a proxy you control.
export function configuredLiveProxy(env:NodeJS.ProcessEnv=process.env):URL|null{
  const raw=String(env.DBTV_LIVE_PROXY||'').trim();if(!raw)return null;
  let parsed:URL;try{parsed=new URL(raw);}catch{throw Error('DBTV_LIVE_PROXY 配置无效');}
  if(parsed.protocol!=='http:'||!parsed.hostname)throw Error('DBTV_LIVE_PROXY 配置无效（仅支持 http 代理）');
  return parsed;
}
const proxyAuthorization=(proxy:URL)=>proxy.username?`Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password||'')}`).toString('base64')}`:'';

// https.Agent is the supported extension point for CONNECT tunneling:
// https.request ignores a createConnection passed in request options (it
// would wrap the tunnel in a second TLS handshake).
class ConnectAgent extends https.Agent{
  constructor(private proxy:URL){super({keepAlive:false});}
  createConnection(options:any,oncreate?:(error:any,socket?:any)=>void):any{
    proxyConnect(this.proxy,String(options.host||''),Number(options.port||443)).then(socket=>{
      const secure=tls.connect({socket,servername:options.servername||options.host});
      secure.once('secureConnect',()=>oncreate?.(null,secure));
      secure.once('error',(error:any)=>oncreate?.(error));
    },(error:any)=>oncreate?.(error));
    return null;
  }
}

function proxyConnect(proxy:URL,targetHost:string,targetPort:number):Promise<net.Socket>{
  return new Promise((resolve,reject)=>{
    const socket=net.connect(Number(proxy.port||80),proxy.hostname);
    const timer=setTimeout(()=>socket.destroy(Error('代理连接超时')),10000);
    let buffer=Buffer.alloc(0);
    const onData=(chunk:Buffer)=>{
      buffer=Buffer.concat([buffer,chunk]);
      const end=buffer.indexOf('\r\n\r\n');
      if(end<0)return;
      clearTimeout(timer);socket.off('data',onData);
      if(!/^HTTP\/1\.[01] 200/.test(buffer.subarray(0,end).toString('latin1'))){socket.destroy();reject(Error('代理拒绝建立连接'));return;}
      resolve(socket);
    };
    socket.on('data',onData);
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
    socket.once('connect',()=>{
      const auth=proxyAuthorization(proxy);
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth?`Proxy-Authorization: ${auth}\r\n`:''}\r\n`);
    });
  });
}

// Resolve and pin every hop, including redirects. Never use a generic open URL proxy.
export async function liveFetch(input:string,maxBytes=1024*1024,redirects=0,range?:string):Promise<{body:Buffer;type:string;url:string;range?:string}>{
  const normalized=publicHttpUrl(input);if(!normalized||redirects>4)throw Error('不允许的直播地址');
  const url=new URL(normalized),hostname=url.hostname.replace(/^\[|\]$/g,'');
  const proxy=configuredLiveProxy();
  // Direct mode resolves and pins public addresses; proxy mode delegates
  // resolution to the configured proxy (see the note above).
  let addresses:{address:string;family:number}[]=[],pinned:{address:string;family:number}|undefined;
  if(!proxy){
    let dnsTimer:ReturnType<typeof setTimeout>|undefined;
    addresses=await Promise.race([lookup(hostname,{all:true}),new Promise<never>((_ok,fail)=>{dnsTimer=setTimeout(()=>fail(Error('直播 DNS 查询超时')),5000);})]).finally(()=>clearTimeout(dnsTimer));
    if(!addresses.length||addresses.some(x=>!isPublicAddress(x.address)))throw Error('不允许访问内网地址');
    pinned=addresses[0];
  }
  return new Promise((resolve,reject)=>{
    const headers={Accept:'*/*',...range?{Range:range}:{}};
    const onResponse=(response:http.IncomingMessage)=>{
      response.on('error',reject);
      if([301,302,303,307,308].includes(response.statusCode||0)&&response.headers.location){response.resume();try{liveFetch(new URL(response.headers.location,url).href,maxBytes,redirects+1,range).then(resolve,reject);}catch{reject(Error('直播重定向地址无效'));}return;}
      if(response.statusCode!==200&&!(range&&response.statusCode===206)){response.resume();reject(new LiveError([401,403,451].includes(response.statusCode||0)?'UPSTREAM_DENIED':'UPSTREAM_HTTP'));return;}
      if(Number(response.headers['content-length'])>maxBytes){response.destroy();reject(Error('直播响应过大'));return;}
      const chunks:Buffer[]=[];let size=0;response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){response.destroy(Error('直播响应过大'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve({body:Buffer.concat(chunks),type:String(response.headers['content-type']||'application/octet-stream'),url:url.href,...response.statusCode===206&&/^bytes \d+-\d+\/(\d+|\*)$/.test(String(response.headers['content-range']))?{range:String(response.headers['content-range'])}:{}}));
    };
    let request:http.ClientRequest;
    if(proxy&&url.protocol==='https:'){
      request=https.get(url,{headers,agent:new ConnectAgent(proxy)},onResponse);
    }else if(proxy){
      const auth=proxyAuthorization(proxy);
      request=http.get({host:proxy.hostname,port:Number(proxy.port||80),path:url.href,headers:{...headers,Host:url.host,...auth?{'Proxy-Authorization':auth}:{}}},onResponse);
    }else{
      request=(url.protocol==='https:'?https:http).get(url,{headers,lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,addresses):cb(null,pinned!.address,pinned!.family)) as any},onResponse);
    }
    const timer=setTimeout(()=>request.destroy(new LiveError('UPSTREAM_TIMEOUT')),15000);request.on('close',()=>clearTimeout(timer));request.on('error',reject);
  });
}
