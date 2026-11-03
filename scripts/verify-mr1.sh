#!/usr/bin/env bash
# MR1 验收脚本（反思优化模块）：产物文件 + typecheck + 全量单测（含领域用例矩阵）+ 主线基线不回退
# 口径见 docs/开发计划.md「测试验收方案」：收口命令 = 领域单测 + 契约校验 + typecheck + E2E 子集 + 基线不回退
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

echo "=== [MR1 验收] 1/4 产物文件 ==="
for f in \
  packages/contract/src/reflection.ts \
  packages/domain/src/intent-profile.ts \
  packages/domain/src/intent-profile.test.ts \
  apps/server/src/requirement-profile.ts \
  apps/server/src/requirement-profile.test.ts \
  apps/server/src/profile-extract.ts \
  apps/server/src/profile-extract.test.ts \
  apps/server/src/requirement-routes.ts \
  apps/server/src/requirement-routes.test.ts \
  apps/web/src/components/RequirementProfilePanel.tsx \
  apps/web/src/components/RequirementProfilePanel.test.ts \
  scripts/verify-mr1.sh \
; do
  if [ -f "$f" ]; then echo "✅ $f"; else echo "❌ 缺 $f"; FAIL=1; fi
done

echo ""
echo "=== [MR1 验收] 2/4 TypeScript 类型检查 ==="
if pnpm typecheck >/dev/null 2>&1; then
  echo "✅ typecheck 通过"
else
  echo "❌ 类型检查失败"
  FAIL=1
fi

echo ""
echo "=== [MR1 验收] 3/4 领域用例矩阵 + 端点 + 管道单测（E2E 子集）==="
if npx vitest run \
  packages/domain/src/intent-profile.test.ts \
  apps/server/src/requirement-profile.test.ts \
  apps/server/src/profile-extract.test.ts \
  apps/server/src/requirement-routes.test.ts \
  apps/server/src/interaction-hooks.test.ts \
  apps/web/src/components/RequirementProfilePanel.test.ts \
  >/dev/null 2>&1; then
  echo "✅ MR1 六个测试文件全绿"
else
  echo "❌ MR1 子集测试失败"
  FAIL=1
fi

echo ""
echo "=== [MR1 验收] 4/4 全量回归（主线基线不回退：≥2,113 过）==="
OUT=$(npx vitest run 2>/dev/null | grep -Eo "Tests  [0-9]+ passed" | grep -Eo "[0-9]+" | head -1 || echo "0")
echo "全量通过：${OUT} 项"
if [ "${OUT}" -ge 2113 ]; then
  echo "✅ 基线不回退"
else
  echo "❌ 低于 MR1 收口基线 2113"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== MR1 验收通过 ==="
else
  echo "=== MR1 验收存在失败项 ==="
  exit 1
fi
