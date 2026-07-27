#!/usr/bin/env bash
set -euo pipefail

cd /home/young/WorkSpace/love

# 从 .env 读取 ROOM_KEY、PORT（KEY=VALUE，每行一个）
set -a
. ./.env
set +a

# 关掉旧的
pkill -f "node server.js" || true
sleep 1

# 重新启动
ROOM_KEY="$ROOM_KEY" PORT="$PORT" nohup node server.js > server.log 2>&1 &
