#!/usr/bin/env bash
# T4.6 构建产物验收 + release 打包
# 步骤：全量构建 → 以构建产物启动做冒烟检查 → 打包 release tarball
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

STAMP="$(date +%Y%m%d-%H%M)"
RELEASE_DIR="release"
TARBALL="${RELEASE_DIR}/scene-master-${STAMP}.tgz"
SMOKE_PORT="${SMOKE_PORT:-4099}"
SMOKE_DB="$(mktemp -d)/smoke.db"

echo "── 1/4 全量构建（tsc -b ×4 + vite build）──────────────"
pnpm -r --if-present run build

echo "── 2/4 以构建产物启动冒烟检查 ─────────────────────────"
cleanup() {
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  rm -f "$SMOKE_DB" "$SMOKE_DB-wal" "$SMOKE_DB-shm" 2>/dev/null || true
}
trap cleanup EXIT

APP_PORT="$SMOKE_PORT" DB_PATH="$SMOKE_DB" node apps/server/dist/index.js &
SRV_PID=$!

ready=""
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${SMOKE_PORT}/api/v1/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.3
done
[[ -n "$ready" ]] || { echo "❌ 构建产物服务未就绪"; exit 1; }

HEALTH=$(curl -s "http://127.0.0.1:${SMOKE_PORT}/api/v1/health")
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || { echo "❌ health 异常"; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/api/v1/projects/nope/resume")
[[ "$CODE" == "404" ]] || { echo "❌ resume 路由异常（HTTP $CODE）"; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${SMOKE_PORT}/api/v1/projects/nope/rollback" -H 'content-type: application/json' -d '{"targetStage":1}')
[[ "$CODE" == "404" ]] || { echo "❌ rollback 路由异常（HTTP $CODE）"; exit 1; }

kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; SRV_PID=""
echo "✅ 构建产物冒烟通过（health / resume / rollback）"

echo "── 3/4 打包 release tarball ───────────────────────────"
mkdir -p "$RELEASE_DIR"
STAGE="$(mktemp -d)/scene-master"
mkdir -p "$STAGE"
# 源码 + 配置 + 文档（排除依赖/运行时数据/构建中间产物）
tar -cf - \
  --exclude node_modules --exclude .dsh --exclude vendor --exclude data \
  --exclude dist-release --exclude release --exclude .git --exclude .DS_Store \
  --exclude '*.tsbuildinfo' \
  -C . apps packages scripts 00b-智能体工作流标准.md 01-产品定义.md \
  03-数据契约与API.md AGENTS.md package.json pnpm-workspace.yaml \
  tsconfig.json vitest.config.ts 2>/dev/null | tar -xf - -C "$STAGE"
# 构建产物随包分发
for p in packages/contract packages/domain packages/infra apps/server; do
  mkdir -p "$STAGE/$p/dist"
  rsync -a "$p/dist/" "$STAGE/$p/dist/"
done
mkdir -p "$STAGE/apps/web"
rsync -a apps/web/dist "$STAGE/apps/web/" 2>/dev/null || true
tar -czf "$TARBALL" -C "$(dirname "$STAGE")" "$(basename "$STAGE")"
rm -rf "$(dirname "$STAGE")"

SIZE=$(du -h "$TARBALL" | cut -f1)
echo "── 4/4 完成 ───────────────────────────────────────────"
echo "✅ release 包：$TARBALL（$SIZE）"
echo "   运行方式：解压后 pnpm install（native 依赖）→ pnpm build → pnpm --filter @scene/server start（需在解压根目录启动，DSH 配置按相对路径解析）"
