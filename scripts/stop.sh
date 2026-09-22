#!/usr/bin/env bash
# 方案助手 DSH 实例停止脚本
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME_DIR="${PROJECT_DIR}/.dsh"
PID_FILE="${DSH_HOME_DIR}/dsh.pid"
PORT="${DSH_PORT:-3081}"

stop_by_pid() {
  if [ -f "${PID_FILE}" ]; then
    local pid
    pid=$(cat "${PID_FILE}")
    if kill -0 "${pid}" 2>/dev/null; then
      echo "停止 DSH 实例 (PID: ${pid}, 端口: ${PORT})..."
      kill "${pid}"
      for i in $(seq 1 10); do
        if ! kill -0 "${pid}" 2>/dev/null; then
          echo "已停止"
          rm -f "${PID_FILE}"
          return 0
        fi
        sleep 0.5
      done
      echo "进程未响应，强制终止..."
      kill -9 "${pid}" 2>/dev/null || true
      rm -f "${PID_FILE}"
      return 0
    else
      echo "PID 文件存在但进程已退出，清理 PID 文件"
      rm -f "${PID_FILE}"
    fi
  fi
  return 1
}

stop_by_port() {
  local pids
  pids=$(lsof -ti :${PORT} 2>/dev/null || true)
  if [ -n "${pids}" ]; then
    echo "通过端口 ${PORT} 找到进程，停止中..."
    echo "${pids}" | xargs kill 2>/dev/null || true
    sleep 1
    echo "已停止"
    return 0
  fi
  return 1
}

if stop_by_pid; then
  :
elif stop_by_port; then
  :
else
  echo "方案助手 DSH 实例未在运行（端口 ${PORT}）"
fi
