/**
 * knowledge — 知识库
 *
 * 职责：知识沉淀（竞品/需求/趋势/成本）、跨场景复用、来源追溯。
 * 规则：只读资产与任务写库物理分离；沉淀/回写自动化，不设用户触发的"回写阶段"。
 */

import type { Knowledge, Authority } from "@scene/contract";

// ─── 类型 ──────────────────────────────────────────────────────

/** 知识分类 */
export type KnowledgeCategory = Knowledge["category"];

/** 知识来源 */
export interface KnowledgeSource {
  /** 来源描述（文件名+页码/URL+日期） */
  description: string;
  /** 来源权威性 */
  authority: Authority;
  /** 来源场景ID */
  scenarioId: string;
}

/** 创建知识条目的输入 */
export interface CreateKnowledgeInput {
  /** 产品线ID（可选） */
  productLineId?: string;
  /** 场景（可选） */
  scene?: string;
  /** 分类 */
  category: KnowledgeCategory;
  /** 内容 */
  content: string;
  /** 来源 */
  source: KnowledgeSource;
}

/** 知识条目（带ID和时间戳） */
export interface KnowledgeItem extends Knowledge {
  /** 是否已确认（去重后） */
  confirmed: boolean;
  /** 相关条目ID（去重时发现的相似条目） */
  relatedIds?: string[];
}

// ─── 去重逻辑 ─────────────────────────────────────────────────

/**
 * 计算内容相似度（简单实现：基于关键词重叠）
 * 实际项目中可使用更复杂的NLP算法
 */
export function calculateSimilarity(content1: string, content2: string): number {
  // 简单分词：按空格和常见标点分割
  const words1 = new Set(content1.split(/[\s,，。、；：！？""''（）【】]+/).filter(Boolean));
  const words2 = new Set(content2.split(/[\s,，。、；：！？""''（）【】]+/).filter(Boolean));

  if (words1.size === 0 || words2.size === 0) return 0;

  let overlap = 0;
  for (const word of words1) {
    if (words2.has(word)) overlap++;
  }

  return overlap / Math.max(words1.size, words2.size);
}

/**
 * 检查是否与现有知识重复
 * @param newItem 新条目
 * @param existingItems 已有条目列表
 * @param threshold 相似度阈值（0-1，默认0.8）
 * @returns 重复的条目ID列表
 */
export function findDuplicates(
  newItem: CreateKnowledgeInput,
  existingItems: KnowledgeItem[],
  threshold = 0.8,
): string[] {
  const duplicates: string[] = [];

  for (const item of existingItems) {
    // 同分类才检查重复
    if (item.category !== newItem.category) continue;

    // 同产品线或同场景才检查
    if (newItem.productLineId && item.product_line_id !== newItem.productLineId) continue;
    if (newItem.scene && item.scene !== newItem.scene) continue;

    const similarity = calculateSimilarity(newItem.content, item.content);
    if (similarity >= threshold) {
      duplicates.push(item.id);
    }
  }

  return duplicates;
}

// ─── 创建知识条目 ─────────────────────────────────────────────

/**
 * 创建知识条目（带去重检查）
 * @param input 创建输入
 * @param existingItems 已有条目
 * @returns 新条目（confirmed=false 如果有重复）
 */
export function createKnowledgeItem(
  input: CreateKnowledgeInput,
  existingItems: KnowledgeItem[],
): KnowledgeItem {
  const duplicates = findDuplicates(input, existingItems);
  const now = new Date().toISOString();

  return {
    id: `K${Date.now()}`,
    product_line_id: input.productLineId,
    scene: input.scene,
    category: input.category,
    content: input.content,
    source: input.source.description,
    source_authority: input.source.authority,
    from_scenario_id: input.source.scenarioId,
    created_at: now,
    confirmed: duplicates.length === 0,
    relatedIds: duplicates.length > 0 ? duplicates : undefined,
  };
}

// ─── 自动回写逻辑 ─────────────────────────────────────────────

/** 阶段3/4/5的回写触发条件 */
export interface WritebackTrigger {
  /** 阶段ID */
  stage: 3 | 4 | 5;
  /** 场景ID */
  scenarioId: string;
  /** 产品线ID */
  productLineId?: string;
}

/** 从阶段3（理解商业）提取知识 */
export function extractKnowledgeFromStage3(
  data: {
    profitPool: Array<{ segment: string; revenue: number; margin: number; growth: number }>;
    unmetNeeds: Array<{ description: string; evidenceLevel: string; sourceAuthority: string }>;
    alternatives: Array<{ name: string; cost: number; featureCoverage: number }>;
  },
  trigger: WritebackTrigger,
): CreateKnowledgeInput[] {
  const items: CreateKnowledgeInput[] = [];

  // 利润池数据 → 成本类知识
  for (const pool of data.profitPool) {
    items.push({
      productLineId: trigger.productLineId,
      category: "成本",
      content: `${pool.segment}市场：营收${pool.revenue}万，利润率${pool.margin}%，增长率${pool.growth}%`,
      source: {
        description: `阶段3利润池分析`,
        authority: "T2",
        scenarioId: trigger.scenarioId,
      },
    });
  }

  // 未满足需求 → 需求类知识
  for (const need of data.unmetNeeds) {
    items.push({
      productLineId: trigger.productLineId,
      category: "需求",
      content: need.description,
      source: {
        description: `阶段3需求分析，证据等级${need.evidenceLevel}`,
        authority: need.sourceAuthority as Authority,
        scenarioId: trigger.scenarioId,
      },
    });
  }

  // 替代方案 → 竞品类知识
  for (const alt of data.alternatives) {
    items.push({
      productLineId: trigger.productLineId,
      category: "竞品",
      content: `${alt.name}：成本${alt.cost}元，功能覆盖率${alt.featureCoverage}%`,
      source: {
        description: `阶段3替代方案分析`,
        authority: "T2",
        scenarioId: trigger.scenarioId,
      },
    });
  }

  return items;
}

/** 从阶段4（能力匹配）提取知识 */
export function extractKnowledgeFromStage4(
  data: {
    capabilityMatch: Array<{ scene: string; capability: string; matchLevel: string; gap: string }>;
    priorityMatrix: Array<{ scene: string; priorityScore: number; recommendation: string }>;
  },
  trigger: WritebackTrigger,
): CreateKnowledgeInput[] {
  const items: CreateKnowledgeInput[] = [];

  // 能力匹配 → 需求类知识
  for (const match of data.capabilityMatch) {
    if (match.matchLevel !== "完全匹配") {
      items.push({
        productLineId: trigger.productLineId,
        scene: match.scene,
        category: "需求",
        content: `${match.scene}场景需要${match.capacity}能力，当前${match.matchLevel}，差距：${match.gap}`,
        source: {
          description: `阶段4能力匹配分析`,
          authority: "T2",
          scenarioId: trigger.scenarioId,
        },
      });
    }
  }

  // 优先级矩阵 → 趋势类知识
  for (const priority of data.priorityMatrix) {
    items.push({
      productLineId: trigger.productLineId,
      scene: priority.scene,
      category: "趋势",
      content: `${priority.scene}场景优先级得分${priority.priorityScore}，建议：${priority.recommendation}`,
      source: {
        description: `阶段4优先级矩阵`,
        authority: "T2",
        scenarioId: trigger.scenarioId,
      },
    });
  }

  return items;
}

/** 从阶段5（方案设计）提取知识 */
export function extractKnowledgeFromStage5(
  data: {
    costEstimate: Array<{ category: string; item: string; unitCost: number; total: number }>;
    competitorPricing: Array<{ competitor: string; price: number; priceComparison: string }>;
  },
  trigger: WritebackTrigger,
): CreateKnowledgeInput[] {
  const items: CreateKnowledgeInput[] = [];

  // 成本估算 → 成本类知识
  for (const cost of data.costEstimate) {
    items.push({
      productLineId: trigger.productLineId,
      category: "成本",
      content: `${cost.category}成本：${cost.item}，单价${cost.unitCost}元，总计${cost.total}元`,
      source: {
        description: `阶段5成本估算`,
        authority: "T2",
        scenarioId: trigger.scenarioId,
      },
    });
  }

  // 竞品价格 → 竞品类知识
  for (const competitor of data.competitorPricing) {
    items.push({
      productLineId: trigger.productLineId,
      category: "竞品",
      content: `${competitor.competitor}报价${competitor.price}元，${competitor.priceComparison}`,
      source: {
        description: `阶段5竞品价格对照`,
        authority: "T2",
        scenarioId: trigger.scenarioId,
      },
    });
  }

  return items;
}

// ─── 批量处理 ─────────────────────────────────────────────────

/**
 * 批量创建知识条目（带去重）
 * @param inputs 创建输入列表
 * @param existingItems 已有条目
 * @returns 新条目列表
 */
export function batchCreateKnowledge(
  inputs: CreateKnowledgeInput[],
  existingItems: KnowledgeItem[],
): KnowledgeItem[] {
  const newItems: KnowledgeItem[] = [];
  const currentItems = [...existingItems];

  for (const input of inputs) {
    const item = createKnowledgeItem(input, currentItems);
    newItems.push(item);
    currentItems.push(item); // 添加到当前列表以支持后续去重
  }

  return newItems;
}

// ─── 查询与过滤 ─────────────────────────────────────────────────

/** 查询条件 */
export interface KnowledgeQuery {
  /** 按分类过滤 */
  category?: KnowledgeCategory;
  /** 按产品线过滤 */
  productLineId?: string;
  /** 按场景过滤 */
  scene?: string;
  /** 按来源场景过滤 */
  fromScenarioId?: string;
  /** 搜索关键词 */
  keyword?: string;
  /** 是否只看已确认 */
  confirmedOnly?: boolean;
}

/**
 * 查询知识条目
 * @param items 所有条目
 * @param query 查询条件
 * @returns 符合条件的条目
 */
export function queryKnowledge(
  items: KnowledgeItem[],
  query: KnowledgeQuery,
): KnowledgeItem[] {
  return items.filter((item) => {
    if (query.category && item.category !== query.category) return false;
    if (query.productLineId && item.product_line_id !== query.productLineId) return false;
    if (query.scene && item.scene !== query.scene) return false;
    if (query.fromScenarioId && item.from_scenario_id !== query.fromScenarioId) return false;
    if (query.confirmedOnly && !item.confirmed) return false;

    if (query.keyword) {
      const keyword = query.keyword.toLowerCase();
      const contentMatch = item.content.toLowerCase().includes(keyword);
      const sourceMatch = item.source.toLowerCase().includes(keyword);
      if (!contentMatch && !sourceMatch) return false;
    }

    return true;
  });
}

/**
 * 按分类统计
 * @param items 所有条目
 * @returns 统计结果
 */
export function getKnowledgeStats(items: KnowledgeItem[]): Record<KnowledgeCategory, number> {
  const stats: Record<KnowledgeCategory, number> = {
    "竞品": 0,
    "需求": 0,
    "趋势": 0,
    "成本": 0,
  };

  for (const item of items) {
    stats[item.category]++;
  }

  return stats;
}
