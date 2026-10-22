import {mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import config from './database-config.cjs';
import {prepareMemberIdentity} from './prepare-member-identity.mjs';

try {
  const root = process.cwd();
  const db = config.applyDatabaseEnvironment(root);
  const command = process.argv[2] || 'generate';
  if (!['generate', 'push', 'validate', 'prepare'].includes(command)) throw Error('未知数据库操作');
  const folder = resolve(root, '.generated/prisma');
  mkdirSync(folder, {recursive: true});
  const schema = resolve(folder, 'schema.prisma');
  writeFileSync(schema, config.renderSchema(readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8'), db.provider));
  if (db.provider === 'sqlite' && ['push','prepare'].includes(command)) {
    const file = db.url.slice(5);
    mkdirSync(resolve(file, '..'), {recursive: true});
    // Some schema-engine/platform combinations require the SQLite file to exist first.
    // Exclusive creation never truncates an existing database.
    if (!existsSync(file)) { try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  }
  function run(args) {
    const result = spawnSync(process.execPath, [resolve(root, 'node_modules/prisma/build/index.js'), ...args, '--schema', schema], {cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
    if (result.status !== 0) {
      const code = `${result.stderr || ''}${result.stdout || ''}`.match(/\bP\d{4}\b/)?.[0];
      // Prisma diagnostics can contain credentials. Keep them off console, even on failure.
      throw Error(`数据库 ${args[0]} 操作失败${code ? `（${code}）` : ''}；请检查连接、数据库权限和表结构。未启用强制重置或允许数据丢失。`);
    }
    console.log(`数据库 ${db.provider}：${args[0]} 完成`);
  }
  async function push(){
    const {PrismaClient}=await import('@prisma/client');
    const client=new PrismaClient({datasourceUrl:db.url});
    try{await prepareMemberIdentity(client,db.provider);}
    catch{throw Error('会员号无损升级检查失败；请检查数据库权限及会员号重复记录。未启用强制重置或允许数据丢失。');}
    finally{await client.$disconnect();}
    run(['db','push','--skip-generate']);
  }
  if (command === 'prepare') {
    run(['generate']);
    const {default:generateInstallClients}=await import('./generate-install-clients.cjs');generateInstallClients(root);
    if (process.env.DB_AUTO_SYNC !== 'false') await push();
  } else if (command === 'push') await push();
  else if (command === 'generate') {run(['generate']);const {default:generateInstallClients}=await import('./generate-install-clients.cjs');generateInstallClients(root);}
  else run([command]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
