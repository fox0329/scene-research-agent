/**
 * market — 市场分析（阶段 3，00b §4 表 3-1 ~ 表 3-6）
 *
 * 职责：未满足需求交叉验证、替代方案对比、利润池分析。
 * 规则：判定逻辑只在领域层（AGENTS.md 规则 5），
 * 交叉验证要求至少两个独立 T2+ 来源（G-R1），
 * 事实/判断分离（G-R5）：标注推理依据。
 */

import type { Authority, EvidenceLevel } from "@scene/contract";

// ─── 常量 ──────────────────────────────────────────────────────

/** 交叉验证最低独立来源数（至少两个独立来源才可确认需求） */
const MIN_CROSS_SOURCES = 2;

/** T2+ 权威性集合（只有 T1/T2 才算"较权威以上"） */
const T2_PLUS: ReadonlySet<Authority> = new Set(["T1", "T2"]);

// ─── 类型 ──────────────────────────────────────────────────────

/** 未满足需求条目 */
export interface UnmetNeed {
  id: string;
  description: string;
  source: string;
  sourceAuthority: Authority;
  evidenceLevel: EvidenceLevel;
}

/** 交叉验证结果 */
export interface CrossCheckResult {
  needId: string;
  description: string;
  /** 独立来源数 */
  sourceCount: number;
  /** T2+ 来源是否达到交叉验证要求 */
  isConfirmed: boolean;
  /** 各来源标签 */
  sources: string[];
}

/** 替代方案条目 */
export interface Alternative {
  id: string;
  name: string;
  cost: number;
  /** 功能覆盖度百分比 0-100 */
  featureCoverage: number;
}

/** 替代方案分析结果 */
export interface AlternativeAnalysis {
  alternativeId: string;
  name: string;
  /** 成本对比：高于/持平/低于我方 */
  costComparison: "高于我方" | "持平" | "低于我方";
  /** 我方功能覆盖优势（百分点，正=我方优） */
  featureAdvantage: number;
  /** 我方优势描述 */
  ourAdvantages: string;
  /** 我方劣势描述 */
  ourDisadvantages: string;
}

/** 利润池条目（某个市场环节） */
export interface ProfitPoolEntry {
  segment: string;
  /** 该环节营收（万元） */
  revenue: number;
  /** 该环节毛利（万元） */
  grossProfit: number;
}

/** 利润池分析结果 */
export interface ProfitAnalysis {
  /** 各环节分析（按毛利率降序） */
  segments: SegmentAnalysis[];
  /** 毛利率最高的环节 */
  topSegment: string;
  /** 总营收 */
  totalRevenue: number;
  /** 总毛利 */
  totalGrossProfit: number;
}

/** 单个环节分析 */
export interface SegmentAnalysis {
  segment: string;
  revenue: number;
  grossProfit: number;
  /** 毛利率（百分比） */
  marginPercent: number;
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 未满足需求多源交叉验证（00b §4 表 3-3）
 *
 * 按需求 ID 分组，统计独立来源数量。
 * 只有至少两个独立 T2+ 来源（G-R1）确认的需求才标记为已确认。
 * 这是确定性判定，不含推断；D 级证据（过度宣称）的需求
 * 不参与交叉验证计数（G-R2：D 必须删除）。
 *
 * @param needs - 未满足需求列表
 * @param products - 产品列表（预留接口，当前不参与判定）
 * @returns 每条需求的交叉验证结果
 */
export function crossCheckNeeds(
  needs: UnmetNeed[],
  _products: Array<{ id: string; name: string }>,
): CrossCheckResult[] {
  // 按需求 ID 分组，排除 D 级证据
  const grouped = new Map<string, UnmetNeed[]>();
  for (const need of needs) {
    if (need.evidenceLevel === "D") continue;
    const arr = grouped.get(need.id) ?? [];
    arr.push(need);
    grouped.set(need.id, arr);
  }

  const results: CrossCheckResult[] = [];
  for (const [id, group] of grouped) {
    // 统计独立 T2+ 来源
    const t2PlusSources = new Set(
      group
        .filter((n) => T2_PLUS.has(n.sourceAuthority))
        .map((n) => n.source),
    );
    results.push({
      needId: id,
      description: group[0]!.description,
      sourceCount: t2PlusSources.size,
      isConfirmed: t2PlusSources.size >= MIN_CROSS_SOURCES,
      sources: [...t2PlusSources],
    });
  }
  return results;
}

/**
 * 替代方案对比分析（00b §4 表 3-5）
 *
 * 将每个替代方案与我方产品做成本/功能双维度对比：
 * - 成本三档：高于我方 / 持平（±5%）/ 低于我方
 * - 功能优势：我方覆盖率 - 对方覆盖率（正=我方优）
 * - 优势/劣势自动生成文字标签
 *
 * 只做事实对比，不做推荐；推荐逻辑在阶段建议层。
 *
 * @param alternatives - 替代方案列表
 * @param ourCost - 我方成本
 * @returns 每个替代方案的分析结果
 */
export function compareAlternatives(
  alternatives: Alternative[],
  ourCost: number,
): AlternativeAnalysis[] {
  if (ourCost <= 0) {
    throw new Error("我方成本必须大于 0");
  }

  return alternatives.map((alt) => {
    const costRatio = alt.cost / ourCost;
    let costComparison: AlternativeAnalysis["costComparison"];
    if (costRatio > 1.05) {
      costComparison = "高于我方";
    } else if (costRatio < 0.95) {
      costComparison = "低于我方";
    } else {
      costComparison = "持平";
    }

    // 我方功能覆盖优势（百分点，正=我方更优）
    // 用我方 100% 覆盖度假设与对方 featureCoverage 做差
    const featureAdvantage = 100 - alt.featureCoverage;

    let ourAdvantages: string;
    let ourDisadvantages: string;
    if (costComparison === "高于我方" && featureAdvantage > 0) {
      ourAdvantages = "成本更低且功能覆盖更全";
      ourDisadvantages = "无明显劣势";
    } else if (costComparison === "低于我方" && featureAdvantage < 0) {
      ourAdvantages = "无明显优势";
      ourDisadvantages = "成本更高且功能覆盖更少";
    } else if (costComparison === "高于我方") {
      ourAdvantages = "成本更低";
      ourDisadvantages = featureAdvantage < 0 ? "功能覆盖更少" : "无明显劣势";
    } else if (costComparison === "低于我方") {
      ourAdvantages = featureAdvantage > 0 ? "功能覆盖更全" : "无明显优势";
      ourDisadvantages = "成本更高";
    } else {
      ourAdvantages = featureAdvantage > 0 ? "功能覆盖更全" : "无明显优势";
      ourDisadvantages = featureAdvantage < 0 ? "功能覆盖更少" : "无明显劣势";
    }

    return {
      alternativeId: alt.id,
      name: alt.name,
      costComparison,
      featureAdvantage,
      ourAdvantages,
      ourDisadvantages,
    };
  });
}

/**
 * 利润池分析（00b §4 表 3-6：哪个环节毛利最高）
 *
 * 计算每个环节的毛利率，按毛利率降序排列。
 * 毛利率 = 毛利 / 营收 × 100（营收为 0 的环节毛利率记为 0）。
 * 分析结果中 topSegment 标识毛利率最高的环节。
 *
 * @param pool - 利润池各环节数据
 * @returns 利润池分析结果（含排序后的环节列表）
 */
export function analyzeProfitPool(pool: ProfitPoolEntry[]): ProfitAnalysis {
  if (pool.length === 0) {
    throw new Error("利润池数据不能为空");
  }

  const segments: SegmentAnalysis[] = pool
    .map((entry) => ({
      segment: entry.segment,
      revenue: entry.revenue,
      grossProfit: entry.grossProfit,
      marginPercent: entry.revenue > 0
        ? Math.round((entry.grossProfit / entry.revenue) * 10000) / 100
        : 0,
    }))
    .sort((a, b) => b.marginPercent - a.marginPercent);

  const totalRevenue = pool.reduce((sum, e) => sum + e.revenue, 0);
  const totalGrossProfit = pool.reduce((sum, e) => sum + e.grossProfit, 0);

  return {
    segments,
    topSegment: segments[0]!.segment,
    totalRevenue,
    totalGrossProfit,
  };
}
