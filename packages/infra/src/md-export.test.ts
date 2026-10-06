/**
 * @scene/infra — 交付物导出测试（v1.4 装配式）
 *
 * 覆盖：
 * - 内部报告 = 阶段总结装配 + 附录（来源索引、信息覆盖概览）
 * - 对外材料 = 章节 ← 表映射，**只渲染中栏列**
 * - **两份文档都不含建议与判断**（这是本次重写的核心约束）
 * - 对外材料不含内部信息（竞品身份表、证据级标签、利润池）
 * - 空数据降级、文件命名规则
 */

import { describe, it, expect } from "vitest";
import { exportDeliverables, exportFileName } from "./md-export.js";
import type { DeliverableInput, StageData } from "@scene/contract";

// ─── 测试数据构造 ────────────────────────────────────────────

function row(
  table_code: string,
  fields: Record<string, unknown>,
  extra: Partial<StageData> = {},
): StageData {
  return {
    id: `sd-${table_code}-${Math.random().toString(36).slice(2, 8)}`,
    scenario_id: "s1",
    stage: 1 as StageData["stage"],
    table_code: table_code as StageData["table_code"],
    row: fields,
    is_stale: false,
    source: "《白皮书》p.3",
    source_type: "AI提取",
    created_at: "2026-09-01",
    updated_at: "2026-09-01",
    ...extra,
  };
}

function makeInput(): DeliverableInput {
  return {
    scenario: {
      id: "s1",
      name: "智慧水务",
      product_line_id: "pl-iot",
      status: "进行中",
      current_stage: 6 as never,
      created_at: "2026-09-01",
      updated_at: "2026-09-15",
    },
    stageSummaries: [
      {
        stage: 0,
        title: "材料解析与入库",
        markdown: "# 阶段 0 · 材料解析与入库 — 总结\n\n## 一、信息摘要\n\n共获得 7 张表 / 12 行信息。",
      },
      {
        stage: 1,
        title: "认识场景（含门槛与合规）",
        markdown: "# 阶段 1 · 认识场景（含门槛与合规） — 总结\n\n## 五、待补齐信息\n\n- 表1-2 尚无数据",
      },
    ],
    stageData: [
      row("表1-1", { item: "场景名称", content: "智慧水务" }),
      row("表1-1", { item: "场景边界", content: "制水到输配" }),
      row("表1-1", { item: "买方类型", content: "市政水务集团" }),
      row("表1-2", {
        link: "制水",
        can_touch: "可以碰",
        our_role: "辅助",
        description: "加药与过滤",
      }),
      row("表1-3", {
        barrier_type: "技术",
        barrier_name: "等保三级",
        veto_holder: "",
        criteria: "GB/T 22239",
        judgment: "过得了",
      }),
      // 对外材料必须排除的表
      row("表3-1", { link: "视频监控", gross_margin: "35%", representative: "海康/大华" }),
      row("表3-4", {
        dimension: "算法准确率",
        our: "95%",
        competitor_a: "海康",
        competitor_b: "大华",
        competitor_c: "",
      }),
      row("表5-1", {
        layer: "边缘层",
        components: "边缘网关",
        interface: "Modbus",
        integration: "协议转换",
        boundary: "不承担安全责任",
        interface_name: "",
        type: "",
        protocol: "",
      }),
      row("表6-1", {
        benefit: "降低漏损",
        metric: "漏损率",
        baseline: "18%",
        expected: "12%",
        how_to_measure: "分区计量",
        user_feeling: "水费下降",
        evidence_level: "C",
      }),
    ],
    generatedAt: "2026-09-25",
  };
}

describe("exportFileName", () => {
  it("内部报告文件名", () => {
    expect(exportFileName("智慧水务", "internal")).toBe("内部调研报告.md");
  });

  it("对外材料文件名", () => {
    expect(exportFileName("智慧水务", "external")).toBe("对外汇报材料.md");
  });

  it("不同场景名不影响文件名（命名规则固定）", () => {
    expect(exportFileName("A", "internal")).toBe(exportFileName("B", "internal"));
  });
});

describe("exportDeliverables — 内部调研报告", () => {
  it("头部含场景、日期与「核实结论 + 不给决策建议」声明", async () => {
    const { internal_report } = await exportDeliverables(makeInput());
    expect(internal_report).toContain("# 智慧水务 场景调研报告");
    expect(internal_report).toContain("**生成日期**：2026-09-25");
    expect(internal_report).toContain("每条信息都带核实结论");
    expect(internal_report).toContain("不给决策建议");
    // 场景锚派生副标题
    // 场景锚派生副标题：场景边界 ｜ 买方类型（新口径里"客户类型"已不在表1-1）
    expect(internal_report).toContain("制水到输配 ｜ 市政水务集团");
  });

  it("正文是六章报告（不再是「阶段 N 总结」的拼接）", async () => {
    const { internal_report } = await exportDeliverables(makeInput());
    for (const title of [
      "## 一、场景定义",
      "## 二、场景认识",
      "## 三、存在的问题",
      "## 四、我们的方案",
      "## 五、能够提供的价值",
      "## 六、总结",
    ]) {
      expect(internal_report, title).toContain(title);
    }
    // 用户定调 v1.32：「首先应该是报告，不是记录」——阶段总结标题不该再出现
    expect(internal_report).not.toContain("第 0 部分");
    expect(internal_report).not.toContain("信息摘要");
    expect(internal_report).not.toContain("上下游衔接");
  });

  it("模型写了正文就用模型的（逐章替换，附录仍是确定性装配）", async () => {
    const input = makeInput();
    const { internal_report } = await exportDeliverables({
      ...input,
      chapters: [
        { key: "problems", markdown: "模型归纳：问题集中在三处。" },
        { key: "value", markdown: "模型归纳：价值集中在两处。" },
      ],
    });
    expect(internal_report).toContain("模型归纳：问题集中在三处。");
    expect(internal_report).toContain("模型归纳：价值集中在两处。");
    // 没给模型的章仍用要点版兜底（六章齐全）
    expect(internal_report).toContain("## 一、场景定义");
    expect(internal_report).toContain("附录 A、来源索引");
  });

  it("附录 A 来源索引按表汇总来源", async () => {
    const { internal_report } = await exportDeliverables(makeInput());
    expect(internal_report).toContain("## 附录 A、来源索引");
    expect(internal_report).toContain("### 表1-2 场景环节地图");
    expect(internal_report).toContain("《白皮书》p.3（1 条）");
  });

  it("附录 B 信息覆盖概览给出行数与有来源行数", async () => {
    const { internal_report } = await exportDeliverables(makeInput());
    expect(internal_report).toContain("## 附录 B、信息覆盖概览");
    expect(internal_report).toContain("| 表号 | 表名 | 行数 | 有来源行数 |");
    expect(internal_report).toMatch(/\| 表1-1 \| 场景概述 \| 3 \| 3 \|/);
  });

  it("无阶段总结也照样出报告（正文不再依赖阶段总结）", async () => {
    const { internal_report } = await exportDeliverables({ ...makeInput(), stageSummaries: [] });
    expect(internal_report).toContain("## 六、总结");
    expect(internal_report).toContain("附录 B、信息覆盖概览");
  });
});

describe("exportDeliverables — 对外汇报材料", () => {
  it("含客户视角章节且不含结论性建议", async () => {
    const { external_report } = await exportDeliverables(makeInput());
    expect(external_report).toContain("# 智慧水务 解决方案");
    // 与内部版同一套六章，只是侧重点与取列不同（变更表 #112）
    for (const t of ["一、场景定义", "二、场景认识", "三、存在的问题", "四、我们的方案", "五、能够提供的价值", "六、总结"]) {
      expect(external_report, t).toContain(t);
    }
    expect(external_report).toContain("不含结论性建议");
  });

  it("只渲染中栏列：不出现来源、证据级、权威性", async () => {
    const { external_report } = await exportDeliverables(makeInput());
    expect(external_report).not.toContain("《白皮书》p.3");
    expect(external_report).not.toContain("证据等级");
    expect(external_report).not.toContain("来源权威性");
    // 表6-1 的 evidence_level 是中栏列已改为右栏，故导出里不应出现其取值
    expect(external_report).not.toContain("| 证据级 |");
  });

  it("不渲染竞品身份表与利润池表", async () => {
    const { external_report } = await exportDeliverables(makeInput());
    expect(external_report).not.toContain("海康");
    expect(external_report).not.toContain("大华");
    expect(external_report).not.toContain("表3-1");
    expect(external_report).not.toContain("表3-4");
    expect(external_report).not.toContain("利润池");
  });

  it("对外版正文里不写内部表号（只写结论）", async () => {
    const { external_report } = await exportDeliverables(makeInput());
    expect(external_report).toMatch(/场景定义/);
    expect(external_report).not.toMatch(/表\d+-\d+ （|表\d+-\d+$/m);
  });

  it("本节无数据时给出待补充提示", async () => {
    const input = makeInput();
    const { external_report } = await exportDeliverables({
      ...input,
      stageData: input.stageData.filter((r) => r.table_code !== "表6-1"),
    });
    // 缺表的章给出「本节信息待补充：表号」，而不是静默留空
    expect(external_report).toContain("本节信息待补充");
  });
});

describe("exportDeliverables — 不给决策建议（核心约束）", () => {
  it("两份文档都不含建议档位与结论性措辞", async () => {
    const { internal_report, external_report } = await exportDeliverables(makeInput());
    const forbidden = [
      "建议通过",
      "建议有条件通过",
      "建议不通过",
      "建议进",
      "不建议进",
      "结论：",
      "具备落地条件",
      "经评估",
      "红线",
    ];
    for (const bad of forbidden) {
      expect(internal_report, `内部报告含「${bad}」`).not.toContain(bad);
      expect(external_report, `对外材料含「${bad}」`).not.toContain(bad);
    }
  });
});

describe("exportDeliverables — 空数据", () => {
  it("无任何阶段数据也能生成两份文档骨架", async () => {
    const { internal_report, external_report } = await exportDeliverables({
      scenario: {
        id: "s2",
        name: "空场景",
        product_line_id: "pl",
        status: "进行中",
        current_stage: 0 as never,
        created_at: "2026-09-01",
        updated_at: "2026-09-01",
      },
      stageSummaries: [],
      stageData: [],
      generatedAt: "2026-09-25",
    });
    expect(internal_report).toContain("# 空场景 场景调研报告");
    expect(internal_report).toContain("（暂无带来源的信息）");
    expect(external_report).toContain("# 空场景 解决方案");
    expect(external_report).toContain("本节信息待补充");
  });
});
