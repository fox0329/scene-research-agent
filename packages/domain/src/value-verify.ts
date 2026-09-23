/**
 * value-verify — 价值验证（阶段 6，00b §7 表 6-1 ~ 表 6-7）
 *
 * 职责：ROI 计算、试点成败判据校验、价值指标校验。
 * 规则：建议三档（建议通过/有条件/不通过），决定权在用户。
 * 校验逻辑为确定性映射（AGENTS.md 规则 5）。
 */

// ─── 类型 ──────────────────────────────────────────────────────

/** ROI 计算结果 */
export interface RoiResult {
  /** 总投资（万元） */
  investment: number;
  /** 年节约（万元/年） */
  annualSaving: number;
  /** 静态回收期（年） */
  paybackYears: number;
  /** 年化 ROI（百分比） */
  roiPercent: number;
}

/** 试点成败判据 */
export interface PilotCriterion {
  id: string;
  /** 判据描述 */
  description: string;
  /** 目标值 */
  target: number;
  /** 单位 */
  unit: string;
  /** true 表示越低越好（如响应时间、故障率），默认 false（越高越好） */
  lowerIsBetter?: boolean;
}

/** 试点实测结果 */
export interface PilotResult {
  criterionId: string;
  /** 实测值 */
  actualValue: number;
}

/** 试点验证结论 */
export interface PilotVerification {
  /** 各判据校验结果 */
  criteria: CriterionCheck[];
  /** 达标数 */
  passedCount: number;
  /** 总判据数 */
  totalCount: number;
  /** 全部达标 */
  allPassed: boolean;
}

/** 单项判据校验结果 */
export interface CriterionCheck {
  criterionId: string;
  description: string;
  target: number;
  actual: number;
  unit: string;
  /** 是否达标（实测 >= 目标） */
  passed: boolean;
}

/** 价值指标输入 */
export interface ValueMetric {
  /** 指标名称 */
  name: string;
  /** 是否有基线数据 */
  hasBaseline: boolean;
  /** 是否可测量 */
  isMeasurable: boolean;
  /** 数据来源 */
  source: string;
}

/** 指标校验结果 */
export interface MetricValidation {
  metricName: string;
  isValid: boolean;
  /** 不合格原因列表（空则合格） */
  issues: string[];
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 投资回报计算（静态回收期法）
 *
 * - 回收期 = 投资 / 年节约（年），保留两位小数
 * - 年化 ROI = 年节约 / 投资 × 100（百分比）
 * - 年节约 <= 0 时回收期为 Infinity，ROI 为 0
 * - 投资 <= 0 时抛错（无意义计算）
 *
 * @param investment - 总投资（万元）
 * @param annualSaving - 年节约（万元/年）
 * @returns ROI 计算结果
 * @throws 投资 <= 0 时抛错
 */
export function calcRoi(investment: number, annualSaving: number): RoiResult {
  if (investment <= 0) {
    throw new Error("投资金额必须大于 0");
  }

  if (annualSaving <= 0) {
    return {
      investment,
      annualSaving,
      paybackYears: Infinity,
      roiPercent: 0,
    };
  }

  const paybackYears = Math.round((investment / annualSaving) * 100) / 100;
  const roiPercent = Math.round((annualSaving / investment) * 10000) / 100;

  return { investment, annualSaving, paybackYears, roiPercent };
}

/**
 * 试点成败判据校验（00b §7 表 6-5）
 *
 * 将实测结果与目标逐项对比：实测 >= 目标视为达标。
 * 无实测数据的判据标记为未达标（宁可保守，不做无据判定）。
 *
 * @param criteria - 试点成败判据列表
 * @param results - 实测结果列表
 * @returns 试点验证结论（含逐项结果和汇总）
 */
export function verifyPilotCriteria(
  criteria: PilotCriterion[],
  results: PilotResult[],
): PilotVerification {
  const resultMap = new Map<string, number>();
  for (const r of results) {
    resultMap.set(r.criterionId, r.actualValue);
  }

  const checks: CriterionCheck[] = criteria.map((c) => {
    const actual = resultMap.get(c.id);
    const passed = actual !== undefined && (c.lowerIsBetter
      ? actual <= c.target
      : actual >= c.target);
    return {
      criterionId: c.id,
      description: c.description,
      target: c.target,
      actual: actual ?? 0,
      unit: c.unit,
      passed,
    };
  });

  const passedCount = checks.filter((c) => c.passed).length;

  return {
    criteria: checks,
    passedCount,
    totalCount: criteria.length,
    allPassed: passedCount === criteria.length,
  };
}

/**
 * 价值指标校验（00b §7 表 6-6：有基线/可测/有来源）
 *
 * 三项全部合格才算有效：
 * - 有基线数据（否则无法衡量改善）
 * - 可测量（否则无法验证）
 * - 有来源（来源为空则违反 G-R0 溯源铁律）
 *
 * @param metric - 价值指标
 * @returns 校验结果（含不合格原因）
 */
export function validateMetric(metric: ValueMetric): MetricValidation {
  const issues: string[] = [];

  if (!metric.hasBaseline) {
    issues.push("缺少基线数据，无法衡量改善幅度");
  }
  if (!metric.isMeasurable) {
    issues.push("指标不可测量，无法验证效果");
  }
  if (!metric.source.trim()) {
    issues.push("缺少数据来源，违反溯源铁律（G-R0）");
  }

  return {
    metricName: metric.name,
    isValid: issues.length === 0,
    issues,
  };
}
