import { describe, it, expect } from "vitest";
import { checkStageCompleteness, type InfoRow } from "./completeness.js";
import { buildStageBrief, buildStageSummary, type StageSummaryInput } from "./stage-summary.js";

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
    expect(md).toContain("信息完整度：2/6 张表齐备"); // 阶段 1 = 表1-1、表1-3、表2-2..2-5（有数据的 2 张）
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
    expect(md).toContain("6 张表 / 7 行"); // 表1-1 两行 + 表1-3 五行；表1-2 不算在阶段 1
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
    expect(md).toContain("本阶段产出：表1-1、表1-3、表2-2、表2-3、表2-4、表2-5");
    expect(md).toContain("阶段 3 · 能力匹配 会引用：表1-1");
    expect(md).toContain("阶段 4 · 方案与实现 会引用：表1-1、表1-3、表2-2、表2-3、表2-4、表2-5");
    expect(md).toContain("上游依据：能力清单、边界与限制（不做）");
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
    expect(md3).toContain("信息完整度：1/5 张表齐备");
    expect(md3).toContain("本阶段产出：表1-2、表4-1、表4-2、表4-3、表4-4");
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
    expect(md).toContain("信息完整度：0/6"); // 阶段 1 现为 6 张表
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
    expect(md).toContain("本阶段产出：产品清单、规格书、能力清单、边界与限制（不做）、边界与限制（限制）、报价、可选材料");
    expect(md).toContain("**产品清单**：1 行——IPC-3000·IPC");
  });
});

/**
 * 右栏「阶段总结」要点视图（brief）
 *
 * 用户定调 2026-10-21：「阶段总结只列：调研信息来源的源地址，用户可以打开自己看；
 * 还有关于这个阶段的几个重点的结论性的提醒或建议」。
 * 关键约束：提醒必须由表里的真实字段 + 固定规则推导，不调模型、不编造、不凑数。
 */
describe("stage-summary — 要点视图（brief）", () => {
  /** 按阶段/本步表集构造输入（与右栏同一口径） */
  function briefOf(
    stage: 1 | 3,
    rowsByTable: Record<string, InfoRow[]>,
    step: number,
    tableCodes: string[],
  ): ReturnType<typeof buildStageBrief> {
    const input: StageSummaryInput = {
      stage,
      step,
      tableCodes,
      scope: "step",
      scenarioName: "智慧水务",
      rowsByTable,
      completeness: checkStageCompleteness({ stage, rowsByTable, tableCodes }),
    };
    return buildStageBrief(input);
  }

  const step2Tables = ["表1-3"];
  const step4Tables = ["表4-3", "表4-4"];

  it("表1-3 认证差距非空且不是「无」→ 不建议贸然进入", () => {
    const brief = briefOf(
      1,
      {
        "表1-3": [
          row({
            barrier_type: "行业准入",
            barrier_name: "等保三级",
            criteria: "GB/T 22239",
            cert_gap: "等保三级认证",
          }),
        ],
      },
      2,
      step2Tables,
    );
    expect(brief.advice).toContain(
      "门槛「等保三级」：拿不出 等保三级认证——不建议贸然进入",
    );
  });

  it("表1-3 cert_gap 为「无/不适用/不涉及/暂无」时不产生提醒", () => {
    for (const gap of ["无", "不适用", "不涉及", "暂无"]) {
      const brief = briefOf(
        1,
        { "表1-3": [row({ barrier_name: "防爆认证", cert_gap: gap, criteria: "Ex d" })] },
        2,
        step2Tables,
      );
      expect(brief.advice.join(" "), gap).not.toContain("不建议贸然进入");
    }
  });

  it("表4-4 win_loss 弱 → 不建议正面竞争（有劣势时补进去）", () => {
    const brief = briefOf(
      3,
      {
        "表4-4": [
          row({
            sub_scene: "污水厂集控",
            opponent: "海康",
            win_loss: "弱",
            weakness: "价格高约 20%",
          }),
        ],
      },
      4,
      step4Tables,
    );
    expect(brief.advice).toContain("对 海康 处弱势：价格高约 20%——不建议正面竞争");
  });

  it("数据里带出的内部表号在提醒里换成人类说法（界面不再显示表号）", () => {
    const brief = briefOf(
      3,
      {
        "表4-4": [
          row({
            sub_scene: "会议室",
            opponent: "台电（表3-2 所列无纸化会议厂商）",
            win_loss: "弱",
            weakness: "无会议文件流转",
          }),
        ],
      },
      4,
      step4Tables,
    );
    expect(brief.advice.join("")).not.toContain("表3-2");
    expect(brief.advice.join("")).toContain("（前述无纸化会议厂商）");
  });

  it("表4-3 match 不能做 → 建议分包或放弃这一段", () => {
    const brief = briefOf(
      3,
      {
        "表4-3": [
          row({
            gap_ref: "边缘 AI 推理",
            match: "不能做",
            action: "转分包给算法厂商",
          }),
        ],
      },
      4,
      step4Tables,
    );
    expect(brief.advice).toContain(
      "「边缘 AI 推理」做不了，转分包给算法厂商——建议分包或放弃这一段",
    );
  });

  it("一条都判不出时只给一句兜底，不凑数", () => {
    const brief = briefOf(3, { "表4-3": [row({ gap_ref: "报表导出", match: "真能解" })] }, 4, [
      "表4-3",
    ]);
    expect(brief.advice).toEqual([
      "本步还没有可下结论的判据：门槛、赢面与能力匹配表尚未产出，风险提醒随这些表出现",
    ]);
    // 来源与提醒互相独立：判不出结论也要列出本步用到的来源（无网址时给原文）
    for (const s of brief.sources) {
      expect(s.url).toBe("");
      expect(s.file).toBeTruthy();
    }
  });

  it("提醒去重、每条 ≤60 字、最多 4 条、门槛最多 2 条", () => {
    const barriers: InfoRow[] = [];
    for (let i = 1; i <= 4; i += 1) {
      // 前两行完全相同 → 必须只出现一次
      const n = i <= 2 ? 1 : i;
      barriers.push(row({ barrier_name: `门槛${n}`, cert_gap: `认证${n}` }));
    }
    const brief = briefOf(
      1,
      {
        "表1-3": barriers,
        "表4-4": [
          row({ sub_scene: "A", opponent: "海康", win_loss: "弱", weakness: "价格高 20%" }),
          row({ sub_scene: "B", opponent: "大华", win_loss: "弱" }),
        ],
        "表4-3": [row({ gap_ref: "边缘推理", match: "不能做", action: "转分包" })],
      },
      2,
      ["表1-3", "表4-4", "表4-3"],
    );
    expect(brief.advice).toHaveLength(4);
    expect(new Set(brief.advice).size).toBe(4);
    expect(brief.advice.filter((a) => a.includes("门槛1"))).toHaveLength(1);
    // 门槛超过 2 道时不再往下堆（否则其他三类提醒永远排不上）
    expect(brief.advice.filter((a) => a.includes("不建议贸然进入"))).toHaveLength(2);
    for (const a of brief.advice) expect(Array.from(a).length).toBeLessThanOrEqual(61);
  });

  it("本步一条网址都没有时，退回文件来源（文件名:页码）", () => {
    const brief = briefOf(
      1,
      {
        "表1-3": [
          row({ barrier_name: "等保三级", criteria: "GB/T 22239", source: "产品白皮书.pdf:12" }),
          row({ barrier_name: "防爆认证", criteria: "Ex d IIC T6", source: "产品白皮书.pdf:12" }),
        ],
      },
      2,
      step2Tables,
    );
    expect(brief.sources).toHaveLength(1);
    expect(brief.sources[0]?.url).toBe("");
    expect(brief.sources[0]?.file).toBe("产品白皮书.pdf:12");
    expect(brief.sources[0]?.label).toContain("产品白皮书");
  });

  it("来源只收 http(s)、按规范化地址去重、标签取主键并截断", () => {
    const longName = "某省市政供水管网智能调度与漏损控制综合改造项目准入门槛";
    const brief = briefOf(
      1,
      {
        "表1-3": [
          row({
            barrier_name: longName,
            criteria: "GB 50013",
            source:
              "https://example.com/a，https://example.com/a/ https://example.com/b?utm_source=x https://example.com/wiki/A_(b)",
          }),
          row({
            barrier_name: "计量认证",
            criteria: "CPA",
            source: "《招标文件》p.2", // 没有 URL → 不收
          }),
          row({
            barrier_name: "旧版来源",
            criteria: "x",
            source: "ftp://example.com/a",
          }),
        ],
      },
      2,
      step2Tables,
    );
    expect(brief.sources.map((s) => s.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/wiki/A_(b)",
    ]);
    expect(brief.sources[0]!.label.endsWith("…")).toBe(true);
    expect(Array.from(brief.sources[0]!.label).length).toBe(25); // 24 字 + 省略号
  });

  it("同一标签只留一条（不同 URL 重复收录也不刷屏）", () => {
    const brief = briefOf(
      1,
      {
        "表1-3": [
          row({ barrier_name: "等保三级", criteria: "x", source: "https://example.com/a" }),
          row({ barrier_name: "等保三级", criteria: "x", source: "https://example.com/b" }),
        ],
      },
      2,
      step2Tables,
    );
    expect(brief.sources).toHaveLength(1);
    expect(brief.sources[0]?.url).toBe("https://example.com/a");
  });

  it("来源最多 20 条", () => {
    const rows: InfoRow[] = [];
    for (let i = 1; i <= 25; i += 1) {
      rows.push(row({ barrier_name: `门槛${i}`, criteria: "x", source: `https://example.com/s${i}` }));
    }
    const brief = briefOf(1, { "表1-3": rows }, 2, step2Tables);
    expect(brief.sources).toHaveLength(20);
  });
});
