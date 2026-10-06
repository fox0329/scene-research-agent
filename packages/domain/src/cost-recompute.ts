/**
 * 表5-5 成本估算的**确定性重算**（金额只由公式算，文字仍由模型写）
 *
 * 为什么要有这个模块：表5-5 是报价的唯一来源，但它的金额一直是模型"写"出来的——
 * 用户把 M6 内部费率从 1000 改成别的数，表里的费用不会跟着变，只能整步重跑让模型再猜一遍；
 * 实测线上还出现过**同一行里乘不出来**的情况：`工时 16`（2 人天，8 小时/人天）
 * × `人天单价 1000` = 16000，而行里写的'费用'是 2000（模型心里按 2 人天算的）。
 * 这类"数字对不上"必须由确定性层保证（AGENTS §三.5）。
 *
 * 分工（用户定调 2026-10-05）：
 * - **公式算**：硬件小计 = 数量 × 单价；人工费用 = 人天 × M6 单价；运营年费 = M6 单价；
 *   各子块合计与总汇总 = 各行之和。
 * - **模型写**：型号/规格、说明、核实结论等文字，本模块一律不碰。
 *
 * 口径（写进契约注释，见 变更表 #103）：
 * - `工时` 的单位是**小时**，`人天单价` 是**元/人天**，1 人天 = {@link HOURS_PER_DAY} 小时；
 *   所以 `费用 = 工时 ÷ 8 × 人天单价`，等价于 `费用 = 人天 × 人天单价`。
 * - 人天**取自表5-3 实施计划**（分析结论，不由本模块产生）；表5-3 没有的行（如差旅）
 *   沿用行里已有的工时，只重算费用。
 * - `M6 单价 ≤ 0` 视为**没有单价**：不许算成 0 元，如实记入 `missingRates`；
 *   单价仍标「待确认」的，照算但记入 `pendingRates`（报价前必须确认来源）。
 * - 本模块**不删行**：只在既有行上改数，缺的行补在 `added` 里由调用方决定是否落库。
 */

/** 1 人天 = 8 小时（表5-5「工时」列的单位是小时，「人天单价」是元/人天） */
export const HOURS_PER_DAY = 8;

/** 表5-5 的四个子块 */
export type CostBlock = "硬件" | "人工" | "运营" | "汇总";

/** 表5-3 实施计划的一项（人天是分析结论，这里只读） */
export interface CostPlanItem {
  item: string;
  man_days: number;
}

/** M6 内部费率的一行（scope: own=本场景专属库，library=通用库） */
export interface CostRateItem {
  item: string;
  rate: number;
  unit?: string | null;
  data_source?: string | null;
  scope?: string;
}

export interface CostRow {
  [key: string]: unknown;
}

export interface CostRecomputeInput {
  /** 表5-5 现有行（按显示顺序） */
  rows: readonly CostRow[];
  /** 表5-3 实施计划（人天来源） */
  plans: readonly CostPlanItem[];
  /** M6 内部费率（本场景专属库 + 通用库） */
  rates: readonly CostRateItem[];
}

export interface CostRecomputeResult {
  /** 改过数的既有行（顺序、行数不变） */
  rows: CostRow[];
  /** 表5-3 有人天、表5-5 却缺行的项（调用方决定是否落库） */
  added: CostRow[];
  /** 数值被改写的行数 */
  changed: number;
  /** M6 没有可用单价（无该行或单价 ≤ 0）的项名 */
  missingRates: string[];
  /** 用上了、但 M6 仍标「待确认」的项名（报价前须确认） */
  pendingRates: string[];
  /** 应有却没有的汇总行（合格线「汇总 = 各子块之和」） */
  missingTotals: string[];
  /**
   * 人工块里"既不是表5-3 的项、M6 也认不出来"的行（模型自己归并出来的名字）
   *
   * 出现这种行时**不补表5-3 的行**：模型的一行可能已经覆盖了表5-3 的多项，
   * 再补一遍等于同一批工作算两遍（实测线上：模型 5 行归并 + 系统补 1 行 = 人工翻倍）。
   */
  unmatchedLabor: string[];
  /** 各子块合计（元），供界面/交付物直接引用 */
  totals: { hardware: number; labor: number; operation: number; total: number };
}

/** 金额保留两位（避免浮点尾差写进库里） */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 行属于哪个子块：按"这行有哪些键"判定
 * （表5-5 四个子块的列不同：硬件有 qty/subtotal，人工有 hours/day_rate/cost，
 * 运营有 annual_fee，汇总只有 amount；库里的行不带 block 字段）
 */
export function costBlockOf(row: CostRow): CostBlock {
  if (row["amount"] !== undefined) return "汇总";
  if (row["annual_fee"] !== undefined) return "运营";
  if (
    row["hours"] !== undefined ||
    row["day_rate"] !== undefined ||
    row["cost"] !== undefined
  ) {
    return "人工";
  }
  return "硬件";
}

/**
 * 项名归一化：去掉括号里的补充说明、空白，转小写
 *
 * 必要性：表5-3 与 M6 是两处分别维护的项名，实测差异都在括号里，例如
 * 表5-3「定制开发（按需授予，条件项）」↔ M6「定制开发（按需授予）」、
 * 表5-3「项目管理（按实施人天计提）」↔ M6「项目管理（按实施人天计提）」。
 */
export function normalizeCostItem(name: unknown): string {
  return String(name ?? "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s\u3000]/g, "")
    .toLowerCase();
}

/** M6 单价候选：必须是正数才有资格参与计算（≤0 = 没填） */
function positiveRates(rates: readonly CostRateItem[]): CostRateItem[] {
  return rates.filter((r) => typeof r.rate === "number" && r.rate > 0);
}

/**
 * 按项名找 M6 单价
 *
 * 顺序：归一化精确匹配 → 包含匹配（取最具体的那个；两个同样具体 = 有歧义，宁可不认）；
 * 同分候选里**本场景专属库优先**（场景自己的费率压过主库）。
 */
function matchRate(
  rates: readonly CostRateItem[],
  item: unknown,
): CostRateItem | undefined {
  const key = normalizeCostItem(item);
  if (!key) return undefined;
  const usable = positiveRates(rates);
  const exact = usable.filter((r) => normalizeCostItem(r.item) === key);
  if (exact.length > 0) return preferOwn(exact);
  const loose = usable.filter((r) => {
    const other = normalizeCostItem(r.item);
    return other.length > 0 && (other.includes(key) || key.includes(other));
  });
  if (loose.length === 0) return undefined;
  const longest = Math.max(...loose.map((r) => normalizeCostItem(r.item).length));
  const best = loose.filter((r) => normalizeCostItem(r.item).length === longest);
  const distinct = new Set(best.map((r) => normalizeCostItem(r.item)));
  if (distinct.size > 1) return undefined; // 两个同样具体的项都像 → 不猜
  return preferOwn(best);
}

function preferOwn(candidates: readonly CostRateItem[]): CostRateItem | undefined {
  const own = candidates.filter((r) => r.scope === "own");
  return (own.length > 0 ? own : candidates)[0];
}

/** 表5-5 里人工行的"人天"：优先用表5-3 的人天，其次由工时 ÷ 8 推 */
function manDaysOf(row: CostRow, plans: Map<string, CostPlanItem>): number | undefined {
  const plan = plans.get(normalizeCostItem(row["item"]));
  if (plan) return plan.man_days;
  const hours = num(row["hours"]);
  if (hours !== undefined) return hours / HOURS_PER_DAY;
  const days = num(row["days"]);
  return days;
}

/** 子块合计行认哪个块：先认"合计/总计/总成本"，再看块名 */
function totalTarget(item: unknown): "hardware" | "labor" | "operation" | "total" {
  const text = String(item ?? "");
  if (/合计|总计|总成本|总额/.test(text)) return "total";
  if (/人工|人力/.test(text)) return "labor";
  if (/硬件|设备/.test(text)) return "hardware";
  if (/运营|年费/.test(text)) return "operation";
  return "total";
}

function withField(row: CostRow, key: string, value: unknown): CostRow {
  if (row[key] === value) return row;
  return { ...row, [key]: value };
}

/**
 * 重算表5-5：返回改过数的行、需补的行、缺单价项、各子块合计
 *
 * 纯函数（不碰 IO）：表5-3 人天、M6 费率、表5-5 现有行都是入参，便于单测覆盖
 * 边界（缺单价 / 待确认 / 行里乘不出来 / 同名多候选）。
 */
export function recomputeCostRows(input: CostRecomputeInput): CostRecomputeResult {
  const plans = new Map<string, CostPlanItem>();
  for (const plan of input.plans) plans.set(normalizeCostItem(plan.item), plan);

  const missing = new Set<string>();
  const pending = new Set<string>();

  /** 取单价：M6 优先；M6 没有就把行里原有的单价留作"模型估价"，并如实记账 */
  const resolveRate = (
    item: unknown,
    fallback: number | undefined,
  ): { rate: number | undefined; fromM6: boolean; sourceItem?: string } => {
    const hit = matchRate(input.rates, item);
    if (hit) {
      if (String(hit.data_source ?? "") === "待确认") pending.add(String(hit.item));
      return { rate: hit.rate, fromM6: true, sourceItem: String(hit.item) };
    }
    if (fallback !== undefined && fallback > 0) {
      missing.add(String(item ?? ""));
      return { rate: fallback, fromM6: false };
    }
    missing.add(String(item ?? ""));
    return { rate: undefined, fromM6: false };
  };

  /**
   * 人工行的出处文案（右栏溯源字段，必须说清"人天从哪来、单价从哪来"）
   *
   * 两种来源要分开写：表5-3 的项 → 人天来自实施计划；模型自造的行（表5-3 没有）
   * → 人天只能由行内工时折算，且单价基本是模型估价——写清楚，用户才知道该不该信。
   */
  const laborSource = (
    item: unknown,
    manDays: number,
    rate: number,
    sourceItem: string | undefined,
    fromPlan: boolean,
  ): string => {
    const days = fromPlan
      ? `表5-3 人天(${manDays})`
      : `行内工时折算(${manDays} 人天)`;
    const price = sourceItem
      ? `M6「${sourceItem}」单价(${rate} 元/人天)`
      : `模型估价(${rate} 元/人天)，M6 ${fromPlan ? "无可用单价" : "无对应项"}`;
    return `系统计算：「${String(item)}」${days} × ${price}`;
  };

  const out: CostRow[] = [];
  let changed = 0;
  let hardware = 0;
  let labor = 0;
  let operation = 0;
  let hasHardwareTotal = false;
  let hasLaborTotal = false;
  let hasOperationTotal = false;
  let hasGrandTotal = false;
  const seenLabor = new Set<string>();
  const unmatchedLabor = new Set<string>();

  for (const row of input.rows) {
    const block = costBlockOf(row);
    if (block === "汇总") {
      out.push(row); // 第二遍统一重算
      continue;
    }
    if (block === "硬件") {
      const qty = num(row["qty"]);
      const unitPrice = num(row["unit_price"]);
      let next = row;
      if (qty !== undefined && unitPrice !== undefined) {
        next = withField(next, "subtotal", money(qty * unitPrice));
      }
      hardware += num(next["subtotal"]) ?? 0;
      if (next !== row) changed += 1;
      out.push(next);
      continue;
    }
    if (block === "运营") {
      const { rate, fromM6, sourceItem } = resolveRate(row["item"], num(row["annual_fee"]));
      let next = row;
      if (rate !== undefined) {
        next = withField(next, "annual_fee", money(rate));
        if (fromM6) {
          next = withField(
            next,
            "source",
            `系统计算：M6「${sourceItem}」单价(${rate} 元)`,
          );
        }
      }
      operation += num(next["annual_fee"]) ?? 0;
      if (next !== row) changed += 1;
      out.push(next);
      continue;
    }

    // 人工
    const laborKey = normalizeCostItem(row["item"]);
    seenLabor.add(laborKey);
    if (!plans.has(laborKey) && !matchRate(input.rates, row["item"])) {
      // 既不在表5-3、M6 也认不出来 → 模型自造的名字（如"勘察与实施准备"覆盖了好几个 M6 项）
      unmatchedLabor.add(String(row["item"] ?? ""));
    }
    const manDays = manDaysOf(row, plans);
    const { rate, fromM6, sourceItem } = resolveRate(row["item"], num(row["day_rate"]));
    let next = row;
    if (manDays !== undefined) {
      next = withField(next, "hours", money(manDays * HOURS_PER_DAY));
    }
    if (rate !== undefined) {
      next = withField(next, "day_rate", money(rate));
    }
    if (manDays !== undefined && rate !== undefined) {
      next = withField(next, "cost", money(manDays * rate));
      next = withField(
        next,
        "source",
        laborSource(row["item"], manDays, rate, fromM6 ? sourceItem : undefined, plans.has(laborKey)),
      );
    }
    labor += num(next["cost"]) ?? 0;
    if (next !== row) changed += 1;
    out.push(next);
  }

  // 第二遍：表5-3 有、表5-5 缺的人工行（不删行，只补）
  //
  // 只在"人工块没有模型自造行"时才补：否则同一批工作会被算两遍（见 unmatchedLabor 注释）。
  const added: CostRow[] = [];
  for (const plan of unmatchedLabor.size > 0 ? [] : input.plans) {
    const key = normalizeCostItem(plan.item);
    if (seenLabor.has(key)) continue;
    const { rate, fromM6, sourceItem } = resolveRate(plan.item, undefined);
    if (rate === undefined) continue; // 没有可用单价，补一行 0 元反而误导
    const row: CostRow = {
      item: plan.item,
      hours: money(plan.man_days * HOURS_PER_DAY),
      day_rate: money(rate),
      cost: money(plan.man_days * rate),
      source: laborSource(plan.item, plan.man_days, rate, fromM6 ? sourceItem : undefined, true),
    };
    added.push(row);
    labor += row["cost"] as number;
    seenLabor.add(key);
  }

  for (const row of out) {
    if (costBlockOf(row) !== "汇总") continue;
    const target = totalTarget(row["item"]);
    if (target === "hardware") hasHardwareTotal = true;
    if (target === "labor") hasLaborTotal = true;
    if (target === "operation") hasOperationTotal = true;
    if (target === "total") hasGrandTotal = true;
  }

  const totals = {
    hardware: money(hardware),
    labor: money(labor),
    operation: money(operation),
    total: money(hardware + labor + operation),
  };

  const finalRows = out.map((row) => {
    if (costBlockOf(row) !== "汇总") return row;
    const target = totalTarget(row["item"]);
    const amount =
      target === "hardware"
        ? totals.hardware
        : target === "labor"
          ? totals.labor
          : target === "operation"
            ? totals.operation
            : totals.total;
    const next = withField(row, "amount", amount);
    if (next !== row) changed += 1;
    return next;
  });

  const missingTotals: string[] = [];
  if (hardware > 0 && !hasHardwareTotal) missingTotals.push("硬件合计");
  if (labor > 0 && !hasLaborTotal) missingTotals.push("人工合计");
  if (operation > 0 && !hasOperationTotal) missingTotals.push("运营合计");
  if (!hasGrandTotal) missingTotals.push("总合计");

  return {
    rows: finalRows,
    added,
    changed,
    missingRates: [...missing],
    pendingRates: [...pending],
    missingTotals,
    unmatchedLabor: [...unmatchedLabor],
    totals,
  };
}
