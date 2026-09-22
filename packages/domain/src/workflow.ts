/**
 * workflow — 工作流编排
 *
 * 职责：阶段推进状态机、风险继承链、资料失效语义（产品定义 §4.1/§五）。
 * 规则：阶段推进需质量关通过；用户可决定继续/补充/停止/重算。
 * 智能体只有建议权，用户有决定权——本模块只做状态迁移与标记，
 * 不阻断任何流程；是否推进/回退/重算由应用层响应用户决定。
 */

import type { StageId } from "@scene/contract";

// ─── 阶段常量 ─────────────────────────────────────────────────

/** 全部阶段编号（0-8，00b §一工作流总览） */
export const STAGES: readonly StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** 首阶段 */
export const FIRST_STAGE: StageId = 0;

/** 终态阶段（阶段 8 · 最终交付物，无后继） */
export const LAST_STAGE: StageId = 8;

// ─── 资料失效标记类型 ─────────────────────────────────────────

/** 资料失效标记（产品定义 §4.1 失效语义：分析保留、横幅提示、重算由用户决定） */
export interface StaleMark {
  /** 场景分析项目 ID */
  scenarioId: string;
  /** 被更新的资料表（如 "M1"、"capability"） */
  refTable: string;
  /** 被更新的资料行 ID */
  refId: string;
  /** 受影响阶段（依据表间依赖反查，去重升序） */
  affectedStages: StageId[];
  /** 横幅提示文案（不自动改数据，只提示建议重算范围） */
  banner: string;
}

// ─── 内部工具 ─────────────────────────────────────────────────

/** 校验阶段编号在 0-8 范围内（JS 边界的参数防御） */
function assertValidStage(stage: number, label: string): asserts stage is StageId {
  if (!Number.isInteger(stage) || stage < FIRST_STAGE || stage > LAST_STAGE) {
    throw new Error(`${label}非法：${stage}（合法范围 ${FIRST_STAGE}-${LAST_STAGE}）`);
  }
}

/** 校验字符串非空白 */
function assertNonBlank(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 推进到下一阶段（0→1→…→8）
 *
 * 仅做状态迁移计算，不含质量关判定——是否推进由用户决定（核心原则）。
 *
 * @param currentStage - 当前阶段
 * @returns 下一阶段编号
 * @throws 当前阶段为 8（终态）或编号非法时抛错
 */
export function advance(currentStage: StageId): StageId {
  assertValidStage(currentStage, "当前阶段");
  if (currentStage === LAST_STAGE) {
    throw new Error(`阶段 ${LAST_STAGE} 为终态，不能再推进`);
  }
  return (currentStage + 1) as StageId;
}

/**
 * 是否可推进（阶段 8 是终态）
 *
 * @param currentStage - 当前阶段
 * @returns 0-7 返回 true；8 返回 false
 */
export function canAdvance(currentStage: StageId): boolean {
  assertValidStage(currentStage, "当前阶段");
  return currentStage !== LAST_STAGE;
}

/**
 * 回退到指定阶段（重算入口，产品定义 §五"随时回编辑"）
 *
 * 回退只允许向后（目标早于当前）；目标不早于当前时不是回退，抛错。
 * 旧阶段数据标记"待重算"由应用层执行，本函数只返回目标阶段。
 *
 * @param currentStage - 当前阶段
 * @param targetStage - 回退目标阶段
 * @returns 回退目标阶段
 * @throws 目标不早于当前阶段、或任一编号非法时抛错
 */
export function rollback(currentStage: StageId, targetStage: StageId): StageId {
  assertValidStage(currentStage, "当前阶段");
  assertValidStage(targetStage, "回退目标阶段");
  if (targetStage >= currentStage) {
    throw new Error(
      `回退目标阶段 ${targetStage} 必须早于当前阶段 ${currentStage}`,
    );
  }
  return targetStage;
}

/**
 * 标记资料失效（产品定义 §4.1 失效语义）
 *
 * 资料库更新后反查受影响阶段：已生成的分析一律保留、不自动覆盖、
 * 不自动重算；只生成横幅提示"建议重算阶段 N-M"，是否重算由用户决定。
 *
 * @param scenarioId - 场景分析项目 ID
 * @param refTable - 被更新的资料表
 * @param refId - 被更新的资料行 ID
 * @param affectedStages - 受影响阶段列表（会去重并升序排列）
 * @returns 失效标记（含横幅文案）
 * @throws 任一标识为空时抛错
 */
export function markStale(
  scenarioId: string,
  refTable: string,
  refId: string,
  affectedStages: StageId[],
): StaleMark {
  assertNonBlank(scenarioId, "场景 ID");
  assertNonBlank(refTable, "资料表名");
  assertNonBlank(refId, "资料行 ID");

  // 去重 + 升序：同一阶段多行失效只提示一次，横幅按范围呈现
  const stages = [...new Set(affectedStages)].sort((a, b) => a - b);

  return {
    scenarioId,
    refTable,
    refId,
    affectedStages: stages,
    banner: buildStaleBanner(stages),
  };
}

/** 生成横幅文案：空列表无重算建议；单个阶段单点提示；多个阶段范围提示 */
function buildStaleBanner(stages: StageId[]): string {
  if (stages.length === 0) {
    return "资料已更新";
  }
  const first = stages[0]!;
  const last = stages[stages.length - 1]!;
  const scope = first === last ? `阶段 ${first}` : `阶段 ${first}-${last}`;
  return `资料已更新，建议重算${scope}`;
}

/**
 * 收集从阶段 0 到当前阶段的所有继承风险（产品定义 §五"风险继承"）
 *
 * 当前阶段取映射中出现的最大阶段编号；按阶段升序收集，
 * 同名风险只保留首次出现（继承不重复、不丢失）。
 *
 * @param stageRisks - 各阶段的风险标注
 * @returns 去重后的风险列表（按首次出现顺序）
 */
export function getRiskChain(stageRisks: Map<StageId, string[]>): string[] {
  if (stageRisks.size === 0) {
    return [];
  }
  const currentStage = Math.max(...stageRisks.keys());

  const seen = new Set<string>();
  const chain: string[] = [];
  for (let stage = FIRST_STAGE; stage <= currentStage; stage++) {
    for (const risk of stageRisks.get(stage as StageId) ?? []) {
      if (!seen.has(risk)) {
        seen.add(risk);
        chain.push(risk);
      }
    }
  }
  return chain;
}
