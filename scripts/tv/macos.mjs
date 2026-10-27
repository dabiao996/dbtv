import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export const macLabel=(home,kind)=>`com.dabiaotv.${createHash('sha256').update(path.resolve(home)).digest('hex').slice(0,16)}.${kind}`;
export const macTarget=(home,kind)=>`gui/${process.getuid()}/${macLabel(home,kind)}`;
export const macAgentFile=(home,kind,agentsDirectory=path.join(os.homedir(),'Library','LaunchAgents'))=>path.join(agentsDirectory,`${macLabel(home,kind)}.plist`);
export function macPlist(home,state,kind,entry){
  if(!['app','updates'].includes(kind)||state.bind!=='127.0.0.1')throw Error('macOS 托管站只允许本机回环地址');
  const args=kind==='app'?[state.node,entry,'serve','--home',home]:[state.node,entry,'update-worker','--home',home];
  const argumentsXML=args.map(value=>`    <string>${escape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${macLabel(home,kind)}</string>\n  <key>ProgramArguments</key><array>\n${argumentsXML}\n  </array>\n  <key>WorkingDirectory</key><string>${escape(kind==='app'?state.source:home)}</string>\n  <key>RunAtLoad</key><true/>\n  ${kind==='app'?'<key>KeepAlive</key><true/>':'<key>StartInterval</key><integer>10</integer>'}\n</dict>\n</plist>\n`;
}
function agentDirectory(file){
  const directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o022))throw Error('用户级 LaunchAgents 目录权限不安全');
}
function writeAgent(file,text,{exclusive=false}={}){
  agentDirectory(file);
  if(fs.existsSync(file)){
    const stat=fs.lstatSync(file);
    if(exclusive||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o022))throw Error('已有同名 LaunchAgent 或权限不安全，拒绝覆盖');
  }
  const temp=`${file}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function registerMacApp(home,state,{agentsDirectory}={}){
  writeAgent(macAgentFile(home,'app',agentsDirectory),macPlist(home,state,'app',path.join(state.source,'scripts/tv.mjs')),{exclusive:true});
}
export function macRunning(home,kind,execute){
  const result=execute('launchctl',['print',macTarget(home,kind)],{capture:true,allowFailure:true});
  return result.ok&&/\bpid = [1-9][0-9]*\b/.test(result.text);
}
export function macService(home,state,action,execute,{allowFailure=false,agentsDirectory}={}){
  const target=macTarget(home,'app'),file=macAgentFile(home,'app',agentsDirectory);
  if(action==='stop'||action==='restart')execute('launchctl',['bootout',target],{allowFailure});
  if(action==='start'||action==='restart'){
    writeAgent(file,macPlist(home,state,'app',path.join(state.source,'scripts/tv.mjs')));
    execute('launchctl',['bootstrap',`gui/${process.getuid()}`,file],{allowFailure});
  }
}
export function enableMacAgent(home,state,entry,execute,{agentsDirectory}={}){
  const file=macAgentFile(home,'updates',agentsDirectory);
  writeAgent(file,macPlist(home,state,'updates',entry),{exclusive:true});
  execute('launchctl',['bootstrap',`gui/${process.getuid()}`,file]);
}
