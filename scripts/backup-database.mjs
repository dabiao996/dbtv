import {mkdirSync, chmodSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import tools from './web-database.cjs';
import config from './database-config.cjs';

let db;
try {
  const selected = config.applyDatabaseEnvironment();
  if (selected.provider !== 'sqlite') throw Error('外部数据库请使用面板备份或官方 pg_dump / mysqldump，参见 docs/DATABASES.md；不要复制 SQLite 文件');
  const directory = resolve(process.env.BACKUP_DIR || 'backups');
  mkdirSync(directory, {recursive:true, mode:0o700});
  const file = join(directory, `dabiao-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.db`);
  const PrismaClient=tools.clientConstructor(selected.provider);
  db = new PrismaClient({datasourceUrl:selected.url});
  // SQLite's online backup creates a consistent snapshot, including committed WAL data.
  await db.$executeRawUnsafe(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  chmodSync(file, 0o600);
  console.log(`SQLite 一致性备份已保存：${file}`);
} catch (error) {
  console.error(error.message?.startsWith('外部数据库') ? error.message : 'SQLite 备份失败，请检查连接、客户端类型及备份目录权限');
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
