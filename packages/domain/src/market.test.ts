import { describe, it, expect } from "vitest";
import {
  crossCheckNeeds,
  compareAlternatives,
  analyzeProfitPool,
} from "./market.js";
import type { UnmetNeed, Alternative, ProfitPoolEntry } from "./market.js";

// ─── crossCheckNeeds ───────────────────────────────────────────

describe("crossCheckNeeds", () => {
  const baseNeed: Omit<UnmetNeed, "source" | "sourceAuthority"> = {
    id: "N1",
    description: "需要支持国产加密算法",
    evidenceLevel: "B",
  };

  it("两个独立 T2+ 来源确认 → isConfirmed=true", () => {
    const needs: UnmetNeed[] = [
      { ...baseNeed, source: "客户A", sourceAuthority: "T1" },
      { ...baseNeed, source: "客户B", sourceAuthority: "T2" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results).toHaveLength(1);
    expect(results[0]!.isConfirmed).toBe(true);
    expect(results[0]!.sourceCount).toBe(2);
  });

  it("只有一个 T2+ 来源 → isConfirmed=false", () => {
    const needs: UnmetNeed[] = [
      { ...baseNeed, source: "客户A", sourceAuthority: "T1" },
      { ...baseNeed, source: "行业报告", sourceAuthority: "T3" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results[0]!.isConfirmed).toBe(false);
    expect(results[0]!.sourceCount).toBe(1);
  });

  it("T3/T4 来源不计入交叉验证（权威性不足）", () => {
    const needs: UnmetNeed[] = [
      { ...baseNeed, source: "报告1", sourceAuthority: "T3" },
      { ...baseNeed, source: "推断2", sourceAuthority: "T4" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results[0]!.isConfirmed).toBe(false);
    expect(results[0]!.sourceCount).toBe(0);
  });

  it("D 级证据（过度宣称）不参与交叉验证（G-R2：D 必须删除）", () => {
    const needs: UnmetNeed[] = [
      { ...baseNeed, source: "客户A", sourceAuthority: "T1" },
      { ...baseNeed, source: "疑似来源", sourceAuthority: "T1", evidenceLevel: "D" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results[0]!.sourceCount).toBe(1);
  });

  it("多个不同需求分别验证", () => {
    const needs: UnmetNeed[] = [
      { id: "N1", description: "需求1", source: "A", sourceAuthority: "T1", evidenceLevel: "A" },
      { id: "N1", description: "需求1", source: "B", sourceAuthority: "T2", evidenceLevel: "B" },
      { id: "N2", description: "需求2", source: "C", sourceAuthority: "T1", evidenceLevel: "A" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results).toHaveLength(2);
    const n1 = results.find((r) => r.needId === "N1");
    const n2 = results.find((r) => r.needId === "N2");
    expect(n1?.isConfirmed).toBe(true);
    expect(n2?.isConfirmed).toBe(false);
  });

  it("相同来源名去重（同一个来源不重复计数）", () => {
    const needs: UnmetNeed[] = [
      { ...baseNeed, source: "客户A", sourceAuthority: "T1" },
      { ...baseNeed, source: "客户A", sourceAuthority: "T1" },
    ];
    const results = crossCheckNeeds(needs, []);
    expect(results[0]!.sourceCount).toBe(1);
  });

  it("空输入返回空数组", () => {
    expect(crossCheckNeeds([], [])).toEqual([]);
  });
});

// ─── compareAlternatives ───────────────────────────────────────

describe("compareAlternatives", () => {
  const alt: Alternative = { id: "A1", name: "竞品X", cost: 50, featureCoverage: 70 };

  it("竞品成本高于我方 → 高于我方", () => {
    const results = compareAlternatives([alt], 40);
    expect(results[0]!.costComparison).toBe("高于我方");
  });

  it("竞品成本低于我方 → 低于我方", () => {
    const results = compareAlternatives([alt], 60);
    expect(results[0]!.costComparison).toBe("低于我方");
  });

  it("竞品成本与我方持平（±5%）→ 持平", () => {
    const results = compareAlternatives([alt], 50);
    expect(results[0]!.costComparison).toBe("持平");
  });

  it("功能优势正确计算（featureAdvantage = 100 - 对方覆盖率）", () => {
    const results = compareAlternatives([alt], 40);
    expect(results[0]!.featureAdvantage).toBe(30);
  });

  it("成本高于我方 + 功能优势 → 优势标签正确", () => {
    const results = compareAlternatives([alt], 40);
    expect(results[0]!.ourAdvantages).toContain("成本更低");
  });

  it("成本低于我方 + 功能劣势 → 劣势标签正确", () => {
    const cheapAlt: Alternative = { id: "A2", name: "便宜货", cost: 30, featureCoverage: 110 };
    // featureCoverage > 100 → featureAdvantage < 0
    const results = compareAlternatives([cheapAlt], 60);
    expect(results[0]!.ourDisadvantages).toContain("成本更高");
  });

  it("我方成本 <= 0 抛错", () => {
    expect(() => compareAlternatives([alt], 0)).toThrow("我方成本必须大于 0");
    expect(() => compareAlternatives([alt], -10)).toThrow("我方成本必须大于 0");
  });

  it("多个竞品同时比较", () => {
    const alts: Alternative[] = [
      { id: "A1", name: "竞品X", cost: 60, featureCoverage: 80 },
      { id: "A2", name: "竞品Y", cost: 40, featureCoverage: 60 },
    ];
    const results = compareAlternatives(alts, 50);
    expect(results).toHaveLength(2);
    expect(results[0]!.costComparison).toBe("高于我方");
    expect(results[1]!.costComparison).toBe("低于我方");
  });
});

// ─── analyzeProfitPool ─────────────────────────────────────────

describe("analyzeProfitPool", () => {
  const pool: ProfitPoolEntry[] = [
    { segment: "硬件", revenue: 1000, grossProfit: 200 },
    { segment: "软件", revenue: 500, grossProfit: 350 },
    { segment: "服务", revenue: 300, grossProfit: 150 },
  ];

  it("按毛利率降序排列", () => {
    const result = analyzeProfitPool(pool);
    expect(result.segments[0]!.segment).toBe("软件"); // 70%
    expect(result.segments[1]!.segment).toBe("服务"); // 50%
    expect(result.segments[2]!.segment).toBe("硬件"); // 20%
  });

  it("topSegment 为毛利率最高的环节", () => {
    const result = analyzeProfitPool(pool);
    expect(result.topSegment).toBe("软件");
  });

  it("总营收和总毛利正确", () => {
    const result = analyzeProfitPool(pool);
    expect(result.totalRevenue).toBe(1800);
    expect(result.totalGrossProfit).toBe(700);
  });

  it("毛利率计算正确（保留两位小数）", () => {
    const result = analyzeProfitPool(pool);
    const software = result.segments.find((s) => s.segment === "软件");
    expect(software?.marginPercent).toBe(70);
  });

  it("营收为 0 的环节毛利率记为 0", () => {
    const poolWithZero: ProfitPoolEntry[] = [
      { segment: "测试", revenue: 0, grossProfit: 0 },
    ];
    const result = analyzeProfitPool(poolWithZero);
    expect(result.segments[0]!.marginPercent).toBe(0);
  });

  it("空输入抛错", () => {
    expect(() => analyzeProfitPool([])).toThrow("利润池数据不能为空");
  });

  it("单个环节正常计算", () => {
    const single: ProfitPoolEntry[] = [
      { segment: "唯一", revenue: 200, grossProfit: 100 },
    ];
    const result = analyzeProfitPool(single);
    expect(result.topSegment).toBe("唯一");
    expect(result.segments[0]!.marginPercent).toBe(50);
  });

  it("毛利率精度：1/3 ≈ 33.33", () => {
    const tricky: ProfitPoolEntry[] = [
      { segment: "特殊", revenue: 300, grossProfit: 100 },
    ];
    const result = analyzeProfitPool(tricky);
    expect(result.segments[0]!.marginPercent).toBe(33.33);
  });
});
