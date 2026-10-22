import fs from 'node:fs';
import path from 'node:path';
// Copy only public source; never adopt a developer's real database or .env.
const [source,destination]=process.argv.slice(2).map(value=>path.resolve(value));
if(!source||!destination||destination===source||!destination.endsWith('/app'))throw Error('无效的源码复制目标');
if(fs.existsSync(destination)) {
  if(!fs.existsSync(path.join(destination,'.dbtv-source')))throw Error('安装目录已有非本脚本管理的app，拒绝覆盖');
  console.error('保留之前下载的源码；不覆盖安装失败现场。');
} else {
  fs.mkdirSync(destination,{recursive:true,mode:0o755});
  for(const name of ['package.json','package-lock.json','release.json','.env.example','.dockerignore','Dockerfile','compose.yaml','client','server','prisma','scripts','deploy','docs','README.md']) {
    if(!fs.existsSync(path.join(source,name)))continue;
    fs.cpSync(path.join(source,name),path.join(destination,name),{recursive:true,filter:file=>{
      const part=path.basename(file);
      return !fs.lstatSync(file).isSymbolicLink()&&!['node_modules','dist','build','coverage','cache','.generated','data','backups','.DS_Store'].includes(part)&&(!/\.(?:db|sqlite3?)(?:-|$)|\.log$|\.tmp$|\.bak$|\.key$|\.pem$/.test(part)||part==='update-public.pem')&&(!part.startsWith('.env')||part==='.env.example');
    }});
  }
  fs.writeFileSync(path.join(destination,'.dbtv-source'),'managed source copy\n',{mode:0o600});
}
