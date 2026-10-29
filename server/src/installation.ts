import type {Express} from 'express';
import type {PrismaClient} from '@prisma/client';
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync,unlinkSync,openSync,closeSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createAccount,validPassword} from './identity.js';

const tools=require('../../scripts/web-database.cjs');

// Replay only known read-only model operations. A timeout/disconnect can occur
// after a write committed, so retrying create/update (including increments),
// or raw SQL of unknown intent, can duplicate effects. Transaction failures
// P2028/P2034 belong to the caller's whole-transaction recovery policy, never
// to an individual query retry (membership has its own idempotent recovery).
const TRANSIENT_READ_CODES=new Set(['P1001','P1002','P1008','P2024']);
const READ_ONLY_MODEL_OPERATIONS=new Set(['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy']);
export function withTransientRetry(client:any){
  return client.$extends({
    name:'transient-retry',
    query:{
      async $allOperations({model,operation,args,query}:{model?:string;operation:string;args:any;query:(args:any)=>Promise<any>}){
        if(!model||!READ_ONLY_MODEL_OPERATIONS.has(operation))return query(args);
        let lastError:any;
        for(let attempt=0;attempt<3;attempt++){
          try{return await query(args);}
          catch(error:any){
            lastError=error;
            if(!TRANSIENT_READ_CODES.has(error?.code)||attempt===2)throw error;
            await new Promise(resolve=>setTimeout(resolve,40*(attempt+1)+Math.floor(Math.random()*30)));
          }
        }
        throw lastError;
      },
    },
  });
}
type Choice={provider:'sqlite'|'mysql'|'postgresql';url:string};
class SetupError extends Error {constructor(public status:number,message:string){super(message)}}
const fail=(status:number,message:string):never=>{throw new SetupError(status,message)};

export function validateDatabaseChoice(input:any,current:Choice,dataDirectory:string):Choice{
  if(!input||typeof input!=='object'||Array.isArray(input)||!['sqlite','mysql','postgresql'].includes(input.provider))return fail(400,'请选择 SQLite、MySQL 或 PostgreSQL');
  const fields=input.provider==='sqlite'?['provider']:['provider','host','port','database','username','password','ssl'];
  if(Object.keys(input).some(key=>!fields.includes(key)))return fail(400,'数据库配置包含不允许的字段；不能指定任意连接URL或本地文件路径');
  if(input.provider==='sqlite')return {provider:'sqlite',url:current.provider==='sqlite'?current.url:`file:${path.join(dataDirectory,'dabiao.db')}`};
  const {host,database,username,password}=input;
  const port=Number(input.port||(input.provider==='mysql'?3306:5432));
  if(typeof host!=='string'||!host||host.length>253||!/^([a-zA-Z0-9._-]+|\[[a-fA-F0-9:]+\])$/.test(host)||!Number.isInteger(port)||port<1||port>65535||typeof database!=='string'||!/^[a-zA-Z0-9_-]{1,63}$/.test(database)||typeof username!=='string'||!username||username.length>128||/[\x00-\x1f]/.test(username)||typeof password!=='string'||password.length>256||/[\x00\r\n]/.test(password)||input.ssl!==undefined&&typeof input.ssl!=='boolean')return fail(400,'数据库主机、端口、库名、用户名或密码格式不正确');
  if(input.provider==='mysql'&&input.ssl)return fail(400,'需要 MySQL 自定义TLS证书时，请通过服务器配置部署，不在网页上传证书');
  let url:URL;try{url=new URL(`${input.provider}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`);}catch{return fail(400,'数据库主机地址无效');}
  url.searchParams.set('connect_timeout','5');url.searchParams.set('pool_timeout','5');
  if(input.provider==='postgresql'){url.searchParams.set('schema','public');if(input.ssl)url.searchParams.set('sslmode','require');}
  return {provider:input.provider,url:url.toString()};
}

export function probeDatabase(choice:Choice,prepare:boolean,current:Choice,root=process.cwd()):Promise<void>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'scripts/web-database-worker.cjs')],{cwd:root,env:process.env,stdio:['pipe','pipe','pipe']});
    let output='',finished=false;const timeout=setTimeout(()=>{child.kill('SIGKILL');done(new SetupError(504,'数据库操作超时，未更换当前数据库，请检查网络后重试'));},90000);
    function done(error?:Error){if(finished)return;finished=true;clearTimeout(timeout);error?reject(error):resolve();}
    child.on('error',()=>done(new SetupError(500,'无法启动数据库检查进程')));
    child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>8192){child.kill('SIGKILL');done(new SetupError(500,'数据库检查返回异常'));}});
    child.stderr.on('data',()=>{}); // Prisma diagnostics can include credentials. Never relay them.
    child.on('close',code=>{if(finished)return;try{const result=JSON.parse(output);if(code!==0||!result.ok)return done(new SetupError(400,result.error||'数据库连接检查失败'));done();}catch{done(new SetupError(500,'数据库检查失败，请确认安装驱动完整'));}});
    child.stdin.end(JSON.stringify({...choice,prepare,allowCurrent:choice.provider===current.provider&&choice.url===current.url}));
  });
}

export function createInstallation(initial:Choice,deps:{hashPassword:(password:string)=>string;settings:Record<string,string>},root=process.cwd()){
  const directory=tools.stateDirectory(root),lockFile=path.join(directory,'installation.lock'),operationFile=path.join(directory,'installation-operation.lock');
  let choice:Choice=initial,current:any=withTransientRetry(new (tools.clientConstructor(initial.provider,root))({datasourceUrl:initial.url,log:[]}));
  const db=new Proxy({} as PrismaClient,{get(_target,key){const value=Reflect.get(current,key,current);return typeof value==='function'?value.bind(current):value;}});
  let installed=!!tools.readChoice(root)||existsSync(lockFile),connected=false,schemaReady=false,recovery=false,busy=false,token='';
  function markInstalled(){tools.privateDirectory(root);if(!existsSync(lockFile)){try{writeFileSync(lockFile,'installed\n',{mode:0o600,flag:'wx'});}catch(error:any){if(error.code!=='EEXIST')throw error;}}installed=true;}
  const ready=(async()=>{
    if(initial.provider==='sqlite'){
      const filename=initial.url.slice(5);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
      if(!existsSync(filename)){try{writeFileSync(filename,'',{flag:'wx',mode:0o600});}catch(error:any){if(error.code!=='EEXIST')throw error;}}
    }
    try{await current.$connect();connected=true;try{if(await current.user.count())markInstalled();else if(installed)recovery=true;schemaReady=true;}catch(error:any){if(error.code!=='P2021')throw error;if(installed)recovery=true;}}
    catch{recovery=true;connected=false;}
    if(installed&&!schemaReady)recovery=true;
    if(!installed&&!recovery){token=tools.installToken(root);console.log(process.env.INSTALL_TOKEN_LOG==='false'?'首次安装令牌已保存在私有数据目录的 setup-token 文件，请仅在本机查看并在 /install 输入。':`首次安装令牌：${token}\n请在 /install 输入此令牌选择数据库；不要公开或分享令牌。`);}
  })().catch(()=>{recovery=true;connected=false;});
  async function status(){
    await ready;
    // Another worker may have completed installation against a different connector.
    // Lock this process until restart instead of letting its stale bootstrap DB reopen setup.
    if(!installed&&(existsSync(tools.configFile(root))||existsSync(lockFile))){installed=true;recovery=true;}
    if(!installed&&schemaReady){try{if(await current.user.count())markInstalled();}catch{recovery=true;connected=false;}}
    return {installed,database:{provider:choice.provider,connected,configured:true,schemaReady,selectable:!installed&&!recovery},requiresSetupToken:!installed&&!recovery,recovery,busy,node:process.versions.node};
  }
  async function owner(req:any){
    const state=await status();if(state.installed)return fail(409,'系统已经完成安装，禁止再次选择数据库或初始化管理员');
    if(state.recovery)return fail(503,'现有数据库连接或表结构异常，安装入口已锁定；请检查服务器配置或恢复备份');
    const supplied=String(req.get('X-Install-Token')||'');
    if(!supplied||Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return fail(403,'安装令牌不正确，请从面板运行日志获取令牌');
  }
  async function exclusive<T>(work:()=>Promise<T>):Promise<T>{
    if(busy)return fail(409,'安装操作正在进行，请稍候');busy=true;let descriptor:number|undefined;
    try{tools.privateDirectory(root);try{descriptor=openSync(operationFile,'wx',0o600);}catch{return fail(409,'另一个安装进程正在操作；若服务曾异常退出，请管理员检查安装锁文件');}return await work();}
    finally{if(descriptor!==undefined){closeSync(descriptor);unlinkSync(operationFile);}busy=false;}
  }
  function register(app:Express){
    const handle=(callback:any)=>async(req:any,res:any)=>{res.setHeader('Cache-Control','no-store');try{await owner(req);await callback(req,res);}catch(error:any){if(!res.headersSent)res.status(error.status||500).json({error:error.status?error.message:'安装失败，未输出数据库凭证；请检查连接、写入权限和专用空数据库'});}};
    app.get('/api/install/status',async(_req,res)=>{res.setHeader('Cache-Control','no-store');try{res.json(await status());}catch{res.status(503).json({error:'安装状态检查失败，请检查私有数据目录权限'});}});
    app.post('/api/install/database/test',handle(async(req:any,res:any)=>{
      const candidate=validateDatabaseChoice(req.body,choice,directory);
      await exclusive(()=>probeDatabase(candidate,false,choice,root));
      res.json({ok:true,provider:candidate.provider,message:'连接正常，目标库检查通过；尚未保存配置或切换数据库'});
    }));
    app.post('/api/install',handle(async(req:any,res:any)=>{
      const username=typeof req.body?.username==='string'?req.body.username.trim():'';
      const password=req.body?.password,confirm=req.body?.confirmPassword;
      if(!/^[A-Za-z0-9_-]{3,32}$/.test(username))return fail(400,'管理员账号需为3–32位字母、数字、下划线或短横线');
      if(!validPassword(password))return fail(400,'管理员密码需为6–128位');if(password!==confirm)return fail(400,'两次输入的密码不一致');
      const candidate=req.body.database===undefined?choice:validateDatabaseChoice(req.body.database,choice,directory);
      const sessionToken=randomBytes(32).toString('hex');
      await exclusive(async()=>{
        await owner(req);await probeDatabase(candidate,true,choice,root);
        const Client=tools.clientConstructor(candidate.provider,root),target=new Client({datasourceUrl:candidate.url,log:[]});let savedId:string|undefined;
        try{
          await target.$transaction(async(tx:any)=>{
            if(await tx.user.count())return fail(409,'目标数据库已有账号，已停止安装');
            const user=await createAccount(tx,{username,passwordHash:deps.hashPassword(password),role:'admin',pageAccess:'home,sources,search,favorites,history,admin'});
            for(const [key,value] of Object.entries(deps.settings))await tx.setting.upsert({where:{key},update:{},create:{key,value}});
            await tx.setting.upsert({where:{key:'installationComplete'},update:{value:'true'},create:{key:'installationComplete',value:'true'}});
            await tx.session.create({data:{token:sessionToken,userId:user.id,expiresAt:new Date(Date.now()+30*24*60*60*1000)}});
            savedId=tools.writeChoice(candidate,root);
          },{timeout:15000,isolationLevel:'Serializable'});
        }catch(error){if(savedId)tools.rollbackChoice(savedId,root);await target.$disconnect();throw error;}
        const previous=current;current=withTransientRetry(target);choice=candidate;installed=true;connected=true;schemaReady=true;recovery=false;token='';
        // The durable database.json also locks reinstall if writing the secondary marker fails.
        try{markInstalled();}catch{}void previous.$disconnect().catch(()=>{});
      });
      res.setHeader('Set-Cookie',`webtv_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.secure||process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
      res.status(201).json({ok:true,provider:candidate.provider});
    }));
  }
  return {db,ready,status,register,get installed(){return installed},get available(){return connected&&!recovery}};
}
