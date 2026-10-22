const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {renderSchema}=require('./database-config.cjs');
const {clientDirectory}=require('./web-database.cjs');

module.exports=function generateInstallClients(root=process.cwd()){
  const source=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8');
  for(const provider of ['sqlite','mysql','postgresql']){
    const folder=path.join(root,'.generated','install-schemas',provider);fs.mkdirSync(folder,{recursive:true});
    const output=clientDirectory(provider,root);
    const schema=renderSchema(source,provider).replace(/generator client\s*\{/,`generator client {\n  output = ${JSON.stringify(output.replaceAll('\\','/'))}`);
    const file=path.join(folder,'schema.prisma');fs.writeFileSync(file,schema);
    const result=spawnSync(process.execPath,[path.join(root,'node_modules/prisma/build/index.js'),'generate','--schema',file],{cwd:root,env:{...process.env,DATABASE_URL:provider==='sqlite'?'file:unused.db':`${provider}://build:build@localhost/build`},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    if(result.status!==0)throw Error(`安装向导 ${provider} 驱动生成失败；未输出数据库连接凭证`);
  }
  console.log('首次安装驱动：SQLite、MySQL、PostgreSQL 已就绪');
};
