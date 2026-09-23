#!/usr/bin/env bash
# M2 验收脚本：typecheck + 单测 + 后端文件 + 前端构建 + 阶段面板文件
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "=== [M2 验收] 1/5 TypeScript 类型检查 ==="
if pnpm typecheck; then
  echo "✅ typecheck 通过"
else
  echo "❌ typecheck 失败"
  FAIL=1
fi

echo ""
echo "=== [M2 验收] 2/5 单元测试 ==="
if pnpm test; then
  echo "✅ 测试通过"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M2 验收] 3/5 后端关键文件 ==="
for f in apps/server/src/advance-stage.ts apps/server/src/advance-stage.test.ts apps/server/src/stage-prompts.ts apps/server/src/converse.ts apps/server/src/converse.test.ts; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename $f)"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M2 验收] 4/5 前端关键文件 ==="
for f in apps/web/src/components/AdviceCard.tsx apps/web/src/views/stages/Stage0Panel.tsx apps/web/src/views/stages/Stage1Panel.tsx apps/web/src/views/stages/Stage2Panel.tsx apps/web/src/views/ProjectView.tsx apps/web/src/mock/stage-data.ts; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename $f)"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M2 验收] 5/5 前端构建 ==="
if pnpm --filter @scene/web exec vite build >/dev/null 2>&1; then
  echo "✅ vite build 成功"
else
  echo "❌ vite build 失败"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M2 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M2 验收：存在失败项 ❌ ==="
  exit 1
fi