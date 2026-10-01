/**
 * @scene/server — 业务流程推进服务（v1.5 逐页推进）
 *
 * 职责：算出 8 步流程的当前状态（就绪判定 + 锁步），并处理用户的推进动作。
 *
 * 三条既定规则（用户确认）：
 *  1. **数据判定可用 + 用户点「完成本步」推进**——本模块算 `ready`，不自动完成
 *  2. **默认锁步**，可一键「解锁全部步骤」
 *  3. **已完成的步骤可随时回去重跑**——重跑清掉该步及其后的完成标记，数据保留
 *
 * 就绪判定（按步骤类型）：
 *  - 输入（第 1 步）：`scenario_brief.intent` 非空
 *  - 确认（第 1 步）：**定义已整理**即可推进（不要求逐项确认；用户常说不准）
 *  - 分析（第 3-8 步）：本步表集中至少 1 张有数据（**只要求有产出，不要求齐备**）
 *  - 组装（第 8 步）：随时可生成交付物
 */

import {
  FLOW_LAST_STEP,
  FLOW_STEPS,
  flowStep,
  type Scenario,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  buildFlowStatus,
  l1Rows,
  type FlowReadiness,
  type FlowStatus,
} from "@scene/domain";
import { readAnchorRows } from "./scenario-anchor.js";
import { readStageRowsByTable } from "./stage-summary-service.js";

/** 步骤就绪判定的统一形态 */
function readinessOf(
  ready: boolean,
  readyHint: string,
  progress?: { tablesWithData: number; expectedTables: number; rows: number },
): FlowReadiness {
  return progress ? { ready, readyHint, progress } : { ready, readyHint };
}

/** 表集产出统计（表数与行数） */
function tableProgress(
  db: DbInstance,
  scenarioId: string,
  tables: readonly string[],
  stage: number | null,
): { tablesWithData: number; expectedTables: number; rows: number } {
  const rowsByTable =
    stage === null ? {} : readStageRowsByTable(db, scenarioId, stage as never);
  let tablesWithData = 0;
  let rows = 0;
  for (const code of tables) {
    const list = rowsByTable[code] ?? [];
    if (list.length > 0) tablesWithData += 1;
    rows += list.length;
  }
  return { tablesWithData, expectedTables: tables.length, rows };
}

/**
 * 读取场景流程状态（就绪判定 + 锁步状态）
 */
export function getFlowState(db: DbInstance, scenario: Scenario): FlowStatus {
  const completed = db.scenarioStepRepo.completedSteps(scenario.id);
  const anchor = readAnchorRows(db, scenario.id);
  const byItem = new Map(anchor.map((a) => [a.item, a]));
  const readiness: Record<number, FlowReadiness> = {};

  for (const step of FLOW_STEPS) {
    switch (step.kind) {
      case "确认": {
        // 第 1 步「场景定义与边界」：**门槛降到"整理过就算"**
        //
        // 用户定调："场景定义要求太细了，要抽象一点，用户很多时候也没有说要定义那么准确，
        // 更多的是要对行业有个比较全面的了解"，且明确"定义不影响后面的业务流程"。
        // 因此这里不再要求 6 项 L1 全部确认，只看**定义是否整理过**
        // （表1-1 里除预填的「场景名称」外，至少一项有内容）。
        // 核心 2 项（客户类型/行业、覆盖什么）只在 hint 里提示，不阻断推进。
        const filledRows = anchor.filter(
          (r) =>
            r.item !== "场景名称" &&
            String(r.content).trim() !== "" &&
            r.content !== "未提供",
        );
        const core = l1Rows();
        const coreDone = core.filter((r) => {
          const row = byItem.get(r.label);
          const st = String(row?.source_type ?? "");
          return st === "用户确认" || st === "用户补充";
        }).length;
        const ok = filledRows.length > 0;
        readiness[step.id] = readinessOf(
          ok,
          ok
            ? `定义已整理（表1-1 已填 ${filledRows.length} 项；核心 ${coreDone}/${core.length} 项已确认）`
            : "先在「场景定义」对话里聊两句——说不准也没关系，聊完点「整理成定义」即可推进",
          tableProgress(db, scenario.id, step.tables, step.stage),
        );
        break;
      }
      case "分析": {
        const p = tableProgress(db, scenario.id, step.tables, step.stage);
        readiness[step.id] = readinessOf(
          p.rows > 0,
          p.rows > 0 ? `本步已有 ${p.rows} 行信息` : "本步还没有产出，先发起本步分析",
          p,
        );
        break;
      }
      case "组装": {
        readiness[step.id] = readinessOf(true, "可生成并导出交付物");
        break;
      }
    }
  }

  return buildFlowStatus({
    completed,
    unlockedAll: Boolean(scenario.flow_unlocked_all),
    readiness,
  });
}

/**
 * 完成某一步（用户显式动作）
 *
 * 副作用：写完成标记；把 `current_stage` 推进到本步落库阶段（单调不回退）；
 * 完成最后一步把场景标记为「已完成」。
 */
export function completeFlowStep(db: DbInstance, scenario: Scenario, stepId: number): FlowStatus {
  const step = flowStep(stepId);
  db.scenarioStepRepo.complete(scenario.id, stepId);

  const patch: Record<string, unknown> = {};
  if (step.stage !== null && step.stage > scenario.current_stage) {
    patch["current_stage"] = step.stage;
  }
  if (stepId === FLOW_LAST_STEP) patch["status"] = "已完成";
  if (Object.keys(patch).length > 0) {
    db.scenarioRepo.update(scenario.id, patch as never);
  }

  const fresh = db.scenarioRepo.getById(scenario.id) ?? scenario;
  return getFlowState(db, fresh);
}

/**
 * 回到某一步重跑
 *
 * 清掉该步及其之后的完成标记（数据保留，由既有失效/重算语义处理下游），
 * 场景回到「进行中」。对应"可随时回到任一已完成步骤重跑并更新交付物"。
 */
export function reopenFlowStep(db: DbInstance, scenario: Scenario, stepId: number): FlowStatus {
  flowStep(stepId); // 校验步骤号
  db.scenarioStepRepo.clearFrom(scenario.id, stepId);
  db.scenarioRepo.update(scenario.id, { status: "进行中" } as never);
  const fresh = db.scenarioRepo.getById(scenario.id) ?? scenario;
  return getFlowState(db, fresh);
}

/** 解锁全部步骤（正常是锁步推进；着急或只想看某一步时用） */
export function unlockAllFlowSteps(db: DbInstance, scenario: Scenario): FlowStatus {
  db.scenarioRepo.update(scenario.id, { flow_unlocked_all: 1 } as never);
  const fresh = db.scenarioRepo.getById(scenario.id) ?? scenario;
  return getFlowState(db, fresh);
}
