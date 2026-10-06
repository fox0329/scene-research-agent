import { describe, expect, it } from "vitest";
import { computeRoi, investmentFromCostRows, type RoiRow } from "./roi.js";

/**
 * 投资回报（回收期 = 投入 ÷ 年收益）
 *
 * 这些用例钉的是「不许编造」：缺年收益、投入为 0 时必须报算不出，
 * 而不是给一个看起来合理却无法复核的数字（客户会拿它做决策）。
 */

const BENEFITS: RoiRow[] = [
  { benefit: "巡检人力节省", metric: "巡检工时", annual_value: 120000 },
  { benefit: "故障停机减少", metric: "停机时长", annual_value: 80000 },
];

describe("investmentFromCostRows：取表5-5 的总投入", () => {
  it("有「总投入」行时只认它，不把子块合计再加一遍", () => {
    const rows: RoiRow[] = [
      { item: "硬件成本合计", amount: 118500 },
      { item: "人工成本合计", amount: 27750 },
      { item: "年度运营合计", amount: 32400 },
      { item: "项目总投入（含首年运营）", amount: 178650 },
    ];
    expect(investmentFromCostRows(rows)).toBe(178650);
  });

  it("没有总投入行时，把各子块合计相加", () => {
    const rows: RoiRow[] = [
      { item: "硬件成本合计", amount: 1000 },
      { item: "人工成本合计", amount: 2000 },
      { item: "年度运营合计", amount: 500 },
    ];
    expect(investmentFromCostRows(rows)).toBe(3500);
  });

  it("没有汇总行（还没算成本）→ 0，由调用方报「算不出来」", () => {
    expect(investmentFromCostRows([{ item: "在鸿 IO 控制器", qty: 2, unit_price: 3000 }])).toBe(0);
  });

  it("汇总金额是文本数字（1234.5 / 空串）也能读", () => {
    expect(investmentFromCostRows([{ item: "项目总投入", amount: "1234.5" }])).toBe(1234.5);
    expect(investmentFromCostRows([{ item: "项目总投入", amount: "" }])).toBe(0);
  });
});

describe("computeRoi：回收期与投资回报率", () => {
  it("投入 178650、年收益 20 万 → 回收期 0.89 年、投资回报率 1.12 倍", () => {
    const roi = computeRoi({ investment: 178650, valueRows: BENEFITS });
    expect(roi.blocked).toBeNull();
    expect(roi.annualValue).toBe(200000);
    expect(roi.paybackYears).toBeCloseTo(0.893, 3);
    expect(roi.roiMultiple).toBeCloseTo(1.1195, 3);
    expect(roi.valuedRows).toBe(2);
    expect(roi.totalRows).toBe(2);
    expect(roi.missingAnnualValue).toEqual([]);
  });

  it("年收益带千分位/单位文字也能读（2,400,000 元）", () => {
    const roi = computeRoi({
      investment: 1000000,
      valueRows: [{ benefit: "电费节省", annual_value: "2,400,000 元" }],
    });
    expect(roi.annualValue).toBe(2400000);
    expect(roi.paybackYears).toBeCloseTo(0.4167, 3);
  });

  it("年收益没填 → 不给数字，报出缺哪几条", () => {
    const roi = computeRoi({
      investment: 178650,
      valueRows: [{ benefit: "巡检人力节省", annual_value: 120000 }, { benefit: "品牌提升" }],
    });
    expect(roi.blocked).toBeNull(); // 有一条能算：回收期照算，但要报缺项
    expect(roi.annualValue).toBe(120000);
    expect(roi.missingAnnualValue).toEqual(["品牌提升"]);
    expect(roi.valuedRows).toBe(1);
    expect(roi.totalRows).toBe(2);
  });

  it("一条年收益都没有 → 算不出（blocked 说清原因，数字为 0）", () => {
    const roi = computeRoi({ investment: 178650, valueRows: [{ benefit: "品牌提升" }] });
    expect(roi.blocked).toContain("年收益");
    expect(roi.paybackYears).toBe(0);
    expect(roi.roiMultiple).toBe(0);
    expect(roi.missingAnnualValue).toEqual(["品牌提升"]);
  });

  it("投入为 0（成本还没生成）→ 算不出，不许拿 0 当分母", () => {
    const roi = computeRoi({ investment: 0, valueRows: BENEFITS });
    expect(roi.blocked).toContain("投入");
    expect(roi.paybackYears).toBe(0);
    expect(roi.annualValue).toBe(200000);
  });

  it("年收益填 0 或 -1 不算有效（不能拿 0 当分母，也不能算成负回收期）", () => {
    const roi = computeRoi({
      investment: 1000,
      valueRows: [
        { benefit: "填 0 的", annual_value: 0 },
        { benefit: "填负数的", annual_value: -5000 },
        { benefit: "填文字", annual_value: "待测算" },
      ],
    });
    expect(roi.blocked).toContain("年收益");
    expect(roi.missingAnnualValue).toEqual(["填 0 的", "填负数的", "填文字"]);
  });

  it("收益行没有名字时用占位标签，不报行 id", () => {
    const roi = computeRoi({ investment: 1000, valueRows: [{}] });
    expect(roi.missingAnnualValue).toEqual(["(未命名收益)"]);
  });
});
