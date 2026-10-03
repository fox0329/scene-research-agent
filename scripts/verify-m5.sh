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
check_contains "04-业务过程重定义.md" "v1.12" "业务过程 v1.12（进度卡保留关键词、去圆点）"
check_contains "docs/项目变更表.md" "| 68 |" "变更表 #68 关键词进度卡登记"
# ── v2.10 右栏只讲当前步骤 ───────────────────────────────
check_contains "03-数据契约与API.md" "v2.10" "契约版本记录 v2.10（右栏只讲当前步骤）"
check_contains "03-数据契约与API.md" "?step=N" "总结/完整度的 step 限定登记"
check_contains "04-业务过程重定义.md" "v1.13" "业务过程 v1.13（右栏只讲当前步骤）"
check_contains "04-业务过程重定义.md" "右栏只针对当前步骤" "右栏步骤级口径登记"
check_contains "docs/项目变更表.md" "| 69 |" "变更表 #69 右栏只讲当前步骤登记"
# ── v1.14 中栏表格：逐列独立拖宽 + 内容换行 + 行高随内容 ──────
check_contains "04-业务过程重定义.md" "v1.14" "业务过程 v1.14（中栏表格三项优化）"
check_contains "04-业务过程重定义.md" "每列独立可拖" "逐列独立拖宽口径登记"
check_contains "04-业务过程重定义.md" "内容换行 + 行高随内容长" "换行与行高口径登记"
check_contains "docs/项目变更表.md" "| 70 |" "变更表 #70 中栏表格优化登记"
check_contains "04-业务过程重定义.md" "v1.15" "业务过程 v1.15（去掉隐形填充列、表宽恒等于中栏宽）"
check_contains "04-业务过程重定义.md" "表宽恒等于中栏宽" "不出横向滚动的口径登记"
check_contains "docs/项目变更表.md" "| 71 |" "变更表 #71 中栏表格修正登记"
# 正向守卫：本步分析的进度必须读服务端的 message（只读 text 会每条都显示同一句"分析中…"）
if grep -qF "ev.message ?? ev.text" "$ROOT/apps/web/src/hooks/useStageAnalysis.ts" && \
   grep -qF '已输出 ${text.length} 字' "$ROOT/apps/server/src/advance-stage.ts"; then
  echo "✅ 本步分析进度：读 message 字段 + 生成过程有心跳（不再一直显示「分析中」）"
else
  echo "❌ 本步分析进度线断了（用户定调：不认「一直分析中」）"
  FAIL=1
fi
# 正向守卫：模型流必须有超时，供应商卡死不能把页面永远挂在"分析中"
if grep -qF "LLM_IDLE_TIMEOUT_MS" "$ROOT/packages/infra/src/dsh-client.ts" && \
   grep -qF "超时" "$ROOT/packages/infra/src/dsh-client.ts"; then
  echo "✅ 模型流空闲超时（卡死会报超时并可重试）"
else
  echo "❌ 模型流没有超时，供应商卡死会永远显示「分析中」"
  FAIL=1
fi
check_contains "docs/项目变更表.md" "| 73 |" "变更表 #73 分析中修正登记"
# 正向守卫：v1.16 中栏只剩信息（表名一行、无表号）+ 分析入口在流程轴按钮位
check_contains "04-业务过程重定义.md" "v1.16" "业务过程 v1.16（分析步中栏只剩信息）"
check_contains "docs/项目变更表.md" "| 74 |" "变更表 #74 中栏信息口径登记"
# v1.17 守卫：商业理解（第 3 步）的行业行情必须写满，不许把市场调研退回给用户
check_contains "04-业务过程重定义.md" "v1.17" "业务过程 v1.17（商业理解的行业行情口径）"
check_contains "docs/项目变更表.md" "| 75 |" "变更表 #75 市场行情口径登记"
check_contains "apps/server/src/stage-prompts.ts" "市场行情必须由你写出来" "商业理解：行业行情必须由模型写满"
check_contains "apps/server/src/stage-prompts.ts" "行业通例（模型知识）" "行业行情须标 C/T4（待验证由 authority 列表达）"
# v1.25：来源标记不再写进格子（用户定调「要谁去核实？没必要写」），且删掉跨阶段补填
if grep -q "内容里用「（行业通例，待核实）」" "$ROOT/apps/server/src/stage-prompts.ts"; then
  echo "❌ 提示词又要求把来源标记写进格子（用户已定调不写）"
  FAIL=1
else
  echo "✅ 格子里不写来源标记（来源属性只进 source/evidence_level/authority 三列）"
fi
if grep -qE "filledInStages|filterRowByStage|crossStageTables" "$ROOT/packages/contract/src/tables.ts"; then
  echo "❌ 契约里又出现跨阶段补填机制（后面的步不会回头更新上游表，那类列永远填不上）"
  FAIL=1
else
  echo "✅ 无跨阶段补填机制（表2-5/表3-8 的死列已删）"
fi
for gone in "is_digital" "current_status" "compliance_path"; do
  if grep -q "$gone" "$ROOT/packages/contract/src/tables.ts"; then
    echo "❌ 已删的列又回来了：$gone"
    FAIL=1
  fi
done
echo "✅ 已删列不再出现（有无电子部分 / 门槛现状 / 实现路径·责任人·状态）"
check_contains "packages/infra/src/dsh-client.ts" "LLM_MAX_TOKENS" "单次生成给足输出预算（避免中途截断）"
# 反向守卫：连接超时只盖「等到响应头」，不得挂到 fetch 上（会把跑过 60 秒的分析整条掐断）
if grep -qF "AbortSignal.timeout(connectTimeoutMs)" "$ROOT/packages/infra/src/dsh-client.ts"; then
  echo "❌ 连接超时又挂到 fetch 上了：任何跑过 60 秒的分析都会被自己掐死"
  FAIL=1
else
  echo "✅ 连接超时只盖握手，不掐长流"
fi
# 反向守卫：截断 / 解析不出行 = 失败，且必须**先判空再清库**（否则重算把本步数据清零）
if grep -qF 'finishReason === "length"' "$ROOT/apps/server/src/advance-stage.ts" && \
   [ "$(grep -n 'dshOutput.rows.length === 0' "$ROOT/apps/server/src/advance-stage.ts" | head -1 | cut -d: -f1)" -lt "$(grep -n 'db.stageDataRepo.deleteByScenarioStage' "$ROOT/apps/server/src/advance-stage.ts" | head -1 | cut -d: -f1)" ]; then
  echo "✅ 截断/解析失败按失败处理，且先判空再清库（不会清空用户数据）"
else
  echo "❌ 截断或空结果的判定丢了／顺序错了：重算会把本步数据清空"
  FAIL=1
fi
if grep -qE "AnchorFoldPanel|本步信息表|完成本步，进入下一步|重算本步分析" "$ROOT/apps/web/src/views/RealStagePanel.tsx"; then
  echo "❌ 中栏又冒出表1-1／小标题／动作按钮（用户定调：上一步的信息不要在这一步显示、上面有下一步）"
  FAIL=1
else
  echo "✅ 分析步中栏只剩信息（无表1-1、无小标题、无动作按钮）"
fi
if grep -qF "开始本步分析" "$ROOT/apps/web/src/components/FlowRail.tsx" && \
   grep -qF "useStageAnalysis" "$ROOT/apps/web/src/views/ProjectView.tsx" && \
   grep -qF "{t.name}" "$ROOT/apps/web/src/views/RealStagePanel.tsx"; then
  echo "✅ 分析入口在流程轴按钮位 + 表名一行（不带表号）"
else
  echo "❌ 分析入口或表名行被改动（没产出时必须能发起分析；表名不带表号）"
  FAIL=1
fi
# 正向守卫：只改被拖那一列的像素模型 + 表宽恒等于中栏宽（末列承接余量）+ 多行编辑器
if grep -qF "末列不给宽" "$ROOT/apps/web/src/components/SceneTable.tsx" && \
   grep -q "scene.colwidths.v4" "$ROOT/apps/web/src/components/SceneTable.tsx" && \
   grep -q "AutoGrowTextarea" "$ROOT/apps/web/src/components/SceneTable.tsx" && \
   grep -q "multiline: true" "$ROOT/apps/web/src/components/SchemaTable.tsx"; then
  echo "✅ 中栏表格：像素列宽（末列承接余量）+ 多行编辑器（只改被拖那一列）"
else
  echo "❌ 中栏表格缺少末列承接余量/多行编辑器（用户定调：拖一条线只动这一列、内容要换行）"
  FAIL=1
fi
# 负向守卫：不得再有隐形的填充列（用户："明明只有 2 列有内容，表格却有 3 列"）
if grep -q "col-fill" "$ROOT/apps/web/src/components/SceneTable.tsx" "$ROOT/apps/web/src/styles/app.css"; then
  echo "❌ 表格又出现隐形填充列（用户定调：表里只有业务列）"
  FAIL=1
else
  echo "✅ 表格只有业务列（无隐形填充列）"
fi
# 负向守卫：末列右缘就是表右缘，不该再给它装拖宽手柄
if grep -qF "ci < columns.length - 1 ? resizeHandle(col) : null" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "✅ 只在列与列之间装拖宽手柄（末列不装）"
else
  echo "❌ 拖宽手柄的安装位置变了（末列不该有手柄）"
  FAIL=1
fi
# 负向守卫：旧实现（两项交换）的调用点是 startResize(本列, 下一列, e)——必须只剩单列参数
if grep -qF "startResize(col.key, columns[ci + 1]" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "❌ 列宽拖拽又变回两侧列交换宽度（用户定调：不影响其他列）"
  FAIL=1
elif grep -qF "startResize(col.key, e)" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "✅ 拖分割线只改被拖的那一列（不再交换两侧宽度）"
else
  echo "❌ 找不到单列拖拽调用点（SceneTable 的列宽机制被改动过？）"
  FAIL=1
fi
# v1.18 守卫：列宽自动适配到「行高最小」，且自动适配的宽不得当成用户手动宽度留存
check_contains "04-业务过程重定义.md" "v1.18" "业务过程 v1.18（列宽自动适配）"
check_contains "docs/项目变更表.md" "| 76 |" "变更表 #76 列宽自动适配登记"
check_contains "apps/web/src/components/table-fit.ts" "fitWidthsMinHeight" "列宽适配是独立的纯函数（可单测）"
check_contains "apps/web/src/components/SceneTable.tsx" "demandsSigRef" "适配前校验需求与当前列集同源"
# 反向守卫：只有用户手动拖过才留存——否则下次生成会沿用旧内容的宽度（列挤成一条、行撑得高）
if grep -qF "if (!storageKey || widths === null || !manualRef.current) return;" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "✅ 只有用户手动拖过的列宽才留存（自动适配不留存）"
else
  echo "❌ 列宽留存的判定丢了：自动适配的宽会被当成用户手动宽度存下来，下次生成就沿用旧宽"
  FAIL=1
fi
# 反向守卫：v3 键（把自动宽度也存下来的旧口径）不得再用
if grep -q "colwidths.v3" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "❌ 又开始读写 v3 列宽键（旧键里存的是自动适配的宽，会让表格永远不重新适配）"
  FAIL=1
else
  echo "✅ 列宽留存只用 v4 键（v3 的自动宽度视为无效）"
fi
# 反向守卫：生成/重算要触发重新适配（行集变化 → 回测量态）
if grep -qF "dataSig" "$ROOT/apps/web/src/components/SceneTable.tsx"; then
  echo "✅ 行集变化（表格刚生成/重算）会触发重新适配"
else
  echo "❌ 内容变化不再触发重新适配：生成后还得用户一列列自己调"
  FAIL=1
fi
if grep -qF "列宽自动适配" "$ROOT/e2e/interaction.spec.ts"; then
  echo "✅ E2E 覆盖列宽自动适配（生成即紧凑、未拖不留存、双击恢复）"
else
  echo "❌ 缺少列宽自动适配的 E2E 用例"
  FAIL=1
fi
# v1.21 守卫：前两步只梳理场景现状，公司能力到「能力匹配」才进场
check_contains "04-业务过程重定义.md" "v1.21" "业务过程 v1.21（场景侧与公司侧分家）"
check_contains "docs/项目变更表.md" "| 79 |" "变更表 #79 场景现状口径登记"
check_contains "packages/contract/src/tables.ts" "code: \"表4-2\"" "新增表4-2 我方参与地图（公司能力进场的第一步）"
# 正向守卫：公司材料只在阶段 3 及以后注入（根因：每个阶段都注入 M1–M6，模型看着自家产品写场景）
check_contains "apps/server/src/advance-stage.ts" "if (stage >= 3) {" "公司材料只在阶段 3+ 注入"
# 正向守卫：阶段 1/2 提示词必须写明「只写现状、不得出现我方视角」
check_contains "apps/server/src/stage-prompts.ts" "只写这个场景" "阶段 1 提示词限定只写场景现状"
check_contains "apps/server/src/stage-prompts.ts" "同样禁止出现我方视角" "阶段 2 提示词禁止我方视角"
check_contains "apps/server/src/stage-prompts.ts" "公司能力从这里进场" "阶段 3 提示词说明公司能力进场"
# 反向守卫：第 2、3 步（阶段 1、2）的表里不得再出现公司侧列
# 只看阶段 1–2 的两段定义（表4-2 里 can_touch/our_role 是**应该**有的——那是阶段 3 的公司侧镜像）
awk '/^\/\/ ─── 阶段 1 ·/,/^\/\/ ─── 阶段 3 ·/' "$ROOT/packages/contract/src/tables.ts" > /tmp/vm5-stage12.txt
for bad in 'mid("can_touch"' 'mid("our_role"' 'mid("our_entry"' 'mid("our_advantage"' 'mid("implication"' 'mid("judgment"'; do
  if grep -qF "$bad" /tmp/vm5-stage12.txt; then
    echo "❌ 公司侧列又出现在第 2、3 步的表里：${bad}（前两步只写场景现状，我方视角归阶段 3）"
    FAIL=1
  fi
done
rm -f /tmp/vm5-stage12.txt
echo "✅ 第 2、3 步中栏不含公司侧列（可参与程度/我方角色/我方切入点/我方优势/对我方含义）"
# 正向守卫：迁走的公司侧内容在阶段 3 有落点（参与地图 / 细分优先级 / 竞争力判断）
check_contains "packages/contract/src/tables.ts" "role_reason" "表4-2 承接角色判定依据"
check_contains "packages/contract/src/tables.ts" "market_form" "表4-4 承接对应市场形态或趋势"
check_contains "packages/contract/src/tables.ts" "compared_with" "表4-5 承接对照对象"
# 正向守卫：存量数据要有迁移脚本（默认 dry-run）
check_contains "scripts/migrate-scene-vs-company.mjs" "表1-2 → 表4-2" "存量迁移脚本在册（表1-2 → 表4-2）"
check_contains "scripts/migrate-scene-vs-company.mjs" "表4-2" "迁移目标表正确"
# 正向守卫：测试必须真的跑源码（tsc 就地编译的 .js 会让测试跑旧代码，见故障 #24）
if [ -f "$ROOT/packages/contract/src/tables.js" ]; then
  echo "❌ 源码目录里有 tsc 就地编译的 .js：测试会跑旧代码（故障 #24）"
  FAIL=1
else
  echo "✅ 源码目录无就地编译残留（测试跑的是 .ts 源码）"
fi
check_contains "package.json" "clean:stray" "pretest 清理残留编译产物"
check_contains "docs/故障及解决清单.md" "测试跑的还是上次编译的产物" "故障 #24 登记（单测测旧代码）"
check_contains "docs/故障及解决清单.md" "按表并发后整步报「完成」" "故障 #25 登记（并发提前收工/就绪判据）"

# v1.23 守卫：八步同形（第 1 步的动作也在流程轴上，中栏不留按钮、不留重跑提示条）
check_contains "04-业务过程重定义.md" "v1.23" "业务过程 v1.23（八步同形动作位）"
check_contains "docs/项目变更表.md" "| 81 |" "变更表 #81 动作位同形登记"
check_contains "apps/web/src/components/FlowRail.tsx" "RailRunAction" "流程轴只有一个运行按钮契约（八步共用）"
check_contains "apps/web/src/views/ProjectView.tsx" "stepDef.kind === \"确认\"" "确认步也走流程轴运行按钮"
check_contains "apps/web/src/views/ProjectView.tsx" "definitionDialogOpen" "定义对话弹窗由流程轴按钮驱动"
check_contains "apps/web/src/views/AnchorStepPanel.tsx" "definitionOpen" "联真第 1 步弹窗受控（入口在流程轴）"
check_contains "apps/web/src/views/DemoFlowPanels.tsx" "definitionOpen" "演示态第 1 步同形（入口在流程轴）"
check_contains "04-业务过程重定义.md" "v1.24" "业务过程 v1.24（流程轴只留两个按钮）"
check_contains "docs/项目变更表.md" "| 82 |" "变更表 #82 导航按钮删除登记"
# 反向守卫：流程轴上不再有导航按钮（用户定调：回到哪一步直接点阶段名称）
if grep -qE ">[[:space:]]*回到(当前步|这一步)" "$ROOT/apps/web/src/components/FlowRail.tsx"; then
  echo "❌ 流程轴又出现导航按钮（回到这一步/回到当前步）：回到哪一步直接点阶段名称"
  FAIL=1
else
  echo "✅ 流程轴只留「重算本步/开始本步分析」+「下一步」"
fi
# 反向守卫：中栏不再有「场景定义对话」按钮，也不再有那条重跑提示条
if grep -q "场景定义对话</button>" "$ROOT/apps/web/src/views/AnchorStepPanel.tsx" "$ROOT/apps/web/src/views/DemoFlowPanels.tsx"; then
  echo "❌ 中栏又出现「场景定义对话」按钮：动作只留流程轴（八步同形）"
  FAIL=1
fi
if grep -q "flow-reopen" "$ROOT/apps/web/src/views/ProjectView.tsx"; then
  echo "❌ 中栏又出现重跑提示条（flow-reopen）：回看重跑走流程轴「回到这一步」"
  FAIL=1
fi
check_contains "e2e/interaction.spec.ts" "八步同形" "八步同形有 E2E 用例"

# v1.22 守卫：按表并发生成（延迟 ≈ 最慢那张表；单表失败不拖垮整步）
check_contains "04-业务过程重定义.md" "v1.22" "业务过程 v1.22（按表并发生成）"
check_contains "docs/项目变更表.md" "| 80 |" "变更表 #80 按表并发登记"
check_contains "packages/contract/src/tables.ts" "dependsOnTables" "契约声明本步内的真实依赖"
check_contains "packages/contract/src/tables.ts" "dependsOnTables" "依赖在契约里声明（要素清单先跑）"
check_contains "apps/server/src/advance-stage.ts" "export function readyTables" "就绪队列是纯函数（可单测）"
check_contains "apps/server/src/advance-stage.ts" "args.finished.has(d)" "等的是依赖完成，不是依赖开始"
check_contains "apps/server/src/advance-stage.ts" "STAGE_TABLE_CONCURRENCY" "并发上限可配（默认 5）"
# 单表失败必须只丢该表：逐表删，失败表沿用原有内容
check_contains "apps/server/src/advance-stage.ts" "deleteByScenarioStageTable" "逐表覆盖（失败表不被清空）"
check_contains "packages/infra/src/sqlite-repo.ts" "deleteByScenarioStageTable" "仓储提供逐表删除"
if grep -q "db.stageDataRepo.deleteByScenarioStage(scenarioId, stage);" "$ROOT/apps/server/src/advance-stage.ts"; then
  echo "❌ 又整阶段删了：单表失败会把该表原有内容一起清掉（应按表删）"
  FAIL=1
else
  echo "✅ 不再整阶段删（逐表覆盖，失败表沿用原内容）"
fi
check_contains "apps/server/src/advance-stage.ts" "tablesFailed" "未生成的表要明说（done.tablesFailed）"
check_contains "apps/web/src/views/ProjectView.tsx" "部分未生成" "中栏提示条报出未生成的表"
check_contains "apps/server/src/stage-prompts.ts" "siblings" "并发时把兄弟表列给模型对齐口径"
check_contains "apps/server/src/advance-stage.test.ts" "同一批的多张表同时在跑" "并发行为有单测（峰值并发 ≥ 2）"
check_contains "apps/server/src/advance-stage.test.ts" "失败表沿用原有内容" "单表失败不拖垮整步有单测"
check_contains "packages/contract/src/tables.test.ts" "dependsOnTables" "依赖声明有单测（含不跨阶段）"
check_contains "apps/server/src/advance-stage.test.ts" "就绪队列" "就绪队列有单测（完成即放行/环兜底）"
check_contains "apps/server/src/advance-stage.test.ts" "最后才起始的依赖表也必须落库" "收工条件回归用例在册（不准全部开始就收工）"

# v1.20 守卫：进度不进中栏（中栏只放信息），进度只留在流程轴按钮上
check_contains "04-业务过程重定义.md" "v1.20" "业务过程 v1.20（进度不进中栏）"
check_contains "docs/项目变更表.md" "| 78 |" "变更表 #78 进度只留流程轴登记"
# 反向守卫：中栏不许再出现进度块（跑完留一屏"模型已输出…/完成"就是用户报的残留）
if grep -qF "本步分析输出" "$ROOT/apps/web/src/views/RealStagePanel.tsx"; then
  echo "❌ 中栏又出现进度块了：跑完会留下「本步分析／模型已输出…」的残留（用户实测反馈）"
  FAIL=1
else
  echo "✅ 中栏不含进度块（进度只在流程轴按钮上）"
fi
if grep -qF "streamLines" "$ROOT/apps/web/src/views/RealStagePanel.tsx"; then
  echo "❌ 中栏又在渲染进度行（streamLines）"
  FAIL=1
else
  echo "✅ 中栏不渲染进度行"
fi
# 正向守卫：运行中按钮 title 要能显示最新一行进度（否则只剩一个静止的计时）
check_contains "apps/web/src/components/FlowRail.tsx" "run.progress" "运行中按钮 title 显示最新进度"
check_contains "apps/web/src/components/FlowRail.tsx" "run.elapsedLabel" "重算按钮运行中显示最新进度与计时"
check_contains "apps/web/src/views/ProjectView.tsx" "analysis.streamLines.at(-1)" "最新一行进度喂给流程轴"
# 非致命情况（续连没接回来）必须有可见出口：进度行不显示了，只能靠提示
check_contains "apps/web/src/hooks/useStageAnalysis.ts" "onWarn" "非致命情况有可见提示出口"
# 正向守卫：失败要有**常驻**出口（进度区没了以后，几秒就消失的提示条不能是唯一出口）
if grep -qF "analysisNotice" "$ROOT/apps/web/src/views/ProjectView.tsx" && \
   grep -qF "本步分析失败" "$ROOT/apps/web/src/views/ProjectView.tsx"; then
  echo "✅ 分析失败有常驻横幅（进度区不再进中栏，失败仍看得见）"
else
  echo "❌ 分析失败只剩几秒的提示条：用户不知道为什么没结果"
  FAIL=1
fi

# v1.19 守卫：进度通道断线要能自己接回来，收尾必须无条件对账（不许停在「分析中」）
check_contains "04-业务过程重定义.md" "v1.19" "业务过程 v1.19（断线续连 + 收尾对账）"
check_contains "docs/项目变更表.md" "| 77 |" "变更表 #77 断线续连登记"
check_contains "apps/web/src/hooks/analysis-stream.ts" "consumeAnalysisStream" "进度流消费是独立的可单测模块"
check_contains "apps/web/src/hooks/analysis-stream.ts" "DEFAULT_STALL_MS" "连接看门狗（静默即断线）在册"
check_contains "apps/web/src/hooks/useStageAnalysis.ts" "reconnectStageStream" "断线按 Last-Event-ID 续连"
# 反向守卫：收尾必须无条件对账（原来只在 done 里刷新，连接断了就永远停在「分析中」）
if grep -qF "onSettled?.();" "$ROOT/apps/web/src/hooks/useStageAnalysis.ts" && \
   grep -qF "onSettled:" "$ROOT/apps/web/src/views/ProjectView.tsx"; then
  echo "✅ 运行结束（含断线/失败）一律对账刷新，界面不会停在「分析中」"
else
  echo "❌ 收尾对账丢了：连接断了界面会永远停在「分析中」（用户实测事故）"
  FAIL=1
fi
# 反向守卫：模型不吐字时也要有按时间的「仍在思考」心跳（否则界面一条事件都没有）
check_contains "apps/server/src/advance-stage.ts" "模型仍在思考" "模型空闲时按时间补心跳"
# 反向守卫：心跳不得吞掉真实事件（tick 后必须继续等同一份读取）
if grep -qF "const reader = createEventReader" "$ROOT/apps/server/src/advance-stage.ts"; then
  echo "✅ 心跳与读取共用同一份结果（不会把已吐出的事件吞掉）"
else
  echo "❌ 心跳又把读取丢掉了：模型吐的字可能被吞，导致整步分析失败"
  FAIL=1
fi
if grep -q "td.ed" "$ROOT/apps/web/src/styles/app.css" && \
   awk '/^td\.ed \{/,/\}/' "$ROOT/apps/web/src/styles/app.css" | grep -q "nowrap"; then
  echo "❌ 可编辑单元格仍是单行截断（用户定调：内容换行、行高随内容）"
  FAIL=1
else
  echo "✅ 可编辑单元格允许换行（行高随内容长）"
fi

# 负向守卫：右栏的步骤级总结不得再引用诉求全文与上下游衔接
if grep -q "briefRawText" "$ROOT/packages/domain/src/stage-summary.ts" &&    grep -q 'scope !== "step" && input.briefRawText' "$ROOT/packages/domain/src/stage-summary.ts" &&    grep -q 'scope !== "step"' "$ROOT/packages/domain/src/stage-summary.ts"; then
  echo "✅ 步骤级总结已隔离诉求全文与上下游衔接（只在阶段级/交付物出现）"
else
  echo "❌ 步骤级总结仍会带上诉求全文或上下游衔接（用户定调：不要整理整个过程）"
  FAIL=1
fi
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
# 负向守卫：进度卡不得再有第二行提示、序号或圆点；正向守卫：必须显示关键词
if grep -q "flow-hint\|flow-node-no\|flow-node-dot" "$ROOT/apps/web/src/components/FlowRail.tsx" 2>/dev/null; then
  echo "❌ 进度卡仍渲染第二行提示/序号/圆点（用户定调：只一行、去掉序号、不要圆点）"
  FAIL=1
else
  echo "✅ 进度卡只一行：无第二行提示、无序号、无圆点"
fi
if grep -q "flow-node-tt" "$ROOT/apps/web/src/components/FlowRail.tsx" && grep -q "short" "$ROOT/packages/contract/src/flow.ts"; then
  echo "✅ 进度卡保留关键词节点（简化标题来自契约 short 字段）"
else
  echo "❌ 进度卡关键词节点缺失（用户定调：不要只有圆点，保留场景定义/能力匹配这些关键词）"
  FAIL=1
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
