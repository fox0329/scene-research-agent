/**
 * cell-trust — 表格单元格该用什么颜色（确定性层）
 *
 * 用户定调（2026-11-03）：「只要是有真实的网络数据来源，也就是右栏有可验证的链接，
 * 就认为是可信的，字体用黑色。如果查不到资料，是模型推理加行业通识的用蓝色字体，
 * 这样还是不能填有价值信息的用红色字体」。
 *
 * 所以颜色**由来源决定，不由模型自报**：
 *   - 黑：右栏是真链接 / 材料页码 / 用户输入
 *   - 蓝：右栏是「推断：…」「行业通识：…」或空（查不到资料，模型推的）
 *   - 红：这格有内容但没价值（未知、不适用、单个是或否）——红色优先于蓝色
 *
 * 为什么不继续用模型自报的 `low_trust_fields`：实测会漏标（照明场景 8 行里 4 行没标）、
 * 也会误标（把整行 9 个列全报成推断）。来源是落库的客观字段，判定可复算、可解释。
 */

import { isBlankOrFiller, isValuableCell } from "./table-value.js";
import type { TableDef } from "@scene/contract";

export type CellTrust = "verified" | "inferred" | "worthless";

/**
 * 这一行的来源能不能验证
 *
 * - 真 http(s) 链接、材料 `文件名:页码`、用户输入 → 可验证
 * - `推断：…` / `行业通识：…` / 空 → 不可验证（内容农场已被来源质量门改写成「推断：」）
 */
export function isVerifiableSource(source: unknown): boolean {
  const text = typeof source === "string" ? source.trim() : "";
  if (text === "") return false;
  /* 来源质量门改写过的文本，一律算推断 */
  if (/^(推断|行业通识)/u.test(text)) return false;
  /* 客户自己说的是一手来源 */
  if (/^用户输入/u.test(text)) return true;
  if (/^https?:\/\//iu.test(text)) return true;
  /* 材料定位：文件名:页码 / 文件名#章节 */
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md|csv)([:#：]|\s|$)/iu.test(text)) return true;
  return false;
}

/**
 * 判一格颜色
 *
 * 空格不染色（没有文字，染了也看不见）。
 */
export function cellTrustOf(
  def: TableDef | undefined,
  row: Record<string, unknown>,
  key: string,
  source: unknown,
): CellTrust {
  const raw = row[key];
  const text = (Array.isArray(raw) ? raw.join("、") : String(raw ?? "")).trim();
  if (text === "") return "verified";
  const col = def?.columns?.find((c) => c.key === key);
  const worthless = col?.enum !== undefined && col?.enum !== null
    ? isBlankOrFiller(raw)
    : !isValuableCell(raw);
  /* 红优先：填了但没价值，比"来源是推断"更严重 */
  if (worthless) return "worthless";
  return isVerifiableSource(source) ? "verified" : "inferred";
}

/** 映射到 DOM 类名（黑＝无类） */
export function cellTrustClass(trust: CellTrust): string | undefined {
  if (trust === "worthless") return "weak-value";
  if (trust === "inferred") return "low-trust";
  return undefined;
}
