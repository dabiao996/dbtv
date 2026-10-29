#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {randomUUID,createHash} from 'node:crypto';
import {APP,DEFAULT_PORT,portNumber,origin,available,choosePort,question,privateDirectory,atomic,secureCopy,backupLiveCatalog,read,save,environment,writeEnvironment,addresses,health,redact,compose,systemdUnit} from './tv/core.mjs';
import releases from './releases.cjs';
import * as updates from './tv/updates.mjs';
import {createDriver} from './tv/update-driver.mjs';

const entry=fileURLToPath(import.meta.url);
const say=message=>process.stderr.write(`${message}\n`);
const shellQuote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
function options(args) {
  const opts={};const values=new Set(['home','source','mode','node','port','bind','origin','version','record']);
  const flags=new Set(['json','yes','dry-run']);
  for(let i=0;i<args.length;i++) {
    const key=args[i].replace(/^--/,'');
    if(!args[i].startsWith('--')||!values.has(key)&&!flags.has(key)) throw Error(`不支持的参数：${args[i]}`);
    if(values.has(key)) {if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`--${key} 缺少值`);opts[key]=args[++i];}
    else opts[key]=true;
  }
  return opts;
}
function execute(command,args=[],{cwd,env={},capture=false,allowFailure=false}={}) {
  const result=spawnSync(command,args,{cwd,env:{...process.env,...env},encoding:'utf8',stdio:capture?'pipe':['inherit',2,2],maxBuffer:8*1024*1024});
  if(!allowFailure&&(result.error||result.status!==0)) throw Error(`操作失败：${path.basename(command)}（${result.status??'无法执行'}）；未自动删除数据`);
  return capture?{ok:!result.error&&result.status===0,text:result.stdout||''}:result;
}
function composeArgs(home) {return ['compose','--project-name',`dbtv-${createHash('sha256').update(home).digest('hex').slice(0,12)}`,'--file',path.join(home,'compose.json')];}
function docker(home,args,opts={}) {return execute('docker',[...composeArgs(home),...args],opts);}
function application(home,state,command,args=[],opts={}) {
  const env={...environment(home,state),PATH:`${path.dirname(state.node)}:${process.env.PATH}`,...opts.env};
  if(state.mode==='termux') {
    const pairs=Object.entries(env).filter(([key])=>key!=='PATH').map(([key,value])=>`${key}=${value}`);
    return execute('proot-distro',['login','dbtv','--bind',`${home}:${home}`,'--','/bin/sh','-c',`cd ${shellQuote(state.source)} && exec /usr/bin/env ${[`PATH=${path.dirname(state.node)}:/usr/local/bin:/usr/bin:/bin`,...pairs,command,...args].map(shellQuote).join(' ')}`],{...opts,cwd:state.source});
  }
  if(process.getuid?.()===0&&state.mode==='native') return execute('runuser',['-u','dabiaotv','--',command,...args],{...opts,cwd:state.source,env});
  return execute(command,args,{...opts,cwd:state.source,env});
}
function npmPath(state) {return path.resolve(path.dirname(state.node),'../lib/node_modules/npm/bin/npm-cli.js');}
function requireRoot(state) {if(state.mode==='native'&&(process.platform!=='linux'||process.getuid?.()!==0))throw Error('Linux 原生管理需要 root 权限和 systemd；请使用 sudo，或选择 Docker');}
function service(home,state,action,{allowFailure=false}={}) {
  if(state.mode==='docker') {
    if(action==='stop')return docker(home,['stop'],{allowFailure});
    return docker(home,['up','-d','--no-build','--force-recreate'],{allowFailure});
  }
  if(state.mode==='termux') {
    const directory=path.join(process.env.PREFIX,'var/service/dabiao-tv');
    if(action==='start'&&fs.existsSync(path.join(directory,'down')))fs.unlinkSync(path.join(directory,'down'));
    return execute('sv',[action==='restart'?'restart':action==='start'?'up':'down',directory],{allowFailure});
  }
  requireRoot(state);return execute('systemctl',[action,'dabiao-tv-managed.service'],{allowFailure});
}
function processRunning(home,state) {
  if(state.mode==='docker')return docker(home,['ps','--status','running','--quiet'],{capture:true,allowFailure:true}).text.trim().length>0;
  if(state.mode==='termux')return execute('sv',['status',path.join(process.env.PREFIX,'var/service/dabiao-tv')],{capture:true,allowFailure:true}).text.startsWith('run:');
  return execute('systemctl',['is-active','--quiet','dabiao-tv-managed.service'],{capture:true,allowFailure:true}).ok;
}
async function waitHealthy(home,state) {
  for(let i=0;i<90;i++) {
    const status=await health(state);
    if(status.http) {if(status.database!=='connected')throw Error('网站已响应，但数据库未连接；请检查配置，未声明安装成功');return status;}
    if(i>3&&!processRunning(home,state))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('启动健康检查未通过；请查看日志。配置和数据已保留，可修复后重试 start');
}
async function status(home,state) {
  const running=processRunning(home,state),checks=await health(state);
  // Never attribute a different process on this port to our managed application.
  return {...APP,home,mode:state.mode,port:state.port,bind:state.bind,running,...checks,healthy:running&&checks.http&&checks.database==='connected',...addresses(state),domainVerified:false};
}
function showStatus(value,json) {
  if(json) {console.log(JSON.stringify(value));return;}
  console.log(`大彪TV：${value.running?'运行中':'未运行'}\n网站检查：${value.http?'正常':'未响应'}\n数据库：${value.database}\n端口：${value.port}\n本机：${value.local}`);
  value.lan.forEach(url=>console.log(`局域网候选地址：${url}`));
  if(value.domain)console.log(`已设置域名：${value.domain}（DNS / 反代 / 证书需另行验证）`);
  console.log(`管理目录：${value.home}\n${value.installed===false?'首次安装：打开 /install；令牌仅在本机 data/setup-token 文件中查看。':''}`);
}
function managerFiles(home,state) {
  writeEnvironment(home,state);
  if(state.mode==='docker')atomic(path.join(home,'compose.json'),compose(home,state));
}
function persist(home,state) {
  managerFiles(home,state);save(home,state);
  if(state.mode==='native'&&process.getuid?.()===0) {
    // The service reads a private copy; the root management entry/config stay root-owned.
    save(path.join(home,'data'),state);
    execute('chown',['dabiaotv:dabiaotv',path.join(home,'data/deployment.json')]);
  }
}
function protectNative(home,state) {
  // An application compromise must not be able to rewrite the root-run management adapter.
  execute('chown',['-R','root:root',home]);
  execute('chmod',['755',home]);
  execute('chmod',['-R','a+rX',path.join(home,'app'),path.join(home,'tools')]);
  for(const directory of ['data','app/.generated','app/node_modules'])execute('chown',['-R','dabiaotv:dabiaotv',path.join(home,directory)]);
}
function registerService(home,state) {
  if(state.mode==='docker')return;
  if(state.mode==='termux') {
    const directory=path.join(process.env.PREFIX,'var/service/dabiao-tv');
    if(fs.existsSync(directory))throw Error('Termux 已有同名服务，拒绝覆盖；请先核对服务来源');
    privateDirectory(directory);fs.writeFileSync(path.join(directory,'down'),'');
    atomic(path.join(directory,'run'),`#!${process.env.PREFIX}/bin/sh\n# Managed by dbtv\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} serve --home ${shellQuote(home)}\n`,0o700);
    return;
  }
  const file='/etc/systemd/system/dabiao-tv-managed.service';
  if(fs.existsSync(file))throw Error('已有同名 systemd 服务，拒绝覆盖');
  atomic(file,`# Managed by dbtv\n${systemdUnit(home,state)}`,0o644);
  execute('systemctl',['daemon-reload']);execute('systemctl',['enable','dabiao-tv-managed.service']);
}
async function backup(home,state,{offline=false}={}) {
  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),id=randomUUID();
  const target=path.join(home,'backups',`${stamp}-${id.slice(0,8)}`);
  privateDirectory(path.dirname(target));
  if(process.getuid?.()===0){fs.chownSync(path.dirname(target),0,0);fs.chmodSync(path.dirname(target),0o700);}
  privateDirectory(target);
  const scratch=path.join(home,'data',`.snapshot-${id}`);
  let directoryFD;
  try {
    if(state.mode==='docker') {
      if(offline){
        // Pin backup to the OLD local image, not a rebuilt/mutable tag.
        persist(home,state);
        docker(home,['run','--rm','--no-deps','--entrypoint','node','-e',`BACKUP_DIR=/app/data/.snapshot-${id}`,'dabiao-tv','scripts/backup-database.mjs']);
      }else docker(home,['exec','-T','-e',`BACKUP_DIR=/app/data/.snapshot-${id}`,'dabiao-tv','node','scripts/backup-database.mjs']);
    } else {
      privateDirectory(scratch);if(state.mode==='native')execute('chown',['dabiaotv:dabiaotv',scratch]);
      application(home,state,state.node,[path.join(state.source,'scripts/backup-database.mjs')],{env:{BACKUP_DIR:scratch}});
    }
    // Pin the source directory. Never copy through a web-writable symlink into root files.
    directoryFD=fs.openSync(scratch,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    const pinned=process.platform==='linux'?`/proc/self/fd/${directoryFD}`:scratch;
    const snapshots=fs.readdirSync(pinned);
    if(snapshots.length!==1||!/^dabiao-.*\.db$/.test(snapshots[0]))throw Error('未获得唯一SQLite快照，禁止把空目录当成功备份');
    secureCopy(path.join(pinned,snapshots[0]),path.join(target,snapshots[0]));
    const snapshotFD=fs.openSync(path.join(target,snapshots[0]),'r');
    try{const header=Buffer.alloc(16);fs.readSync(snapshotFD,header,0,16,0);if(header.toString('binary')!=='SQLite format 3\0')throw Error('备份不是有效SQLite文件');}finally{fs.closeSync(snapshotFD);}
    for(const filename of ['database.json','installation.lock','setup-token']) {
      const source=path.join(home,'data',filename);
      if(fs.existsSync(source))secureCopy(source,path.join(target,filename));
    }
    secureCopy(path.join(home,'deployment.json'),path.join(target,'deployment.json'));
    secureCopy(path.join(home,'app.env'),path.join(target,'app.env'));
    const liveTv=backupLiveCatalog(path.join(home,'data'),target);
    for(const filename of fs.readdirSync(target))fs.chmodSync(path.join(target,filename),0o600);
    const record=path.join(target,'backup.json');
    atomic(record,JSON.stringify({version:1,id:'dbtv',createdAt:new Date().toISOString(),complete:true,liveTv}));
    const marker=fs.openSync(record,'r');try{fs.fsyncSync(marker);}finally{fs.closeSync(marker);}
    const backupDirectory=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{fs.fsyncSync(backupDirectory);}finally{fs.closeSync(backupDirectory);}
    return target;
  } catch(error) {throw Error(`${error.message}；此备份未完成，不可用于恢复。外部数据库请用面板/官方备份工具，并另存 data 私有配置`);}
  finally {if(directoryFD!==undefined)fs.closeSync(directoryFD);if(fs.existsSync(scratch)&&!fs.lstatSync(scratch).isSymbolicLink())fs.rmSync(scratch,{recursive:true});}
}
async function serve(home,state) {
  // Called by systemd/runit, not a PID-file background daemon. Never expose setup tokens in logs.
  const env={...process.env,...environment(home,state),PATH:`${path.dirname(state.node)}:${process.env.PATH}`};
  let command=state.node,args=[npmPath(state),'start'];
  if(state.mode==='termux') {
    command='proot-distro';args=['login','dbtv','--bind',`${home}:${home}`,'--','/usr/bin/env',`PATH=${path.dirname(state.node)}:/usr/local/bin:/usr/bin:/bin`,...Object.entries(environment(home,state)).map(([key,value])=>`${key}=${value}`),'/bin/sh','-c',`cd ${shellQuote(state.source)} && exec ${shellQuote(state.node)} ${shellQuote(npmPath(state))} start`];
  }
  const log=path.join(home,'service.log');
  let fd;
  if(state.mode==='termux') {
    if(fs.existsSync(log)&&fs.statSync(log).size>2*1024*1024)fs.renameSync(log,`${log}.1`);
    fd=fs.openSync(log,'a',0o600);
  }
  const emit=text=>{
    const value=redact(text);
    if(fd!==undefined){
      if(fs.fstatSync(fd).size+Buffer.byteLength(value)>2*1024*1024){fs.closeSync(fd);fs.renameSync(log,`${log}.1`);fd=fs.openSync(log,'w',0o600);}
      fs.writeSync(fd,value);
    }else process.stdout.write(value);
  };
  const child=spawn(command,args,{cwd:state.source,env,stdio:['ignore','pipe','pipe']});
  // Buffer whole lines so a split secret cannot bypass redaction.
  for(const stream of [child.stdout,child.stderr]) {
    let pending='';stream.setEncoding('utf8');stream.on('data',data=>{
      pending+=data;let end;while((end=pending.indexOf('\n'))>=0){emit(pending.slice(0,end+1));pending=pending.slice(end+1);}
      if(pending.length>65536){pending='';emit('[过长日志已省略]\n');}
    });stream.on('end',()=>{if(pending)emit(pending);});
  }
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
  child.on('error',()=>{emit('服务启动失败，请检查运行环境\n');process.exitCode=1;});
  await new Promise(resolve=>child.on('close',code=>{if(fd!==undefined)fs.closeSync(fd);process.exitCode=code??1;resolve();}));
}
async function main() {
  const command=process.argv[2]||'menu',opts=options(process.argv.slice(3));
  const termux=!!process.env.PREFIX?.includes('com.termux');
  const home=path.resolve(opts.home||process.env.DBTV_HOME||(termux?path.join(os.homedir(),'.local/share/dabiao-tv'):'/opt/dabiao-tv'));
  if(/[:\r\n\0]/.test(home)||['/','/opt','/usr','/var','/var/lib','/home','/root','/tmp',os.homedir()].includes(home)||home===path.resolve(path.dirname(entry),'..')&&fs.existsSync(path.join(home,'package.json')))throw Error('请使用专用管理目录，不得使用源码根目录、系统根目录或整个用户目录');
  let rl;
  const ask=async text=>{
    if(opts.yes||!process.stdin.isTTY)throw Error('非交互执行必须提供完整参数，例如 --port 8787 --origin https://tv.example.com');
    rl??=createInterface({input:process.stdin,output:process.stderr});return question(rl,text);
  };
  const confirm=async message=>{if(!opts.yes&&(await ask(`${message} [y/N]：`)).toLowerCase()!=='y')throw Error('操作已取消');};
  let locked=false;
  try {
    if(command==='help') {
      console.log('大彪TV 独立管理适配器\n命令：install / start / stop / restart / status / port / domain / backup / logs / doctor\n更新：check-update / enable-updates / update --version X.Y.Z / rollback --record ID / update-history / update-worker\n参数：--home DIR --port NUMBER --bind 127.0.0.1|0.0.0.0 --origin URL --mode native|docker|termux --yes --json --dry-run\n默认端口8787；安装使用 bash scripts/install.sh。domain 只设置应用来源，不修改 DNS/Nginx/证书。');return;
    }
    if(command==='describe'){console.log(JSON.stringify(APP));return;}
    if(command==='doctor') {
      const value={...APP,platform:process.platform,arch:process.arch,node:process.versions.node,termux,home,installed:fs.existsSync(path.join(home,'deployment.json')),docker:execute('docker',['compose','version'],{capture:true,allowFailure:true}).ok,systemd:fs.existsSync('/run/systemd/system')};
      console.log(opts.json?JSON.stringify(value):JSON.stringify(value,null,2));return;
    }
    if(command==='menu') {
      for(;;) {
        say('\n大彪TV\n1. 查看状态\n2. 启动\n3. 停止\n4. 重启\n5. 修改端口\n6. 设置域名\n7. SQLite备份\n8. 查看日志\n9. 检查正式版更新\n10. 更新/回退记录\n0. 退出');
        const value=await ask('请选择：');if(value==='0')return;
        const action={'1':'status','2':'start','3':'stop','4':'restart','5':'port','6':'domain','7':'backup','8':'logs','9':'check-update','10':'update-history'}[value];
        if(action)execute(process.execPath,[entry,action,'--home',home],{allowFailure:true});
      }
    }
    if(command==='serve'){await serve(home,read(process.getuid?.()===0||termux?home:path.join(home,'data')));return;}
    if(command==='check-update'){
      const state=read(home),key=releases.publicKey(state.source),remote=await releases.release({key});
      console.log(JSON.stringify({current:state.release||releases.current(state.source),latest:remote.manifest.version,url:remote.url,notes:remote.notes}));return;
    }
    if(command==='update-history'){console.log(JSON.stringify(updates.history(home).map(x=>({id:x.id,version:x.previous.release.version,at:x.at,state:x.state,hasBackup:!!x.backup})),null,opts.json?0:2));return;}
    if(!['install','start','stop','restart','status','port','domain','backup','logs','enable-updates','update-worker','update','rollback'].includes(command))throw Error('未知命令，请查看 help');
    if(command==='status') {const value=await status(home,read(home));showStatus(value,opts.json);if(!value.healthy)process.exitCode=3;return;}
    if(command==='logs') {
      const state=read(home);
      const result=state.mode==='docker'?docker(home,['logs','--tail','100'],{capture:true,allowFailure:true}):state.mode==='native'?execute('journalctl',['-u','dabiao-tv-managed.service','-n','100','--no-pager'],{capture:true,allowFailure:true}):{text:fs.existsSync(path.join(home,'service.log'))?fs.readFileSync(path.join(home,'service.log'),'utf8').slice(-32768):'暂无日志'};
      console.log(opts.json?JSON.stringify({logs:redact(result.text)}):redact(result.text));return;
    }
    if(opts['dry-run']) {
      if(!['install','port'].includes(command))throw Error('此命令不支持dry-run；请先查看check-update和update-history');
      if(opts.bind&&!['127.0.0.1','0.0.0.0'].includes(opts.bind))throw Error('监听地址只能是127.0.0.1或0.0.0.0');
      const port=await choosePort({value:opts.port,host:opts.bind||'127.0.0.1',ask,report:say});
      console.log(JSON.stringify({...APP,action:command,dryRun:true,home,port,origin:origin(opts.origin||''),mode:opts.mode||'native',bind:opts.bind||'127.0.0.1'}));return;
    }
    privateDirectory(home);
    try{fs.writeFileSync(path.join(home,'operation.lock'),String(process.pid),{flag:'wx',mode:0o600});locked=true;}catch{throw Error('另一个管理操作正在执行；异常中断后请先核实进程，再处理 operation.lock，不会自动抢锁');}
    if(command==='install') {
      if(fs.existsSync(path.join(home,'deployment.json'))) {say('检测到已有部署，未重装、未覆盖数据。');showStatus(await status(home,read(home)),opts.json);return;}
      const mode=opts.mode||(termux?'termux':'native');
      if(!['native','docker','termux'].includes(mode))throw Error('不支持的安装方式');
      const bind=opts.bind||(mode==='termux'?'0.0.0.0':'127.0.0.1');
      if(!['127.0.0.1','0.0.0.0'].includes(bind))throw Error('监听地址只能是127.0.0.1或0.0.0.0');
      const port=await choosePort({value:opts.port,host:bind,ask,report:say});
      const domain=origin(opts.origin!==undefined?opts.origin:opts.yes?'':await ask('访问域名（可留空，以后设置）：'));
      const state={version:1,id:'dbtv',mode,bind,port,origin:domain,source:path.resolve(opts.source||path.join(home,'app')),node:path.resolve(opts.node||process.execPath),createdAt:new Date().toISOString()};
      if(state.source!==path.join(home,'app'))throw Error('自动安装仅接受管理目录下的 app 源码，避免接管现有站点；请使用 install.sh');
      requireRoot(state);
      if(mode==='termux'&&!termux)throw Error('termux 模式必须在 Termux 宿主执行');
      if(mode==='native'&&!fs.existsSync('/run/systemd/system'))throw Error('未检测到运行中的 systemd；面板/容器请使用 Docker 或手动部署');
      if(!fs.existsSync(path.join(state.source,'package-lock.json')))throw Error('缺少源码或锁文件，请先运行 install.sh');
      if(mode==='native'&&fs.existsSync('/etc/systemd/system/dabiao-tv-managed.service')||mode==='termux'&&fs.existsSync(path.join(process.env.PREFIX,'var/service/dabiao-tv')))throw Error('已有同名管理服务，拒绝接管或覆盖；请先确认已有部署位置');
      if(fs.existsSync(path.join(state.source,'.env'))||fs.existsSync(path.join(state.source,'prisma/dev.db')))throw Error('发现已有私有配置或数据库，拒绝当成新站覆盖；请先备份并按文档迁移');
      await confirm(`安装到 ${home}，端口 ${port}，方式 ${mode}，将创建专属服务；不更改防火墙或现有反代`);
      privateDirectory(path.join(home,'data'));managerFiles(home,state);
      if(mode==='native') {
        const identity=execute('id',['-u','dabiaotv'],{capture:true,allowFailure:true});
        if(!identity.ok)execute('useradd',['--system','--user-group','--home-dir',home,'--shell','/usr/sbin/nologin','dabiaotv']);
        else if(Number(identity.text.trim())===0)throw Error('专用服务账号不能具有root身份');
        execute('chown',['-R','dabiaotv:dabiaotv',home]);
      }
      if(mode==='docker')docker(home,['build']);
      else {
        application(home,state,state.node,[npmPath(state),'ci','--ignore-scripts','--no-audit','--no-fund']);
        application(home,state,state.node,[npmPath(state),'run','build']);
        application(home,state,state.node,[npmPath(state),'cache','clean','--force']);
      }
      // A second check catches another app claiming the port during a lengthy build.
      if(!await available(port,bind))throw Error(`构建期间端口 ${port} 被其他程序占用；未抢占，请换端口重试`);
      registerService(home,state);persist(home,state);
      if(mode==='native')protectNative(home,state);
      if(mode==='termux') {
        say('正在唤醒 Termux 服务管理器；Android 可能仍需允许后台运行。');
        execute('sh',[path.join(process.env.PREFIX,'etc/profile.d/start-services.sh')],{allowFailure:true});
      }
      service(home,state,'start');await waitHealthy(home,state);
      showStatus(await status(home,state),opts.json);return;
    }
    const state=read(home);requireRoot(state);
    if(['enable-updates','update-worker','update','rollback'].includes(command)){
      if(command==='enable-updates'){
        await confirm('启用独立更新代理；允许后台经管理员确认后安装签名正式版，SQLite先停站备份，不授予网页root或Docker socket');
        const key=releases.publicKey(state.source);if(!key)throw Error('请先配置发行公钥，不能启用不可信更新');
        if(state.mode!=='termux'&&(process.platform!=='linux'||process.getuid?.()!==0||!fs.existsSync('/run/systemd/system')))throw Error('更新代理需要Linux root/systemd；Termux使用独立runit服务');
        const agentNode=state.mode==='termux'?process.execPath:path.join(home,'tools/node/bin/node');
        if(state.mode!=='termux'&&(!fs.existsSync(agentNode)||fs.statSync(agentNode).uid!==0||(fs.statSync(agentNode).mode&0o022)))throw Error('代理必须使用安装目录中root持有的私有Node，拒绝使用用户可修改的运行环境');
        if(state.mode==='termux'?fs.existsSync(path.join(process.env.PREFIX,'var/service/dabiao-tv-updates')):fs.existsSync('/etc/systemd/system/dbtv-updater.service')||fs.existsSync('/etc/systemd/system/dbtv-updater.timer'))throw Error('已有同名更新代理，拒绝覆盖，请先核对来源');
        const controller=path.join(home,'manager');privateDirectory(controller);
        for(const file of ['tv.mjs','releases.cjs'])fs.copyFileSync(path.join(path.dirname(entry),file),path.join(controller,file));
        privateDirectory(path.join(controller,'tv'));
        for(const file of ['core.mjs','updates.mjs','update-driver.mjs'])fs.copyFileSync(path.join(path.dirname(entry),'tv',file),path.join(controller,'tv',file));
        const agentEntry=path.join(controller,'tv.mjs');
        updates.enable(home,key);
        const directory=updates.publicStatus(home,{enabled:false,currentContract:(state.release||releases.current(state.source)).dataContract});
        const driver=createDriver(home,{execute,docker,application,npmPath,processRunning,service,backup,persist,waitHealthy,key,mode:state.mode});await driver.permissions(directory);
        if(state.mode==='termux'){
          const dir=path.join(process.env.PREFIX,'var/service/dabiao-tv-updates');if(fs.existsSync(dir))throw Error('已有同名更新代理，拒绝覆盖');privateDirectory(dir);
          atomic(path.join(dir,'run'),`#!${process.env.PREFIX}/bin/sh\nwhile true; do\n${shellQuote(agentNode)} ${shellQuote(agentEntry)} update-worker --home ${shellQuote(home)}\nsleep 10\ndone\n`,0o700);
          execute('sv',['up',dir]);
        }else{
          const base='/etc/systemd/system/dbtv-updater';
          if(fs.existsSync(`${base}.service`)||fs.existsSync(`${base}.timer`))throw Error('已有同名更新代理，拒绝覆盖，请先核对来源');
          const quote=value=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')}"`;
          atomic(`${base}.service`,`[Unit]\nDescription=大彪TV受限更新代理\n[Service]\nType=oneshot\nUMask=0077\nExecStart=${quote(agentNode)} ${quote(agentEntry)} update-worker --home ${quote(home)}\nTimeoutStartSec=1800\n`,0o644);
          atomic(`${base}.timer`,'[Unit]\nDescription=大彪TV更新队列\n[Timer]\nOnBootSec=20s\nOnUnitInactiveSec=10s\n[Install]\nWantedBy=timers.target\n',0o644);
          execute('systemctl',['daemon-reload']);execute('systemctl',['enable','--now','dbtv-updater.timer']);
        }
        updates.publicStatus(home,{currentContract:(state.release||releases.current(state.source)).dataContract});await driver.permissions(directory);
        console.log(opts.json?JSON.stringify({ok:true,enabled:true}):'已启用独立更新代理；只接受签名正式版和已记录的兼容回退。');return;
      }
      const key=updates.policy(home).publicKey,driver=createDriver(home,{execute,docker,application,npmPath,processRunning,service,backup,persist,waitHealthy,key,mode:state.mode});
      if(command==='update-worker'){
        const result=await updates.consume(home,state,driver);if(result.state!=='idle')console.log(JSON.stringify(result));return;
      }
      const target=command==='update'?opts.version:opts.record;if(!target)throw Error(command==='update'?'请提供--version正式版本号':'请提供--record回退记录ID');
      await confirm(command==='update'?`更新至${target}，将短暂停站并备份数据库`:'仅回退程序，不恢复旧数据库；只允许数据兼容记录');
      const result=await updates.processUpdate(home,state,{id:randomUUID(),action:command==='update'?'update':'rollback',target,createdAt:new Date().toISOString(),actor:0},driver);
      console.log(JSON.stringify(result));if(result.state!=='complete')process.exitCode=1;return;
    }
    if(command==='backup'){const target=await backup(home,state);console.log(opts.json?JSON.stringify({ok:true,path:target}):`备份完成：${target}（含私有配置，勿上传）`);return;}
    if(command==='stop'){service(home,state,'stop');if(opts.json)console.log(JSON.stringify({ok:true,action:'stop'}));return;}
    if(command==='start'||command==='restart') {
      const running=processRunning(home,state);
      if(command==='start'&&running){const current=await status(home,state);if(!current.healthy)throw Error('服务进程正在运行但健康检查失败，请查看日志，不会重复启动');showStatus(current,opts.json);return;}
      if(!running&&!await available(state.port,state.bind))throw Error(`端口 ${state.port} 已被其他程序占用；请用 port 命令修改，未停止其他服务`);
      service(home,state,command);await waitHealthy(home,state);showStatus(await status(home,state),opts.json);return;
    }
    const next={...state};
    if(command==='port') {
      const value=opts.port!==undefined?portNumber(opts.port):(await ask(`新端口 [${state.port}]：`)).trim()||state.port;
      if(Number(value)===state.port){say('端口未改变。');showStatus(await status(home,state),opts.json);return;}
      next.port=await choosePort({value:opts.port!==undefined?value:undefined,initial:opts.port===undefined?value:undefined,defaultPort:state.port,host:state.bind,ask,report:say});
    } else next.origin=origin(opts.origin!==undefined?opts.origin:await ask('域名或完整 http(s) 来源，留空清除：'));
    await confirm('保存新配置；正在运行的网站将短暂重启。请同步修改面板反向代理');
    const running=processRunning(home,state);
    try {
      // Do not stop the old service until validation and the initial conflict check have passed.
      if(running)service(home,state,'stop');
      if(command==='port'&&!await available(next.port,next.bind))throw Error('目标端口刚被其他程序占用，取消修改');
      persist(home,next);
      if(running){service(home,next,'start');await waitHealthy(home,next);}
    } catch(error) {
      service(home,next,'stop',{allowFailure:true});persist(home,state);
      if(running)service(home,state,'start',{allowFailure:true});
      throw Error(`${error.message}；已恢复原配置，请检查原服务状态`);
    }
    showStatus(await status(home,next),opts.json);
  } finally {rl?.close();if(locked)fs.unlinkSync(path.join(home,'operation.lock'));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry)main().catch(error=>{const message=redact(error.message);if(process.argv.includes('--json'))console.log(JSON.stringify({ok:false,error:message,code:error.code||'FAILED'}));else say(message);process.exitCode=error.code==='PORT_IN_USE'?2:1;});
