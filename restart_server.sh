#!/usr/bin/env bash
set -euo pipefail

# 脚本自己所在的目录，从哪儿调用都对
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# 从 .env 读取 ROOM_KEY、DEBUG_KEY、PORT（KEY=VALUE，每行一个）
set -a
. ./.env
set +a

# 关掉旧的
pkill -f "node server.js" || true
sleep 1

# 重新启动
ROOM_KEY="$ROOM_KEY" DEBUG_KEY="${DEBUG_KEY:-}" PORT="$PORT" nohup node server.js > server.log 2>&1 &
