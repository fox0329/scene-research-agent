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
  apps/web/src/views/RealKnowledgeView.tsx \
  apps/web/src/components/ConversationDrawer.tsx \
  packages/infra/src/provider-store.ts \
  packages/infra/src/provider-check.ts \
  scripts/verify-live-chain.mjs \
  packages/contract/src/tables.ts \
  packages/contract/src/tables.test.ts \
  packages/contract/src/docgen.ts \
  packages/domain/src/completeness.ts \
  packages/domain/src/confirmation.ts \
  packages/domain/src/anchor.ts \
  packages/domain/src/stage-summary.ts \
  packages/domain/src/row-validation.ts \
  apps/server/src/scenario-anchor.ts \
  apps/server/src/stage-summary-service.ts \
  apps/web/src/components/SchemaTable.tsx \
  apps/web/src/components/StageRightPanel.tsx \
  apps/web/src/views/DemoStagePanel.tsx \
  scripts/copy-infra-sql.mjs \
  scripts/migrate-info-model.mjs \
  packages/contract/src/flow.ts \
  packages/domain/src/flow.ts \
  packages/domain/src/flow.test.ts \
  apps/server/src/flow-service.ts \
  apps/server/src/flow-service.test.ts \
  apps/server/src/library-merge.test.ts \
  apps/server/src/scenario-definition.ts \
  apps/server/src/scenario-definition.test.ts \
  apps/web/src/components/ScenarioDefinitionDialog.tsx \
  apps/web/src/components/NewScenarioDialog.tsx \
  apps/web/src/components/AlignmentTable.tsx \
  apps/web/src/components/FlowRail.tsx \
  apps/web/src/views/DemoFlowPanels.tsx \
  apps/web/src/mock/demo-flow.ts \
  scripts/verify-flow-ui.mjs \
  05-表格定义总表.md; do
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
# 验收服务不读用户真实配置：显式指向不存在的登记表 → 「默认未配置」语义确定
APP_PORT=$PORT DB_PATH="$SDIR/verify.db" SCENE_PROVIDERS_FILE="$SDIR/providers.none.json" WEB_DIST="$ROOT/apps/web/dist" \
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
    echo "❌ 静态托管异常（GET / = ${C_STATIC}）"
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
      echo "❌ CRUD 异常（get=$C_GET patch=$C_PATCH delete=$C_DEL after=${C_GONE}，期望 200/200/200/404）"
      FAIL=1
    fi
  else
    echo "❌ 项目创建失败，无法验证 CRUD"
    FAIL=1
  fi
  # ── 流程 UI 真机验收（v1.5 逐页推进）─────────────────────
  # 先建一个场景（脚本会驱动浏览器进入它并断言 8 步流程轴）
  curl -s -X POST "http://127.0.0.1:${PORT}/api/v1/projects" \
    -H 'content-type: application/json' \
    -d '{"name":"流程验收场景","intent":"验收逐页推进"}' >/dev/null 2>&1 || true
  if BASE_URL="http://127.0.0.1:${PORT}" ALLOW_MUTATE=1 node scripts/verify-flow-ui.mjs >"$SDIR/flowui.log" 2>&1; then
    echo "✅ 流程 UI 真机验收（8 步流程轴 / 四态 / 双 Tab / 无判断产出）"
  else
    echo "❌ 流程 UI 真机验收失败："
    tail -8 "$SDIR/flowui.log"
    FAIL=1
  fi

  # 会话重连端点（契约 v1.5）：未知会话 404
  C_EVT=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/conversations/nope/messages/events")
  if [ "$C_EVT" = "404" ]; then
    echo "✅ messages/events 路由在册（未知会话 404）"
  else
    echo "❌ messages/events 异常（${C_EVT}，期望 404）"
    FAIL=1
  fi
fi
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
rm -rf "$SDIR"

echo ""
echo "=== [M5 验收] 5/6 真实链路走查（Playwright · 构建产物 :4098）+ 演示 E2E ==="
# 密钥探测（变更表 #16：模型配置应用自持后）：登记表 data/providers.local.json 中
# 默认供应商已填 API Key → SCENE_HAS_KEY=1 走真实 LLM 分支；否则服务指向不存在的登记表，走「默认未配置」降级分支。
PF="$ROOT/data/providers.local.json"
HAS_KEY=0
PORT2=4098
SDIR2=$(mktemp -d)
PROVIDERS_FILE="$SDIR2/providers.none.json"
PROVIDERS_LABEL="登记表未配置（走无密钥降级分支，真实 LLM 段待用户在设置页添加供应商后复跑）"
if [ -f "$PF" ]; then
  DEF_DESC=$(python3 - "$PF" <<'PY' 2>/dev/null || true
import json, sys
try:
    reg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
d = reg.get("default_model") or {}
provs = {p.get("name"): p for p in reg.get("providers", [])}
p = provs.get(d.get("provider"))
if p and (p.get("api_key") or "").strip():
    model = d.get("model") or (p.get("models") or [{}])[0].get("id", "")
    print(f"{p['name']} / {model}")
PY
)
  if [ -n "$DEF_DESC" ]; then
    HAS_KEY=1
    PROVIDERS_FILE="$PF"
    PROVIDERS_LABEL="检测到默认模型已配密钥（${DEF_DESC}），走真实 LLM 分析分支"
  fi
fi

APP_PORT=$PORT2 DB_PATH="$SDIR2/live.db" EXPORT_DIR="$SDIR2/exports" SCENE_PROVIDERS_FILE="$PROVIDERS_FILE" WEB_DIST="$ROOT/apps/web/dist" \
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
  echo "· $PROVIDERS_LABEL"
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

# E2E 用固定端口 4180/4181：上一次失败可能留下服务，先把端口清干净再跑，
# 否则 playwright 会以「4181 already used」直接失败（而不是测试失败，容易误判）。
#
# 安全约束（重要）：**只杀白名单命令的进程**。本脚本的父进程是 DSH 桌面宿主，
# 按端口取到的裸 PID 若不校验命令就 kill，一旦取到宿主进程会直接杀掉用户会话。
kill_our_server_on_port() {
  local port="$1" pid cmd
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    case "$cmd" in
      # 注意：vite preview 的真实命令行是 `node .../vite.js preview --port 4180`，
      # 用 *"vite preview"* 匹配不上（中间隔着 vite.js）——曾导致残留服务没被清掉，
      # 下一次 E2E 直接因「4180 already in use」起不来（而不是测试失败，极易误判）
      *vite*preview*|*apps/server/dist/index.js*)
        echo "· 清理上一次遗留的 :$port 服务（PID ${pid}）"
        kill "$pid" 2>/dev/null || true
        ;;
      "")
        ;;
      *)
        echo "· 注意：:$port 被非本项目进程占用（PID ${pid}），跳过：$(printf '%s' "$cmd" | cut -c1-70)"
        ;;
    esac
  done
}
for P in 4180 4181; do kill_our_server_on_port "$P"; sleep 1; done

E2E_OUT=$(npm run test:e2e 2>&1) && E2E_OK=1 || E2E_OK=0

# 收尾：无论成败都清掉 E2E 起的服务，避免污染后续手工验证（同样只杀白名单）
for P in 4180 4181; do kill_our_server_on_port "$P"; done
if [ "$E2E_OK" = "1" ]; then
  EN=$(printf '%s' "$E2E_OUT" | grep -Eo "[0-9]+ passed" | tail -1 || echo "?")
  echo "✅ 演示模式 E2E 通过（${EN}）"
else
  echo "❌ 演示模式 E2E 失败（末 15 行）："
  printf '%s\n' "$E2E_OUT" | tail -15
  FAIL=1
fi

echo ""
echo "=== [M5 验收] 6/6 契约与文档收口 ==="
# 注意：本函数用 grep 基本正则（BRE）——模式不要以 * 开头（会报 repetition-operator
# operand invalid，表现为"文档缺少"其实只是模式非法），含 . * 的才当正则用。
check_contains() {
  if grep -q "$2" "$ROOT/$1"; then
    echo "✅ $1 · $3"
  else
    echo "❌ $1 缺少：$3"
    FAIL=1
  fi
}
check_contains "package.json" '"start":' "冷启动一条命令 npm start 在册（故障 #9）"
check_contains "package.json" 'copy-infra-sql.mjs' "start 前同步 SQL 迁移文件（tsc -b 不拷贝 .sql）"
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
check_contains "docs/故障及解决清单.md" "| 9 |" "故障 #9 npm start 冷启动记录"
check_contains "docs/故障及解决清单.md" "| 10 |" "故障 #10 联真模式 mock 残留记录"
check_contains "03-数据契约与API.md" "v1.6" "契约版本记录 v1.6（模型配置应用自持）"
check_contains "03-数据契约与API.md" "system/providers" "供应商登记端点契约登记"
check_contains "docs/项目变更表.md" "| 16 |" "变更表 #16 模型配置应用自持登记"
# ── v2.0 信息模型收口 ──────────────────────────────────────
check_contains "03-数据契约与API.md" "v2.0" "契约版本记录 v2.0（信息模型重构）"
check_contains "03-数据契约与API.md" "/stages/{n}/completeness" "信息完整度端点登记（替代质量关）"
check_contains "03-数据契约与API.md" "/stages/{n}/summary" "阶段总结端点登记"
check_contains "03-数据契约与API.md" "/projects/{id}/brief" "场景诉求端点登记（第一输入）"
check_contains "03-数据契约与API.md" "只有「用户确认」「用户补充」可被下游当依据" "确认机制铁律登记"
check_contains "docs/项目变更表.md" "| 53 |" "变更表 #53 三段式诉求与 SQL 迁移修复"
# ── v2.1 业务流程逐页推进收口 ──────────────────────────────
check_contains "03-数据契约与API.md" "v2.1" "契约版本记录 v2.1（逐页推进）"
check_contains "03-数据契约与API.md" "/flow/steps/{n}/complete" "流程推进端点登记"
check_contains "03-数据契约与API.md" "scenario_step" "流程步完成表登记"
check_contains "03-数据契约与API.md" "data_scope" "资料合并来源可区分登记"
check_contains "docs/项目变更表.md" "| 55 |" "变更表 #55 逐页推进登记"
# ── v2.2 场景定义对话收口 ─────────────────────────────────
check_contains "03-数据契约与API.md" "v2.2" "契约版本记录 v2.2（场景定义对话）"
check_contains "03-数据契约与API.md" "/definition/consolidate" "「整理成定义」端点登记"
check_contains "03-数据契约与API.md" "只在用户点「整理成定义」时才写表" "显式写表规则登记"
check_contains "04-业务过程重定义.md" "v1.6" "业务过程 v1.6（对话式定义）"
# ── v2.3 流程收成 8 步 ───────────────────────────────────
check_contains "03-数据契约与API.md" "v2.3" "契约版本记录 v2.3（流程收成 8 步）"
check_contains "07-业务流程总表.md" "用户可见的 8 步流程" "流程总表改为 8 步"
check_contains "01-产品定义.md" "8 个阶段（0-7，数据落库口径）" "产品定义流程概览为 8 阶段 0-7"
# ── v2.4 放松场景定义 ────────────────────────────────────
check_contains "03-数据契约与API.md" "v2.4" "契约版本记录 v2.4（放松定义口径）"
check_contains "03-数据契约与API.md" "定义已整理" "第 1 步就绪降为「定义已整理」"
check_contains "07-业务流程总表.md" "不要求确认齐全" "流程总表就绪条件改「不要求确认齐全」"
check_contains "04-业务过程重定义.md" "v1.7" "业务过程 v1.7（放松定义）"
check_contains "docs/项目变更表.md" "| 61 |" "变更表 #61 放松定义登记"
# ── v2.9 资料来源默认引用 + 进度卡一行收口 ────────────────
check_contains "03-数据契约与API.md" "v2.9" "契约版本记录 v2.9（默认引用 + 删解锁全部）"
check_contains "03-数据契约与API.md" "scenario_linked_line.excluded" "通用库取消引用（excluded）登记"
check_contains "01-产品定义.md" "没有「解锁全部」" "产品定义：锁步推进、无解锁入口"
check_contains "04-业务过程重定义.md" "v1.11" "业务过程 v1.11（进度卡一行）"
check_contains "docs/项目变更表.md" "| 66 |" "变更表 #66 资料默认引用登记"
check_contains "docs/项目变更表.md" "| 67 |" "变更表 #67 进度卡一行登记"
# 负向守卫：「解锁全部步骤」必须从契约 / 领域 / 服务 / 前端四条链路彻底消失
# （测试文件除外——`flow-service.test.ts` 反向断言该端点已 404，必须留着那个路径字面量）
UNLOCK_HITS=$(grep -rn "unlock-all\|unlockedAll\|unlockAllFlowSteps" "$ROOT/apps/web/src" "$ROOT/apps/server/src" "$ROOT/packages/contract/src" "$ROOT/packages/domain/src" --include=*.ts --include=*.tsx 2>/dev/null | grep -v "\.test\.ts" || true)
if [ -n "$UNLOCK_HITS" ]; then
  echo "❌ 仍存在「解锁全部步骤」残留（用户定调：不需要这个功能）"
  echo "$UNLOCK_HITS" | head -3
  FAIL=1
else
  echo "✅ 「解锁全部步骤」已从契约/领域/服务/前端彻底移除（测试里的 404 反向断言除外）"
fi
# 负向守卫：进度卡不得再有第二行提示与序号节点
if grep -q "flow-hint\|flow-node-no" "$ROOT/apps/web/src/components/FlowRail.tsx" 2>/dev/null; then
  echo "❌ 进度卡仍渲染第二行提示或序号（用户定调：只一行、去掉序号）"
  FAIL=1
else
  echo "✅ 进度卡只一行：无第二行提示、无序号节点"
fi
if [ -f "$ROOT/05-表格定义总表.md" ] && pnpm check:docs >/dev/null 2>&1; then
  echo "✅ 05-表格定义总表.md 与表定义注册表一致（漂移守卫）"
else
  echo "❌ 05 与注册表不一致（跑 pnpm gen:docs 重新生成）"
  FAIL=1
fi
if grep -q "建议通过\|建议不通过" "$ROOT/apps/server/src/stage-prompts.ts" 2>/dev/null; then
  echo "❌ 提示词里仍出现建议档位措辞（产品不产出判断）"
  FAIL=1
else
  echo "✅ 提示词不含建议档位措辞（信息版口径）"
fi
if grep -rq "adviceFromGateRecords\|decideAdvice" "$ROOT/apps" "$ROOT/packages" --include=*.ts --exclude-dir=dist --exclude-dir=node_modules 2>/dev/null; then
  echo "❌ 旧门禁装置仍被引用"
  FAIL=1
else
  echo "✅ 旧门禁装置（质量关/建议三档）已彻底移除"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== M5 验收：全部通过 ✅ ==="
  exit 0
else
  echo "=== M5 验收：存在失败项 ❌ ==="
  exit 1
fi
