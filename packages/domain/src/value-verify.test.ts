import { describe, it, expect } from "vitest";
import {
  calcRoi,
  verifyPilotCriteria,
  validateMetric,
} from "./value-verify.js";
import type {
  PilotCriterion,
  PilotResult,
  ValueMetric,
} from "./value-verify.js";

// ─── calcRoi ───────────────────────────────────────────────────

describe("calcRoi", () => {
  it("正常 ROI 计算", () => {
    const result = calcRoi(100, 30);
    expect(result.investment).toBe(100);
    expect(result.annualSaving).toBe(30);
    expect(result.paybackYears).toBe(3.33);
    expect(result.roiPercent).toBe(30);
  });

  it("回收期 = 投资 / 年节约", () => {
    const result = calcRoi(200, 50);
    expect(result.paybackYears).toBe(4);
  });

  it("年化 ROI = 年节约 / 投资 * 100", () => {
    const result = calcRoi(100, 50);
    expect(result.roiPercent).toBe(50);
  });

  it("回收期精度保留两位小数", () => {
    const result = calcRoi(100, 33);
    // 100/33 = 3.0303... → 3.03
    expect(result.paybackYears).toBe(3.03);
  });

  it("投资 <= 0 抛错", () => {
    expect(() => calcRoi(0, 30)).toThrow("投资金额必须大于 0");
    expect(() => calcRoi(-100, 30)).toThrow("投资金额必须大于 0");
  });

  it("年节约 <= 0 → 回收期 Infinity，ROI 0", () => {
    const result = calcRoi(100, 0);
    expect(result.paybackYears).toBe(Infinity);
    expect(result.roiPercent).toBe(0);
  });

  it("年节约为负 → 同样 Infinity/0", () => {
    const result = calcRoi(100, -10);
    expect(result.paybackYears).toBe(Infinity);
    expect(result.roiPercent).toBe(0);
  });
});

// ─── verifyPilotCriteria ──────────────────────────────────────

describe("verifyPilotCriteria", () => {
  const criteria: PilotCriterion[] = [
    { id: "C1", description: "识别准确率", target: 95, unit: "%" },
    { id: "C2", description: "响应时间", target: 200, unit: "ms", lowerIsBetter: true },
    { id: "C3", description: "日处理量", target: 10000, unit: "条" },
  ];

  it("全部达标 → allPassed=true", () => {
    const results: PilotResult[] = [
      { criterionId: "C1", actualValue: 97 },
      { criterionId: "C2", actualValue: 150 },
      { criterionId: "C3", actualValue: 12000 },
    ];
    const verdict = verifyPilotCriteria(criteria, results);
    expect(verdict.allPassed).toBe(true);
    expect(verdict.passedCount).toBe(3);
    expect(verdict.totalCount).toBe(3);
  });

  it("部分达标 → allPassed=false", () => {
    const results: PilotResult[] = [
      { criterionId: "C1", actualValue: 97 },
      { criterionId: "C2", actualValue: 300 }, // 未达标
      { criterionId: "C3", actualValue: 12000 },
    ];
    const verdict = verifyPilotCriteria(criteria, results);
    expect(verdict.allPassed).toBe(false);
    expect(verdict.passedCount).toBe(2);
  });

  it("实测恰好等于目标 → 达标", () => {
    const results: PilotResult[] = [
      { criterionId: "C1", actualValue: 95 },
    ];
    const verdict = verifyPilotCriteria([criteria[0]!], results);
    expect(verdict.criteria[0]!.passed).toBe(true);
  });

  it("无实测数据的判据 → 未达标（宁可保守）", () => {
    const verdict = verifyPilotCriteria(criteria, []);
    expect(verdict.allPassed).toBe(false);
    expect(verdict.passedCount).toBe(0);
  });

  it("单项判据校验结果正确", () => {
    const results: PilotResult[] = [
      { criterionId: "C1", actualValue: 97 },
    ];
    const verdict = verifyPilotCriteria([criteria[0]!], results);
    expect(verdict.criteria[0]).toEqual({
      criterionId: "C1",
      description: "识别准确率",
      target: 95,
      actual: 97,
      unit: "%",
      passed: true,
    });
  });

  it("空判据列表 → allPassed=true（零判据默认全通过）", () => {
    const verdict = verifyPilotCriteria([], []);
    expect(verdict.allPassed).toBe(true);
    expect(verdict.passedCount).toBe(0);
    expect(verdict.totalCount).toBe(0);
  });
});

// ─── validateMetric ────────────────────────────────────────────

describe("validateMetric", () => {
  const validMetric: ValueMetric = {
    name: "设备故障率",
    hasBaseline: true,
    isMeasurable: true,
    source: "历史工单数据",
  };

  it("三项全合格 → isValid=true，无 issues", () => {
    const result = validateMetric(validMetric);
    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("无基线 → 不合格，含基线问题", () => {
    const result = validateMetric({ ...validMetric, hasBaseline: false });
    expect(result.isValid).toBe(false);
    expect(result.issues).toContain("缺少基线数据，无法衡量改善幅度");
  });

  it("不可测量 → 不合格，含测量问题", () => {
    const result = validateMetric({ ...validMetric, isMeasurable: false });
    expect(result.isValid).toBe(false);
    expect(result.issues).toContain("指标不可测量，无法验证效果");
  });

  it("来源为空 → 不合格，违反 G-R0", () => {
    const result = validateMetric({ ...validMetric, source: "" });
    expect(result.isValid).toBe(false);
    expect(result.issues).toContain("缺少数据来源，违反溯源铁律（G-R0）");
  });

  it("来源为空白 → 不合格", () => {
    const result = validateMetric({ ...validMetric, source: "   " });
    expect(result.isValid).toBe(false);
  });

  it("多项同时不合格 → issues 包含所有问题", () => {
    const result = validateMetric({
      name: "坏指标",
      hasBaseline: false,
      isMeasurable: false,
      source: "",
    });
    expect(result.isValid).toBe(false);
    expect(result.issues).toHaveLength(3);
  });

  it("metricName 在结果中保留", () => {
    const result = validateMetric(validMetric);
    expect(result.metricName).toBe("设备故障率");
  });
});
