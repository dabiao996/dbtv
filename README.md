# 大彪TV

正式仓库：[dabiao996/dbtv](https://github.com/dabiao996/dbtv)。当前主分支为 **1.0.1 开发版（尚未正式发布）**。`v1.0.0` 的 GitHub 发布、下载附件和标签已删除；修复源码已在主分支完成验证。目前没有正式发布包，之后以本仓库的 [Releases](https://github.com/dabiao996/dbtv/releases) 为准，功能与验证范围见 [版本记录](CHANGELOG.md)。

一个支持 Termux、普通 Linux、宝塔和 1Panel 的网页版 TVBox。部署时可选 SQLite、MySQL、PostgreSQL；使用 SQLite 时，手机即可独立运行前端、Express 后端和数据库，电视、电脑或其他手机可以通过同一 Wi-Fi 访问。

本项目不使用苹果 CMS，也不内置盗版接口、破解解析接口或绕过授权的功能。请仅配置你自己拥有或已经获得授权的 JSON、NAS、WebDAV、Alist 和视频地址。

## 功能

- React + Vite + TypeScript 前端
- Node.js + Express + TypeScript 后端
- Prisma 数据库：部署时可选择 SQLite、MySQL、PostgreSQL
- local、manual、tvbox-json 资源源
- TVBox 风格 JSON 基础解析
- MP4 与 M3U8 播放
- 首页、资源源、搜索、详情、播放、收藏、历史
- 后台配置导入和手动视频 API
- PWA、电视端友好深色界面
- 账号注册开关、积分赠送/调整、积分兑换会员、等级权限和审计流水（未接在线支付）

会员与积分操作说明见 [会员系统说明](docs/MEMBERSHIP.md)。用户入口 `/membership`，后台入口 `/admin/membership`。升级前备份数据库；积分与会员数据保存在部署时选择的数据库里，不属于公开源码。

## 项目结构

```text
client/       React 前端
server/       Express API 后端
prisma/       Prisma schema 和 seed 数据
output/pdf/   Termux 部署教程
```

## 本地运行

需要 Node.js 20.19+ 或 22 LTS。

```bash
npm install
cp .env.example .env
# 可选：安装前命令行配置数据库用 npm run setup；也可在网页首次安装时选择。
npm run db:push
npm run db:seed
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:8787`。

首次启动空数据库时，浏览器会自动进入 `/install` 安装向导。现在可以直接在网页选择 SQLite、MySQL 或 PostgreSQL，填写外部数据库连接、测试连接，再创建管理员，密码至少 6 位。请从面板的程序／容器运行日志复制首次安装令牌到页面；令牌保护安装入口，防止公网访客抢先配置数据库。管理员仍建议使用更长的密码。

SQLite 保留当前服务器配置的原路径，不允许浏览器指定任意文件。MySQL/PostgreSQL 请先在面板创建专用空库和用户；未通过连接、空库检查时不会更换当前数据库。网页安装不自动迁移旧数据。已有用户的 Termux/其他旧部署直接视为已安装，不能再次进入数据库选择或重建管理员。

网页安装成功后，连接保存在私有数据目录的 `database.json`（权限600），同时保存安装锁；不放进公开接口、前端构建或 Git。默认数据目录为项目 `data/`，Docker 固定 `/app/data`，可通过 `DBTV_DATA_DIR` 指定真实持久目录。该连接配置优先于 `.env` 中的数据库默认值，请和数据库一起备份并在升级时保留。部署前的命令行 `npm run setup` 仍保留；网页安装后不允许它静默覆盖已保存的选择。

旧版 `file:./dev.db` 继续对应 `prisma/dev.db`；新示例使用 `data/dabiao.db`。状态接口只返回类型和连接状态，不公开已保存的连接凭证。切换数据库不会自动迁移旧数据，完整配置、Docker、备份和切换注意事项见 [数据库部署说明](docs/DATABASES.md)。登录管理后台后，在“源配置”页面点击“从 tvbox.json 恢复”，即可恢复接口配置，但不会自动下载内容。

## Termux 部署

新增独立一键入口：在本版本源码目录执行 `bash scripts/install.sh`。自动检测Termux，采用独立Linux用户环境并询问端口；回车默认8787。旧原生部署方式仍保留。Linux、Docker、端口冲突、运行状态、域名和数据保护说明见 [大彪TV一键安装与管理](docs/ONE-CLICK.md)。新Termux分支尚需真实设备验证。

Termux 作为 VPS 时，前端、后端和数据库全部运行在手机本地。

```bash
pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts python clang make pkg-config
termux-setup-storage

cd ~/web-tvbox
npm install
npm run setup
npm run db:push
npm run db:seed
npm run build
npm start
```

手机浏览器访问：

```text
http://127.0.0.1:8787
```

让同一 Wi-Fi 下的电视访问，先查询手机 IP：

```bash
ip addr show wlan0 | grep inet
```

例如手机 IP 是 `192.168.1.25`，电视打开：

```text
http://192.168.1.25:8787
```

## 环境变量

`.env` 示例：

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:../data/dabiao.db"
PORT=8787
HOST="0.0.0.0"
```

SQLite 数据库是本地文件，请定期备份：

```bash
sh scripts/backup.sh
```

## JSON 播放源

后台可以导入 TVBox 风格配置。项目支持基础字段：

```json
{
  "name": "大彪TV",
  "sites": [
    {
      "key": "my_source",
      "name": "我的授权源",
      "type": "tvbox-json",
      "api": "https://example.com/my-source.json"
    }
  ]
}
```

JSON 数据通常使用以下字段：

```json
{
  "list": [
    {
      "vod_id": "demo-1",
      "vod_name": "我的视频",
      "vod_pic": "https://example.com/cover.jpg",
      "vod_year": "2025",
      "vod_class": "电影",
      "vod_play_url": "正片$https://example.com/video.mp4"
    }
  ]
}
```

播放地址必须来自自己的存储、NAS、WebDAV、Alist 或其他授权来源。

## 常用 API

```text
GET  /api/health
GET  /api/config
POST /api/config
GET  /api/sources
GET  /api/sources/:key/videos
GET  /api/sources/:key/videos/:id
GET  /api/search?q=关键词
GET  /api/favorites
GET  /api/history
```

## 开机自启动

安装 Termux:Boot 后：

```bash
mkdir -p ~/.termux/boot
nano ~/.termux/boot/web-tvbox.sh
```

写入：

```bash
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/web-tvbox
npm start >> ~/web-tvbox.log 2>&1
```

然后执行：

```bash
chmod +x ~/.termux/boot/web-tvbox.sh
```

## Linux、宝塔、1Panel 与 Docker

本版本提供 `sudo bash scripts/install.sh`（原生systemd）及 `sudo bash scripts/install.sh --mode docker`（复用面板Docker）。仅管理大彪TV，不含总工具箱。端口可选，冲突不抢占，重复安装不覆盖数据。详情及目前未实现的升级/恢复范围见 [独立管理脚本说明](docs/ONE-CLICK.md)。

普通 Linux 可使用 `npm ci && npm run build && npm start`。`npm start` 会先执行 Prisma 数据库同步，再启动 Express 服务。

项目提供 `Dockerfile` 和 `compose.yaml`：

```bash
cp .env.example .env
docker compose up -d --build
```

SQLite 数据保存在 Docker 命名卷中。宝塔和 1Panel 只需要将站点反向代理到 `127.0.0.1:8787`，并开启 WebSocket；详细的 Node.js 版本、systemd、Termux:Boot、备份和反向代理说明见 [`docs/BAOTA-1PANEL.md`](docs/BAOTA-1PANEL.md)。

手动Compose对外端口通过 `.env` 的 `DBTV_PORT` 设置，默认8787；`DBTV_BIND_IP` 默认127.0.0.1，需要局域网直连时显式改为0.0.0.0。自动脚本使用独立Compose和绑定数据目录，与此处手动命名卷部署不混用。

systemd 模板位于 `deploy/systemd/dabiao-tv.service`，需按实际用户和安装目录修改后启用。数据库备份使用 `sh scripts/backup.sh`，不要把 `.env` 或 SQLite 数据库提交到 Git。

## 安全说明

后台新增“系统更新”：正式版检查、独立代理更新和兼容版本回退。Docker走固定digest镜像，原生/Termux走签名源码包；需要发布者配置签名密钥并发布首个版本、部署者启用代理后才能执行。不会自动追主分支或给网页Docker控制权限。详见 [更新与回退说明](docs/UPDATES.md)。

- 不要公开 `.env`、`prisma/dev.db` 或私有播放源密钥。
- 不要将数据库文件或管理员密钥公开。
- 手机局域网部署适合个人或家庭使用。
- 如果需要公网访问，请额外配置 HTTPS、认证和反向代理。
- `/install` 只在用户表为空时有效；安装完成后服务端会拒绝重复安装，密码只保存为 scrypt 哈希。
- 反向代理不会替视频源绕过鉴权；视频播放仍要求源站允许浏览器跨域和 Range 请求。

## 许可证

当前项目适合个人自用和后续商业化开发。使用者需要自行确保视频源、封面和播放地址拥有合法授权。
