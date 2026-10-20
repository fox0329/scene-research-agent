import { describe, it, expect } from "vitest";
import { checkStageCompleteness, type InfoRow } from "./completeness.js";
import { buildStageSummary } from "./stage-summary.js";

const row = (o: Record<string, unknown>): InfoRow => ({ source: "《白皮书》p.3", ...o });

const anchor: InfoRow[] = [
  row({ item: "场景名称", content: "智慧水务", source_type: "用户补充" }),
  row({ item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" }),
];

const stage1Rows: Record<string, InfoRow[]> = {
  "表1-1": anchor,
  "表1-2": [
    row({ link: "制水", can_touch: "可以碰", our_role: "辅助", description: "加药与过滤" }),
    row({ link: "输配", can_touch: "可以碰", our_role: "替代", description: "管网调度" }),
    row({ link: "原水取水", can_touch: "不能碰", our_role: "不参与", description: "水源安全" }),
  ],
  "表1-3": [
    row({ barrier_type: "技术", barrier_name: "等保三级", criteria: "GB/T 22239", judgment: "过得了", evidence_level: "C" }),
    row({ barrier_type: "行业准入", barrier_name: "计量认证", criteria: "CPA", judgment: "绕道", source_type: "AI推断" }),
    row({ barrier_type: "经济", barrier_name: "预算科目", criteria: "智慧水务专项", judgment: "不知道" }),
    row({ barrier_type: "生态锁定", barrier_name: "协议封闭", criteria: "厂商私有协议", judgment: "借道", strategy: "借道" }),
    row({ barrier_type: "一票否决者", barrier_name: "水务安全条线", criteria: "供水安全条例", judgment: "过得了" }),
  ],
};

function summaryFor(rows: Record<string, InfoRow[]> = stage1Rows): string {
  const completeness = checkStageCompleteness({ stage: 1, rowsByTable: rows });
  return buildStageSummary({
    stage: 1,
    scenarioName: "智慧水务",
    productLineName: "感知与控制",
    rowsByTable: rows,
    completeness,
    briefRawText: "场景名称：智慧水务\n想搞清楚什么：值不值得进",
    generatedAt: "2026-09-25",
  });
}

/**
 * 步骤级总结（右栏口径，v2.9）
 *
 * 用户定调「右栏的补充说明和阶段总结只针对当前阶段做说明和总结，不要整理整个过程」：
 * 步骤级只覆盖本步表集，且**不含用户诉求全文与上下游衔接**（那两段属于阶段级/交付物）。
 */
describe("stage-summary — 步骤级只讲本步", () => {
  // 第 2 步（认识场景）本步表集：阶段 1 六张减去场景锚，表1-3 是其中之一
  // （表1-2 已迁到阶段 3，不再是第 2 步的表）
  const stepRows: Record<string, InfoRow[]> = { "表1-3": stage1Rows["表1-3"] ?? [] };
  const md = buildStageSummary({
    stage: 1,
    step: 2,
    tableCodes: ["表1-3"],
    scope: "step",
    scenarioName: "智慧水务",
    productLineName: "感知与控制",
    rowsByTable: stepRows,
    completeness: checkStageCompleteness({ stage: 1, rowsByTable: stepRows, tableCodes: ["表1-3"] }),
    briefRawText: "场景名称：智慧水务\n想搞清楚什么：值不值得进",
    generatedAt: "2026-09-25",
  });

  it("抬头写「第 n 步」而不是底层阶段名", () => {
    expect(md).toContain("# 第 2 步 · 认识场景 — 总结");
    expect(md).not.toContain("阶段 1 ·");
    expect(md).toContain("本步要获得的信息是：");
  });

  it("不含用户诉求全文（那是整个项目的输入，不属于某一步）", () => {
    expect(md).not.toContain("用户诉求（第一输入，唯一基准）");
    expect(md).not.toContain("值不值得进");
  });

  it("不含「六、上下游衔接」（那是整个流程的映射）", () => {
    expect(md).not.toContain("上下游衔接");
    expect(md).not.toContain("上游依据");
  });

  it("只写本步表集：其他表的行与表名不出现，完整度也只算本步", () => {
    expect(md).toContain("表1-3");
    expect(md).not.toContain("表1-1");
    expect(md).not.toContain("表1-2"); // 表1-2 属阶段 3，不该进第 2 步的总结
    expect(md).toContain("信息完整度：1/1 张表齐备");
  });

  it("五段骨架齐全且顺序固定（步骤级没有第六段）", () => {
    const titles = ["## 一、信息摘要", "## 二、关键信息清单", "## 三、说明与方法口径", "## 四、核实结论", "## 五、待补齐信息"];
    const positions = titles.map((t) => md.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("stage-summary — 阶段级六段骨架（交付物装配口径）", () => {
  const md = summaryFor();

  it("标题与头部信息（场景/产品线/完整度/用户诉求）", () => {
    expect(md).toContain("# 阶段 1 · 认识场景（含门槛与合规） — 总结");
    expect(md).toContain("场景：智慧水务");
    expect(md).toContain("产品线：感知与控制");
    expect(md).toContain("信息完整度：2/5 张表齐备"); // 阶段 1 = 表1-1、表1-3、表2-2..2-5（有数据的 2 张）
    expect(md).toContain("用户诉求（第一输入，唯一基准）");
    expect(md).toContain("想搞清楚什么：值不值得进");
  });

  it("六段标题齐全且顺序固定", () => {
    const titles = ["## 一、信息摘要", "## 二、关键信息清单", "## 三、说明与方法口径", "## 四、核实结论", "## 五、待补齐信息", "## 六、上下游衔接"];
    const positions = titles.map((t) => md.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("一、信息摘要含表数/行数/来源分布/假设与推断计数", () => {
    expect(md).toContain("5 张表 / 7 行"); // 表1-1 两行 + 表1-3 五行；表1-2 不算在阶段 1
    expect(md).toContain("来源分布 T1");
    expect(md).toContain("C 级假设的条目 1 条");
    expect(md).toContain("系统推断条目 1 条");
  });

  it("二、关键信息清单逐表给行数与取值样例，缺表标「尚无数据」", () => {
    expect(md).toContain("**表1-1 场景概述**：2 行——场景名称·智慧水务；客户类型/行业·市政水务集团");
    expect(md).toContain("**表1-3 门槛与合规**：5 行——技术·等保三级；行业准入·计量认证；经济·预算科目 …");
    expect(md).toContain("**表2-2 场景要素清单**：尚无数据");
    // 客户现状（表1-2 场景环节地图）归阶段 3，阶段 1 的清单里不该出现（表2-7 已删除，变更表 #226）
    expect(md).not.toContain("表1-2");
    expect(md).not.toContain("表2-7");
  });

  it("三、说明与方法口径列出 C 级假设与系统推断（带表号）", () => {
    expect(md).toContain("C 级假设（1 条，按 G-R2 不作结论；核实结论见第四节）");
    expect(md).toContain("表1-3｜技术");
    expect(md).toContain("系统推断（1 条");
    expect(md).toContain("表1-3｜行业准入");
  });

  it("四、核实结论给出核实分布、无法核实清单与核实理由指引", () => {
    expect(md).toContain("来源分布：T1");
    // v1.27：不再把核实推给读者（没有「建议抽查」），而是给出模型自己的核实判定
    expect(md).not.toContain("建议抽查");
    expect(md).toContain("核实分布：已核实");
    expect(md).toContain("每条信息的核实理由");
    // 来源清单不再在总结里复述（附录 A 有来源索引）；这里只给分布
    expect(md).not.toMatch(/建议抽查/);
  });

  it("四、核实结论的来源分布带上「未标」（否则全 0 与「共 N 个来源」自相矛盾）", () => {
    // 夹具里的行没有权威性字段 → 应显示「未标」
    const seg = summaryFor();
    const i = seg.indexOf("## 四、核实结论");
    const section = seg.slice(i, seg.indexOf("## 五、"));
    expect(section).toContain("未标");
    expect(section).not.toMatch(/T1 0 条 \/ T2 0 条 \/ T3 0 条 \/ T4 0 条；不同来源共 [1-9]/);
  });

  it("五、待补齐信息来自完整度报告", () => {
    expect(md).toContain("尚无数据");
    expect(md).toContain("表2-2 场景要素清单：尚无数据");
  });

  it("六、上下游衔接给出产出、下游引用与上游依据", () => {
    expect(md).toContain("本阶段产出：表1-1、表1-3、表2-2、表2-4、表2-5");
    expect(md).toContain("阶段 3 · 能力匹配 会引用：表1-1");
    expect(md).toContain("阶段 4 · 方案与实现 会引用：表1-1、表1-3、表2-2、表2-4、表2-5");
    expect(md).toContain("上游依据：M3、M4");
  });

  it("表1-2 的总结归阶段 3（能力匹配）：产出清单与行样例都在那里", () => {
    const rows: Record<string, InfoRow[]> = {
      "表1-2": stage1Rows["表1-2"] ?? [],
    };
    const md3 = buildStageSummary({
      stage: 3,
      scenarioName: "智慧水务",
      productLineName: "感知与控制",
      rowsByTable: rows,
      completeness: checkStageCompleteness({ stage: 3, rowsByTable: rows }),
      briefRawText: "场景名称：智慧水务\n想搞清楚什么：值不值得进",
      generatedAt: "2026-09-25",
    });
    expect(md3).toContain("# 阶段 3 · 能力匹配 — 总结");
    expect(md3).toContain("信息完整度：1/6 张表齐备");
    expect(md3).toContain("本阶段产出：表1-2、表4-1、表4-2、表4-3、表4-4、表4-5");
    expect(md3).toContain("**表1-2 场景环节地图**：3 行——制水；输配；原水取水");
    expect(md3).toContain("**表4-1 能力底账**：尚无数据");
    expect(md3).not.toContain("表1-3"); // 门槛与合规留在阶段 1
  });
});

describe("stage-summary — 信息版口径", () => {
  it("不含决策建议措辞（但必须带核实结论）", () => {
    const md = summaryFor();
    for (const bad of ["建议进", "建议通过", "建议不通过", "建议有条件", "红线"]) {
      expect(md, bad).not.toContain(bad);
    }
    expect(md).toContain("不给决策建议");
    expect(md).toContain("核实结论");
  });

  it("空阶段也能生成（不报错，缺口清单占位）", () => {
    const md = summaryFor({});
    expect(md).toContain("信息完整度：0/5"); // 阶段 1 现为 6 张表
    expect(md).toContain("（本阶段尚无信息，见第五节待补清单）");
    expect(md).toContain("表1-1 场景概述：尚无数据");
    expect(md).not.toContain("表1-2"); // 表1-2 不属阶段 1
  });
});

describe("stage-summary — 确定性", () => {
  it("同输入同输出（注入 generatedAt 后完全可复现）", () => {
    expect(summaryFor()).toBe(summaryFor());
  });

  it("阶段 0 也能生成，且表清单来自注册表", () => {
    const rows = { M1: [row({ model: "IPC-3000", name: "IPC", status: "在售" })] };
    const completeness = checkStageCompleteness({ stage: 0, rowsByTable: rows });
    const md = buildStageSummary({
      stage: 0,
      scenarioName: "智慧水务",
      rowsByTable: rows,
      completeness,
      generatedAt: "2026-09-25",
    });
    expect(md).toContain("# 阶段 0 · 材料解析与入库 — 总结");
    expect(md).toContain("本阶段产出：M1、M2、M3、M4、M5、可选材料");
    expect(md).toContain("**M1 产品清单**：1 行——IPC-3000·IPC");
  });
});
