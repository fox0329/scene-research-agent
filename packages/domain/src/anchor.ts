/**
 * anchor — 场景锚（表1-1）的纯逻辑
 *
 * 场景锚 = 表1-1 场景概述（**表格形态**，中栏顶部常驻），不是一段自由文本。
 * 本模块只做纯计算：由注册表的固定行生成骨架、把用户诉求映射成起草线索、
 * 由锚行派生展示缓存文本、统计确认完成度。IO（DB/LLM）在服务端模块。
 *
 * 依据：04-业务过程重定义.md v1.4 §3.0.4、§4.7
 */

import {
  TABLES_BY_CODE,
  type AnchorRow,
  type FixedRow,
  type ScenarioBrief,
} from "@scene/contract";
import { isEmptyValue } from "./completeness.js";

/** 表1-1 的固定行（顺序即呈现顺序） */
export function anchorFixedRows(): readonly FixedRow[] {
  return TABLES_BY_CODE["表1-1"]?.fixedRows ?? [];
}

/** 表1-1 的必填固定行 */
export function anchorRequiredRows(): readonly FixedRow[] {
  return anchorFixedRows().filter((r) => r.required === true);
}

/**
 * 表1-1 中**必须由用户输入**的固定行（`owner === "用户"`）
 *
 * 用户定调（2026-09-26）：表1-1 收成 3 项，**只有「场景名称」是他的活**。
 * 其余项（覆盖什么 / 明确不含什么）是智能体从业务角度写的范围说明，用户只需看与改。
 */
export function anchorUserRows(): readonly FixedRow[] {
  return anchorFixedRows().filter((r) => r.owner === "用户");
}

/**
 * 表1-1 中**由智能体产出内容**的固定行（`owner` 缺省视为智能体）
 *
 * 这一步的口径是「智能体负责从业务角度说清楚场景的范围」——写不写得出来是
 * **智能体自己的事**，不该变成用户的填空题（见 `FixedRowOwner`）。
 */
export function anchorAgentRows(): readonly FixedRow[] {
  return anchorFixedRows().filter((r) => (r.owner ?? "智能体") === "智能体");
}

/**
 * 生成锚骨架（3 行，内容留空）
 *
 * `scene_name` 直接用场景名填入并标 `用户补充`（这是用户给的，不是系统猜的）。
 */
export function buildAnchorSkeleton(sceneName: string): readonly AnchorRow[] {
  return anchorFixedRows().map((r) => {
    if (r.key === "scene_name") {
      return { item: r.label, content: sceneName, source: "用户输入", source_type: "用户补充" };
    }
    return { item: r.label, content: "" };
  });
}

/**
 * 把用户诉求映射成已有的锚行预填（仅在起草前使用）
 *
 * 表1-1 现在只有「场景名称 + 业务画像（5 项）」，其中能直接从诉求里拿的只有
 * `场景边界`：用户写了想覆盖的范围就用范围，只写了意图（intent）就用意图兜底。
 * 生产对象/核心系统/买方/采购这四项**必须由智能体从行业知识 + 材料写**——
 * 直接拿诉求里的词去猜就退化成"系统自说自话"。
 */
export function anchorFromBrief(brief: ScenarioBrief): readonly AnchorRow[] {
  const boundary = !isEmptyValue(brief.scope_hint) ? brief.scope_hint : brief.intent;
  if (isEmptyValue(boundary)) return [];
  const fixed = anchorFixedRows().find((r) => r.key === "scene_boundary");
  if (!fixed) return [];
  return [
    {
      item: fixed.label,
      content: String(boundary).trim(),
      source: "用户诉求",
      source_type: "用户补充",
    },
  ];
}

/** 起草时给模型的用户线索（一段人话，不含系统推测） */
export function briefDraftHints(brief: ScenarioBrief): readonly string[] {
  const lines: string[] = [`场景名称：${brief.scene_name}`, `用户想搞清楚什么：${brief.intent}`];
  if (!isEmptyValue(brief.customer_hint)) lines.push(`客户/行业线索：${brief.customer_hint}`);
  if (!isEmptyValue(brief.region_hint)) lines.push(`地域/客户名线索：${brief.region_hint}`);
  if (!isEmptyValue(brief.scope_hint)) lines.push(`想覆盖范围线索：${brief.scope_hint}`);
  if (!isEmptyValue(brief.audience)) lines.push(`用途：${brief.audience}`);
  if (!isEmptyValue(brief.deadline)) lines.push(`时间要求：${brief.deadline}`);
  return lines;
}

/**
 * 由锚行派生展示缓存文本（写入 `scenario.description`）
 *
 * 为什么需要：`description` 是**派生缓存**，供不感知新表结构的旧代码/旧提示词读取；
 * **锚才是唯一事实源**。派生规则固定，避免两处各写一份。
 */
export function descriptionFromAnchor(rows: readonly AnchorRow[]): string {
  const order = anchorFixedRows().map((r) => r.label);
  const sorted = [...rows].sort(
    (a, b) => order.indexOf(a.item) - order.indexOf(b.item),
  );
  const parts = sorted
    .filter((r) => !isEmptyValue(r.content))
    .map((r) => `${r.item}：${String(r.content).trim()}`);
  return parts.join("\n");
}

/** 锚的填写完成度（阶段完整度检查与展示摘要共用） */
export interface AnchorCompletion {
  /** 必填行数 */
  required: number;
  /** 必填行已填数 */
  filled: number;
  /** 仍空着的必填行项名 */
  missing: readonly string[];
  /**
   * 用户该给但还空着的项名
   *
   * 只有这一项算「用户欠的」；其余空项是智能体待补的（不再以"缺口"名义问用户）。
   */
  userInputMissing: readonly string[];
}

/** 统计锚的完成度（"未提供" 视为空） */
export function anchorCompletion(rows: readonly AnchorRow[]): AnchorCompletion {
  const byItem = new Map(rows.map((r) => [r.item, r]));
  const required = anchorRequiredRows();
  const missing: string[] = [];
  let filled = 0;
  for (const r of required) {
    const row = byItem.get(r.label);
    if (row && !isEmptyValue(row.content)) filled += 1;
    else missing.push(r.label);
  }
  const userInputMissing = anchorUserRows()
    .filter((r) => {
      const row = byItem.get(r.label);
      return !row || isEmptyValue(row.content);
    })
    .map((r) => r.label);

  return { required: required.length, filled, missing, userInputMissing };
}

/**
 * 合并「既有锚行 + 新内容」——保留用户已确认的内容
 *
 * 起草/重算时使用：**用户确认过的行不被系统覆盖**（用户的决定优先）。
 */
export function mergeAnchorRows(
  existing: readonly AnchorRow[],
  incoming: readonly AnchorRow[],
): readonly AnchorRow[] {
  const result = new Map(existing.map((r) => [r.item, r]));
  for (const row of incoming) {
    const prev = result.get(row.item);
    const userOwned =
      prev && (prev.source_type === "用户确认" || prev.source_type === "用户补充");
    if (userOwned) continue;
    result.set(row.item, row);
  }
  return anchorFixedRows()
    .map((r) => result.get(r.label) ?? { item: r.label, content: "" })
    .filter((r, i, arr) => arr.findIndex((x) => x.item === r.item) === i);
}
