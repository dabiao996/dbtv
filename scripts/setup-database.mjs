import {existsSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import config from './database-config.cjs';

export function updateEnv(source, provider, url) {
  const keep = source.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?DATABASE_(PROVIDER|URL)\s*=/.test(line));
  return `${keep.join('\n').trimEnd()}\nDATABASE_PROVIDER=${provider}\nDATABASE_URL=${JSON.stringify(url)}\n`;
}

async function main() {
  const {default:webDatabase}=await import('./web-database.cjs');
  if(webDatabase.readChoice())throw Error('本机已通过网页安装，数据库选择已锁定；切库请先备份并按 docs/DATABASES.md 审核迁移，不直接覆盖连接');
  if (!process.stdin.isTTY) throw Error('交互配置需要终端；无人值守部署请编辑 .env 的 DATABASE_PROVIDER 和 DATABASE_URL');
  let muted = false;
  const output = new Writable({write(chunk, _encoding, done) {if (!muted) process.stdout.write(chunk); done();}});
  const rl = createInterface({input: process.stdin, output, terminal: true});
  const ask = async (label, fallback = '') => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}：`)).trim() || fallback;
  try {
    console.log('选择部署数据库：1 SQLite（默认）  2 MySQL  3 PostgreSQL');
    const choice = await ask('请输入编号', '1');
    const provider = {'1':'sqlite','2':'mysql','3':'postgresql'}[choice];
    if (!provider) throw Error('无效的数据库编号');
    let url;
    if (provider === 'sqlite') {
      const existing = existsSync('.env') ? parseEnv(readFileSync('.env','utf8')).DATABASE_URL : '';
      const fallback = existing?.startsWith('file:') ? existing.slice(5) : '../data/dabiao.db';
      url = `file:${await ask('数据库路径（相对路径以 prisma/ 为基准）', fallback)}`;
    }
    else {
      const host = await ask('数据库主机', '127.0.0.1');
      const port = await ask('数据库端口', provider === 'mysql' ? '3306' : '5432');
      const name = await ask('数据库名', 'dabiao');
      const username = await ask('数据库用户名', 'dabiao');
      if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !name || !username) throw Error('主机、端口、库名或用户名无效');
      process.stdout.write('数据库密码（不回显）：');
      muted = true;
      let password;
      try { password = await rl.question(''); } finally { muted = false; process.stdout.write('\n'); }
      url = `${provider}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}`;
      if (provider === 'postgresql') url += '?schema=public';
    }
    config.databaseConfig({DATABASE_PROVIDER:provider, DATABASE_URL:url});
    const file = resolve('.env');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Error('请直接编辑 .env 符号链接的目标文件，不自动覆盖');
    const old = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync('.env.example', 'utf8');
    console.log('切换数据库不会自动迁移账号、影片和历史。请先备份；目标数据库须为空或属于本项目。');
    if (await ask('输入 SAVE 保存配置（其他输入取消）') !== 'SAVE') {console.log('已取消，未修改配置'); return;}
    const temp = `${file}.setup-${process.pid}.tmp`;
    writeFileSync(temp, updateEnv(old, provider, url), {mode:0o600, flag:'wx'});
    renameSync(temp, file); chmodSync(file, 0o600);
    console.log(`已保存 ${provider} 配置（未输出密码）。下一步：npm run build，再 npm start；首次访问 /install 创建管理员。`);
  } finally { rl.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {console.error(error.message); process.exitCode = 1;});
