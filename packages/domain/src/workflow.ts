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

/** 全部阶段编号（**现行 0-7**；老 00b 的 0-8 已收窄，门槛并入「认识场景」、交付物为阶段 7） */
export const STAGES: readonly StageId[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** 首阶段 */
export const FIRST_STAGE: StageId = 0;

/** 终态阶段（阶段 7 · 最终交付物，无后继） */
export const LAST_STAGE: StageId = 7;

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

/** 校验阶段编号在 0-7 范围内（JS 边界的参数防御） */
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
 * 推进到下一阶段（0→1→…→7）
 *
 * 仅做状态迁移计算，不含质量关判定——是否推进由用户决定（核心原则）。
 *
 * @param currentStage - 当前阶段
 * @returns 下一阶段编号
 * @throws 当前阶段为 7（终态）或编号非法时抛错
 */
export function advance(currentStage: StageId): StageId {
  assertValidStage(currentStage, "当前阶段");
  if (currentStage === LAST_STAGE) {
    throw new Error(`阶段 ${LAST_STAGE} 为终态，不能再推进`);
  }
  return (currentStage + 1) as StageId;
}

/**
 * 是否可推进（阶段 7 是终态）
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
 * 回退后需标记"待重算"的阶段集合（M4-T4.2 回退清理）
 *
 * 回退到目标阶段意味着目标阶段的输入将被修改，其下游（严格晚于
 * 目标、不晚于当前阶段）已生成的分析全部失效待重算；目标阶段自身
 * 的数据保留供编辑对比，重算时才被新结果覆盖（§4.1 失效语义）。
 *
 * @param targetStage - 回退目标阶段
 * @param currentStage - 回退前的当前阶段
 * @returns 升序阶段列表；target>=current 时为空（非法回退由 rollback() 抛错兜底）
 */
export function stagesToMarkAfterRollback(
  targetStage: StageId,
  currentStage: StageId,
): StageId[] {
  if (targetStage >= currentStage) return [];
  const result: StageId[] = [];
  for (let s = (targetStage + 1) as number; s <= currentStage; s++) {
    result.push(s as StageId);
  }
  return result;
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

// ─── 表间依赖反查 ─────────────────────────────────────────────

/**
 * 表间依赖映射（来源表 → 被引用的阶段 id 列表）
 *
 * **值 = `stage_data.stage` 的阶段 id（0 基）**：0 材料解析与入库、1 认识场景、2 理解商业、
 * 3 能力匹配、4 方案与实现、5 价值与验证、6 最终交付物——即 `07-业务流程总表.md` 里
 * 「阶段 N」的 N-1。每一行的取值都能在 07-业务流程总表.md 第四节「34 张表对业务的作用 ·
 * 谁用它」里逐条对上（注释里标了对应条目）。
 *
 * 为什么要把这条规矩写死在注释里（2026-10-04 修正）：原表里填的是"第几个阶段"的**人话**
 * （从 1 起），而 [`markStale()`] 把它当成 `stage_data.stage`（从 0 起）直接
 * `WHERE stage IN (...)`，于是**每一处都晚一个阶段**——改 M6 内部费率会去标「价值与验证」，
 * 而真正吃费率的「方案与实现」反而标不到（变更表 #101；当时吃费率的是 表5-5 成本估算，
 * 该表已按用户定调删除，见变更表 #105）。
 */
export const TABLE_DEPENDENCIES: Record<string, StageId[]> = {
  // 阶段 0 · 资料库（行 id 各自属于某条产品线，改动只影响引用它的分析阶段）
  "M1": [3, 4], // 产品清单 → 阶段3 匹配候选池(表4-3)、阶段4 架构选型(表5-1)
  "M2": [3, 4], // 规格书 → 阶段3 选型对照、阶段4 选型
  "M3": [1, 3], // 能力清单 → 阶段1 环节角色、阶段3 表4-1 能力底账
  "M4": [1, 3], // 边界声明 → 阶段1 环节能否参与、阶段3 我方参与地图
  "M5": [4, 5], // 已知限制 → 阶段4 实施风险、阶段5 验收约束
  "O2": [3, 6], // 已交付案例 → 阶段3 能力证明、阶段6 对外材料
  "O3": [4], // 价格与授权 → 阶段4 定价

  // 阶段 1
  "表1-2": [1], // 场景环节地图 → 阶段1 要素清单范围
  "表1-3": [4], // 门槛与合规 → 阶段4 约束与合规

  // 阶段 2
  "表2-2": [2, 4], // 场景要素清单 → 阶段2 竞品对照维度、阶段4 方案架构选型
  "表2-5": [4], // 物理与合规约束 → 阶段4 合规路径（跨阶段表：阶段1 填要求值、阶段4 填我方路径）
  "表2-6": [4], // 数据规模与治理 → 阶段4 平台选型
  "表3-6": [4], // 替代方案 → 阶段4 竞品价格对照、我方价格位置
  "表3-8": [3], // 未被满足的需求 → 阶段3 痛点排序、匹配矩阵缺口

  // 阶段 3
  "表4-3": [4], // 匹配矩阵 → 阶段4 方案范围
  "表4-4": [4], // 优先级矩阵 → 阶段4 先做哪个细分

  // 阶段 4
  "表5-6": [5, 6], // 竞品价格对照 → 阶段5 价值测算、阶段6 对外材料

  // 阶段 5
  "表6-3": [6], // 投资回报估算 → 阶段6 内部报告结论
};
/**
 * 根据表名反查受影响的阶段列表
 * @param refTable 被更新的资料表名（如 "M1"、"表3-6"）
 * @returns 受影响的阶段列表（去重升序）
 */
export function getAffectedStages(refTable: string): StageId[] {
  const stages = TABLE_DEPENDENCIES[refTable];
  if (!stages) return [];
  return [...new Set(stages)].sort((a, b) => a - b);
}

/**
 * 创建失效标记（自动反查依赖）
 * @param scenarioId 场景分析项目 ID
 * @param refTable 被更新的资料表名
 * @param refId 被更新的资料行 ID
 * @returns 失效标记（含横幅文案）
 */
export function createStaleMark(
  scenarioId: string,
  refTable: string,
  refId: string,
): StaleMark {
  const affectedStages = getAffectedStages(refTable);
  return markStale(scenarioId, refTable, refId, affectedStages);
}

/**
 * 检查项目是否有失效标记
 * @param staleMarks 失效标记列表
 * @param scenarioId 场景分析项目 ID
 * @returns 是否有失效标记
 */
export function hasStaleMarks(staleMarks: StaleMark[], scenarioId: string): boolean {
  return staleMarks.some((mark) => mark.scenarioId === scenarioId);
}

/**
 * 获取项目的失效横幅列表
 * @param staleMarks 失效标记列表
 * @param scenarioId 场景分析项目 ID
 * @returns 横幅文案列表（去重）
 */
export function getStaleBanners(staleMarks: StaleMark[], scenarioId: string): string[] {
  const banners = staleMarks
    .filter((mark) => mark.scenarioId === scenarioId)
    .map((mark) => mark.banner);
  return [...new Set(banners)];
}

/**
 * 清除项目的失效标记
 * @param staleMarks 失效标记列表
 * @param scenarioId 场景分析项目 ID
 * @param refTable 可选：只清除特定表的标记
 * @returns 清除后的列表
 */
export function clearStaleMarks(
  staleMarks: StaleMark[],
  scenarioId: string,
  refTable?: string,
): StaleMark[] {
  return staleMarks.filter((mark) => {
    if (mark.scenarioId !== scenarioId) return true;
    if (refTable && mark.refTable !== refTable) return true;
    return false;
  });
}
