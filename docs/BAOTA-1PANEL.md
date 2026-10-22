# 宝塔 / 1Panel 部署

需要环境检测、端口选择、启停和运行状态菜单时，使用新增 [大彪TV独立安装脚本](ONE-CLICK.md)。它不包含总工具箱，不改面板的DNS/反代/证书；安装后将反代目标改为实际选择的端口。已有站点不要当新站直接覆盖。

## 普通 Linux

安装 Node.js 20.19+ 或 22 LTS、Git。将项目放到 `/opt/dabiao-tv`，复制 `.env.example` 为 `.env`，然后执行：

```sh
npm ci
# 数据库可在网页首次安装向导中选择。
npm run build
npm start
```

首次打开站点进入 `/install`，在面板程序运行日志中复制安装令牌，然后在网页选择 SQLite、MySQL 或 PostgreSQL，测试连接并创建管理员。`npm run setup` 仅作为部署前的可选方式，不再是选择数据库的必经步骤。外部数据库先在面板创建专用空库和用户；容器中的数据库主机请使用共享网络服务名，不能把容器的 127.0.0.1 当成服务器地址。完整说明见 [数据库部署](DATABASES.md)。已有账号或安装锁时禁止重新选库；管理员密码至少 6 位，建议使用长密码。

连接选择、令牌与安装锁在私有持久目录（默认 `data/`，Docker `/app/data`）中，不在源码或公开设置里。升级、迁移需同时保留数据库和私有配置；不要删除锁文件来尝试重装，不要把该目录设成网站静态根目录。

## 宝塔

1. 创建 Node.js 项目，项目目录指向源码根目录，Node.js 选择 20 或更高版本。
2. 安装依赖 `npm ci`，启动文件使用 `npm start`，端口填 `.env` 中的 `PORT`（默认 8787）。
3. 在“网站”中新建反向代理，目标地址为 `http://127.0.0.1:8787`，开启 WebSocket 支持。
4. 把 `.env`、数据库文件和 `prisma/` 的运行数据放在项目外的备份目录；不要在面板文件管理器中公开下载 `.env`。

## 1Panel

推荐使用仓库中的 `compose.yaml`：

```sh
cp .env.example .env
docker compose up -d --build
```

容器会把 SQLite 数据写入 Docker 命名卷 `dabiao_data`。在 1Panel 的“网站”中反向代理到 `127.0.0.1:8787`，并开启 WebSocket。更新时执行 `docker compose up -d --build`，不要删除数据卷。

## Termux

保留原有手机部署方式：把源码放到 `~/web-tvbox`，执行 `sh scripts/termux-install.sh`。若要开机启动，安装 Termux:Boot 后，把下面内容保存为 `~/.termux/boot/dabiao-tv.sh`：

```sh
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$HOME/web-tvbox"
exec npm start
```

## 反向代理与视频播放

反向代理只转发大彪TV 的 HTTP API、静态页面和 WebSocket；视频 URL 仍由浏览器直接请求源站。若视频源需要鉴权、跨域或 Range 请求，应在源站或你自己的授权代理上配置 `Access-Control-Allow-Origin`、`Accept-Ranges` 和 HTTPS。项目不会绕过源站权限。

数据库备份：`sh scripts/backup.sh`。SQLite 迁移由 `npm start` 启动脚本执行 `prisma db push`，升级前请先备份。
