// Shared by the CLI and first-install HTTP service. Never send these files to a browser.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const stateDirectory=(root=process.cwd(),env=process.env)=>path.resolve(env.DBTV_DATA_DIR||path.join(root,'data'));
const configFile=(root=process.cwd(),env=process.env)=>path.join(stateDirectory(root,env),'database.json');
function privateDirectory(root=process.cwd(),env=process.env){
  const directory=stateDirectory(root,env);
  if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('安装数据目录不能是符号链接，请指定真实目录');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});return directory;
}
function readPrivate(file){
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077))throw Error('安装配置权限无效，请将私有文件权限设为600');
  return fs.readFileSync(file,'utf8');
}
function readChoice(root=process.cwd(),env=process.env){
  const file=configFile(root,env);if(!fs.existsSync(file))return null;
  let value;try{value=JSON.parse(readPrivate(file));}catch{throw Error('数据库安装配置无法读取，请检查私有文件权限或恢复备份');}
  if(value.version!==1||value.complete!==true||!['sqlite','mysql','postgresql'].includes(value.provider)||typeof value.url!=='string')throw Error('数据库安装配置无效，请恢复备份');
  return value;
}
function writeChoice(choice,root=process.cwd(),env=process.env){
  privateDirectory(root,env);const file=configFile(root,env);
  // This file is created only once; an existing completed installation must never be overwritten.
  const value={version:1,complete:true,id:crypto.randomUUID(),provider:choice.provider,url:choice.url};
  const temporary=path.join(stateDirectory(root,env),`.database-${value.id}.tmp`);
  try{fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.linkSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return value.id;
}
function rollbackChoice(id,root=process.cwd(),env=process.env){
  const file=configFile(root,env);if(fs.existsSync(file)&&readChoice(root,env)?.id===id)fs.unlinkSync(file);
}
function installToken(root=process.cwd(),env=process.env){
  if(env.INSTALL_TOKEN){if(env.INSTALL_TOKEN.length<32||env.INSTALL_TOKEN.length>256)throw Error('INSTALL_TOKEN 至少32位，最多256位');return env.INSTALL_TOKEN;}
  const file=path.join(privateDirectory(root,env),'setup-token');
  if(!fs.existsSync(file)){try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const token=readPrivate(file).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('安装令牌文件无效');return token;
}
function clientDirectory(provider,root=process.cwd()){
  if(!['sqlite','mysql','postgresql'].includes(provider))throw Error('不支持的数据库类型');
  return path.join(root,'.generated','install-clients',provider);
}
function clientConstructor(provider,root=process.cwd()){
  const file=path.join(clientDirectory(provider,root),'index.js');
  if(fs.existsSync(file))return require(file).PrismaClient;
  // Supports an existing single-provider deployment until it is rebuilt.
  const schema=fs.readFileSync(path.join(root,'node_modules/.prisma/client/schema.prisma'),'utf8');
  if(!schema.includes(`provider = "${provider}"`))throw Error('缺少所选数据库驱动，请重新构建程序');
  return require(path.join(root,'node_modules/@prisma/client')).PrismaClient;
}
module.exports={stateDirectory,configFile,privateDirectory,readPrivate,readChoice,writeChoice,rollbackChoice,installToken,clientDirectory,clientConstructor};
