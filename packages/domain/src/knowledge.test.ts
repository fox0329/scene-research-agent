import { describe, it, expect } from "vitest";
import {
  calculateSimilarity,
  findDuplicates,
  createKnowledgeItem,
  extractKnowledgeFromStage3,
  extractKnowledgeFromStage4,
  extractKnowledgeFromStage5,
  batchCreateKnowledge,
  queryKnowledge,
  getKnowledgeStats,
  type KnowledgeItem,
  type CreateKnowledgeInput,
} from "./knowledge.js";

// ─── calculateSimilarity ─────────────────────────────────────

describe("calculateSimilarity", () => {
  it("完全相同的内容 → 相似度1", () => {
    const similarity = calculateSimilarity("会议平板市场竞争激烈", "会议平板市场竞争激烈");
    expect(similarity).toBe(1);
  });

  it("完全不同的内容 → 相似度0", () => {
    const similarity = calculateSimilarity("会议平板", "工业设备预测性维护");
    expect(similarity).toBe(0);
  });

  it("部分重叠的内容 → 相似度0-1", () => {
    const similarity = calculateSimilarity("会议平板 市场 竞争", "会议平板 需求 分析");
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it("空内容 → 相似度0", () => {
    expect(calculateSimilarity("", "test")).toBe(0);
    expect(calculateSimilarity("test", "")).toBe(0);
    expect(calculateSimilarity("", "")).toBe(0);
  });
});

// ─── findDuplicates ─────────────────────────────────────────

describe("findDuplicates", () => {
  const existingItems: KnowledgeItem[] = [
    {
      id: "K1",
      category: "竞品",
      content: "钉钉会议室：成本3000元，功能覆盖率60%",
      source: "阶段3替代方案分析",
      source_authority: "T2",
      from_scenario_id: "S1",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: true,
    },
    {
      id: "K2",
      category: "需求",
      content: "跨平台统一预约",
      source: "阶段3需求分析",
      source_authority: "T1",
      from_scenario_id: "S1",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: true,
    },
  ];

  it("相同分类、相似内容 → 返回重复ID", () => {
    const newItem: CreateKnowledgeInput = {
      category: "竞品",
      content: "钉钉会议室：成本3000元，功能覆盖率60%",
      source: {
        description: "阶段5竞品价格对照",
        authority: "T2",
        scenarioId: "S2",
      },
    };

    const duplicates = findDuplicates(newItem, existingItems);
    expect(duplicates).toContain("K1");
  });

  it("不同分类 → 不检查重复", () => {
    const newItem: CreateKnowledgeInput = {
      category: "成本",
      content: "钉钉会议室：成本3000元，功能覆盖率60%",
      source: {
        description: "阶段5成本估算",
        authority: "T2",
        scenarioId: "S2",
      },
    };

    const duplicates = findDuplicates(newItem, existingItems);
    expect(duplicates).toHaveLength(0);
  });

  it("内容不相似 → 不重复", () => {
    const newItem: CreateKnowledgeInput = {
      category: "竞品",
      content: "华为IdeaHub：成本15000元，功能覆盖率95%",
      source: {
        description: "阶段5竞品价格对照",
        authority: "T2",
        scenarioId: "S2",
      },
    };

    const duplicates = findDuplicates(newItem, existingItems);
    expect(duplicates).toHaveLength(0);
  });
});

// ─── createKnowledgeItem ─────────────────────────────────────

describe("createKnowledgeItem", () => {
  const existingItems: KnowledgeItem[] = [
    {
      id: "K1",
      category: "竞品",
      content: "钉钉会议室：成本3000元",
      source: "阶段3分析",
      source_authority: "T2",
      from_scenario_id: "S1",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: true,
    },
  ];

  it("无重复 → confirmed=true", () => {
    const input: CreateKnowledgeInput = {
      category: "竞品",
      content: "华为IdeaHub：成本15000元",
      source: {
        description: "阶段5分析",
        authority: "T2",
        scenarioId: "S2",
      },
    };

    const item = createKnowledgeItem(input, existingItems);
    expect(item.confirmed).toBe(true);
    expect(item.relatedIds).toBeUndefined();
  });

  it("有重复 → confirmed=false，relatedIds包含重复ID", () => {
    const input: CreateKnowledgeInput = {
      category: "竞品",
      content: "钉钉会议室：成本3000元",
      source: {
        description: "阶段5分析",
        authority: "T2",
        scenarioId: "S2",
      },
    };

    const item = createKnowledgeItem(input, existingItems);
    expect(item.confirmed).toBe(false);
    expect(item.relatedIds).toContain("K1");
  });

  it("自动生成ID和时间戳", () => {
    const input: CreateKnowledgeInput = {
      category: "需求",
      content: "无感签到",
      source: {
        description: "阶段3分析",
        authority: "T1",
        scenarioId: "S1",
      },
    };

    const item = createKnowledgeItem(input, []);
    expect(item.id).toMatch(/^K\d+$/);
    expect(item.created_at).toBeTruthy();
  });
});

// ─── extractKnowledgeFromStage3 ─────────────────────────────

describe("extractKnowledgeFromStage3", () => {
  const trigger = {
    stage: 3 as const,
    scenarioId: "S1",
    productLineId: "PL1",
  };

  const stage3Data = {
    profitPool: [
      { segment: "会议平板", revenue: 50000, margin: 35, growth: 12 },
      { segment: "中控系统", revenue: 20000, margin: 45, growth: 8 },
    ],
    unmetNeeds: [
      { description: "跨平台统一预约", evidenceLevel: "A", sourceAuthority: "T1" },
      { description: "无感签到", evidenceLevel: "B", sourceAuthority: "T2" },
    ],
    alternatives: [
      { name: "钉钉会议室", cost: 3000, featureCoverage: 60 },
      { name: "飞书会议室", cost: 5000, featureCoverage: 80 },
    ],
  };

  it("从利润池提取成本类知识", () => {
    const items = extractKnowledgeFromStage3(stage3Data, trigger);
    const costItems = items.filter((i) => i.category === "成本");
    expect(costItems).toHaveLength(2);
    expect(costItems[0]!.content).toContain("会议平板");
    expect(costItems[0]!.content).toContain("50000");
  });

  it("从需求提取需求类知识", () => {
    const items = extractKnowledgeFromStage3(stage3Data, trigger);
    const needItems = items.filter((i) => i.category === "需求");
    expect(needItems).toHaveLength(2);
    expect(needItems[0]!.content).toBe("跨平台统一预约");
  });

  it("从替代方案提取竞品类知识", () => {
    const items = extractKnowledgeFromStage3(stage3Data, trigger);
    const altItems = items.filter((i) => i.category === "竞品");
    expect(altItems).toHaveLength(2);
    expect(altItems[0]!.content).toContain("钉钉会议室");
  });

  it("来源场景ID正确", () => {
    const items = extractKnowledgeFromStage3(stage3Data, trigger);
    expect(items[0]!.source.scenarioId).toBe("S1");
  });
});

// ─── extractKnowledgeFromStage4 ─────────────────────────────

describe("extractKnowledgeFromStage4", () => {
  const trigger = {
    stage: 4 as const,
    scenarioId: "S1",
    productLineId: "PL1",
  };

  const stage4Data = {
    capabilityMatch: [
      { scene: "预约管理", capability: "日历集成", matchLevel: "完全匹配", gap: "无" },
      { scene: "设备控制", capability: "IoT平台", matchLevel: "部分匹配", gap: "协议适配" },
    ],
    priorityMatrix: [
      { scene: "预约管理", priorityScore: 88, recommendation: "优先推进" },
      { scene: "设备控制", priorityScore: 65, recommendation: "条件推进" },
    ],
  };

  it("只从不完全匹配的场景提取需求类知识", () => {
    const items = extractKnowledgeFromStage4(stage4Data, trigger);
    const needItems = items.filter((i) => i.category === "需求");
    expect(needItems).toHaveLength(1);
    expect(needItems[0]!.content).toContain("设备控制");
  });

  it("从优先级矩阵提取趋势类知识", () => {
    const items = extractKnowledgeFromStage4(stage4Data, trigger);
    const trendItems = items.filter((i) => i.category === "趋势");
    expect(trendItems).toHaveLength(2);
    expect(trendItems[0]!.content).toContain("预约管理");
  });
});

// ─── extractKnowledgeFromStage5 ─────────────────────────────

describe("extractKnowledgeFromStage5", () => {
  const trigger = {
    stage: 5 as const,
    scenarioId: "S1",
    productLineId: "PL1",
  };

  const stage5Data = {
    costEstimate: [
      { category: "硬件", item: "会议平板", unitCost: 8000, total: 80000 },
      { category: "软件", item: "预约系统", unitCost: 2000, total: 2000 },
    ],
    competitorPricing: [
      { competitor: "钉钉", price: 3000, priceComparison: "低于我方" },
      { competitor: "飞书", price: 5000, priceComparison: "持平" },
    ],
  };

  it("从成本估算提取成本类知识", () => {
    const items = extractKnowledgeFromStage5(stage5Data, trigger);
    const costItems = items.filter((i) => i.category === "成本");
    expect(costItems).toHaveLength(2);
    expect(costItems[0]!.content).toContain("硬件成本");
  });

  it("从竞品价格提取竞品类知识", () => {
    const items = extractKnowledgeFromStage5(stage5Data, trigger);
    const altItems = items.filter((i) => i.category === "竞品");
    expect(altItems).toHaveLength(2);
    expect(altItems[0]!.content).toContain("钉钉");
  });
});

// ─── batchCreateKnowledge ────────────────────────────────────

describe("batchCreateKnowledge", () => {
  it("批量创建带去重", () => {
    const existingItems: KnowledgeItem[] = [
      {
        id: "K1",
        category: "竞品",
        content: "钉钉会议室：成本3000元",
        source: "阶段3分析",
        source_authority: "T2",
        from_scenario_id: "S1",
        created_at: "2026-09-23T00:00:00Z",
        confirmed: true,
      },
    ];

    const inputs: CreateKnowledgeInput[] = [
      {
        category: "竞品",
        content: "钉钉会议室：成本3000元", // 重复
        source: { description: "阶段5分析", authority: "T2", scenarioId: "S2" },
      },
      {
        category: "竞品",
        content: "华为IdeaHub：成本15000元", // 不重复
        source: { description: "阶段5分析", authority: "T2", scenarioId: "S2" },
      },
    ];

    const items = batchCreateKnowledge(inputs, existingItems);
    expect(items).toHaveLength(2);
    expect(items[0]!.confirmed).toBe(false);
    expect(items[1]!.confirmed).toBe(true);
  });
});

// ─── queryKnowledge ──────────────────────────────────────────

describe("queryKnowledge", () => {
  const items: KnowledgeItem[] = [
    {
      id: "K1",
      product_line_id: "PL1",
      category: "竞品",
      content: "钉钉会议室",
      source: "阶段3分析",
      source_authority: "T2",
      from_scenario_id: "S1",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: true,
    },
    {
      id: "K2",
      product_line_id: "PL1",
      scene: "预约管理",
      category: "需求",
      content: "跨平台统一预约",
      source: "阶段3分析",
      source_authority: "T1",
      from_scenario_id: "S1",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: true,
    },
    {
      id: "K3",
      product_line_id: "PL2",
      category: "成本",
      content: "会议平板单价8000元",
      source: "阶段5分析",
      source_authority: "T2",
      from_scenario_id: "S2",
      created_at: "2026-09-23T00:00:00Z",
      confirmed: false,
    },
  ];

  it("按分类过滤", () => {
    const result = queryKnowledge(items, { category: "竞品" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("K1");
  });

  it("按产品线过滤", () => {
    const result = queryKnowledge(items, { productLineId: "PL1" });
    expect(result).toHaveLength(2);
  });

  it("按场景过滤", () => {
    const result = queryKnowledge(items, { scene: "预约管理" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("K2");
  });

  it("关键词搜索", () => {
    const result = queryKnowledge(items, { keyword: "钉钉" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("K1");
  });

  it("只看已确认", () => {
    const result = queryKnowledge(items, { confirmedOnly: true });
    expect(result).toHaveLength(2);
  });

  it("组合条件", () => {
    const result = queryKnowledge(items, {
      productLineId: "PL1",
      category: "需求",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("K2");
  });
});

// ─── getKnowledgeStats ───────────────────────────────────────

describe("getKnowledgeStats", () => {
  it("正确统计各分类数量", () => {
    const items: KnowledgeItem[] = [
      { id: "K1", category: "竞品", content: "", source: "", source_authority: "T2", from_scenario_id: "S1", created_at: "", confirmed: true },
      { id: "K2", category: "竞品", content: "", source: "", source_authority: "T2", from_scenario_id: "S1", created_at: "", confirmed: true },
      { id: "K3", category: "需求", content: "", source: "", source_authority: "T1", from_scenario_id: "S1", created_at: "", confirmed: true },
      { id: "K4", category: "趋势", content: "", source: "", source_authority: "T2", from_scenario_id: "S1", created_at: "", confirmed: true },
      { id: "K5", category: "成本", content: "", source: "", source_authority: "T2", from_scenario_id: "S1", created_at: "", confirmed: true },
    ];

    const stats = getKnowledgeStats(items);
    expect(stats["竞品"]).toBe(2);
    expect(stats["需求"]).toBe(1);
    expect(stats["趋势"]).toBe(1);
    expect(stats["成本"]).toBe(1);
  });

  it("空列表 → 全部为0", () => {
    const stats = getKnowledgeStats([]);
    expect(stats["竞品"]).toBe(0);
    expect(stats["需求"]).toBe(0);
    expect(stats["趋势"]).toBe(0);
    expect(stats["成本"]).toBe(0);
  });
});
