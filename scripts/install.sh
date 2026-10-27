#!/usr/bin/env bash
# Single-application bootstrap. No parent-toolbox menu or global "c" command.
set -euo pipefail
umask 077
script_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
termux=false
[[ "${PREFIX:-}" == *com.termux* ]] && termux=true
if "$termux"; then install_home="${DBTV_HOME:-$HOME/.local/share/dabiao-tv}"; install_mode=termux
else install_home="${DBTV_HOME:-/opt/dabiao-tv}"; install_mode=native; fi
auto_yes=false
port_supplied=false
manager_args=()
while (($#)); do
  case "$1" in
    --home) install_home="${2:?--home 缺少目录}"; shift 2 ;;
    --mode) install_mode="${2:?--mode 缺少方式}"; shift 2 ;;
    --yes) auto_yes=true; manager_args+=(--yes); shift ;;
    --port)
      port_value="${2:?端口缺少值}"
      [[ "$port_value" =~ ^[0-9]{1,5}$ ]] && ((10#$port_value >= 1024 && 10#$port_value <= 65535)) || { printf '%s\n' '端口必须是1024–65535的整数' >&2; exit 1; }
      port_supplied=true; manager_args+=(--port "$port_value"); shift 2 ;;
    --bind|--origin) manager_args+=("$1" "${2:?参数缺少值}"); shift 2 ;;
    --help) printf '%s\n' '用法：bash scripts/install.sh [--mode native|docker|termux] [--home 专用目录] [--port 8787] [--bind 127.0.0.1|0.0.0.0] [--origin https://域名] [--yes]' '默认回车端口8787；--yes 非交互安装必须显式指定 --port。不会自动开放防火墙、修改反代或 DNS。'; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done
if "$auto_yes" && ! "$port_supplied"; then printf '%s\n' '--yes非交互安装必须显式提供--port，避免替你决定端口' >&2; exit 1; fi
case "$install_home" in
  /*) ;;
  *) printf '%s\n' '--home 必须是绝对路径' >&2; exit 1 ;;
esac
[[ ! -L "$install_home" ]] || { printf '%s\n' '安装目录不能是符号链接' >&2; exit 1; }
install_home="$(realpath -m -- "$install_home")"
case "$install_home" in
  /|/opt|/usr|/var|/var/lib|/home|/root|/tmp|"$HOME"|*:*|*$'\n'*|*$'\r'*) printf '%s\n' '请使用专属于大彪TV的子目录' >&2; exit 1 ;;
esac
[[ ! -L "$install_home" ]] || { printf '%s\n' '安装目录不能是符号链接' >&2; exit 1; }
case "$install_mode" in native|docker|termux) ;; *) printf '%s\n' '安装方式仅支持native/docker/termux' >&2; exit 1;; esac

install_runtime() {
  # Pinned official Node archive + SHA256; do not overwrite the system's Node.
  local arch digest archive tempdir
  case "$(uname -m)" in
    x86_64|amd64) arch=x64; digest=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
    aarch64|arm64) arch=arm64; digest=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
    *) printf '%s\n' '首版自动安装只支持amd64/arm64，未修改现有应用。' >&2; exit 1 ;;
  esac
  mkdir -p "$install_home/tools"
  if [[ -x "$install_home/tools/node/bin/node" ]]; then
    [[ "$("$install_home/tools/node/bin/node" -v)" == v22.23.4 ]] || { printf '%s\n' '私有Node版本与脚本不符，拒绝自动覆盖，请先核对。' >&2; exit 1; }
    return
  fi
  [[ ! -e "$install_home/tools/node" ]] || { printf '%s\n' '已有不完整Node目录，拒绝覆盖。' >&2; exit 1; }
  tempdir="$(mktemp -d "$install_home/.node-download.XXXXXX")"
  # The trap only removes this freshly-created, dedicated download directory.
  trap '[[ -z "${tempdir:-}" ]] || rm -r -- "$tempdir"' EXIT
  archive="node-v22.23.4-linux-$arch.tar.xz"
  curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 15 "https://nodejs.org/dist/v22.23.4/$archive" -o "$tempdir/$archive"
  printf '%s  %s\n' "$digest" "$tempdir/$archive" | sha256sum -c -
  tar -xJf "$tempdir/$archive" -C "$tempdir"
  mv "$tempdir/node-v22.23.4-linux-$arch" "$install_home/tools/node"
  rm -r -- "$tempdir"; tempdir=''; trap - EXIT
}

if [[ "${DBTV_RUNTIME_ONLY:-}" == 1 ]]; then
  install_runtime
  exit 0
fi
if ! "$auto_yes"; then
  printf '将安装大彪TV及缺失环境。目录：%s；方式：%s。不会覆盖现有站点。继续？[y/N] ' "$install_home" "$install_mode" >&2
  read -r consent
  [[ "$consent" == y || "$consent" == Y ]] || exit 1
fi
if "$termux"; then
  [[ "$install_mode" == termux ]] || { printf '%s\n' 'Termux 自动安装请使用termux模式，不在Android运行Docker守护进程。' >&2; exit 1; }
  pkg update -y
  pkg install -y nodejs-lts curl git proot-distro termux-services
  mkdir -p "$install_home"
  host_node="$(command -v node)"
else
  [[ "$install_mode" != termux ]] || { printf '%s\n' 'termux模式只能在Termux运行' >&2; exit 1; }
  [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || { printf '%s\n' 'Linux自动安装需要root权限；请使用sudo。不会在macOS开发机执行安装。' >&2; exit 1; }
  [[ -f /etc/debian_version ]] || { printf '%s\n' '首版自动补环境支持Debian/Ubuntu；其他Linux请按手动部署说明操作。' >&2; exit 1; }
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git xz-utils openssl libstdc++6
  install_runtime
  host_node="$install_home/tools/node/bin/node"
fi
if [[ ! -f "$script_root/package-lock.json" || ! -f "$script_root/scripts/tv.mjs" ]]; then
  source_download="$(mktemp -d "$install_home/.source-download.XXXXXX")"
  trap 'rm -r -- "$source_download"' EXIT
  git clone --depth 1 --branch main https://github.com/dabiao996/dbtv.git "$source_download/repository"
  script_root="$source_download/repository"
  [[ -f "$script_root/scripts/tv/copy-source.mjs" ]] || { printf '%s\n' 'GitHub当前版本尚未包含此安装适配器，请先发布对应源码。' >&2; exit 1; }
fi
if [[ -f "$install_home/deployment.json" ]]; then
  "$host_node" "$script_root/scripts/tv.mjs" install --home "$install_home" --mode "$install_mode" "${manager_args[@]}"
  exit
fi
"$host_node" "$script_root/scripts/tv/copy-source.mjs" "$script_root" "$install_home/app"
if [[ -n "${source_download:-}" ]]; then rm -r -- "$source_download"; trap - EXIT; fi
if "$termux"; then
  if ! proot-distro login dbtv -- /bin/true >/dev/null 2>&1; then
    # Old Termux packages use distro aliases; newer versions accept OCI references.
    if proot-distro install --help 2>&1 | grep -q -- '--name'; then
      proot-distro install debian:bookworm --name dbtv
    else
      proot-distro install --override-alias dbtv debian
    fi
  fi
  proot-distro login dbtv -- /usr/bin/apt-get update
  proot-distro login dbtv -- /usr/bin/apt-get install -y --no-install-recommends ca-certificates curl xz-utils openssl libstdc++6
  proot-distro login dbtv --bind "$install_home:$install_home" -- /usr/bin/env DBTV_RUNTIME_ONLY=1 /bin/bash "$install_home/app/scripts/install.sh" --home "$install_home"
  printf '%s\n' '使用独立dbtv Linux用户环境，不修改已有Termux网站。首次编译可能较慢；仍需允许Termux后台运行。' >&2
elif [[ "$install_mode" == docker ]]; then
  if ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' '未检测到Docker Compose。已有宝塔/1Panel请先在面板安装Docker/Compose，避免脚本更改面板的容器环境。也可改用默认native模式。' >&2
    exit 1
  fi
  docker info >/dev/null || { printf '%s\n' 'Docker尚未运行，请先在面板启动。' >&2; exit 1; }
fi
exec "$host_node" "$install_home/app/scripts/tv.mjs" install --home "$install_home" --source "$install_home/app" --node "$install_home/tools/node/bin/node" --mode "$install_mode" "${manager_args[@]}"
