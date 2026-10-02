/**
 * completeness — 信息完整度检查（替代旧「质量关」）
 *
 * 职责：按表定义注册表检查一个阶段的信息是否齐备，产出**缺口清单**。
 *
 * 三条铁律：
 *  1. **只输出"还缺什么"**——不输出通过/不通过、不给建议档位（产品不产出判断）
 *  2. **不齐备不阻断**——用户决定先补信息还是先往下走
 *  3. **缺口要分属主**（2026-09-26 新增）：只向用户要**他的活**，其余是智能体的待办
 *
 * 第 3 条的由来（用户投诉）：真机上第 1 步的缺口清单有 9 条，逐条看**没有一条是
 * 用户能回答的**——"6 行无来源""既无来源也未标『推断待确认』"是智能体的溯源文书，
 * "表1-3 / 表2-7 有 1 行空"是第 2 步才产出的表。把智能体的 TODO 打印给用户看，
 * 不是信息过载，是**责任错位**。所以每个 `Gap` 现在带 `owner`，用户界面只渲染
 * `owner === "用户"` 的那些（第 1 步通常一条都没有）。
 *
 * 检查项：表齐备 / 必填列齐备 / 覆盖度 / 来源齐备 / 推断留痕
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

/** 缺口的属主：谁该把它补上 */
export type GapOwner =
  /** 只有用户能给的（如「场景名称」没填）——**只有这类才呈现在用户界面** */
  | "用户"
  /** 智能体自己的待办（补齐内容、标来源、写推断留痕）——不进用户界面 */
  | "智能体";

/** 缺口类型 */
export type GapKind = "缺表" | "缺必填列" | "覆盖度不足" | "缺来源" | "推断未标注";

/** 一条缺口 */
export interface Gap {
  kind: GapKind;
  /** 谁该补上（见 `GapOwner`） */
  owner: GapOwner;
  /** 表号；阶段级缺口为空串 */
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
          owner: "智能体",
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
          owner: "智能体",
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
        owner: "智能体",
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
    return [{ kind: "缺表", owner: "智能体", tableCode: t.code, detail: `${t.code} ${t.name}：尚无数据` }];
  }

  // 「项/内容」表（有固定行）：**逐固定行判必填**，并按固定行的属主标 gap.owner
  //
  // 为什么要逐行：旧版按列汇总，把 12 行一起报成「内容 有 6 行空」——用户看到
  // 这句什么也做不了，而且真正该问他的（场景名称）混在里面看不出来。
  // 现在用户欠的标 `用户`，智能体欠的标 `智能体`，界面只渲染前者。
  if (t.fixedRows) {
    for (const fixed of t.fixedRows) {
      if (fixed.required !== true) continue;
      const row = rows.find((r) => String(r["item"] ?? "").trim() === fixed.label);
      if (row && !isEmptyValue(row["content"])) continue;
      const owner: GapOwner = fixed.owner === "用户" ? "用户" : "智能体";
      gaps.push({
        kind: "缺必填列",
        owner,
        tableCode: t.code,
        column: "content",
        detail:
          owner === "用户"
            ? `${t.code} ${t.name}：「${fixed.label}」还是空的`
            : `${t.code} ${t.name}：「${fixed.label}」还没写`,
        count: 1,
      });
    }
  } else {
    // 普通表格：必填列齐备（按列汇总行数，避免逐行刷屏）
    for (const col of t.columns) {
      if (!isMachineRequired(col)) continue;
      const missing = rows.filter((row) => isEmptyValue(row[col.key])).length;
      if (missing > 0) {
        gaps.push({
          kind: "缺必填列",
          owner: "智能体",
          tableCode: t.code,
          column: col.key,
          detail: `${t.code} ${t.name}：${col.label} 有 ${missing} 行空`,
          count: missing,
        });
      }
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
        owner: "智能体",
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
        owner: "智能体",
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
 */
export function checkStageCompleteness(input: {
  stage: InfoStageId;
  rowsByTable: Readonly<Record<string, readonly InfoRow[] | undefined>>;
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

  return {
    stage: input.stage,
    expectedTables: tables.length,
    tablesWithData,
    missingTables,
    gaps,
    percent: tables.length === 0 ? 100 : Math.round((tablesWithData / tables.length) * 100),
  };
}

/**
 * 只挑出**只有用户能回答**的缺口（用户界面唯一该渲染的部分）
 *
 * 第 1 步通常是空数组——那不是"没有缺口"，而是缺口全在智能体那边。
 */
export function userGaps(report: StageCompleteness): readonly Gap[] {
  return report.gaps.filter((g) => g.owner === "用户");
}

/** 智能体自己的待办（内部用；不进用户界面） */
export function agentGaps(report: StageCompleteness): readonly Gap[] {
  return report.gaps.filter((g) => g.owner === "智能体");
}

/**
 * 缺口清单 → 阶段总结文档「五、待补齐信息」的要点行
 *
 * 口径（用户定调）：缺口**不再是"你的缺口"**，而是分两栏说明——
 * 「需要你补充」极少，其余都是「我将补充」。
 */
export function gapsToSummaryLines(report: StageCompleteness): readonly string[] {
  const forUser = userGaps(report);
  const forAgent = agentGaps(report);
  if (forUser.length === 0 && forAgent.length === 0) return ["本阶段信息齐备，暂无待补项。"];
  const lines: string[] = [];
  for (const g of forUser) lines.push(`- 需要你补充：${g.detail}`);
  if (forAgent.length > 0) {
    lines.push(`- 我将补充（${forAgent.length} 项，不打扰你）：`);
    for (const g of forAgent) lines.push(`  - ${g.detail}`);
  }
  return lines;
}

/** 缺口清单 → 一句话概览（右栏状态行用） */
export function gapsBrief(report: StageCompleteness): string {
  if (report.gaps.length === 0) return `信息完整度 ${report.percent}%（无缺口）`;
  const byKind = new Map<GapKind, number>();
  for (const g of report.gaps) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);
  const parts = [...byKind.entries()].map(([k, n]) => `${k} ${n} 项`);
  return `信息完整度 ${report.percent}%（${parts.join("、")}）`;
}
