# 部署时选择数据库

支持 SQLite、MySQL 8 和 PostgreSQL。使用同一套业务代码、模型和接口，不需要 PHP。Node.js 使用 20.19+ 或 22 LTS。

## 交互式部署（Linux / 宝塔 / 1Panel / Termux）

```sh
npm ci
npm run setup
npm run build
npm start
```

`npm run setup` 显示 SQLite / MySQL / PostgreSQL 选项。SQLite 填文件路径；外部数据库填主机、端口、库名、用户名和密码，密码不回显。最后输入 `SAVE` 才写入权限为 600 的 `.env`，不改动其他配置。它不会自动创建外部数据库账号，也不会搬迁原有数据。已有环境变量优先于 `.env`，面板或 systemd 中的同名变量需要一并调整。

外部数据库请先在面板创建一个专用空数据库和专用用户。首次建表需要该库的建表、修改表、索引以及读写权限，不要使用全局 root / postgres 超级用户。不要将数据库端口直接暴露公网。

上述命令行方式仍适用于预安装配置。也可以保留默认启动配置，打开 `/install`，凭部署者安装令牌在网页选择数据库并创建管理员；状态接口只显示数据库类型、连通性及 Node 版本，不回传数据库 URL、密码或文件路径。

## 无人值守配置

复制 `.env.example` 为 `.env`，三选一：

```dotenv
# SQLite：相对路径以项目 prisma/ 目录为基准
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:../data/dabiao.db"
```

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://dabiao:URL_ENCODED_PASSWORD@127.0.0.1:3306/dabiao"
```

```dotenv
DATABASE_PROVIDER=postgresql
DATABASE_URL="postgresql://dabiao:URL_ENCODED_PASSWORD@127.0.0.1:5432/dabiao?schema=public"
```

用户名、密码中的特殊字符必须 URL 编码；交互配置会自动编码。远程数据库按服务商要求添加 TLS 参数，不要关闭证书校验。可以不填 `DATABASE_PROVIDER`，程序会从连接协议推断；显式类型与 URL 不一致时拒绝启动，不会自动回退到 SQLite。

未配置数据库时兼容旧部署，仍使用 `prisma/dev.db`。旧的 `file:./dev.db` 含义不变。新示例使用 `data/dabiao.db`，**不会自动把旧数据库复制到新位置**；已有部署请保留旧配置或停机后明确迁移。

## Docker / 1Panel 容器

```sh
cp .env.example .env
# 可保留默认启动配置，在网页安装向导中选择数据库：
docker compose up -d --build
```

SQLite 推荐保留示例的 `file:../data/dabiao.db`（解析为 `/app/data/dabiao.db`），或使用 `file:/app/data/dabiao.db`。该目录挂载 `dabiao_data` 持久卷。不要使用容器内未挂载的 `prisma/dev.db`，也不要执行删除数据卷的操作。

MySQL / PostgreSQL 可连接 1Panel 已有数据库服务；URL 的主机填可访问的服务名或地址。容器里的 `127.0.0.1` 指容器自己，不是宿主机。使用共同 Docker 网络上的数据库服务名，或按平台配置宿主机网关。外部库的数据由数据库服务自己的持久卷保存，不能依赖网站容器的数据卷。

同一个镜像支持三种数据库，构建时包含三种 Prisma 客户端，启动也会校验准备驱动。`.dockerignore` 排除 `.env`、私有 data 目录、数据库、备份和本机依赖，真实密码不进入镜像。首次安装前 Compose 使用 `.env` 中的初始连接；网页安装后读取数据卷内的私有连接配置。

## 表结构与升级

`prisma/schema.prisma` 是唯一模型源，部署命令在忽略目录 `.generated/` 产生所选连接器的临时 schema；不要直接修改生成文件，也不要直接运行指定原 SQLite schema 的 Prisma 命令。

```sh
npm run db:validate  # 校验模型，不连接数据库
npm run db:generate # 生成选定连接器的客户端
npm run db:push     # 连接选定数据库并同步表结构，不自动搬迁数据
```

启动保留旧版的自动表结构同步，`DB_AUTO_SYNC=true`。没有启用强制重置或允许数据丢失；遇到潜在破坏性变化会停止。生产升级先做备份和恢复演练，审核 schema 差异；可设 `DB_AUTO_SYNC=false`，在维护窗口手动执行审核后的迁移。当前方案不是完整的版本化 Prisma Migrate 历史。

MySQL 对大字段使用长文本存储配置 JSON、简介、播放 URL、评分缓存和推荐分析，避免默认短文本长度限制。三种数据库的数据类型和排序规则仍可能有差异，特别是大小写唯一性；不要把其他应用共用的数据库直接拿来同步。

会员号升级包含只增不删的前置检查：旧账号表补充可空会员号列，确认无重复后建立唯一索引，再同步其他新增字段；服务为旧账号自动补号，不重置密码或积分。已有重复会员号时停止升级，需要先人工核对。仍须先备份；SQLite 旧库升级已做集成测试，MySQL / PostgreSQL 的升级需在对应服务的备份副本上演练。

## 备份与切换

SQLite：`sh scripts/backup.sh`，使用当前配置的数据库执行 `VACUUM INTO` 一致性备份，包含已提交 WAL 内容，而不是运行中直接复制 `.db`。备份目录默认 `backups/`，可设置 `BACKUP_DIR`，需要数据库及目录可写。备份含私人数据，请妥善保管。恢复时先停服务，再将备份放到配置指定路径，不要覆盖仍在运行的数据库。

MySQL / PostgreSQL：使用宝塔 / 1Panel 的数据库备份及恢复，或官方 `mysqldump` / `pg_dump`。`backup.sh` 遇到外部数据库会明确停止并提示，不会误备份其他 SQLite 文件。应备份数据库本身及服务器上独立保存的 `.env`；不要把真实密码放在公开命令或 Git 中。

**修改连接不等于迁移。** SQLite 切换到 MySQL 或 PostgreSQL 后，旧账号、源配置、采集、收藏、历史和个性化推荐不会自动出现。新空库进入首次安装是正常现象；旧文件不会被删除。需要保留数据时，应停机备份后安排专门的数据转换，保留 ID、关系、日期并校准自增序列；不要把 SQLite SQL 文件直接导入另一种数据库。本文没有提供自动跨库迁移工具。

## 验证范围

自动测试覆盖配置选择、协议校验、旧路径兼容、MySQL 长字段、敏感信息防护、保守同步参数和 SQLite 首次安装/重复安装流程。三种连接器均需通过 Prisma 模型校验。MySQL / PostgreSQL 的实际连接、采集与数据读写，还需要在相应服务中进行集成验证；仅校验 schema 不等于完成真实数据库兼容性验收。
## 网页首次安装选库

首次空库启动可直接在 `/install` 选择 SQLite、MySQL 或 PostgreSQL，不必先运行交互命令。先从程序／容器运行日志复制首次安装令牌；也可由部署者在环境变量中指定至少32位的 `INSTALL_TOKEN`。令牌不由状态接口提供、不存浏览器本地存储，安装完成后失效。通过 HTTPS 或本机受信任连接输入数据库密码。

1. SQLite 使用服务器原有持久文件路径，不接受网页自定义路径；旧版 `prisma/dev.db` 不会被移动。
2. MySQL/PostgreSQL 先创建专用空数据库和用户，再填写主机、端口、库名、账号和密码。PostgreSQL 可勾选 TLS；需要 MySQL 自定义TLS证书时仍用服务器端部署配置，不在网页上传证书。
3. 测试连接不保存选择、不更换当前数据库；安装提交时重新检查目标并初始化表结构。只有当前同一个尚无账号的项目库可保留已有源等初始化数据，其他目标必须为空库。
4. 创建管理员、默认设置和会话在数据库事务内完成。配置文件保存失败会回滚账号初始化；不会使用允许丢失数据或强制清库的选项。
5. 成功后在 `DBTV_DATA_DIR`（默认项目 `data/`，Docker 固定 `/app/data`）保存权限600的 `database.json` 和 `installation.lock`。私有配置优先于 `.env` 的 DATABASE_*，重启保持选择；目录不得公开。备份时同时保存此私有目录与一致性数据库备份。

已有账号、安装锁或已保存的数据库选择时，不允许通过网页重新选库，即使后来连接异常或数据库丢失也不能利用空库重新初始化。异常退出留下 `installation-operation.lock` 时，先确认没有安装进程、检查目标库和私有配置，再由管理员处理锁文件，不自动抢锁。

网页安装后的切库属于数据库迁移，不是安装操作：先停服务、备份数据库和 `database.json`，迁移到专用目标库并核对账号/积分/影片；再由管理员在服务器端审核修改私有连接配置、重新生成驱动和启动。不要只改 `.env`、删除安装锁或把生产库当新库安装。预安装阶段的 `npm run setup` 仍可使用，已网页安装时会明确拒绝覆盖。

构建会生成三种数据库驱动；Docker 发行包包含这些驱动。安装过程中无需下载或执行浏览器提供的脚本。未连接真实 MySQL/PostgreSQL 服务的测试环境只能验证驱动生成、输入校验及连接失败处理，不能据此宣称外部数据库全流程已实测。
