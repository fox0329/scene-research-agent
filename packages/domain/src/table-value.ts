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
 * 判据：**非空、非占位词、不是单字答案**就算有价值。
 *
 * 早前用"≥5 个字"当门槛，结果把「数据采集」「设备控制」「快速上云」这些**能力名**
 * 全判成没价值标了红——名词本来就短，短不等于空。用户要的是"不要空洞地说不适用/未知"，
 * 不是"不许写短名词"，所以门槛只拦真正的空话：占位词与单字是非答案。
 */
export function isValuableCell(raw: unknown): boolean {
  const text = (Array.isArray(raw) ? raw.join("、") : String(raw ?? "")).trim();
  if (text === "" || FILLER.test(text)) return false;
  /* 单个字符：纯数字是有效内容（序号/排名 1、2、3…），单个汉字或字母不是答案（是/否/高/低） */
  if (Array.from(text).length < 2) return /^\d$/u.test(text);
  return true;
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

/**
 * 达标线（用户定调 2026-11-03：「按单个单元格统计，90% 以上达标」）
 *
 * 低于它 → 降低可信度做二轮检索/填表；二轮后仍不达标的格子标红。
 */
export const VALUE_RATIO_FLOOR = 0.9;

/**
 * 一行里"有内容但没价值"的列（空格子不算——没有文字可染红）
 *
 * 「填了但等于没填」：占位词（未知/不适用/待核实）、单字答案（是/否/高/低）、空话。
 * 这些是**已经花了模型 token 却没产出信息**的格子，用户要能一眼看见（红字）。
 */
export function weakCellKeys(def: TableDef, row: Record<string, unknown>): string[] {
  const weak: string[] = [];
  for (const col of middleColumns(def)) {
    const raw = row[col.key];
    const text = (Array.isArray(raw) ? raw.join("、") : String(raw ?? "")).trim();
    /* 真空的格子不标：界面上它本来就是空的，没有文字可染红 */
    if (text === "") continue;
    const isEnum = col.enum !== undefined && col.enum !== null;
    /* 「未知」「不适用」「是/否」这些**填了但没信息量**的才算弱格——用户要的正是把它们标红 */
    const ok = isEnum ? !isBlankOrFiller(raw) : isValuableCell(raw);
    if (!ok) weak.push(col.key);
  }
  return weak;
}
