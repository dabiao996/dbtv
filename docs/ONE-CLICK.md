# 大彪TV独立安装与管理

这里只放大彪TV，不包含总的“大彪一键脚本”，也不安装全局 `c` 命令。未来工具箱读取 `deploy/app.json`，调用 `scripts/tv.mjs` 即可，不需要复制网站代码。

## 安装入口

在**已下载本版本源码**的项目目录执行（不要对正在运行的旧项目执行强制覆盖）：

```sh
# Debian/Ubuntu，原生Node + systemd。首次需要root/sudo权限。
sudo bash scripts/install.sh

# 已通过宝塔/1Panel装好Docker Compose时
sudo bash scripts/install.sh --mode docker

# Termux中使用同一入口，不需要root
bash scripts/install.sh
```

脚本先说明影响并要求确认，检查环境，为大彪TV安装私有Node 22.23.4（官方amd64/arm64包，固定SHA256），不替换服务器系统Node。默认管理目录Linux为 `/opt/dabiao-tv`；Termux为 `$HOME/.local/share/dabiao-tv`。源码复制到管理目录下 `app/`，不会复制开发机的 `.env`、SQLite、依赖、构建和缓存；原下载目录不变。`--home` 可指定**专用绝对路径**，不要使用已有网站目录、根目录或整个用户目录。

自动补环境的Linux范围为Debian/Ubuntu；原生管理要求正在运行的systemd。Docker模式复用面板的Docker/Compose，不擅自安装或替换面板的容器环境。没有Docker时会明确停止并提示安装，或改用native。

本地修改尚未发布到GitHub时，不存在可声称已上线的一行远程安装命令。发布后也应下载完整源码/可信发布包，核对发布的校验值，再执行；不推荐未经核验直接执行网络脚本。独立下载的入口支持从固定 `dabiao996/dbtv` main下载源码，但Git分支的HTTPS下载**不等于签名发布验证**，应审阅后执行。

## 端口和冲突

- 每次新安装询问端口，回车使用 **8787**；允许1024–65535，避免低端口需要应用特权。
- 自动检查实际TCP监听（IPv4/IPv6），检测范围与绑定地址有关。占用时不杀进程，提示并建议后续可用端口，用户确认后再选。
- 长时间编译后、启动前再次检查；其他程序仍可能在最后一瞬抢占，最终还须通过服务和HTTP/数据库健康检查，失败保留数据而不宣称成功。
- `--port 8788` 表示明确指定，冲突即失败，不默默改成其他端口。非交互 `--yes` 必须同时传 `--port`。
- 修改端口不会更换SQLite文件或删除账号；正在运行的服务会短暂重启，启动失败恢复原配置，并尝试重新启动原服务。仍须查看恢复后的健康状态。
- Docker仅修改宿主机端口，容器内部固定8787；不删除其他容器。已停止容器的预留端口无法阻止其他软件占用，日后启动也要复检。

示例：

```sh
sudo bash scripts/install.sh --port 8788 --origin https://tv.example.com --yes
```

Linux默认仅绑定 `127.0.0.1`，适合宝塔/1Panel反代。需要局域网直连时安装参数加 `--bind 0.0.0.0`，并自行检查防火墙；脚本不自动开放端口。Termux默认绑定 `0.0.0.0` 便于家庭Wi-Fi访问，不代表公网可达。

## 首次网页安装

安装后打开输出的访问地址，进入 `/install`，选择SQLite/MySQL/PostgreSQL，测试连接并创建管理员。外部数据库先建专用空库及账号；自动脚本不替你安装数据库服务器。已有账号或安装锁时仍拒绝再次初始化。

一键管理默认不把安装令牌写入日志。仅在本机查看私有文件，并将内容填到安装网页，不要发到聊天、放进URL或截图公开：

```sh
# Linux
sudo less /opt/dabiao-tv/data/setup-token
# Termux
less "$HOME/.local/share/dabiao-tv/data/setup-token"
```

若设置了HTTPS域名，先完成DNS、反代和证书，再通过该域名安装/登录，避免安全Cookie在HTTP地址不能使用。

## 日常管理

Linux安装完成后可以进入菜单：

```sh
sudo /opt/dabiao-tv/tools/node/bin/node /opt/dabiao-tv/app/scripts/tv.mjs menu
```

或单独调用（从本版本源码目录也可执行）：

```sh
sudo node scripts/tv.mjs status --home /opt/dabiao-tv
sudo node scripts/tv.mjs start --home /opt/dabiao-tv
sudo node scripts/tv.mjs stop --home /opt/dabiao-tv
sudo node scripts/tv.mjs restart --home /opt/dabiao-tv
sudo node scripts/tv.mjs port --home /opt/dabiao-tv --port 8788 --yes
sudo node scripts/tv.mjs domain --home /opt/dabiao-tv --origin https://tv.example.com --yes
sudo node scripts/tv.mjs backup --home /opt/dabiao-tv
sudo node scripts/tv.mjs logs --home /opt/dabiao-tv
```

系统没有全局node时，以上 `node` 替换为 `/opt/dabiao-tv/tools/node/bin/node`。Termux用宿主的 `node`，`--home` 换为默认Termux管理目录，不要直接运行Linux版Node二进制。

运行状态分别显示服务是否运行、网站是否响应、数据库是否连接、是否已安装、本机/候选局域网地址、设置的域名。公网IP不自动上传到第三方查询服务；域名显示“已设置”不表示DNS/证书已验证。

域名命令只调整应用来源和HTTPS Cookie设置，**不会自动完成DNS解析、配置反代或签发证书**。面板反代目标使用实际端口，例如 `http://127.0.0.1:8788`；改端口后需在面板同步修改。

## 数据与备份

```text
管理目录/
  app/              运行副本和必要的运行依赖/构建，不是待提交Git的源码目录
  tools/node/       独立Node运行环境
  deployment.json  管理配置
  app.env           脚本管理的启动配置，不要手动覆盖
  data/             数据库、私有连接配置、安装锁和令牌
  backups/          SQLite一致性快照及私有配置（含凭证，禁止上传）
```

原生服务使用专用非root账号；管理入口及管理配置由root持有，应用只写数据、依赖生成目录。Docker数据绑定到同一个 `data/` 目录。重复安装识别 `deployment.json` 后只显示原部署信息，不重建数据库、不覆盖配置；安装失败也不会自动删数据。检测到已有非本脚本管理的目录/同名服务则拒绝接管。

SQLite备份使用在线一致性快照，不直接复制正在写入的数据库，私有连接、安装锁也一起备份；成功时生成 `backup.json` 的 `complete:true`。失败目录没有完成标记，不能当成功备份。MySQL/PostgreSQL需用面板或官方工具另行备份，并同时保存 `data/` 私有配置；此命令会明确拒绝假装完成外部数据库备份。

现在提供签名正式版检查、独立更新代理及受限的程序回退，需先按 [更新与回退说明](UPDATES.md) 配置并启用；不是未配置就自动从主分支升级。数据库自动恢复和卸载仍未加入；不要删除安装锁，不要以重新安装代替升级。原来其他目录的SQLite不会自动迁移过来，请先核对原路径再安排迁移。

## Termux分支

新入口使用独立 `proot-distro` 的 `dbtv` Debian环境，安装Linux版Node和数据库引擎，宿主 `termux-services` 管理前台进程；不用Docker守护进程，不重置已有Debian环境，也不改旧 `~/web-tvbox`。这是因为Prisma所需的Linux libc/引擎不能简单视为Android原生兼容。依据：[Prisma运行环境](https://www.prisma.io/docs/orm/reference/system-requirements)、[Termux PRoot-Distro](https://github.com/termux/proot-distro)。

旧 `scripts/termux-install.sh` 原生入口仍保留，已有能运行的设备可以继续原方式。新分支尚未在真实手机实测，可能受Android后台限制、发行版镜像下载和内核限制影响，不能保证每台设备成功。`termux-services` 未开始时可重新打开Termux会话后重试start；手机重启后还需Termux:Boot配合启动服务管理器，Android省电设置也需自行允许。不会自动获取手机root权限。

## 接入未来大彪工具箱

读取 `deploy/app.json` 后，以子进程参数数组调用，禁止拼接 `eval`：

```sh
node scripts/tv.mjs describe
node scripts/tv.mjs install --home /opt/dabiao-tv --source /opt/dabiao-tv/app --node /opt/dabiao-tv/tools/node/bin/node --mode native --port 8788 --yes --json
node scripts/tv.mjs status --home /opt/dabiao-tv --json
node scripts/tv.mjs port --home /opt/dabiao-tv --port 8790 --yes --json
```

安装环境未准备时由父工具箱先调用 `install.sh`；管理适配器本身不下载安装系统软件。标准输出为JSON时，进度只写标准错误。退出码：0命令成功，1错误，2显式端口冲突，3网站状态不健康（status专用）；没有运行却收到其他进程的HTTP响应不会被当成本应用正常运行。操作锁防止同一部署的并发修改；异常中断后需核实进程再处理锁，不自动抢锁。

## 验证范围

```sh
npm run test:deploy
bash -n scripts/install.sh
```

部署测试无需项目依赖，使用临时目录、真实本机TCP监听及假的Docker命令，覆盖冲突/交互/JSON/重复安装/并发锁/失败恢复/秘密脱敏。它们不是实际Linux安装或Docker、Termux端到端测试。请在隔离的Debian/Ubuntu和手机上分别验证，勿在生产机盲测。
