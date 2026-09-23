#!/usr/bin/env bash
# M3 验收脚本：typecheck + 单测 + 领域模块 + 阶段面板 + 知识库视图 + 前端构建
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "=== [M3 验收] 1/6 TypeScript 类型检查 ==="
if pnpm typecheck; then
  echo "✅ typecheck 通过"
else
  echo "❌ typecheck 失败"
  FAIL=1
fi

echo ""
echo "=== [M3 验收] 2/6 单元测试 ==="
if pnpm test; then
  echo "✅ 测试通过"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M3 验收] 3/6 领域模块（二批 + 知识库）==="
for f in \
  packages/domain/src/market.ts \
  packages/domain/src/market.test.ts \
  packages/domain/src/capability-match.ts \
  packages/domain/src/capability-match.test.ts \
  packages/domain/src/cost-estimate.ts \
  packages/domain/src/cost-estimate.test.ts \
  packages/domain/src/value-verify.ts \
  packages/domain/src/value-verify.test.ts \
  packages/domain/src/knowledge.ts \
  packages/domain/src/knowledge.test.ts \
  packages/domain/src/workflow.ts; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename $f)"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M3 验收] 4/6 阶段 3-8 面板 ==="
for i in 3 4 5 6 7 8; do
  f="apps/web/src/views/stages/Stage${i}Panel.tsx"
  if [ -f "$ROOT/$f" ]; then
    echo "✅ Stage${i}Panel.tsx"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M3 验收] 5/6 知识库视图 + md-export ==="
for f in \
  apps/web/src/views/KnowledgeView.tsx \
  packages/infra/src/md-export.ts \
  packages/infra/src/md-export.test.ts; do
  if [ -f "$ROOT/$f" ]; then
    echo "✅ $(basename $f)"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M3 验收] 6/6 前端构建 ==="
if pnpm --filter @scene/web exec vite build >/dev/null 2>&1; then
  echo "✅ vite build 成功"
else
  echo "❌ vite build 失败"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M3 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M3 验收：存在失败项 ❌ ==="
  exit 1
fi
