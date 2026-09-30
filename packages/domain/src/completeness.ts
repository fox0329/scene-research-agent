/**
 * completeness — 信息完整度检查（替代旧「质量关」）
 *
 * 职责：按表定义注册表检查一个阶段的信息是否齐备，产出**缺口清单**。
 *
 * 两条铁律（对应 04 §六）：
 *  1. **只输出"还缺什么"**——不输出通过/不通过、不给建议档位（产品不产出判断）
 *  2. **不齐备不阻断**——用户决定先补信息还是先往下走
 *
 * 检查项：表齐备 / 必填列齐备 / 覆盖度 / 来源齐备 / 推断留痕 / 待确认回收
 * 依赖：只依赖 @scene/contract，无 IO（DB/网络/模型通过参数注入）
 */

import {
  COVERAGE_RULES,
  tablesOfStage,
  type InfoStageId,
  type SourceType,
  type TableDef,
} from "@scene/contract";

// ─── 输入 / 输出类型 ───────────────────────────────────────

/** 一行信息（键为列字段名；source / source_type 为通用列） */
export interface InfoRow {
  readonly [key: string]: unknown;
  readonly source?: string | null;
  readonly source_type?: SourceType | null;
}

/** 缺口类型 */
export type GapKind =
  | "缺表"
  | "缺必填列"
  | "覆盖度不足"
  | "缺来源"
  | "推断未标注"
  | "待确认未处理";

/** 一条缺口 */
export interface Gap {
  kind: GapKind;
  /** 表号；阶段级缺口（待确认）为空串 */
  tableCode: string;
  /** 列字段名（缺列/缺来源时给） */
  column?: string;
  /** 影响面描述（一行缺口说明） */
  detail: string;
  /** 涉及行数 */
  count?: number;
}

/** 阶段完整度报告 */
export interface StageCompleteness {
  stage: InfoStageId;
  /** 本阶段应产出的表数 */
  expectedTables: number;
  /** 已有数据的表数 */
  tablesWithData: number;
  /** 缺表的表号 */
  missingTables: readonly string[];
  /** 缺口清单（不阻断，仅提示） */
  gaps: readonly Gap[];
  /** 完整度（已有数据的表 / 应产出表，0-100） */
  percent: number;
}

// ─── 取值判定 ──────────────────────────────────────────────

/** 视为「空」的取值：null / undefined / 空串 / 纯空白 / 「未提供」 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === "" || s === "未提供";
}

/** 必填判定：required 为真；条件必填（requiredWhen）不做机器判定，交由人工/提示词 */
function isMachineRequired(col: { required?: boolean }): boolean {
  return col.required === true;
}

// ─── 覆盖度检查 ────────────────────────────────────────────

function coverageGaps(t: TableDef, rows: readonly InfoRow[]): Gap[] {
  const gaps: Gap[] = [];
  const rules = COVERAGE_RULES[t.code] ?? [];
  for (const r of rules) {
    if (r.kind === "min-rows") {
      if (rows.length < r.min) {
        gaps.push({
          kind: "覆盖度不足",
          tableCode: t.code,
          detail: `${r.label}（当前 ${rows.length} 行）`,
          count: rows.length,
        });
      }
      continue;
    }
    if (r.kind === "enum-complete") {
      const present = new Set(rows.map((row) => String(row[r.column] ?? "").trim()));
      const missing = r.values.filter((v) => !present.has(v));
      if (missing.length > 0) {
        gaps.push({
          kind: "覆盖度不足",
          tableCode: t.code,
          column: r.column,
          detail: `${r.label}——缺类别：${missing.join("、")}`,
          count: missing.length,
        });
      }
      continue;
    }
    // all-columns-non-empty：该行这些列必须都填（逐行判定）
    const badRows = rows.filter((row) => r.columns.some((key) => isEmptyValue(row[key])));
    if (badRows.length > 0) {
      gaps.push({
        kind: "覆盖度不足",
        tableCode: t.code,
        column: r.columns.join(","),
        detail: `${r.label}——${badRows.length} 行不满足`,
        count: badRows.length,
      });
    }
  }
  return gaps;
}

// ─── 单表检查 ──────────────────────────────────────────────

function tableGaps(t: TableDef, rows: readonly InfoRow[]): Gap[] {
  const gaps: Gap[] = [];
  if (rows.length === 0) {
    return [{ kind: "缺表", tableCode: t.code, detail: `${t.code} ${t.name}：尚无数据` }];
  }

  // 必填列齐备（按列汇总行数，避免逐行刷屏）
  for (const col of t.columns) {
    if (!isMachineRequired(col)) continue;
    const missing = rows.filter((row) => isEmptyValue(row[col.key])).length;
    if (missing > 0) {
      gaps.push({
        kind: "缺必填列",
        tableCode: t.code,
        column: col.key,
        detail: `${t.code} ${t.name}：${col.label} 有 ${missing} 行空`,
        count: missing,
      });
    }
  }

  // 覆盖度
  gaps.push(...coverageGaps(t, rows));

  // 来源齐备（重要/支撑表；过程表不强制）
  if (t.tier !== "过程") {
    const noSource = rows.filter((row) => isEmptyValue(row.source)).length;
    if (noSource > 0) {
      gaps.push({
        kind: "缺来源",
        tableCode: t.code,
        detail: `${t.code} ${t.name}：${noSource} 行无来源`,
        count: noSource,
      });
    }
    // 推断留痕：有内容但既无来源、又未标 source_type
    const untraced = rows.filter(
      (row) =>
        Object.entries(row).some(
          ([k, v]) => !["source", "source_type", "confirm_state"].includes(k) && !isEmptyValue(v),
        ) &&
        isEmptyValue(row.source) &&
        isEmptyValue(row.source_type),
    ).length;
    if (untraced > 0) {
      gaps.push({
        kind: "推断未标注",
        tableCode: t.code,
        detail: `${t.code} ${t.name}：${untraced} 行既无来源也未标『推断待确认』`,
        count: untraced,
      });
    }
  }

  return gaps;
}

// ─── 阶段检查（对外主接口） ────────────────────────────────

/**
 * 检查一个阶段的信息完整度，产出缺口清单。
 *
 * @param input.stage 阶段编号
 * @param input.rowsByTable 表号 → 行数组
 * @param input.pendingConfirmations 未处理的待确认项数（由 confirmation 模块产出）
 */
export function checkStageCompleteness(input: {
  stage: InfoStageId;
  rowsByTable: Readonly<Record<string, readonly InfoRow[] | undefined>>;
  pendingConfirmations?: number;
}): StageCompleteness {
  const tables = tablesOfStage(input.stage);
  const gaps: Gap[] = [];
  const missingTables: string[] = [];
  let tablesWithData = 0;

  for (const t of tables) {
    const rows = input.rowsByTable[t.code] ?? [];
    if (rows.length > 0) tablesWithData += 1;
    for (const g of tableGaps(t, rows)) {
      gaps.push(g);
      if (g.kind === "缺表") missingTables.push(t.code);
    }
  }

  const pending = input.pendingConfirmations ?? 0;
  if (pending > 0) {
    gaps.push({
      kind: "待确认未处理",
      tableCode: "",
      detail: `右栏待确认清单还有 ${pending} 项未处理`,
      count: pending,
    });
  }

  return {
    stage: input.stage,
    expectedTables: tables.length,
    tablesWithData,
    missingTables,
    gaps,
    percent: tables.length === 0 ? 100 : Math.round((tablesWithData / tables.length) * 100),
  };
}

/** 缺口清单 → 阶段总结文档「五、信息缺口与待补充」的要点行 */
export function gapsToSummaryLines(report: StageCompleteness): readonly string[] {
  if (report.gaps.length === 0) return ["本阶段信息齐备，暂无缺口。"];
  return report.gaps.map((g) => `- ${g.detail}`);
}

/** 缺口清单 → 一句话概览（右栏状态行用） */
export function gapsBrief(report: StageCompleteness): string {
  if (report.gaps.length === 0) return `信息完整度 ${report.percent}%（无缺口）`;
  const byKind = new Map<GapKind, number>();
  for (const g of report.gaps) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);
  const parts = [...byKind.entries()].map(([k, n]) => `${k} ${n} 项`);
  return `信息完整度 ${report.percent}%（${parts.join("、")}）`;
}
