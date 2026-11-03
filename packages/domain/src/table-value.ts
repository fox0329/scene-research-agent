/**
 * table-value — 表格「有没有实际价值」的确定性判定（用户定调 2026-11-03）
 *
 * 用户要的两轮策略：**先按高可信度生成，再检查内容质量；质量差的表降低可信度要求重生成**
 * （放宽产生的内容标蓝）。判定不交给模型——模型自己说"我填得挺好"没有意义，
 * 所以这里用可复算的指标：中栏格里有多少格是"真的说了事"的。
 */

import { middleColumns, type TableDef } from "@scene/contract";

/** 纯填充词：写了等于没写 */
const FILLER = /^(未知|不适用|暂无|待确认|待核实|未提供|无|N\/A|n\/a|-|—|其他|其它|视情况而定|\?+)$/u;

/**
 * 一格算不算"有价值"
 *
 * 判据（任一即算）：
 *  - 长度 ≥ 5 个字（"浮球启泵"这种 4 字短语信息量太低）；
 *  - 含数字或型号（`≥25000 小时`、`CT15`、`1/1000` 这类短但精确）。
 * 空、纯填充词、单字答案（是/否/高/低）都不算。
 */
export function isValuableCell(raw: unknown): boolean {
  const text = (Array.isArray(raw) ? raw.join("、") : String(raw ?? "")).trim();
  if (text === "" || FILLER.test(text)) return false;
  if (/[\dA-Za-z]/u.test(text) && Array.from(text).length >= 2) return true;
  return Array.from(text).length >= 5;
}

/** 空或纯填充词（枚举列只看这个） */
export function isBlankOrFiller(raw: unknown): boolean {
  const text = (Array.isArray(raw) ? raw.join("、") : String(raw ?? "")).trim();
  return text === "" || FILLER.test(text);
}

export interface TableValueScore {
  /** 中栏总格数 */
  total: number;
  /** 有价值的格数 */
  valuable: number;
  /** 有价值占比（0–1）；没有中栏列时为 0 */
  ratio: number;
}

/** 一张表的中栏填充价值：只统计中栏列（右栏来源/核实说明不参与评分） */
export function tableValueScore(def: TableDef, rows: ReadonlyArray<Record<string, unknown>>): TableValueScore {
  const cols = middleColumns(def);
  const total = rows.length * cols.length;
  if (total === 0) return { total: 0, valuable: 0, ratio: 0 };
  let valuable = 0;
  for (const row of rows) {
    for (const col of cols) {
      /* 枚举列单独判：选了合法枚举值（「技术」「过得了」）就是有价值——按字数会把它们全判死，
         而枚举型表的这些列本来就短，用同一个尺子会让每张枚举表都被误触发降级 */
      const isEnum = col.enum !== undefined && col.enum !== null;
      const ok = isEnum
        ? !isBlankOrFiller(row[col.key])
        : isValuableCell(row[col.key]);
      if (ok) valuable++;
    }
  }
  return { total, valuable, ratio: valuable / total };
}

/** 低于这个有效占比就认为"这一轮没产出价值"，值得降级重来一遍 */
export const VALUE_RATIO_FLOOR = 0.6;
