/**
 * cost-estimate — 成本估算（阶段 5，00b §6 表 5-1 ~ 表 5-6）
 *
 * 职责：成本汇总、价格定位、人工成本估算。
 * 规则：纯计算层，不含定价建议（定价决策在用户），
 * 数值精度保留两位小数（元为单位）。
 */

import type { CostRate } from "@scene/contract";

// ─── 常量 ──────────────────────────────────────────────────────

/** 价格定位容差：与竞品价格差距在此范围内视为"持平" */
const PRICE_TOLERANCE = 0.05;

// ─── 类型 ──────────────────────────────────────────────────────

/** 成本项 */
export interface CostItem {
  id: string;
  name: string;
  /** 单价（元） */
  unitCost: number;
  /** 数量 */
  quantity: number;
}

/** 成本汇总结果 */
export interface CostEstimate {
  /** 硬件成本明细 */
  hardwareCosts: CostLineItem[];
  /** 人工成本明细 */
  laborCosts: CostLineItem[];
  /** 运营成本明细 */
  operationCosts: CostLineItem[];
  /** 硬件小计 */
  hardwareSubtotal: number;
  /** 人工小计 */
  laborSubtotal: number;
  /** 运营小计 */
  operationSubtotal: number;
  /** 总成本 */
  total: number;
}

/** 成本行项（含小计） */
export interface CostLineItem {
  id: string;
  name: string;
  unitCost: number;
  quantity: number;
  /** 小计 = unitCost * quantity */
  subtotal: number;
}

/** 价格定位结论 */
export type PricePositionResult =
  | "高于竞品"
  | "持平"
  | "低于竞品";

/** 价格定位详情 */
export interface PricePosition {
  ourCost: number;
  /** 竞品平均成本 */
  competitorAvgCost: number;
  /** 价格比例（我方/竞品） */
  priceRatio: number;
  position: PricePositionResult;
}

/** 任务工时估算输入 */
export interface TaskEstimate {
  taskName: string;
  /** 所需人天 */
  personDays: number;
  /** 匹配的费率类别 */
  rateCategory: string;
}

// ─── 内部工具 ──────────────────────────────────────────────────

function buildLineItems(items: CostItem[]): CostLineItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    unitCost: item.unitCost,
    quantity: item.quantity,
    subtotal: Math.round(item.unitCost * item.quantity * 100) / 100,
  }));
}

function sumLineItems(items: CostLineItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
}

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 成本汇总（硬件 + 人工 + 运营）
 *
 * 每个 CostItem 按 unitCost * quantity 计算小计，
 * 三类成本分别汇总后求总成本。数值保留两位小数。
 *
 * @param hardware - 硬件成本项
 * @param labor - 人工成本项
 * @param operations - 运营成本项
 * @returns 成本汇总（含明细和各小计）
 */
export function estimateTotalCost(
  hardware: CostItem[],
  labor: CostItem[],
  operations: CostItem[],
): CostEstimate {
  const hardwareCosts = buildLineItems(hardware);
  const laborCosts = buildLineItems(labor);
  const operationCosts = buildLineItems(operations);

  const hardwareSubtotal = sumLineItems(hardwareCosts);
  const laborSubtotal = sumLineItems(laborCosts);
  const operationSubtotal = sumLineItems(operationCosts);

  const total =
    Math.round((hardwareSubtotal + laborSubtotal + operationSubtotal) * 100) / 100;

  return {
    hardwareCosts,
    laborCosts,
    operationCosts,
    hardwareSubtotal,
    laborSubtotal,
    operationSubtotal,
    total,
  };
}

/**
 * 价格定位（我方成本与竞品对比）
 *
 * 计算我方成本与竞品平均成本的比率：
 * - > 1.05 → 高于竞品
 * - 0.95 ~ 1.05 → 持平
 * - < 0.95 → 低于竞品
 *
 * 竞品列表为空时直接返回"无竞品"。
 *
 * @param ourCost - 我方成本
 * @param alternatives - 替代方案/竞品列表
 * @returns 价格定位结果
 * @throws 我方成本 <= 0 或竞品列表含非正成本时抛错
 */
export function positionPrice(
  ourCost: number,
  alternatives: Array<{ cost: number }>,
): PricePosition {
  if (ourCost <= 0) {
    throw new Error("我方成本必须大于 0");
  }
  if (alternatives.length === 0) {
    throw new Error("竞品列表不能为空");
  }

  for (const alt of alternatives) {
    if (alt.cost <= 0) {
      throw new Error("竞品成本必须大于 0");
    }
  }

  const competitorAvgCost =
    Math.round(
      (alternatives.reduce((sum, alt) => sum + alt.cost, 0) /
        alternatives.length) *
        100,
    ) / 100;

  const priceRatio = Math.round((ourCost / competitorAvgCost) * 10000) / 10000;

  let position: PricePositionResult;
  if (priceRatio > 1 + PRICE_TOLERANCE) {
    position = "高于竞品";
  } else if (priceRatio < 1 - PRICE_TOLERANCE) {
    position = "低于竞品";
  } else {
    position = "持平";
  }

  return { ourCost, competitorAvgCost, priceRatio, position };
}

/**
 * 从 M6 费率计算人工成本（00b §6 表 5-3）
 *
 * 查找每个任务匹配的费率类别，按 task.personDays * rate.rate 计算人工费用。
 * 未找到匹配费率的任务跳过（返回 0），确保不因数据缺失阻断流程（G-R7）。
 *
 * @param rates - M6 费率表
 * @param tasks - 任务工时估算列表
 * @returns 总人工成本（元）
 */
export function estimateLaborFromRates(
  rates: CostRate[],
  tasks: TaskEstimate[],
): number {
  const rateMap = new Map<string, CostRate>();
  for (const rate of rates) {
    rateMap.set(rate.item, rate);
  }

  let total = 0;
  for (const task of tasks) {
    const rate = rateMap.get(task.rateCategory);
    if (!rate) continue;
    total += task.personDays * rate.rate;
  }

  return Math.round(total * 100) / 100;
}
