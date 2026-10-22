// Shared by deployment commands and the compiled server. Never expose the URL to clients.
const {existsSync, readFileSync} = require('node:fs');
const {resolve, isAbsolute} = require('node:path');
const {loadEnvFile} = require('node:process');

function loadEnvironment(root = process.cwd()) {
  const file = resolve(root, '.env');
  if (existsSync(file)) loadEnvFile(file); // Existing service/container environment takes precedence.
}

function databaseConfig(env = process.env, root = process.cwd()) {
  const raw = String(env.DATABASE_URL || '').trim();
  const inferred = raw.startsWith('file:') ? 'sqlite' : /^postgres(ql)?:/.test(raw) ? 'postgresql' : raw.startsWith('mysql:') ? 'mysql' : '';
  const provider = String(env.DATABASE_PROVIDER || inferred || 'sqlite').toLowerCase();
  if (!['sqlite', 'mysql', 'postgresql'].includes(provider)) throw Error('DATABASE_PROVIDER 只能是 sqlite、mysql 或 postgresql');
  if (raw && inferred !== provider) throw Error('数据库类型与 DATABASE_URL 不一致，请检查配置');
  let url = raw;
  if (provider === 'sqlite') {
    const filename = raw ? raw.slice(5) : 'dev.db';
    if (!filename || /[?\x00\r\n]/.test(filename) || filename === ':memory:') throw Error('SQLite 请使用不带查询参数的持久文件路径');
    // Retain Prisma's original relative-path semantics; never silently move an existing database.
    url = `file:${isAbsolute(filename) ? filename : resolve(root, 'prisma', filename)}`;
  } else {
    if (!raw) throw Error('外部数据库必须填写 DATABASE_URL');
    let parsed;
    try { parsed = new URL(raw); } catch { throw Error('数据库连接地址格式不正确'); }
    if (!parsed.hostname || parsed.pathname.length <= 1 || /[\r\n\x00]/.test(raw)) throw Error('数据库连接地址缺少主机或数据库名');
  }
  return {provider, url};
}

function renderSchema(source, provider) {
  let schema = source.replace(/provider\s*=\s*"sqlite"/, `provider = "${provider}"`);
  if (provider === 'mysql') {
    // Prisma's MySQL default VARCHAR(191) truncates JSON, synopsis and signed playback URLs.
    const longFields = new Set(['name','api','rawConfig','title','cover','tags','desc','director','actors','url','content','errorMessage','detail','value','avatarUrl','pageAccess','collectionError','lastError','description','permissions','sourceKeys','accessGroupIds','contentRules','categoryRules','originalCategory','reason','planName']);
    schema = schema.replace(/^(\s+)(\w+)(\s+String\??)([^\n]*)$/gm, (line, indent, field, type, attrs) => {
      if (!longFields.has(field) || /@id\b|@unique\b|@db\./.test(attrs)) return line;
      // Text defaults are not portable across supported MySQL versions.
      return `${indent}${field}${type}${attrs} ${/@default\(/.test(attrs) ? '@db.VarChar(2048)' : '@db.LongText'}`;
    });
  }
  return schema;
}

function applyDatabaseEnvironment(root = process.cwd()) {
  loadEnvironment(root);
  const choice = require('./web-database.cjs').readChoice(root);
  if (choice) {process.env.DATABASE_PROVIDER = choice.provider;process.env.DATABASE_URL = choice.url;}
  const config = databaseConfig(process.env, root);
  process.env.DATABASE_PROVIDER = config.provider;
  process.env.DATABASE_URL = config.url;
  return config;
}

function assertClientProvider(config, root = process.cwd()) {
  const schema = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  const provider = schema.match(/datasource db\s*\{\s*provider\s*=\s*"([^"]+)"/)?.[1];
  if (provider !== config.provider) throw Error('数据库客户端类型不匹配，请先执行 npm run db:generate，再重启服务');
}

module.exports = {loadEnvironment, databaseConfig, renderSchema, applyDatabaseEnvironment, assertClientProvider};
