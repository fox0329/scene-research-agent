import { describe, it, expect } from "vitest";
import {
  HOURS_PER_DAY,
  costBlockOf,
  normalizeCostItem,
  recomputeCostRows,
  type CostRateItem,
  type CostRow,
} from "./cost-recompute.js";

/** M6 内部费率（实测线上的 14 项，单价 1000/1500/400/10000…） */
const RATES: CostRateItem[] = [
  { item: "现场勘察与点位清点", rate: 1000, scope: "library" },
  { item: "设备安装与上电调试", rate: 1000, scope: "library" },
  { item: "协议接入与点位联调", rate: 1000, scope: "library" },
  { item: "控制逻辑与场景联动配置", rate: 1000, scope: "library" },
  { item: "近场交互（元服务）开发", rate: 1000, scope: "library" },
  { item: "平台上云与子系统纳管", rate: 1000, scope: "library" },
  { item: "客户业务系统对接", rate: 1000, scope: "library" },
  { item: "培训与交付文档", rate: 1000, scope: "library" },
  { item: "试运行与验收支持", rate: 1000, scope: "library" },
  { item: "定制开发（按需授予）", rate: 1500, scope: "library" },
  { item: "项目管理（按实施人天计提）", rate: 1000, scope: "library" },
  { item: "差旅（元/人天·趟）", rate: 400, scope: "library" },
  { item: "售后运维（年费）", rate: 10000, scope: "library" },
  { item: "备件与耗材", rate: 1000, scope: "library" },
];

describe("costBlockOf：按行有哪些键认子块", () => {
  it("硬件 / 人工 / 运营 / 汇总 各认各的", () => {
    expect(costBlockOf({ item: "控制器", qty: 1, unit_price: 1500, subtotal: 1500 })).toBe("硬件");
    expect(costBlockOf({ item: "勘察", hours: 16, day_rate: 1000, cost: 2000 })).toBe("人工");
    expect(costBlockOf({ item: "售后运维", annual_fee: 10000 })).toBe("运营");
    expect(costBlockOf({ item: "合计", amount: 65200 })).toBe("汇总");
  });
});

describe("normalizeCostItem：括号里的补充说明不影响匹配", () => {
  it("表5-3 与 M6 的实测差异都能归一", () => {
    expect(normalizeCostItem("定制开发（按需授予，条件项）")).toBe(
      normalizeCostItem("定制开发（按需授予）"),
    );
    expect(normalizeCostItem("项目管理（按实施人天约 10% 计提）")).toBe(
      normalizeCostItem("项目管理（按实施人天计提）"),
    );
    expect(normalizeCostItem("差旅（按实施人天·趟计提）")).toBe("差旅");
  });
});

describe("recomputeCostRows：金额由公式算", () => {
  it("硬件小计 = 数量 × 单价（行里写错就纠正）", () => {
    const result = recomputeCostRows({
      rows: [{ item: "IO 控制器", spec: "CT15", qty: 4, unit_price: 400, subtotal: 999 }],
      plans: [],
      rates: RATES,
    });
    expect(result.rows[0]!["subtotal"]).toBe(1600);
    expect(result.changed).toBe(1);
  });

  it("人工费用 = 表5-3 人天 × M6 单价；工时按 8 小时/人天 写回", () => {
    const result = recomputeCostRows({
      rows: [
        { item: "现场勘察与点位清点", hours: 16, day_rate: 1500, cost: 3000, spec: "模型写的说明" },
      ],
      plans: [{ item: "现场勘察与点位清点", man_days: 2 }],
      rates: RATES,
    });
    const row = result.rows[0]!;
    expect(row["hours"]).toBe(2 * HOURS_PER_DAY);
    expect(row["day_rate"]).toBe(1000); // 从 M6 取，不是模型的 1500
    expect(row["cost"]).toBe(2000); // 2 人天 × 1000
    expect(String(row["source"])).toContain("M6");
    expect(row["spec"]).toBe("模型写的说明"); // 文字列不动
  });

  it("出处文案分得清人天来源：表5-3 的项 vs 模型自造的行", () => {
    const planned = recomputeCostRows({
      rows: [{ item: "现场勘察与点位清点", hours: 16, day_rate: 1000, cost: 2000 }],
      plans: [{ item: "现场勘察与点位清点", man_days: 2 }],
      rates: RATES,
    });
    expect(String(planned.rows[0]!["source"])).toContain("表5-3 人天(2)");
    expect(String(planned.rows[0]!["source"])).toContain("M6「现场勘察与点位清点」单价(1000 元/人天)");

    const invented = recomputeCostRows({
      rows: [{ item: "勘察与实施准备", hours: 18, day_rate: 1500, cost: 3375 }],
      plans: [{ item: "现场勘察与点位清点", man_days: 2 }],
      rates: RATES,
    });
    expect(String(invented.rows[0]!["source"])).toContain("行内工时折算(2.25 人天)");
    expect(String(invented.rows[0]!["source"])).toContain("M6 无对应项");
  });

  it("工时是小时：256 工时（32 人天）× 400 = 12800（差旅行沿用行内工时）", () => {
    const result = recomputeCostRows({
      rows: [{ item: "差旅（按实施人天·趟计提）", hours: 256, day_rate: 400, cost: 0 }],
      plans: [],
      rates: RATES,
    });
    expect(result.rows[0]!["cost"]).toBe(12800);
  });

  it("单价 ≤ 0（没填）不算成 0 元：沿用模型估价并记入 missingRates", () => {
    const result = recomputeCostRows({
      rows: [{ item: "协议接入与点位联调", hours: 24, day_rate: 1500, cost: 4500 }],
      plans: [{ item: "协议接入与点位联调", man_days: 3 }],
      rates: [{ item: "协议接入与点位联调", rate: 0, scope: "own" }],
    });
    expect(result.rows[0]!["cost"]).toBe(4500); // 3 人天 × 1500（模型估价），不是 0
    expect(result.missingRates).toContain("协议接入与点位联调");
  });

  it("M6 没有这一项 → 记入 missingRates，费用沿用行的估价", () => {
    const result = recomputeCostRows({
      rows: [{ item: "某新型作业", hours: 8, day_rate: 900, cost: 900 }],
      plans: [{ item: "某新型作业", man_days: 1 }],
      rates: [],
    });
    expect(result.missingRates).toContain("某新型作业");
    expect(result.rows[0]!["cost"]).toBe(900);
  });

  it("单价仍标「待确认」：照算，但记入 pendingRates（报价前须确认来源）", () => {
    const result = recomputeCostRows({
      rows: [{ item: "试运行与验收支持", hours: 24, day_rate: 1000, cost: 3000 }],
      plans: [{ item: "试运行与验收支持", man_days: 3 }],
      rates: [{ item: "试运行与验收支持", rate: 1000, data_source: "待确认", scope: "own" }],
    });
    expect(result.rows[0]!["cost"]).toBe(3000);
    expect(result.pendingRates).toContain("试运行与验收支持");
  });

  it("同名两项：本场景专属库的单价压过通用库", () => {
    const result = recomputeCostRows({
      rows: [{ item: "培训与交付文档", hours: 8, day_rate: 0, cost: 0 }],
      plans: [{ item: "培训与交付文档", man_days: 1 }],
      rates: [
        { item: "培训与交付文档", rate: 1000, scope: "library" },
        { item: "培训与交付文档", rate: 800, scope: "own" },
      ],
    });
    expect(result.rows[0]!["day_rate"]).toBe(800);
    expect(result.rows[0]!["cost"]).toBe(800);
  });

  it("运营年费 = M6 单价", () => {
    const result = recomputeCostRows({
      rows: [{ item: "售后运维（年费）", annual_fee: 1, note: "按年计提" }],
      plans: [],
      rates: RATES,
    });
    expect(result.rows[0]!["annual_fee"]).toBe(10000);
    expect(result.rows[0]!["note"]).toBe("按年计提");
  });

  it("表5-3 有人天、表5-5 缺行 → 补在 added，不删任何行", () => {
    const result = recomputeCostRows({
      rows: [{ item: "现场勘察与点位清点", hours: 16, day_rate: 1000, cost: 2000 }],
      plans: [
        { item: "现场勘察与点位清点", man_days: 2 },
        { item: "平台上云与子系统纳管", man_days: 3 },
      ],
      rates: RATES,
    });
    expect(result.rows).toHaveLength(1); // 既有行不增不删
    expect(result.added).toHaveLength(1);
    expect(result.added[0]!["item"]).toBe("平台上云与子系统纳管");
    expect(result.added[0]!["cost"]).toBe(3000);
  });

  it("没有可用单价的行不补（补一行 0 元反而误导）", () => {
    const result = recomputeCostRows({
      rows: [],
      plans: [{ item: "某新型作业", man_days: 2 }],
      rates: [{ item: "某新型作业", rate: 0, scope: "own" }],
    });
    expect(result.added).toHaveLength(0);
    expect(result.missingRates).toContain("某新型作业");
  });
});

describe("recomputeCostRows：模型自造的人工行不许被算两遍", () => {
  it("人工块是模型归并的行（M6 认不出）→ 不补表5-3 的行，并报出这些行", () => {
    const result = recomputeCostRows({
      rows: [
        { item: "勘察与实施准备", hours: 18, day_rate: 1500, cost: 3375 },
        { item: "硬件安装与设备接入", hours: 35, day_rate: 1500, cost: 6562.5 },
      ],
      plans: [
        { item: "现场勘察与点位清点", man_days: 2 },
        { item: "设备安装与上电调试", man_days: 3 },
      ],
      rates: RATES,
    });
    expect(result.added).toHaveLength(0); // 补了就是同一批工作算两遍
    expect(result.unmatchedLabor).toEqual(["勘察与实施准备", "硬件安装与设备接入"]);
    expect(result.missingRates).toEqual(["勘察与实施准备", "硬件安装与设备接入"]);
  });

  it("差旅这种 M6 认得出的额外行不算「模型自造」，照常补表5-3 缺的行", () => {
    const result = recomputeCostRows({
      rows: [
        { item: "现场勘察与点位清点", hours: 16, day_rate: 1000, cost: 2000 },
        { item: "差旅（按实施人天·趟计提）", hours: 256, day_rate: 400, cost: 12800 },
      ],
      plans: [
        { item: "现场勘察与点位清点", man_days: 2 },
        { item: "设备安装与上电调试", man_days: 3 },
      ],
      rates: RATES,
    });
    expect(result.unmatchedLabor).toEqual([]);
    expect(result.added.map((r) => r["item"])).toEqual(["设备安装与上电调试"]);
  });
});

describe("recomputeCostRows：汇总 = 各子块之和", () => {
  const rows: CostRow[] = [
    { item: "在鸿 IO 控制器", spec: "CT15", qty: 1, unit_price: 1500, subtotal: 1500 },
    { item: "末端执行与感知模块", spec: "模块", qty: 4, unit_price: 400, subtotal: 1600 },
    { item: "现场勘察与点位清点", hours: 16, day_rate: 1000, cost: 2000 },
    { item: "设备安装与上电调试", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "差旅（按实施人天·趟计提）", hours: 256, day_rate: 400, cost: 12800 },
    { item: "售后运维（年费）", annual_fee: 10000 },
    { item: "备件与耗材（年计提）", annual_fee: 1000 },
    { item: "硬件（1 间会议室典型配置）", amount: 0, source: "行业通例（模型知识）" },
    { item: "人工（项目基线，含差旅）", amount: 0 },
    { item: "运营（首年）", amount: 0 },
    { item: "合计（1 间硬件+项目人工+首年运营）", amount: 0 },
  ];

  it("四个汇总行分别等于各子块之和；文字/出处不动", () => {
    const result = recomputeCostRows({
      rows,
      plans: [
        { item: "现场勘察与点位清点", man_days: 2 },
        { item: "设备安装与上电调试", man_days: 3 },
      ],
      rates: RATES,
    });
    expect(result.totals).toEqual({
      hardware: 3100,
      labor: 2000 + 3000 + 12800,
      operation: 11000,
      total: 3100 + 17800 + 11000,
    });
    const amounts = result.rows.map((r) => r["amount"]).filter((v) => v !== undefined);
    expect(amounts).toEqual([3100, 17800, 11000, 31900]);
    expect(result.rows[7]!["source"]).toBe("行业通例（模型知识）");
    expect(result.missingTotals).toEqual([]);
  });

  it("汇总行缺失如实报告（合格线「汇总 = 各子块之和」）", () => {
    const result = recomputeCostRows({
      rows: [{ item: "在鸿 IO 控制器", qty: 1, unit_price: 1500, subtotal: 1500 }],
      plans: [],
      rates: RATES,
    });
    expect(result.missingTotals).toContain("总合计");
  });
});

describe("recomputeCostRows：线上快照复现（智慧会议室 2026-10-05）", () => {
  /** 线上实测：硬件 9400 / 人工 44800（32 个人天 + 差旅 12800）/ 运营 11000 / 总 65200 */
  const LIVE_ROWS: CostRow[] = [
    { item: "在鸿 IO 控制器（核心模块）", qty: 1, unit_price: 1500, subtotal: 1500 },
    { item: "IO 扩展模块（DI/DO/AI/AO 各 1）", qty: 4, unit_price: 400, subtotal: 1600 },
    { item: "在鸿物联网关", qty: 1, unit_price: 1200, subtotal: 1200 },
    { item: "工业触控屏（HMI）", qty: 1, unit_price: 1500, subtotal: 1500 },
    { item: "近场交互终端", qty: 1, unit_price: 2000, subtotal: 2000 },
    { item: "末端执行与感知模块", qty: 4, unit_price: 400, subtotal: 1600 },
    { item: "现场勘察与点位清点", hours: 16, day_rate: 1000, cost: 2000 },
    { item: "设备安装与上电调试", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "协议接入与点位联调", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "控制逻辑与场景联动配置", hours: 32, day_rate: 1000, cost: 4000 },
    { item: "近场交互（元服务）开发", hours: 40, day_rate: 1000, cost: 5000 },
    { item: "平台上云与子系统纳管", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "客户业务系统对接", hours: 32, day_rate: 1000, cost: 4000 },
    { item: "培训与交付文档", hours: 16, day_rate: 1000, cost: 2000 },
    { item: "试运行与验收支持", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "项目管理（按实施人天约 10% 计提）", hours: 24, day_rate: 1000, cost: 3000 },
    { item: "差旅（按实施人天·趟计提）", hours: 256, day_rate: 400, cost: 12800 },
    { item: "定制开发（条件项，不触发不发生）", hours: 0, day_rate: 1500, cost: 0 },
    { item: "售后运维（年费）", annual_fee: 10000 },
    { item: "备件与耗材（年计提）", annual_fee: 1000 },
    { item: "硬件（1 间会议室典型配置）", amount: 9400 },
    { item: "人工（项目基线，含差旅）", amount: 44800 },
    { item: "运营（首年）", amount: 11000 },
    { item: "合计（1 间硬件+项目人工+首年运营）", amount: 65200 },
  ];

  /** 表5-3 实施计划的 11 项人天（线上实测） */
  const PLANS = [
    { item: "现场勘察与点位清点", man_days: 2 },
    { item: "设备安装与上电调试", man_days: 3 },
    { item: "协议接入与点位联调", man_days: 3 },
    { item: "控制逻辑与场景联动配置", man_days: 4 },
    { item: "近场交互（元服务）开发", man_days: 5 },
    { item: "平台上云与子系统纳管", man_days: 3 },
    { item: "客户业务系统对接", man_days: 4 },
    { item: "培训与交付文档", man_days: 2 },
    { item: "试运行与验收支持", man_days: 3 },
    { item: "定制开发（按需授予，条件项）", man_days: 0 },
    { item: "项目管理（按实施人天计提）", man_days: 3 },
  ];

  /** 实施类那 9 项（合计 29 人天）——涨价用例只动这 9 项 */
  const IMPLEMENTATION_ITEMS = [
    "现场勘察与点位清点",
    "设备安装与上电调试",
    "协议接入与点位联调",
    "控制逻辑与场景联动配置",
    "近场交互（元服务）开发",
    "平台上云与子系统纳管",
    "客户业务系统对接",
    "培训与交付文档",
    "试运行与验收支持",
  ];

  it("重算结果与线上一致（人工 44800、总 65200），且每一行都乘得出来", () => {
    const result = recomputeCostRows({ rows: LIVE_ROWS, plans: PLANS, rates: RATES });
    expect(result.totals).toEqual({ hardware: 9400, labor: 44800, operation: 11000, total: 65200 });
    expect(result.added).toHaveLength(0);
    expect(result.missingRates).toEqual([]);
    expect(result.rows).toHaveLength(LIVE_ROWS.length);
    // 每一行自洽：硬件 小计 = 数量 × 单价；人工 费用 = 工时 ÷ 8 × 人天单价
    for (const row of result.rows) {
      if (costBlockOf(row) === "硬件") {
        expect(row["subtotal"]).toBe((row["qty"] as number) * (row["unit_price"] as number));
      }
      if (costBlockOf(row) === "人工") {
        expect(row["cost"]).toBe(
          ((row["hours"] as number) / HOURS_PER_DAY) * (row["day_rate"] as number),
        );
      }
    }
  });

  it("M6 单价从 1000 改成 1200 → 人工块与总合计跟着变（这才是「单价一改数字就对」）", () => {
    // 只涨实施类那 9 项（29 个人天），项目管理/差旅/售后/备件不涨
    const raised = RATES.map((r) =>
      IMPLEMENTATION_ITEMS.includes(r.item) ? { ...r, rate: 1200 } : r,
    );
    const result = recomputeCostRows({ rows: LIVE_ROWS, plans: PLANS, rates: raised });
    // 实施 29 人天涨 200（32000 → 37800）；项目管理仍是 1000（原 3000）；差旅是「人天·趟」价，不受实施类涨价影响
    expect(result.totals.labor).toBe(32000 + 29 * 200 + 12800);
    expect(result.totals.total).toBe(9400 + result.totals.labor + 11000);
  });
});
