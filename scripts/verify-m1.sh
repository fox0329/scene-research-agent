#!/usr/bin/env bash
# M1 验收脚本：typecheck + 单测（含 ingest 集成）+ 资料库闭环关键文件存在性
# 退出码 0 = 全部通过，1 = 有失败
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "=== [M1 验收] 1/5 TypeScript 类型检查 ==="
if pnpm typecheck; then
  echo "✅ typecheck 通过"
else
  echo "❌ typecheck 失败"
  FAIL=1
fi

echo ""
echo "=== [M1 验收] 2/5 单元测试（含领域层 ≥90% 覆盖） ==="
if pnpm test; then
  echo "✅ 测试通过"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M1 验收] 3/5 资料库闭环关键文件存在性 ==="
KEY_FILES=(
  "$ROOT/packages/infra/src/sqlite-repo.ts"
  "$ROOT/packages/infra/src/doc-parser.ts"
  "$ROOT/packages/infra/src/dsh-client.ts"
  "$ROOT/packages/domain/src/material.ts"
  "$ROOT/apps/server/src/ingest.ts"
)
for f in "${KEY_FILES[@]}"; do
  if [ -f "$f" ]; then
    echo "✅ 存在: $(basename $f)"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
echo "=== [M1 验收] 4/5 数据库迁移文件存在性 ==="
if [ -f "$ROOT/packages/infra/src/sql/001_init.sql" ]; then
  echo "✅ 存在: 001_init.sql（15 表 + FTS5）"
else
  echo "❌ 缺失: 001_init.sql"
  FAIL=1
fi

echo ""
echo "=== [M1 验收] 5/5 ingest 测试文件存在性 ==="
if [ -f "$ROOT/apps/server/src/ingest.test.ts" ]; then
  echo "✅ 存在: ingest.test.ts"
else
  echo "❌ 缺失: ingest.test.ts"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M1 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M1 验收：存在失败项 ❌ ==="
  exit 1
fi
