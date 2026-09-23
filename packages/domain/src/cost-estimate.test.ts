import { describe, it, expect } from "vitest";
import {
  estimateTotalCost,
  positionPrice,
  estimateLaborFromRates,
} from "./cost-estimate.js";
import type { CostItem, TaskEstimate } from "./cost-estimate.js";
import type { CostRate } from "@scene/contract";

// ─── estimateTotalCost ─────────────────────────────────────────

describe("estimateTotalCost", () => {
  const hw: CostItem[] = [
    { id: "H1", name: "服务器", unitCost: 50000, quantity: 2 },
    { id: "H2", name: "交换机", unitCost: 8000, quantity: 1 },
  ];
  const labor: CostItem[] = [
    { id: "L1", name: "实施", unitCost: 2000, quantity: 10 },
  ];
  const ops: CostItem[] = [
    { id: "O1", name: "云服务", unitCost: 3000, quantity: 12 },
  ];

  it("三类成本分别小计正确", () => {
    const result = estimateTotalCost(hw, labor, ops);
    expect(result.hardwareSubtotal).toBe(108000);
    expect(result.laborSubtotal).toBe(20000);
    expect(result.operationSubtotal).toBe(36000);
  });

  it("总成本 = 三类小计之和", () => {
    const result = estimateTotalCost(hw, labor, ops);
    expect(result.total).toBe(164000);
  });

  it("明细条目数量正确", () => {
    const result = estimateTotalCost(hw, labor, ops);
    expect(result.hardwareCosts).toHaveLength(2);
    expect(result.laborCosts).toHaveLength(1);
    expect(result.operationCosts).toHaveLength(1);
  });

  it("每项 subtotal = unitCost * quantity", () => {
    const result = estimateTotalCost(hw, [], []);
    expect(result.hardwareCosts[0]!.subtotal).toBe(100000);
    expect(result.hardwareCosts[1]!.subtotal).toBe(8000);
  });

  it("空列表返回 0", () => {
    const result = estimateTotalCost([], [], []);
    expect(result.total).toBe(0);
    expect(result.hardwareSubtotal).toBe(0);
    expect(result.laborSubtotal).toBe(0);
    expect(result.operationSubtotal).toBe(0);
  });

  it("小数精度保留两位", () => {
    const items: CostItem[] = [
      { id: "X1", name: "小数项", unitCost: 3.333, quantity: 3 },
    ];
    const result = estimateTotalCost(items, [], []);
    expect(result.hardwareCosts[0]!.subtotal).toBe(10); // 3.333*3 = 9.999 → 10.00
  });
});

// ─── positionPrice ─────────────────────────────────────────────

describe("positionPrice", () => {
  it("我方成本高于竞品均值 >5% → 高于竞品", () => {
    const result = positionPrice(60, [{ cost: 50 }]);
    expect(result.position).toBe("高于竞品");
  });

  it("我方成本低于竞品均值 >5% → 低于竞品", () => {
    const result = positionPrice(40, [{ cost: 50 }]);
    expect(result.position).toBe("低于竞品");
  });

  it("我方成本与竞品均值差距 <=5% → 持平", () => {
    const result = positionPrice(50, [{ cost: 50 }]);
    expect(result.position).toBe("持平");
  });

  it("priceRatio 计算正确", () => {
    const result = positionPrice(60, [{ cost: 40 }]);
    expect(result.priceRatio).toBe(1.5);
  });

  it("多个竞品取均值比较", () => {
    const result = positionPrice(50, [{ cost: 40 }, { cost: 60 }]);
    // 均值 50，我方 50 → 持平
    expect(result.position).toBe("持平");
    expect(result.competitorAvgCost).toBe(50);
  });

  it("我方成本 <= 0 抛错", () => {
    expect(() => positionPrice(0, [{ cost: 50 }])).toThrow("我方成本必须大于 0");
    expect(() => positionPrice(-10, [{ cost: 50 }])).toThrow("我方成本必须大于 0");
  });

  it("竞品列表为空抛错", () => {
    expect(() => positionPrice(50, [])).toThrow("竞品列表不能为空");
  });

  it("竞品成本非正数抛错", () => {
    expect(() => positionPrice(50, [{ cost: 0 }])).toThrow("竞品成本必须大于 0");
    expect(() => positionPrice(50, [{ cost: -1 }])).toThrow("竞品成本必须大于 0");
  });
});

// ─── estimateLaborFromRates ────────────────────────────────────

describe("estimateLaborFromRates", () => {
  const rates: CostRate[] = [
    {
      id: "R1", product_line_id: "PL1", category: "实施",
      item: "现场实施", rate: 2000, unit: "元/人天",
      standard_hours: 8, data_source: "历史项目",
      created_at: "", updated_at: "",
    },
    {
      id: "R2", product_line_id: "PL1", category: "商务",
      item: "技术培训", rate: 1500, unit: "元/人天",
      standard_hours: 6, data_source: "历史项目",
      created_at: "", updated_at: "",
    },
  ];

  it("匹配费率的任务正确计算人工成本", () => {
    const tasks: TaskEstimate[] = [
      { taskName: "部署实施", personDays: 5, rateCategory: "现场实施" },
      { taskName: "客户培训", personDays: 2, rateCategory: "技术培训" },
    ];
    const result = estimateLaborFromRates(rates, tasks);
    // 5*2000 + 2*1500 = 13000
    expect(result).toBe(13000);
  });

  it("未匹配费率的任务跳过（不阻断流程，G-R7）", () => {
    const tasks: TaskEstimate[] = [
      { taskName: "未知任务", personDays: 3, rateCategory: "不存在的类别" },
    ];
    expect(estimateLaborFromRates(rates, tasks)).toBe(0);
  });

  it("混合匹配与未匹配任务", () => {
    const tasks: TaskEstimate[] = [
      { taskName: "部署", personDays: 3, rateCategory: "现场实施" },
      { taskName: "未知", personDays: 10, rateCategory: "未知类别" },
    ];
    expect(estimateLaborFromRates(rates, tasks)).toBe(6000);
  });

  it("空费率表返回 0", () => {
    const tasks: TaskEstimate[] = [
      { taskName: "部署", personDays: 5, rateCategory: "现场实施" },
    ];
    expect(estimateLaborFromRates([], tasks)).toBe(0);
  });

  it("空任务列表返回 0", () => {
    expect(estimateLaborFromRates(rates, [])).toBe(0);
  });

  it("精度保留两位小数", () => {
    const preciseRates: CostRate[] = [
      {
        id: "R3", product_line_id: "PL1", category: "实施",
        item: "精细", rate: 1234.56, unit: "元/人天",
        standard_hours: 8, data_source: "历史项目",
        created_at: "", updated_at: "",
      },
    ];
    const tasks: TaskEstimate[] = [
      { taskName: "测试", personDays: 3, rateCategory: "精细" },
    ];
    // 1234.56 * 3 = 3703.68
    expect(estimateLaborFromRates(preciseRates, tasks)).toBe(3703.68);
  });
});
