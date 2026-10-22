// Untrusted form fields are validated by the HTTP service; credentials arrive on stdin, not argv/logs.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {clientConstructor}=require('./web-database.cjs');
const {renderSchema}=require('./database-config.cjs');

async function main(){
  const input=JSON.parse(fs.readFileSync(0,'utf8'));const {provider,url,prepare}=input;
  if(provider==='sqlite'&&!fs.existsSync(url.slice(5))){try{fs.writeFileSync(url.slice(5),'',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const Client=clientConstructor(provider);const db=new Client({datasourceUrl:url,log:[]});
  try{
    await db.$connect();
    const tables=provider==='sqlite'?await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):provider==='mysql'?await db.$queryRawUnsafe("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'"):await db.$queryRawUnsafe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'");
    const names=new Set([...fs.readFileSync('prisma/schema.prisma','utf8').matchAll(/^model (\w+)/gm)].map(match=>match[1]));
    // Reject foreign tables and any existing application records. Never reset or migrate another site's data.
    for(const table of tables){
      if(!names.has(table.name))throw Object.assign(Error('目标数据库不是空库，请使用新的专用数据库'),{public:true});
      const quoted=provider==='mysql'?`\`${table.name}\``:`"${table.name}"`;
      if((!input.allowCurrent||table.name==='User')&&(await db.$queryRawUnsafe(`SELECT 1 FROM ${quoted} LIMIT 1`)).length)throw Object.assign(Error('目标数据库已有数据，已停止安装；不会覆盖或迁移旧数据'),{public:true});
    }
  }finally{await db.$disconnect();}
  if(prepare){
    const folder=path.resolve('.generated','install-prepare',provider);fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'schema.prisma');fs.writeFileSync(file,renderSchema(fs.readFileSync('prisma/schema.prisma','utf8'),provider));
    const result=spawnSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'db','push','--skip-generate','--schema',file],{env:{...process.env,DATABASE_PROVIDER:provider,DATABASE_URL:url},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
    if(result.status!==0)throw Object.assign(Error('数据库表结构初始化失败，请检查建表权限；未允许数据丢失'),{public:true});
  }
  process.stdout.write(JSON.stringify({ok:true,provider}));
}
main().catch(error=>{process.stdout.write(JSON.stringify({ok:false,error:error.public?error.message:'连接失败，请检查地址、账号、密码、数据库是否已创建及网络权限'}));process.exitCode=1;});
