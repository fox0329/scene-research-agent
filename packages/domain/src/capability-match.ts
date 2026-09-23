/**
 * capability-match — 能力匹配（阶段 4，00b §5 表 4-1 ~ 表 4-5）
 *
 * 职责：匹配矩阵判定、竞争力评分、场景优先级排序。
 * 规则：判定逻辑只在领域层（AGENTS.md 规则 5），
 * 匹配判定按证据分级确定性映射，缺口需标注来源（G-R0）。
 */

import type { EvidenceLevel, Maturity } from "@scene/contract";

// ─── 常量 ──────────────────────────────────────────────────────

/** 竞争力维度数量（技术/价格/生态/服务/品牌） */
const COMPETITIVENESS_DIMENSIONS = 5;

/** 每维度评分范围 */
const SCORE_MIN = 1;
const SCORE_MAX = 5;

// ─── 类型 ──────────────────────────────────────────────────────

/** 匹配判定结论 */
export type MatchJudgment =
  | "真能解"
  | "条件能解"
  | "不能承诺";

/** 竞争力维度评分 */
export interface CompetitivenessDimension {
  dimension: string;
  score: number;
}

/** 竞争力评分结果 */
export interface CompetitivenessResult {
  /** 各维度评分 */
  dimensions: CompetitivenessDimension[];
  /** 总分（满分 25） */
  totalScore: number;
  /** 综合等级 */
  level: "强" | "中" | "弱";
}

/** 子场景输入 */
export interface SubScene {
  id: string;
  name: string;
  /** 价值密度（万元/年，越高越好） */
  valueDensity: number;
  /** 能力契合度（0-100，越高越好） */
  fitness: number;
  /** 进入难度（1-10，越高越难） */
  entryDifficulty: number;
  /** 存量成熟度（1-10，越高越成熟） */
  maturity: number;
}

/** 场景优先级排序结果 */
export interface SubScenePriority {
  sceneId: string;
  name: string;
  /** 综合优先级分数（越高越优先） */
  priorityScore: number;
  rank: number;
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 匹配矩阵判定（00b §5 表 4-1：真能解/条件能解/不能承诺）
 *
 * 确定性映射：
 * - 证据 A/B + 能力已交付/组件具备 → 真能解（直接可验证且能力成熟）
 * - 证据 A/B + 能力在研/规划       → 条件能解（有据但能力未成熟）
 * - 证据 C + 能力已交付/组件具备    → 条件能解（能力有但证据不足）
 * - 证据 C + 能力在研/规划          → 不能承诺（能力不足且证据不足）
 * - 证据 D                          → 不能承诺（D 必须删除，G-R2）
 *
 * gap 为空时直接抛错——没有缺口描述无法做匹配判定。
 *
 * @param gap - 需求缺口描述（须非空）
 * @param capability - 我方能力
 * @param evidence - 证据分级
 * @returns 匹配判定结论
 * @throws gap 为空时抛错
 */
export function judgeMatch(
  gap: string,
  capability: { maturity: Maturity },
  evidence: EvidenceLevel,
): MatchJudgment {
  if (!gap.trim()) {
    throw new Error("需求缺口描述不能为空");
  }

  // D 级证据：过度宣称，直接不能承诺
  if (evidence === "D") {
    return "不能承诺";
  }

  const isCapabilityMature =
    capability.maturity === "已交付" || capability.maturity === "组件具备";

  // A/B 级证据：直接可验证 / 间接有据
  if (evidence === "A" || evidence === "B") {
    return isCapabilityMature ? "真能解" : "条件能解";
  }

  // C 级证据：架构推断
  return isCapabilityMature ? "条件能解" : "不能承诺";
}

/**
 * 竞争力评分（5 维度，每维 1-5 分，总分 25）
 *
 * 评分维度：技术、价格、生态、服务、品牌。
 * 综合等级：20+ 强 / 12-19 中 / <12 弱。
 *
 * @param scores - 各维度评分（每维度名称 + 1-5 分）
 * @returns 竞争力评分结果
 * @throws 维度数量不对或分数越界时抛错
 */
export function scoreCompetitiveness(
  scores: CompetitivenessDimension[],
): CompetitivenessResult {
  if (scores.length !== COMPETITIVENESS_DIMENSIONS) {
    throw new Error(
      `竞争力维度数量应为 ${COMPETITIVENESS_DIMENSIONS}，实际为 ${scores.length}`,
    );
  }

  for (const s of scores) {
    if (s.score < SCORE_MIN || s.score > SCORE_MAX || !Number.isInteger(s.score)) {
      throw new Error(
        `维度"${s.dimension}"评分必须为 ${SCORE_MIN}-${SCORE_MAX} 的整数，实际为 ${s.score}`,
      );
    }
  }

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);

  let level: CompetitivenessResult["level"];
  if (totalScore >= 20) {
    level = "强";
  } else if (totalScore >= 12) {
    level = "中";
  } else {
    level = "弱";
  }

  return { dimensions: [...scores], totalScore, level };
}

/**
 * 场景优先级排序（四维：价值密度/契合度/进入难度/存量成熟度）
 *
 * 四维归一化后加权求和：
 * - 价值密度（30%）：越高越好，min-max 归一化
 * - 能力契合度（30%）：越高越好，直接 /100
 * - 进入难度（20%）：越低越好，反转后归一化
 * - 存量成熟度（20%）：越高越好，/10
 *
 * 按综合分数降序排列，rank 从 1 开始。
 *
 * @param scenes - 子场景列表
 * @returns 按优先级排序的场景列表
 * @throws 场景列表为空时抛错
 */
export function prioritizeSubScenes(scenes: SubScene[]): SubScenePriority[] {
  if (scenes.length === 0) {
    throw new Error("子场景列表不能为空");
  }

  // 计算各维度的 min/max 用于归一化
  const valueDensities = scenes.map((s) => s.valueDensity);
  const maxDensity = Math.max(...valueDensities);
  const minDensity = Math.min(...valueDensities);
  const densityRange = maxDensity - minDensity;

  const difficulties = scenes.map((s) => s.entryDifficulty);
  const maxDiff = Math.max(...difficulties);
  const minDiff = Math.min(...difficulties);
  const diffRange = maxDiff - minDiff;

  const scored = scenes.map((scene) => {
    // 价值密度归一化（0-1，越高越好）
    const normDensity = densityRange > 0
      ? (scene.valueDensity - minDensity) / densityRange
      : 1;

    // 能力契合度归一化（0-1）
    const normFitness = scene.fitness / 100;

    // 进入难度归一化后反转（越低越好 → 反转后越高越好）
    const normDifficulty = diffRange > 0
      ? 1 - (scene.entryDifficulty - minDiff) / diffRange
      : 1;

    // 存量成熟度归一化（0-1）
    const normMaturity = scene.maturity / 10;

    const priorityScore =
      normDensity * 0.3 +
      normFitness * 0.3 +
      normDifficulty * 0.2 +
      normMaturity * 0.2;

    return {
      sceneId: scene.id,
      name: scene.name,
      priorityScore: Math.round(priorityScore * 10000) / 10000,
      rank: 0,
    };
  });

  // 按分数降序排列
  scored.sort((a, b) => b.priorityScore - a.priorityScore);

  // 分配排名
  for (let i = 0; i < scored.length; i++) {
    scored[i]!.rank = i + 1;
  }

  return scored;
}
