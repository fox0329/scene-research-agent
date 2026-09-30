/**
 * row-validation — 模型产出行校验（补「输出契约空壳」）
 *
 * 背景：旧实现的输出契约只约束 `table_code` 与 `source`，`fields` 是
 * `{ type: "object" }`（无字段约束）——模型少填列、写错字段名、必填留空、
 * 自封「用户确认」都会被照收（见 04 §一 的问题诊断）。
 *
 * 本模块用**注册表**做本地校验：表号必须在阶段清单内、必填列必须有值、
 * 枚举必须落在字典内、不得自称用户确认、重要/支撑表必须有来源。
 * 校验结果进入「缺口清单」提示用户，**不阻断**（沿用信息版口径）。
 */

import { TABLES_BY_CODE, tablesOfStage, type InfoStageId } from "@scene/contract";
import { isEmptyValue } from "./completeness.js";

/** 模型产出行（对应输出契约的 rows[] 元素） */
export interface IncomingRow {
  table_code?: unknown;
  fields?: unknown;
  source?: unknown;
  source_type?: unknown;
}

/** 违规类型 */
export type ViolationKind =
  | "未知表号"
  | "缺必填列"
  | "枚举非法"
  | "缺来源"
  | "自称用户确认";

export interface RowViolation {
  kind: ViolationKind;
  tableCode: string;
  /** 在 rows[] 中的下标（从 0 起） */
  rowIndex: number;
  column?: string;
  detail: string;
}

/**
 * 校验一批模型产出行
 *
 * @param stage 阶段编号（0-7；用新 8 阶段口径）
 * @param rows 模型输出的行
 */
export function validateIncomingRows(
  stage: InfoStageId,
  rows: readonly IncomingRow[],
): readonly RowViolation[] {
  const allowed = new Set(tablesOfStage(stage).map((t) => t.code));
  const out: RowViolation[] = [];

  rows.forEach((row, rowIndex) => {
    const code = String(row.table_code ?? "").trim();
    if (!code || !allowed.has(code)) {
      out.push({
        kind: "未知表号",
        tableCode: code || "(空)",
        rowIndex,
        detail: `表号「${code || "空"}」不属于阶段 ${stage}（允许：${[...allowed].join("、")}）`,
      });
      return;
    }
    const t = TABLES_BY_CODE[code]!;
    const fields = (row.fields ?? {}) as Record<string, unknown>;
    /**
     * 行级取值：通用列（source / source_type / confirm_state）可能被模型放在
     * 行上而非 `fields` 内，两处都查，避免误报缺必填。
     */
    const valueOf = (key: string): unknown =>
      fields[key] !== undefined ? fields[key] : (row as Record<string, unknown>)[key];

    // 必填列（条件必填不做机器判定）
    for (const col of t.columns) {
      if (col.required !== true) continue;
      if (isEmptyValue(valueOf(col.key))) {
        out.push({
          kind: "缺必填列",
          tableCode: code,
          rowIndex,
          column: col.key,
          detail: `${code} 第 ${rowIndex + 1} 行缺必填列「${col.label}」`,
        });
      }
    }

    // 枚举合法性
    for (const col of t.columns) {
      if (!col.enum) continue;
      const v = valueOf(col.key);
      if (isEmptyValue(v)) continue;
      const values = ENUM_VALUES[col.enum] ?? [];
      if (!values.includes(String(v))) {
        out.push({
          kind: "枚举非法",
          tableCode: code,
          rowIndex,
          column: col.key,
          detail: `${code} 第 ${rowIndex + 1} 行「${col.label}」取值「${String(v)}」不在枚举内（${values.join("/")}）`,
        });
      }
    }

    // 重要/支撑表必须有来源
    if (t.tier !== "过程" && isEmptyValue(row.source) && isEmptyValue(fields["source"])) {
      out.push({
        kind: "缺来源",
        tableCode: code,
        rowIndex,
        detail: `${code} 第 ${rowIndex + 1} 行缺来源`,
      });
    }

    // 模型不得自称用户确认（那是用户动作的结果）
    const st = String(row.source_type ?? fields["source_type"] ?? "").trim();
    if (st === "用户确认" || st === "用户补充") {
      out.push({
        kind: "自称用户确认",
        tableCode: code,
        rowIndex,
        detail: `${code} 第 ${rowIndex + 1} 行标了「${st}」——该状态只能由用户确认动作产生，模型只能用 AI提取/AI推断`,
      });
    }
  });

  return out;
}

/** 违规清单 → 一句话概览 */
export function violationsBrief(violations: readonly RowViolation[]): string {
  if (violations.length === 0) return "产出行校验通过";
  const byKind = new Map<ViolationKind, number>();
  for (const v of violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
  return [...byKind.entries()].map(([k, n]) => `${k} ${n} 项`).join("、");
}

/** 违规是否致命到不该入库（自称用户确认会污染证据等级，必须降级改写） */
export function mustDowngrade(v: RowViolation): boolean {
  return v.kind === "自称用户确认";
}

// 枚举字典（避免每次查 contract 的 as const 联合）
import { ENUMS as ENUM_DICT } from "@scene/contract";
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = ENUM_DICT;
