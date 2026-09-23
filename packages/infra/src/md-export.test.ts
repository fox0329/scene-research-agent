/**
 * @scene/infra — 交付物导出测试
 *
 * 覆盖：
 * - 内部报告生成（完整数据 + 所有章节）
 * - 对外报告生成（不含敏感信息）
 * - 文件命名规则
 * - 空数据降级（骨架生成）
 */

import { describe, it, expect } from "vitest";
import { exportDeliverables, exportFileName } from "./md-export.js";
import type { ExportData } from "@scene/contract";

// ─── 测试数据构造 ────────────────────────────────────────────

function makeExportData(): ExportData {
  return {
    scenario: {
      id: "s1",
      name: "智慧会议室",
      product_line_id: "pl-iot",
      status: "进行中",
      current_stage: 8,
      created_at: "2026-09-01",
      updated_at: "2026-09-15",
    },
    libraryData: {
      products: [
        {
          id: "p1",
          product_line_id: "pl-iot",
          model: "IOT-3000",
          name: "物联网关",
          status: "在售",
          launch_date: "2025-06",
          position_desc: "面向智慧建筑场景的边缘网关",
          created_at: "",
          updated_at: "",
        },
      ],
      capabilities: [
        {
          id: "c1",
          product_line_id: "pl-iot",
          domain: "数据采集",
          name: "温湿度采集",
          description: "实时采集环境温湿度数据",
          maturity: "已交付",
          dependency: "传感器",
          created_at: "",
          updated_at: "",
        },
        {
          id: "c2",
          product_line_id: "pl-iot",
          domain: "设备管理",
          name: "设备接入",
          description: "支持多协议设备接入",
          maturity: "组件具备",
          dependency: "MQTT",
          created_at: "",
          updated_at: "",
        },
        {
          id: "c3",
          product_line_id: "pl-iot",
          domain: "数据分析",
          name: "能耗分析",
          description: "能耗数据统计分析",
          maturity: "在研",
          dependency: "数据仓库",
          created_at: "",
          updated_at: "",
        },
      ],
      boundaries: [
        {
          id: "b1",
          product_line_id: "pl-iot",
          description: "不承担安防监控",
          reason: "无安防资质",
          has_plan: "无",
          response: "建议客户独立采购",
          owner: "产品部",
          created_at: "",
          updated_at: "",
        },
      ],
      limitations: [
        {
          id: "l1",
          product_line_id: "pl-iot",
          product_name: "IOT-3000",
          description: "高温环境下精度下降",
          impact: "低",
          fix_status: "硬件限制",
          external_visible: "不可提",
          owner: "产品部",
          created_at: "",
          updated_at: "",
        },
      ],
      costRates: [
        {
          id: "cr1",
          product_line_id: "pl-iot",
          category: "实施",
          item: "安装部署",
          rate: 800,
          unit: "元/人天",
          standard_hours: 8,
          data_source: "历史项目",
          created_at: "",
          updated_at: "",
        },
        {
          id: "cr2",
          product_line_id: "pl-iot",
          category: "实施",
          item: "现场调试",
          rate: 1200,
          unit: "元/人天",
          standard_hours: 4,
          data_source: "历史项目",
          created_at: "",
          updated_at: "",
        },
      ],
    },
    stageData: [
      // 阶段 1 — 门槛筛查
      {
        id: "sd1",
        scenario_id: "s1",
        stage: 1,
        table_code: "表1-3",
        row: {
          barrier: "协议兼容",
          currentStatus: "主流协议已支持",
          solution: "协议适配层",
        },
        is_stale: false,
        source_type: "AI提取",
        created_at: "",
        updated_at: "",
      },
      // 阶段 2 — 认识场景
      {
        id: "sd2",
        scenario_id: "s1",
        stage: 2,
        table_code: "表2-1",
        row: {
          indicator: "国内智慧建筑市场规模",
          value: "5000 亿元（2025）",
          source: "行业报告",
        },
        source_type: "AI提取",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      {
        id: "sd3",
        scenario_id: "s1",
        stage: 2,
        table_code: "表2-4",
        row: {
          role: "设备商",
          margin: "20-30%",
          representative: "主流厂商",
        },
        source_type: "AI推断",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      {
        id: "sd4",
        scenario_id: "s1",
        stage: 2,
        table_code: "表2-5",
        row: {
          form: "软硬一体",
          status: "主流方案",
          position: "边缘网关",
        },
        source_type: "AI提取",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      {
        id: "sd5",
        scenario_id: "s1",
        stage: 2,
        table_code: "表2-6",
        row: {
          name: "传统方案",
          cost: "高",
          benefit: "基础功能",
          advantage: "我方更灵活",
        },
        source_type: "AI推断",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      // 阶段 3 — 理解商业
      {
        id: "sd6",
        scenario_id: "s1",
        stage: 3,
        table_code: "表3-1",
        row: {
          scenario: "大型会议",
          customer: "企业总部",
          value: "效率提升 40%",
        },
        source_type: "用户确认",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      // 阶段 4 — 匹配与决策
      {
        id: "sd7",
        scenario_id: "s1",
        stage: 4,
        table_code: "表4-5",
        row: {
          risk: "交付周期长",
          impact: "中",
          response: "标准化流程",
        },
        source_type: "AI推断",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      // 阶段 5 — 方案与实现
      {
        id: "sd8",
        scenario_id: "s1",
        stage: 5,
        table_code: "表5-5",
        row: {
          item: "硬件成本",
          amount: "5000 元/间",
        },
        source_type: "AI提取",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      // 阶段 6 — 价值与验证
      {
        id: "sd9",
        scenario_id: "s1",
        stage: 6,
        table_code: "表6-3",
        row: {
          item: "年节省人工",
          value: "12 万元",
        },
        source_type: "用户确认",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
      // 阶段 7 — 总结沉淀
      {
        id: "sd10",
        scenario_id: "s1",
        stage: 7,
        table_code: "表7-1",
        row: {
          task: "试点方案评审",
          owner: "解决方案部",
          time: "2 周内",
        },
        source_type: "用户确认",
        is_stale: false,
        created_at: "",
        updated_at: "",
      },
    ],
    qualityGates: [
      {
        id: "qg1",
        scenario_id: "s1",
        stage: 2,
        item_no: "1",
        title: "来源抽查≥3条",
        result: "通过",
        detail: "抽查 5 条来源，内容一致",
        evidence_refs: {},
        checked_at: "2026-09-15",
      },
      {
        id: "qg2",
        scenario_id: "s1",
        stage: 4,
        item_no: "2",
        title: "能力匹配矩阵完整",
        result: "不通过",
        detail: "需补充能耗分析验证数据",
        evidence_refs: {},
        checked_at: "2026-09-15",
      },
    ],
    knowledge: [
      {
        id: "k1",
        product_line_id: "pl-iot",
        category: "竞品",
        content: "竞品 A 在华东市场份额约 15%，主打低端方案",
        source: "行业报告",
        source_authority: "T2",
        from_scenario_id: "s1",
        created_at: "",
      },
      {
        id: "k2",
        product_line_id: "pl-iot",
        category: "趋势",
        content: "智慧建筑市场预计年增长率 12%",
        source: "市场研究机构",
        source_authority: "T2",
        from_scenario_id: "s1",
        created_at: "",
      },
    ],
  };
}

function makeEmptyExportData(): ExportData {
  return {
    scenario: {
      id: "s-empty",
      name: "空场景",
      product_line_id: "pl-empty",
      status: "进行中",
      current_stage: 1,
      created_at: "",
      updated_at: "",
    },
    libraryData: {
      products: [],
      capabilities: [],
      boundaries: [],
      limitations: [],
      costRates: [],
    },
    stageData: [],
    qualityGates: [],
    knowledge: [],
  };
}

// ─── 内部调研报告测试 ────────────────────────────────────────

describe("exportDeliverables — 内部调研报告", () => {
  it("应生成完整内部报告（含所有章节标题）", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("一、结论");
    expect(result.internal_report).toContain("二、市场概况");
    expect(result.internal_report).toContain("三、竞争格局");
    expect(result.internal_report).toContain("四、我方能力匹配");
    expect(result.internal_report).toContain("五、方案概要");
    expect(result.internal_report).toContain("六、风险与前提条件");
    expect(result.internal_report).toContain("七、下一步");
    expect(result.internal_report).toContain("附录：证据链索引");
  });

  it("应包含标题与元数据", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("智慧会议室");
    expect(result.internal_report).toContain("内部调研报告");
    expect(result.internal_report).toContain("pl-iot");
  });

  it("应包含产品与能力数据", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("温湿度采集");
    expect(result.internal_report).toContain("设备接入");
    expect(result.internal_report).toContain("能耗分析");
    expect(result.internal_report).toContain("竞争力评分");
  });

  it("应包含成本数据与风险", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("安装部署");
    expect(result.internal_report).toContain("800");
    expect(result.internal_report).toContain("交付周期长");
    expect(result.internal_report).toContain("需补充能耗分析验证数据");
  });

  it("应包含证据链索引", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("证据链索引");
    expect(result.internal_report).toContain("阶段数据");
    expect(result.internal_report).toContain("知识库引用");
    expect(result.internal_report).toContain("竞品");
  });

  it("应包含市场与竞争格局数据", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("5000 亿元");
    expect(result.internal_report).toContain("设备商");
    expect(result.internal_report).toContain("软硬一体");
    expect(result.internal_report).toContain("传统方案");
  });
});

// ─── 对外汇报材料测试 ────────────────────────────────────────

describe("exportDeliverables — 对外汇报材料", () => {
  it("应生成完整对外报告（含所有章节标题）", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).toContain("一句话定位");
    expect(result.external_report).toContain("解决什么问题");
    expect(result.external_report).toContain("方案亮点");
    expect(result.external_report).toContain("适用场景");
    expect(result.external_report).toContain("投入与回报");
    expect(result.external_report).toContain("为什么是我们");
    expect(result.external_report).toContain("下一步");
  });

  it("不应包含证据级标签（A/B/C/D）", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    // 检查不在表格内容中出现证据级标签
    // （注：章节标题本身不包含这些标签）
    expect(result.external_report).not.toMatch(/\|.*[ABCD]级/);
    expect(result.external_report).not.toContain("证据级");
    expect(result.external_report).not.toContain("source_authority");
  });

  it("不应包含竞品名称", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).not.toContain("竞品 A");
    expect(result.external_report).not.toContain("竞品");
  });

  it("不应包含内部假设与风险", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).not.toContain("C 级");
    expect(result.external_report).not.toContain("假设");
    expect(result.external_report).not.toContain("风险");
    expect(result.external_report).not.toContain("不满足");
    expect(result.external_report).not.toContain("证据链");
  });

  it("不应包含售价与成本细节", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    // 不应包含具体的单价数据（如 800 元/人天）
    expect(result.external_report).not.toContain("800 元");
    // 不应包含成本表内部细节
    expect(result.external_report).not.toContain("安装部署");
  });

  it("应包含场景名称与定位", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).toContain("智慧会议室");
    expect(result.external_report).toContain("对外汇报材料");
    expect(result.external_report).toContain("物联网关");
    expect(result.external_report).toContain("面向智慧建筑");
  });

  it("应包含联系人占位", async () => {
    const data = makeExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).toContain("联系人");
    expect(result.external_report).toContain("待填写");
  });
});

// ─── 文件命名规则测试 ────────────────────────────────────────

describe("exportFileName", () => {
  it("内部报告文件名", () => {
    expect(exportFileName("智慧会议室", "internal")).toBe("交付物-内部调研报告.md");
  });

  it("对外材料文件名", () => {
    expect(exportFileName("智慧会议室", "external")).toBe("交付物-对外汇报材料.md");
  });

  it("不同场景名不影响文件名（命名规则固定）", () => {
    expect(exportFileName("任意场景", "internal")).toBe("交付物-内部调研报告.md");
    expect(exportFileName("任意场景", "external")).toBe("交付物-对外汇报材料.md");
  });
});

// ─── 空数据降级测试 ──────────────────────────────────────────

describe("空数据降级", () => {
  it("无阶段数据时仍生成完整内部报告骨架", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("一、结论");
    expect(result.internal_report).toContain("二、市场概况");
    expect(result.internal_report).toContain("三、竞争格局");
    expect(result.internal_report).toContain("四、我方能力匹配");
    expect(result.internal_report).toContain("五、方案概要");
    expect(result.internal_report).toContain("六、风险与前提条件");
    expect(result.internal_report).toContain("七、下一步");
    expect(result.internal_report).toContain("附录：证据链索引");
  });

  it("无阶段数据时市场概况显示待补充", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("待补充");
  });

  it("无阶段数据时仍生成完整对外报告骨架", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).toContain("一句话定位");
    expect(result.external_report).toContain("解决什么问题");
    expect(result.external_report).toContain("方案亮点");
    expect(result.external_report).toContain("适用场景");
    expect(result.external_report).toContain("投入与回报");
    expect(result.external_report).toContain("为什么是我们");
    expect(result.external_report).toContain("下一步");
  });

  it("无能力数据时能力匹配显示待评估", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("待评估");
  });

  it("无知识库时证据链不报错", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.internal_report).toContain("无阶段数据");
    expect(result.internal_report).toContain("无知识库条目");
  });

  it("空数据的对外报告不含敏感信息", async () => {
    const data = makeEmptyExportData();
    const result = await exportDeliverables(data);

    expect(result.external_report).not.toContain("竞品");
    expect(result.external_report).not.toContain("风险");
    expect(result.external_report).not.toContain("证据");
  });
});
