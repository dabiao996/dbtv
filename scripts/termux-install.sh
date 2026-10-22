#!/data/data/com.termux/files/usr/bin/sh
set -eu

pkg update -y
pkg install -y nodejs-lts git
PROJECT_DIR="${PROJECT_DIR:-$HOME/web-tvbox}"
if [ ! -d "$PROJECT_DIR/.git" ]; then
  printf '%s\n' '请先将项目复制或克隆到：' "$PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"
[ -f .env ] || cp .env.example .env
npm ci
npm run build
npm start
