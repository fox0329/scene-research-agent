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
 *  - 确认（第 1 步）：**智能体已写出场景业务画像**（表1-1 的智能体侧行至少一项有内容）；
 *    「确认无误」是用户的一次整表确认，**不卡推进**，也不做逐项表态
 *  - 分析（第 2-7 步）：本步表集中至少 1 张有数据（**只要求有产出，不要求齐备**）
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
  anchorAgentRows,
  buildFlowStatus,
  isEmptyValue,
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
  const readiness: Record<number, FlowReadiness> = {};

  for (const step of FLOW_STEPS) {
    switch (step.kind) {
      case "确认": {
        // 第 1 步「场景定义与边界」：**用户给场景名称，智能体写业务画像**
        // （场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征）。
        //
        // 就绪口径 = **智能体那一侧已经写出东西**（不是"用户逐项确认完了"）：
        // 用户定调「用户确认就默认可以了」+「表格用户自己可以修改，不用显示待确认」，
        // 所以这里既不做逐项表态，也不因为"用户没点确认"卡住推进。
        const agentLabels = new Set(anchorAgentRows().map((r) => r.label));
        const written = anchor.filter(
          (r) => agentLabels.has(r.item) && !isEmptyValue(r.content),
        );
        const ok = written.length > 0;
        readiness[step.id] = readinessOf(
          ok,
          ok
            ? `场景业务画像已写出 ${written.length} 项；看一眼，能直接改，没问题就继续`
            : "先说一句场景名称，我来写这份场景业务画像（场景边界、生产对象、核心系统、买方与采购特征）",
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
