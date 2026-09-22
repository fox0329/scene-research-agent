#!/usr/bin/env bash
# M0 验收脚本：typecheck + 单测 + Spike 结论文件存在性检查
# 退出码 0 = 全部通过，1 = 有失败
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "=== [M0 验收] 1/4 TypeScript 类型检查 ==="
if pnpm typecheck; then
  echo "✅ typecheck 通过"
else
  echo "❌ typecheck 失败"
  FAIL=1
fi

echo ""
echo "=== [M0 验收] 2/4 单元测试 ==="
if pnpm test; then
  echo "✅ 测试通过"
else
  echo "❌ 测试失败"
  FAIL=1
fi

echo ""
echo "=== [M0 验收] 3/4 Lint 检查 ==="
if pnpm lint; then
  echo "✅ lint 通过"
else
  echo "❌ lint 失败"
  FAIL=1
fi

echo ""
echo "=== [M0 验收] 4/4 Spike 结论文件存在性 ==="
SPIKE_FILES=(
  "$ROOT/scripts/spike/s1/report.md"
  "$ROOT/scripts/spike/s3/report.md"
  "$ROOT/scripts/spike/s4/report.md"
)
for f in "${SPIKE_FILES[@]}"; do
  if [ -f "$f" ]; then
    echo "✅ 存在: $f"
  else
    echo "❌ 缺失: $f"
    FAIL=1
  fi
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M0 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M0 验收：存在失败项 ❌ ==="
  exit 1
fi
