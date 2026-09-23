/**
 * @scene/server — rollback-stage command（M4-T4.2 回退清理）
 *
 * 应用层编排：domain(workflow 回退校验与待重算集合) + infra(stageDataRepo)。
 *
 * 回退语义（产品定义 §五"随时回编辑" + §4.1 失效语义）：
 * - 目标阶段自身数据保留供编辑，不删除；
 * - 严格晚于目标、不晚于回退前当前阶段的下游数据统一标"待重算"（is_stale）；
 * - 不自动重算——是否重算由用户决定（重算时 advance-stage 覆盖旧行）。
 */

import type { StageId } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { rollback, stagesToMarkAfterRollback } from "@scene/domain";

// ─── 依赖与结果类型 ────────────────────────────────────────

export interface RollbackStageDeps {
  db: DbInstance;
}

/** 回退执行结果 */
export interface RollbackResult {
  scenarioId: string;
  /** 回退前的当前阶段 */
  fromStage: StageId;
  /** 回退目标阶段 */
  toStage: StageId;
  /** 被标记"待重算"的下游阶段 */
  markedStages: StageId[];
  /** 被标记的数据行数 */
  markedRows: number;
  /** 横幅文案 */
  banner: string;
}

// ─── 工厂函数 ──────────────────────────────────────────────

export function createRollbackStageCommand(deps: RollbackStageDeps) {
  const { db } = deps;

  return {
    /**
     * 执行回退：校验 → 标记下游待重算 → 更新 current_stage。
     *
     * @throws 场景不存在 / 回退目标不早于当前阶段时抛错
     */
    execute: (opts: { scenarioId: string; targetStage: StageId }): RollbackResult =>
      executeRollback(db, opts),
  };
}

// ─── 主流程 ────────────────────────────────────────────────

function executeRollback(
  db: DbInstance,
  opts: { scenarioId: string; targetStage: StageId },
): RollbackResult {
  const { scenarioId, targetStage } = opts;

  const scenario = db.scenarioRepo.getById(scenarioId);
  if (!scenario) {
    throw new Error(`场景 ${scenarioId} 不存在`);
  }
  const fromStage = scenario.current_stage;

  // 领域层校验：目标必须早于当前（不合法直接抛错，应用层不复制规则）
  const toStage = rollback(fromStage, targetStage);

  const markedStages = stagesToMarkAfterRollback(toStage, fromStage);
  const markedRows = db.stageDataRepo.markStale(scenarioId, markedStages, true);

  db.scenarioRepo.update(scenarioId, { current_stage: toStage });

  return {
    scenarioId,
    fromStage,
    toStage,
    markedStages,
    markedRows,
    banner:
      markedStages.length > 0
        ? `已回退到阶段 ${toStage}。阶段 ${markedStages.join("、")} 的既有分析已标记待重算（数据保留），是否重算由您决定。`
        : `已回退到阶段 ${toStage}。`,
  };
}
