#!/usr/bin/env bash
# 方案助手 DSH 实例启动脚本（从本地源码构建运行）
# 端口 3081（可通过 DSH_PORT 环境变量覆盖）
# DSH_HOME 为项目内 .dsh/，不与用户本地 DSH(3080) 冲突
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME_DIR="${PROJECT_DIR}/.dsh"
DSH_CLI="${PROJECT_DIR}/vendor/deepseek-harness/apps/cli/lib/bin.js"
PORT="${DSH_PORT:-3081}"
PID_FILE="${DSH_HOME_DIR}/dsh.pid"

# 检查本地构建是否存在
if [ ! -f "${DSH_CLI}" ]; then
  echo "DSH 本地构建不存在，请先构建："
  echo "  cd vendor/deepseek-harness && pnpm install && pnpm run build"
  exit 1
fi

# 检查端口是否已被占用
if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${PORT} 已被占用："
  lsof -nP -iTCP:${PORT} -sTCP:LISTEN
  echo ""
  echo "如果是用户本地 DSH，请用 DSH_PORT=3082 npm run dsh:start 换端口"
  exit 1
fi

echo "启动方案助手 DSH 实例（本地源码构建）..."
echo "  DSH_HOME: ${DSH_HOME_DIR}"
echo "  CLI:      ${DSH_CLI}"
echo "  端口:     ${PORT}"
echo "  访问地址: http://127.0.0.1:${PORT}"

DSH_HOME="${DSH_HOME_DIR}" node "${DSH_CLI}" web --port "${PORT}" --no-open &
DSH_PID=$!
echo "${DSH_PID}" > "${PID_FILE}"

echo "  PID:      ${DSH_PID}"
echo ""
echo "等待服务就绪..."
for i in $(seq 1 15); do
  if curl -s -o /dev/null -w '' --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    echo "服务已就绪 → http://127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "警告：服务启动超时，请检查日志："
echo "  tail -f ${DSH_HOME_DIR}/dsh-web.log"
echo "  tail -f ${DSH_HOME_DIR}/dsh-web.err.log"
exit 1
