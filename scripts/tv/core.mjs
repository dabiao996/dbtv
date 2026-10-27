// Stable, dependency-free application adapter for a future parent toolbox.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

export const DEFAULT_PORT = 8787;
export const APP = {id:'dbtv', name:'大彪TV', adapterVersion:1, defaultPort:DEFAULT_PORT};
export function portNumber(value) {
  if (!/^\d{1,5}$/.test(String(value))) throw Error('端口必须是 1024–65535 的整数');
  const port=Number(value);
  if (port<1024 || port>65535) throw Error('端口必须是 1024–65535 的整数');
  return port;
}
export function origin(value='') {
  if (!value) return '';
  let url;
  try {url=new URL(value.includes('://')?value:`https://${value}`);} catch {throw Error('请输入有效域名或 http(s)://域名');}
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname) throw Error('域名不能包含账号、路径、查询参数或其他协议');
  return url.origin;
}
export async function available(port, host='0.0.0.0') {
  portNumber(port);
  // macOS/BSD may permit wildcard bind alongside a specific-address listener.
  // A real local TCP connection detects that case as well as normal Linux binds.
  const targets=host==='0.0.0.0'?['127.0.0.1','::1',...Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal).map(x=>x.address)]:[host];
  const accepting=await Promise.all([...new Set(targets)].map(address=>new Promise(resolve=>{
    const socket=net.connect({host:address,port});let finished=false;
    const done=value=>{if(finished)return;finished=true;socket.destroy();resolve(value);};
    socket.setTimeout(300,()=>done(false));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));
  })));
  if(accepting.some(Boolean))return false;
  const probe=address=>new Promise((resolve,reject)=>{
    const server=net.createServer();server.unref();
    server.once('error',error=>{
      if (['EADDRINUSE','EACCES'].includes(error.code)) resolve(false);
      else if (address==='::'&&['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code)) resolve(true);
      else reject(Error('无法检测端口，请检查系统网络权限'));
    });
    server.listen({port,host:address,ipv6Only:address==='::'},()=>server.close(()=>resolve(true)));
  });
  if (!await probe(host)) return false;
  // Check IPv6 too: an IPv6-only listener must not be mistaken for a free port.
  return host==='0.0.0.0'?probe('::'):true;
}
export async function suggest(port,host) {
  for (let candidate=Number(port)+1;candidate<=Math.min(Number(port)+100,65535);candidate++) if(await available(candidate,host)) return candidate;
  return null;
}
export async function choosePort({value,initial,defaultPort=DEFAULT_PORT,host='0.0.0.0',ask,report=()=>{}}) {
  for (;;) {
    let selected;
    const input=value!==undefined?value:initial!==undefined?initial:(await ask(`监听端口 [${defaultPort}]：`)).trim()||defaultPort;
    initial=undefined;
    try {selected=portNumber(input);}
    catch(error) {if(value!==undefined)throw error;report(error.message);continue;}
    if (await available(selected,host)) return selected;
    const next=await suggest(selected,host);
    const message=`端口 ${selected} 已被占用，未停止任何服务${next?`；可尝试 ${next}`:''}`;
    if (value!==undefined) {const error=Error(message);error.code='PORT_IN_USE';throw error;}
    report(message);
    if(next) defaultPort=next;
  }
}
export function privateDirectory(directory) {
  if (fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink()) throw Error('管理目录不能是符号链接');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
}
export function atomic(file,text,mode=0o600) {
  const temp=`${file}.${randomUUID()}.tmp`;
  try {fs.writeFileSync(temp,text,{flag:'wx',mode});fs.renameSync(temp,file);} finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function secureCopy(source,target) {
  let input,output;
  try {
    input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(input);if(!stat.isFile()||stat.nlink!==1)throw Error('备份源不是独立普通文件，拒绝跟随链接');
    output=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    const buffer=Buffer.alloc(1024*1024);let count;
    while((count=fs.readSync(input,buffer,0,buffer.length,null))>0){let written=0;while(written<count)written+=fs.writeSync(output,buffer,written,count-written);}
    fs.fsyncSync(output);
  } finally {if(input!==undefined)fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
}
const liveLimit=30*1024*1024;
const liveFailure=()=>Error('直播 JSON 损坏或私有文件权限不安全，未切换程序版本');
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
function liveHttpUrl(value){
  if(!bounded(value,4096))return false;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}
  catch{return false;}
}
function validLiveCatalog(value){
  if(!value||value.version!==1||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>8||
    !Array.isArray(value.channels)||value.channels.length>100000||typeof value.autoUpdate!=='boolean'||
    value.lastUpdatedAt!==null&&(typeof value.lastUpdatedAt!=='string'||Number.isNaN(Date.parse(value.lastUpdatedAt)))||
    value.sources.some(source=>!source||!bounded(source.id,64)||!bounded(source.name,120)||!liveHttpUrl(source.playlistUrl)||
      source.metadataUrl!==null&&!liveHttpUrl(source.metadataUrl)))return false;
  const ids=new Set();
  for(const channel of value.channels){
    if(!channel||typeof channel.id!=='string'||!/^[a-f0-9]{32}$/.test(channel.id)||ids.has(channel.id)||
      !bounded(channel.name,250)||typeof channel.country!=='string'||!/^[A-Z]{2}$/.test(channel.country)||
      !Array.isArray(channel.categories)||!channel.categories.length||channel.categories.length>20||
      channel.categories.some(category=>!bounded(category,64))||
      channel.cover!==null&&!liveHttpUrl(channel.cover)||!Array.isArray(channel.lines)||!channel.lines.length||channel.lines.length>30||
      channel.lines.some(line=>!line||!liveHttpUrl(line.url)||!bounded(line.name,250)||typeof line.restricted!=='boolean')||
      typeof channel.enabled!=='boolean'||typeof channel.available!=='boolean')return false;
    ids.add(channel.id);
  }
  return true;
}
function privateFile(file,{catalog=false,limit=liveLimit}={}) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size<2||stat.size>limit)throw liveFailure();
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const read=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!read)throw liveFailure();offset+=read;}
    const after=fs.fstatSync(fd);
    if(after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw liveFailure();
    if(catalog){
      const value=JSON.parse(bytes.toString('utf8'));
      if(!validLiveCatalog(value))throw liveFailure();
    }
    return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch {throw liveFailure();}
  finally {if(fd!==undefined)fs.closeSync(fd);}
}
function optionalPrivateFile(file,options){
  try {fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw liveFailure();}
  return privateFile(file,options);
}
function pinnedFolder(directory,requirePrivate=false){
  let fd;
  try {
    fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if(!stat.isDirectory()||requirePrivate&&(stat.mode&0o077))throw liveFailure();
    return {fd,stat,path:process.platform==='linux'?`/proc/self/fd/${fd}`:directory};
  }catch{if(fd!==undefined)fs.closeSync(fd);throw liveFailure();}
}
function writePrivateBytes(file,bytes,owner){
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {
    fs.writeFileSync(fd,bytes);
    if(owner){
      if(process.getuid?.()===0)fs.fchownSync(fd,owner.uid,owner.gid);
      else if(process.getuid?.()!==owner.uid)throw liveFailure();
    }
    fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
}
export function backupLiveCatalog(dataDirectory,backupDirectory){
  const data=pinnedFolder(dataDirectory);let backup;
  try {
    backup=pinnedFolder(backupDirectory,true);
    const value=optionalPrivateFile(path.join(data.path,'live-tv.json'),{catalog:true});
    if(!value)return {present:false};
    writePrivateBytes(path.join(backup.path,'live-tv.json'),value.bytes);
    fs.fsyncSync(backup.fd);
    return {present:true,sha256:value.sha256};
  }finally{fs.closeSync(data.fd);if(backup)fs.closeSync(backup.fd);}
}
export function restoreLiveCatalog(dataDirectory,backupDirectory){
  const data=pinnedFolder(dataDirectory);let backup;
  try {
    backup=pinnedFolder(backupDirectory,true);
    const record=privateFile(path.join(backup.path,'backup.json'),{limit:65536});let metadata;
    try {metadata=JSON.parse(record.bytes.toString('utf8'));}catch{throw liveFailure();}
    const saved=metadata?.liveTv;
    if(metadata?.complete!==true||metadata.id!=='dbtv'||!saved||typeof saved.present!=='boolean')throw liveFailure();
    if(!saved.present){
      if(optionalPrivateFile(path.join(backup.path,'live-tv.json')))throw liveFailure();
      const target=path.join(data.path,'live-tv.json'),current=optionalPrivateFile(target);
      if(!current)return {restored:false};
      writePrivateBytes(path.join(backup.path,`live-tv-before-restore-${randomUUID()}.json`),current.bytes);
      fs.fsyncSync(backup.fd);
      fs.unlinkSync(target);fs.fsyncSync(data.fd);
      return {restored:true};
    }
    if(!/^[a-f0-9]{64}$/.test(saved.sha256||''))throw liveFailure();
    const snapshot=privateFile(path.join(backup.path,'live-tv.json'),{catalog:true});
    if(snapshot.sha256!==saved.sha256)throw liveFailure();
    const target=path.join(data.path,'live-tv.json');
    const current=optionalPrivateFile(target);
    if(current?.sha256===snapshot.sha256)return {restored:false};
    // Keep any version written during a failed launch for manual inspection.
    if(current){
      writePrivateBytes(path.join(backup.path,`live-tv-before-restore-${randomUUID()}.json`),current.bytes);
      fs.fsyncSync(backup.fd);
    }
    const temp=path.join(data.path,`.live-tv-restore-${randomUUID()}.tmp`);
    try {
      writePrivateBytes(temp,snapshot.bytes,data.stat);
      fs.renameSync(temp,target);
      fs.fsyncSync(data.fd);
    }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return {restored:true};
  }finally{fs.closeSync(data.fd);if(backup)fs.closeSync(backup.fd);}
}
export function save(home,state) {atomic(path.join(home,'deployment.json'),`${JSON.stringify(state,null,2)}\n`);}
export function read(home) {
  const file=path.join(home,'deployment.json');
  if(!fs.existsSync(file)) throw Error('此管理目录尚未安装大彪TV；不会自动接管其他目录的网站');
  if(fs.lstatSync(file).isSymbolicLink()||(fs.statSync(file).mode&0o077)) throw Error('管理配置权限不安全，请设为600');
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  if(state.version!==1||state.id!=='dbtv'||!['native','docker','termux','macos'].includes(state.mode)||!path.isAbsolute(state.source)||!path.isAbsolute(state.node)||!['127.0.0.1','0.0.0.0'].includes(state.bind)||state.mode==='macos'&&state.bind!=='127.0.0.1') throw Error('管理配置无效');
  portNumber(state.port);origin(state.origin);
  return state;
}
export function environment(home,state) {
  const data=state.mode==='docker'?'/app/data':path.join(home,'data');
  return {NODE_ENV:'production',HOST:state.bind,PORT:String(state.mode==='docker'?8787:state.port),DATABASE_PROVIDER:'sqlite',DATABASE_URL:`file:${data}/dabiao.db`,DBTV_DATA_DIR:data,NPM_CONFIG_CACHE:`${data}/npm-cache`,APP_ORIGIN:state.origin||'',COOKIE_SECURE:String(state.origin?.startsWith('https://')||false),INSTALL_TOKEN:'',INSTALL_TOKEN_LOG:'false'};
}
export function writeEnvironment(home,state) {
  atomic(path.join(home,'app.env'),Object.entries(environment(home,state)).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n');
}
export function addresses(state) {
  const local=`http://127.0.0.1:${state.port}`;
  const lan=state.bind==='0.0.0.0'?Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal&&x.family==='IPv4').map(x=>`http://${x.address}:${state.port}`):[];
  return {local,lan:[...new Set(lan)],domain:state.origin||null,publicIP:null};
}
export async function health(state,{timeout=2500,fetcher=fetch}={}) {
  const base=`http://127.0.0.1:${state.port}`;
  try {
    const response=await fetcher(`${base}/api/health`,{signal:AbortSignal.timeout(timeout),redirect:'error'});
    const value=await response.json();
    if(!response.ok||value.service!=='web-tvbox'||value.ok!==true) return {http:false,database:'unknown',installed:null};
    const status=await fetcher(`${base}/api/install/status`,{signal:AbortSignal.timeout(timeout),redirect:'error'});
    const setup=await status.json();
    return {http:true,database:status.ok&&setup.database?.connected?'connected':'unavailable',installed:status.ok?!!setup.installed:null,...typeof value.version==='string'?{version:value.version}:{},...typeof value.dataContract==='string'?{dataContract:value.dataContract}:{}};
  } catch {return {http:false,database:'unknown',installed:null};}
}
export function redact(text) {
  return String(text).replace(/首次安装令牌：\S+/g,'首次安装令牌：[已隐藏；请在本机查看 data/setup-token 文件]')
    .replace(/\b(?:mysql|postgres(?:ql)?):\/\/[^\s"']+/gi,'[数据库连接已隐藏]')
    .replace(/((?:password|token|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,'$1[已隐藏]');
}
export function compose(home,state) {
  if(state.image&&!/^(?:ghcr\.io\/dabiao996\/dbtv@)?sha256:[a-f0-9]{64}$/.test(state.image))throw Error('只允许镜像摘要，不允许任意镜像或可变标签');
  // JSON is a YAML 1.2 subset; no shell/YAML interpolation of user input.
  return JSON.stringify({services:{'dabiao-tv':{...state.image?{image:state.image}:{build:{context:state.source}},restart:'unless-stopped',env_file:[path.join(home,'app.env')],environment:{HOST:'0.0.0.0',PORT:'8787',DBTV_DATA_DIR:'/app/data'},ports:[`${state.bind}:${state.port}:8787`],volumes:[`${path.join(home,'data')}:/app/data`],logging:{driver:'local',options:{'max-size':'5m','max-file':'2'}}}}},null,2);
}
export function systemdUnit(home,state,user='dabiaotv') {
  const quote=value=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')}"`;
  return `[Unit]\nDescription=大彪TV\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nWorkingDirectory=${quote(state.source)}\nExecStart=${quote(state.node)} ${quote(path.join(state.source,'scripts/tv.mjs'))} serve --home ${quote(home)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}
