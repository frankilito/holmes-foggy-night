#!/bin/bash
# 福尔摩斯：雾都雨夜谜案 启动器
cd "$(dirname "$0")"
PORT=8952
if ! lsof -i :$PORT >/dev/null 2>&1; then
  /usr/bin/python3 -m http.server $PORT >/dev/null 2>&1 &
  sleep 1
fi
open "http://localhost:$PORT/index.html"
echo "🔍🌧️ 福尔摩斯：雾都雨夜谜案 已启动！ http://localhost:$PORT"
echo "关闭此窗口不会停止服务器；如需停止：lsof -ti :$PORT | xargs kill"
