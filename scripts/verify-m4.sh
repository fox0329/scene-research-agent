#!/usr/bin/env bash
# M4 验收脚本：类型检查 + 全量单测 + M4 产物文件 + 构建产物运行时冒烟 + 交互端到端 + 文档收口
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

echo "=== [M4 验收] 1/6 TypeScript 类型检查（根 + server 构建工程）==="
if pnpm typecheck >/dev/null 2>&1 && npx tsc -b apps/server >/dev/null 2>&1; then
  echo "✅ typecheck + tsc -b apps/server 通过"
else
  echo "❌ 类型检查失败"
  FAIL=1
fi

echo ""
echo "=== [M4 验收] 2/6 全量单元测试 ==="
if pnpm test >/dev/null 2>&1; then
  N=$(npx vitest run 2>/dev/null | grep -Eo "Tests  [0-9]+ passed" | grep -Eo "[0-9]+" | head -1 || echo "?")
  echo "✅ 测试通过（${N} 项）"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M4 验收] 3/6 M4 产物文件 ==="
for f in \
  packages/domain/src/resume.ts \
  packages/domain/src/resume.test.ts \
  apps/server/src/sse-hub.ts \
  apps/server/src/sse-hub.test.ts \
  apps/server/src/app.ts \
  apps/server/src/app.test.ts \
  apps/server/src/rollback-stage.ts \
  apps/server/src/rollback-stage.test.ts \
  apps/server/src/stage-prompts.ts \
  apps/server/src/stage-prompts.test.ts \
  scripts/build-release.sh \
  playwright.config.ts \
  e2e/interaction.spec.ts; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename "$f")"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M4 验收] 4/6 构建产物运行时冒烟 ==="
if pnpm -r --if-present build >/dev/null 2>&1; then
  echo "✅ 全量构建成功（tsc ×4 + vite）"
else
  echo "❌ 构建失败"
  FAIL=1
fi

PORT=4097
SDIR=$(mktemp -d)
APP_PORT=$PORT DB_PATH="$SDIR/verify.db" node apps/server/dist/index.js >"$SDIR/server.log" 2>&1 &
SRV=$!
ready=""
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.3
done
if [ -z "$ready" ]; then
  echo "❌ 构建产物服务未就绪"
  FAIL=1
else
  C1=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/projects/nope/resume")
  C2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/api/v1/projects/nope/rollback" -H 'content-type: application/json' -d '{"targetStage":1}')
  C3=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/projects/nope/stages/0/events")
  if [ "$C1" = "404" ] && [ "$C2" = "404" ] && [ "$C3" = "404" ]; then
    echo "✅ 冒烟通过：health 200 / resume 404 / rollback 404 / events 404"
  else
    echo "❌ 冒烟异常（resume=$C1 rollback=$C2 events=${C3}，期望均 404）"
    FAIL=1
  fi
fi
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
rm -rf "$SDIR"

echo ""
echo "=== [M4 验收] 5/6 交互端到端（Playwright · 构建产物 vite preview:4180）==="
E2E_OUT=$(npm run test:e2e 2>&1) && E2E_OK=1 || E2E_OK=0
if [ "$E2E_OK" = "1" ]; then
  EN=$(printf '%s' "$E2E_OUT" | grep -Eo "[0-9]+ passed" | tail -1 || echo "?")
  echo "✅ E2E 通过（${EN}）"
else
  echo "❌ E2E 失败（产品定义 §4.2 交互定稿 / 00b §11.3 UI 子集）"
  FAIL=1
fi

echo ""
echo "=== [M4 验收] 6/6 文档收口 ==="
check_contains() {
  if grep -q "$2" "$ROOT/$1"; then
    echo "✅ $1 · $3"
  else
    echo "❌ $1 缺少：$3"
    FAIL=1
  fi
}
check_contains "docs/开发计划.md" "T4.1 | 断点续做.*✅" "T4.1 完成标记"
check_contains "docs/开发计划.md" "T4.2 | 回退清理.*✅" "T4.2 完成标记"
check_contains "docs/开发计划.md" "T4.6 | 构建产物验收.*✅" "T4.6 完成标记"
check_contains "docs/开发计划.md" "T4.3 | 交互规范.*✅" "T4.3 完成标记"
check_contains "docs/开发计划.md" "T4.4 | 设计合规.*✅" "T4.4 完成标记"
check_contains "docs/设计合规处置.md" "E9" "合规豁免清单 E1-E9"
check_contains "03-数据契约与API.md" "/rollback" "回退端点契约登记"
check_contains "03-数据契约与API.md" "v1.3" "契约版本记录 v1.3"
check_contains "docs/项目变更表.md" "| 11 |" "变更表 #9-#11 登记"
check_contains "docs/项目变更表.md" "| 13 |" "变更表 #13 Playwright 依赖登记"
check_contains "docs/故障及解决清单.md" "settings.yaml" "DSH 配置故障记录"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M4 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M4 验收：存在失败项 ❌ ==="
  exit 1
fi
