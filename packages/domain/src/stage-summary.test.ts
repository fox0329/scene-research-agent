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
    row({ link: "制水", is_digital: "可以联网采集", can_touch: "可以碰", our_role: "辅助", description: "加药与过滤" }),
    row({ link: "输配", is_digital: "可以联网采集", can_touch: "可以碰", our_role: "替代", description: "管网调度" }),
    row({ link: "原水取水", is_digital: "必须物理隔离", can_touch: "不能碰", our_role: "不参与", description: "水源安全" }),
  ],
  "表1-3": [
    row({ barrier_type: "技术", barrier_name: "等保三级", criteria: "GB/T 22239", current_status: "过得了", judgment: "过得了", evidence_level: "C" }),
    row({ barrier_type: "行业准入", barrier_name: "计量认证", criteria: "CPA", current_status: "绕道", judgment: "绕道", source_type: "AI推断" }),
    row({ barrier_type: "经济", barrier_name: "预算科目", criteria: "智慧水务专项", current_status: "不知道", judgment: "不知道" }),
    row({ barrier_type: "生态锁定", barrier_name: "协议封闭", criteria: "厂商私有协议", current_status: "借道", judgment: "借道", strategy: "借道" }),
    row({ barrier_type: "一票否决者", barrier_name: "水务安全条线", criteria: "供水安全条例", current_status: "过得了", judgment: "过得了" }),
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

describe("stage-summary — 六段骨架", () => {
  const md = summaryFor();

  it("标题与头部信息（场景/产品线/完整度/用户诉求）", () => {
    expect(md).toContain("# 阶段 1 · 认识场景（含门槛与合规） — 总结");
    expect(md).toContain("场景：智慧水务");
    expect(md).toContain("产品线：感知与控制");
    expect(md).toContain("信息完整度：3/8 张表齐备");
    expect(md).toContain("用户诉求（第一输入，唯一基准）");
    expect(md).toContain("想搞清楚什么：值不值得进");
  });

  it("六段标题齐全且顺序固定", () => {
    const titles = ["## 一、信息摘要", "## 二、关键信息清单", "## 三、说明与方法口径", "## 四、来源与抽查", "## 五、待补齐信息", "## 六、上下游衔接"];
    const positions = titles.map((t) => md.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("一、信息摘要含表数/行数/来源分布/假设与推断计数", () => {
    expect(md).toContain("8 张表 / 10 行");
    expect(md).toContain("来源分布 T1");
    expect(md).toContain("C 级假设的条目 1 条");
    expect(md).toContain("系统推断条目 1 条");
  });

  it("二、关键信息清单逐表给行数与取值样例，缺表标「尚无数据」", () => {
    expect(md).toContain("**表1-2 场景环节地图**：3 行——制水·可以联网采集；输配·可以联网采集；原水取水·必须物理隔离");
    expect(md).toContain("**表2-2 场景要素清单**：尚无数据");
  });

  it("三、说明与方法口径列出 C 级假设与系统推断（带表号）", () => {
    expect(md).toContain("C 级假设（1 条，不得当结论用）");
    expect(md).toContain("表1-3｜技术");
    expect(md).toContain("系统推断（1 条");
    expect(md).toContain("表1-3｜行业准入");
  });

  it("四、来源与抽查给出分布与抽查建议", () => {
    expect(md).toContain("来源分布：T1");
    expect(md).toContain("建议抽查 ≥3 条（G-R3）");
    expect(md).toContain("《白皮书》p.3");
  });

  it("五、待补齐信息来自完整度报告", () => {
    expect(md).toContain("尚无数据");
    expect(md).toContain("表2-2 场景要素清单：尚无数据");
  });

  it("六、上下游衔接给出产出、下游引用与上游依据", () => {
    expect(md).toContain("本阶段产出：表1-1、表1-2、表1-3");
    expect(md).toContain("阶段 3 · 能力匹配 会引用：表1-1、表1-2");
    expect(md).toContain("上游依据：M3、M4");
  });
});

describe("stage-summary — 信息版口径", () => {
  it("不含任何建议或判断措辞", () => {
    const md = summaryFor();
    for (const bad of ["建议进", "建议通过", "建议不通过", "建议有条件", "红线"]) {
      expect(md, bad).not.toContain(bad);
    }
    expect(md).toContain("不含任何建议或判断");
  });

  it("空阶段也能生成（不报错，缺口清单占位）", () => {
    const md = summaryFor({});
    expect(md).toContain("信息完整度：0/8");
    expect(md).toContain("（本阶段尚无信息，见第五节待补清单）");
    expect(md).toContain("表1-1 场景概述：尚无数据");
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
    expect(md).toContain("本阶段产出：M1、M2、M3、M4、M5、M6、可选材料");
    expect(md).toContain("**M1 产品清单**：1 行——IPC-3000·IPC");
  });
});
