/**
 * @scene/web — 表格列宽自动适配（目标：**总行高最小**）
 *
 * 用户定调（2026-10-02）：「每个表格生成时调整列宽到行高最小的状态，别让用户自己
 * 一个个调整」。
 *
 * 为什么要单独一个纯函数模块：
 *  - 这是**纯计算**（内容宽 → 列宽），不碰 DOM，可以单测、可以调参（阈值/下限）；
 *  - 之前的实现只在"第一次渲染"算一次，且把算出来的宽度**当成用户手动宽度存进
 *    localStorage**——于是表格内容更新后仍然沿用旧内容的宽度（列挤成一条、行被撑得
 *    很高），用户只能一列一列手动拖。宽度决策必须能被"重新算"。
 *
 * 目标函数（与用户说的「行高最小」一致）：
 *   表格高度 = Σ_行 max_列 该格换行行数
 *   在「列宽之和 ≤ 中栏宽」且「每列 ≥ 可读下限」的约束下最小化它。
 *  - 自然宽总和放得下 → 所有格单行，行高恒为最小（这是最常见的宽裕情形）；
 *  - 放不下 → 贪心：每次把"每减少 1px 引起的总行数增量最小"的那一列减一点，
 *    直到放下。行数按 `ceil(内容宽 / 可用宽)` 估（单元格 `overflow-wrap: anywhere`，
 *    中文与长串都可任意断行，这个估计与真实换行基本一致）。
 */

/** 单元格左右内边距之和（px）：`th/td` 的 padding 是 `--s2 --s3`，量不到时用这个兜底 */
export const DEFAULT_CELL_PAD_PX = 24;

/** 每列可读下限（px）：再窄表头都读不出来 */
export const DEFAULT_MIN_COL_PX = 64;

export interface FitColumn {
  key: string;
  /** 表头文本的单行自然宽（px，**不含**内边距） */
  headerPx: number;
  /** 该列每一行内容的单行自然宽（px，**不含**内边距） */
  demands: readonly number[];
}

export interface FitOptions {
  /** 单元格左右内边距之和 */
  padPx?: number;
  /** 列宽下限 */
  minPx?: number;
}

/** 某列在给定宽度下的换行行数（≥1） */
function linesOf(contentPx: number, widthPx: number, padPx: number): number {
  const usable = Math.max(1, widthPx - padPx);
  if (contentPx <= usable) return 1;
  return Math.ceil(contentPx / usable);
}

/** 单行放得下该列全部内容所需的整列宽（含内边距） */
function naturalWidth(col: FitColumn, padPx: number): number {
  let max = col.headerPx;
  for (const d of col.demands) if (d > max) max = d;
  return Math.max(1, max) + padPx;
}

/** 给定各列宽度时的**总行高**（以"行数"为单位，1 = 单行） */
function totalLines(cols: readonly FitColumn[], widths: readonly number[], padPx: number): number {
  if (cols.length === 0) return 0;
  const rows = cols[0]!.demands.length;
  let sum = 0;
  for (let r = 0; r < rows; r += 1) {
    let tallest = 1;
    for (let c = 0; c < cols.length; c += 1) {
      const n = linesOf(cols[c]!.demands[r] ?? 0, widths[c]!, padPx);
      if (n > tallest) tallest = n;
    }
    sum += tallest;
  }
  // 表头行恒为 1 行：宽度按内容自然宽分配时不会换行，这里不计入比较
  return sum;
}

/**
 * 求「总行高最小」的列宽分配（整数 px，各列之和 ≤ container）
 *
 * 返回 `key → 宽`。调用方通常把**末列**的宽留空（由它承接余量），
 * 所以这里只保证「各列之和 ≤ container」，不强行凑满。
 */
export function fitWidthsMinHeight(
  cols: readonly FitColumn[],
  container: number,
  opts: FitOptions = {},
): Record<string, number> {
  const padPx = opts.padPx ?? DEFAULT_CELL_PAD_PX;
  const out: Record<string, number> = {};
  if (cols.length === 0 || !Number.isFinite(container) || container <= 0) return out;

  /** 列数 × 下限都放不下时，只能均分（极端窄容器，宁可窄也不出横向滚动条） */
  const minPx = Math.max(1, Math.min(opts.minPx ?? DEFAULT_MIN_COL_PX, Math.floor(container / cols.length)));

  const naturals = cols.map((c) => Math.max(minPx, Math.round(naturalWidth(c, padPx))));
  const naturalTotal = naturals.reduce((a, b) => a + b, 0);

  // ① 宽裕：全部单行（行高已是最小），余量按自然宽比例分——继续保持单行
  if (naturalTotal <= container) {
    const extra = container - naturalTotal;
    let assigned = 0;
    cols.forEach((c, i) => {
      const share = i === cols.length - 1 ? extra - assigned : Math.round((extra * naturals[i]!) / naturalTotal);
      assigned += share;
      out[c.key] = naturals[i]! + Math.max(0, share);
    });
    return out;
  }

  // ② 不足：从自然宽出发，贪心压缩"每省 1px 代价最小"的列
  const widths = [...naturals];
  let total = naturalTotal;
  const minOf = (i: number) => Math.min(widths[i]!, minPx);
  const heightOf = () => totalLines(cols, widths, padPx);
  let guard = 0;
  while (total > container && guard < 4000) {
    guard += 1;
    // 每轮至少压掉整体溢出的一部分：列多时步子小、列少时步子大，收敛快且不越界
    const stepBase = Math.max(1, Math.ceil((total - container) / cols.length));
    let bestIdx = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestWidth = 0;
    const before = heightOf();
    for (let i = 0; i < cols.length; i += 1) {
      const floor = minOf(i);
      if (widths[i]! <= floor) continue;
      const step = Math.max(1, Math.min(widths[i]! - floor, stepBase));
      const w = widths[i]! - step;
      const saved = widths[i]! - w;
      widths[i] = w;
      const after = heightOf();
      widths[i] = w + saved;
      const cost = (after - before) / saved; // 每省 1px 增加的行数
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
        bestWidth = w;
      }
    }
    if (bestIdx < 0) break; // 全部到下限，仍放不下：由调用方/容器兜底（宁可横滚）
    total -= widths[bestIdx]! - bestWidth;
    widths[bestIdx] = bestWidth;
  }

  cols.forEach((c, i) => {
    out[c.key] = widths[i]!;
  });
  return out;
}

/**
 * px 列宽 → 百分比列宽（**刚好 100%**）
 *
 * 为什么不能直接把 px 写进 colgroup：`table-layout: fixed` 下，表宽 = max(指定宽, 列宽之和)，
 * 列宽之和只要比容器多出零点几像素（浏览器缩放、Retina 亚像素取整都会造成），`.tw` 就会
 * 长出一条横向滚动条——用户明确要求"表格整体的宽度不能超过中栏的宽度""不能在底部加横向
 * 移动条"。改成百分比后，各列之和**按定义就是 100%**，浏览器会把取整误差摊掉，
 * 溢出在结构上不可能发生；列宽之和本来就等于容器宽，所以视觉上与原来一致。
 */
export function toPercentWidths(widths: Record<string, number>): Record<string, string> {
  const keys = Object.keys(widths);
  const total = keys.reduce((a, k) => a + (widths[k] ?? 0), 0);
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = total > 0 ? `${(((widths[k] ?? 0) / total) * 100).toFixed(4)}%` : "0%";
  }
  return out;
}
