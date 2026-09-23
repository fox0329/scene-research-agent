#!/usr/bin/env bash
# M5 验收脚本（前后端联真收口）：
#   1 类型检查 · 2 全量单测 · 3 M5 产物文件 · 4 构建产物单端口整应用冒烟（静态页 200 + 真实路由 CRUD）
#   · 5 真实链路走查（Playwright · verify-live-chain，密钥自动探测）+ 演示 E2E · 6 契约与文档收口
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

echo "=== [M5 验收] 1/6 TypeScript 类型检查（根 + server 构建工程）==="
if pnpm typecheck >/dev/null 2>&1 && npx tsc -b apps/server >/dev/null 2>&1; then
  echo "✅ typecheck + tsc -b apps/server 通过"
else
  echo "❌ 类型检查失败"
  FAIL=1
fi

echo ""
echo "=== [M5 验收] 2/6 全量单元测试 ==="
if pnpm test >/dev/null 2>&1; then
  N=$(npx vitest run 2>/dev/null | grep -Eo "Tests  [0-9]+ passed" | grep -Eo "[0-9]+" | head -1 || echo "?")
  echo "✅ 测试通过（${N} 项）"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M5 验收] 3/6 M5 产物文件 ==="
for f in \
  apps/server/src/routes-ui.ts \
  apps/server/src/routes-ui.test.ts \
  apps/web/src/api.ts \
  apps/web/src/hooks/useAsync.ts \
  apps/web/src/views/RealStagePanel.tsx \
  apps/web/src/views/RealLibraryView.tsx \
  apps/web/src/components/ConversationDrawer.tsx \
  apps/web/src/components/decision-snapshot.ts \
  scripts/verify-live-chain.mjs; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename "$f")"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M5 验收] 4/6 构建产物 · 单端口整应用冒烟（:4096）==="
if pnpm -r --if-present build >/dev/null 2>&1; then
  echo "✅ 全量构建成功（tsc ×4 + vite）"
else
  echo "❌ 构建失败"
  FAIL=1
fi

PORT=4096
SDIR=$(mktemp -d)
APP_PORT=$PORT DB_PATH="$SDIR/verify.db" WEB_DIST="$ROOT/apps/web/dist" \
  node apps/server/dist/index.js >"$SDIR/server.log" 2>&1 &
SRV=$!
ready=""
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.3
done
if [ -z "$ready" ]; then
  echo "❌ 构建产物服务未就绪（见 $SDIR/server.log）"
  FAIL=1
else
  # 静态页：SPA 首页 + 挂载探测
  HTML=$(curl -s "http://127.0.0.1:${PORT}/")
  C_STATIC=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")
  if [ "$C_STATIC" = "200" ] && printf '%s' "$HTML" | grep -q 'id="root"'; then
    echo "✅ 静态托管：GET / 200 且含 SPA 挂载点"
  else
    echo "❌ 静态托管异常（GET / = $C_STATIC）"
    FAIL=1
  fi
  # 真实路由 CRUD 往返：创建 → 读取 → 重命名 → 删除
  PID=$(curl -s -X POST "http://127.0.0.1:${PORT}/api/v1/projects" \
    -H 'content-type: application/json' -d '{"name":"verify-m5 冒烟项目"}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  if [ -n "$PID" ]; then
    C_GET=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/projects/$PID/stages/0")
    C_PATCH=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "http://127.0.0.1:${PORT}/api/v1/projects/$PID" \
      -H 'content-type: application/json' -d '{"name":"verify-m5 改名"}')
    C_DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:${PORT}/api/v1/projects/$PID")
    C_GONE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/projects/$PID/stages/0")
    if [ "$C_GET" = "200" ] && [ "$C_PATCH" = "200" ] && [ "$C_DEL" = "200" ] && [ "$C_GONE" = "404" ]; then
      echo "✅ CRUD 往返：create/get/patch/delete 通过，删除后 404"
    else
      echo "❌ CRUD 异常（get=$C_GET patch=$C_PATCH delete=$C_DEL after=$C_GONE，期望 200/200/200/404）"
      FAIL=1
    fi
  else
    echo "❌ 项目创建失败，无法验证 CRUD"
    FAIL=1
  fi
  # 会话重连端点（契约 v1.5）：未知会话 404
  C_EVT=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/conversations/nope/messages/events")
  if [ "$C_EVT" = "404" ]; then
    echo "✅ messages/events 路由在册（未知会话 404）"
  else
    echo "❌ messages/events 异常（$C_EVT，期望 404）"
    FAIL=1
  fi
fi
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
rm -rf "$SDIR"

echo ""
echo "=== [M5 验收] 5/6 真实链路走查（Playwright · 构建产物 :4098）+ 演示 E2E ==="
# 密钥自动探测：默认供应商的 apiKeyEnv 环境变量非空 → SCENE_HAS_KEY=1 走真实 LLM 分支
HAS_KEY=0
DEF_PROVIDER=$(awk -F': *' '/^  provider:/{gsub(/ /,"",$2); print $2; exit}' "$ROOT/.dsh/settings.yaml" 2>/dev/null || true)
KEY_ENV=$(awk -v d="$DEF_PROVIDER" '
  index($0, "    " d ":") == 1 { f = 1; next }
  f && /apiKeyEnv:/ { print $2; exit }
  f && $0 ~ /^    [a-z0-9._-]+:[[:space:]]*$/ { f = 0 }
' "$ROOT/.dsh/settings.yaml" 2>/dev/null || true)
if [ -n "$KEY_ENV" ] && [ -n "${!KEY_ENV:-}" ]; then
  HAS_KEY=1
fi

PORT2=4098
SDIR2=$(mktemp -d)
APP_PORT=$PORT2 DB_PATH="$SDIR2/live.db" EXPORT_DIR="$SDIR2/exports" WEB_DIST="$ROOT/apps/web/dist" \
  node apps/server/dist/index.js >"$SDIR2/server.log" 2>&1 &
SRV2=$!
ready2=""
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT2}/api/v1/health" >/dev/null 2>&1; then ready2=1; break; fi
  sleep 0.3
done
if [ -z "$ready2" ]; then
  echo "❌ 走查服务未就绪（见 $SDIR2/server.log）"
  FAIL=1
else
  if [ "$HAS_KEY" = "1" ]; then
    echo "· 检测到默认供应商密钥（$KEY_ENV 已配置），走真实 LLM 分析分支"
  else
    echo "· 未检测到 API Key，走无密钥降级分支（真实 LLM 段待用户在设置页配置密钥后复跑）"
  fi
  LC_OUT=$(BASE_URL="http://127.0.0.1:${PORT2}" EXPORT_DIR="$SDIR2/exports" SCENE_HAS_KEY=$HAS_KEY \
    node scripts/verify-live-chain.mjs 2>&1) && LC_OK=1 || LC_OK=0
  printf '%s\n' "$LC_OUT" | tail -3
  if [ "$LC_OK" = "1" ]; then
    echo "✅ 真实链路走查通过"
  else
    echo "❌ 真实链路走查失败"
    FAIL=1
  fi
fi
kill "$SRV2" 2>/dev/null || true
wait "$SRV2" 2>/dev/null || true
rm -rf "$SDIR2"

E2E_OUT=$(npm run test:e2e 2>&1) && E2E_OK=1 || E2E_OK=0
if [ "$E2E_OK" = "1" ]; then
  EN=$(printf '%s' "$E2E_OUT" | grep -Eo "[0-9]+ passed" | tail -1 || echo "?")
  echo "✅ 演示模式 E2E 通过（${EN}）"
else
  echo "❌ 演示模式 E2E 失败"
  FAIL=1
fi

echo ""
echo "=== [M5 验收] 6/6 契约与文档收口 ==="
check_contains() {
  if grep -q "$2" "$ROOT/$1"; then
    echo "✅ $1 · $3"
  else
    echo "❌ $1 缺少：$3"
    FAIL=1
  fi
}
check_contains "03-数据契约与API.md" "v1.4" "契约版本记录 v1.4"
check_contains "03-数据契约与API.md" "messages/events" "会话重连端点契约登记（v1.5）"
check_contains "03-数据契约与API.md" "联真实现口径" "联真实现口径表"
check_contains "docs/开发计划.md" "T5.3 | 项目工作台接真.*✅" "T5.3 完成标记"
check_contains "docs/开发计划.md" "T5.4 | 资料库视图接真.*✅" "T5.4 完成标记"
check_contains "docs/开发计划.md" "T5.5 | 对话抽屉接 converse.*✅" "T5.5 完成标记"
check_contains "docs/开发计划.md" "T5.6 | 真实场景端到端实测.*✅" "T5.6 完成标记"
check_contains "docs/项目变更表.md" "| 14 |" "变更表 #14 联真依赖登记"
check_contains "docs/项目变更表.md" "| 15 |" "变更表 #15 重连端点登记"
check_contains "docs/故障及解决清单.md" "request.raw" "故障 #6 Node22 SSE 断连记录"
check_contains "docs/故障及解决清单.md" "selfManagedConvRef" "故障 #8 抽屉历史覆盖竞态记录"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M5 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M5 验收：存在失败项 ❌ ==="
  exit 1
fi
