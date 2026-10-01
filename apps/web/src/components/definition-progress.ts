/**
 * @scene/web — 「场景定义」的进度口径（联真 / 演示共用一份）
 *
 * 用户定调（2026-09-25）：
 *  - 场景定义**要抽象一点**——用户很多时候还说不准，允许留「待定」
 *  - 定义的松紧**不卡后续推进**：第 1 步就绪 = 「定义已整理」
 *    （表1-1 除「场景名称」外任一项有内容即可推进，不再要求逐项确认）
 *  - 需要用户表态的项以**返回数组**为准（核心必确认项 ∪ 模型实际填了/推断的项），
 *    前端不假设行数
 *
 * 本模块只做纯派生：联真的就绪与提示由服务端 `readyHint` 给；
 * 演示态用同一口径在本地推导，保证两端文案与行为一致。
 */

import { tableDef } from "@scene/contract";
import { l1Rows } from "@scene/domain";
import type { ApiAnchorRow } from "../api";

/** 只作标题、不算「定义已整理」的那一项（键口径与注册表一致） */
const SCENE_NAME_KEY = "scene_name";

/** 空值口径：空串与「未提供」都不算内容；「待定」算——那是用户明确说"还说不准" */
export function hasDefinitionContent(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return text !== "" && text !== "未提供";
}

/** 表1-1 的定义项名（按注册表顺序，剔除「场景名称」） */
export function definitionItemLabels(): string[] {
  return (tableDef("表1-1")?.fixedRows ?? [])
    .filter((r) => r.key !== SCENE_NAME_KEY)
    .map((r) => r.label);
}

/** 表1-1 的**核心必确认**项名（L1，注册表给行，前端不假设行数） */
export function coreConfirmLabels(): string[] {
  return (tableDef("表1-1")?.fixedRows ?? [])
    .filter((r) => r.confirmRequired)
    .map((r) => r.label);
}

/**
 * 表1-1 折叠态摘要口径（中栏折叠行 + 右栏页脚共用一份，避免两处算法漂移）
 *
 * - `filled`：已有内容的定义项数（不含「场景名称」；「待定」算有内容）
 * - `coreConfirmed` / `coreTotal`：核心必确认项的已表态数 / 总数
 */
export interface AnchorSummary {
  filled: number;
  total: number;
  coreConfirmed: number;
  coreTotal: number;
}

export function anchorSummary(
  anchor: readonly Pick<ApiAnchorRow, "item" | "content" | "source_type">[],
): AnchorSummary {
  const filled = draftedItems(anchor as readonly ApiAnchorRow[]).length;
  const core = coreConfirmLabels();
  const confirmed = anchor.filter(
    (a) =>
      core.includes(a.item) &&
      (a.source_type === "用户确认" || a.source_type === "用户补充"),
  ).length;
  return {
    filled,
    total: tableDef("表1-1")?.fixedRows?.length ?? 0,
    coreConfirmed: confirmed,
    coreTotal: core.length,
  };
}

/** 折叠摘要文案（中栏 / 右栏同一句，防止两处措辞分叉） */
export function anchorFoldSummary(s: AnchorSummary): string {
  return `表1-1 场景概述 · 已填 ${s.filled} 项（核心 ${s.coreConfirmed}/${s.coreTotal} 已确认）`;
}

/** 已整理的定义项（有内容即算，含「待定」） */
export function draftedItems(anchor: readonly ApiAnchorRow[]): string[] {
  const names = new Set(definitionItemLabels());
  return anchor
    .filter((a) => names.has(a.item) && hasDefinitionContent(a.content))
    .map((a) => a.item);
}

/** 定义是否已整理：除「场景名称」外任一项有内容 */
export function isDefinitionDrafted(anchor: readonly ApiAnchorRow[]): boolean {
  return draftedItems(anchor).length > 0;
}

/** 需要用户表态的清单项（联真由服务端给、演示由 buildChecklist 给，形状一致即可） */
export interface StanceItem {
  layer: string;
  state: string;
}

/** 有了内容的项都进对照表——「模型填了/推断的」也值得用户看一眼 */
export function definitionScopeLabels(anchor: readonly ApiAnchorRow[]): string[] {
  const core = new Set(l1Rows().map((r) => r.label));
  const filled = new Set(draftedItems(anchor));
  return (tableDef("表1-1")?.fixedRows ?? [])
    .map((r) => r.label)
    .filter((label) => label !== sceneNameLabel() && (core.has(label) || filled.has(label)));
}

function sceneNameLabel(): string {
  return (tableDef("表1-1")?.fixedRows ?? []).find((r) => r.key === SCENE_NAME_KEY)?.label ?? "";
}

/** 项名 → 固定行 key（对照表 rowKey 用；找不到就回退项名） */
export function definitionRowKey(label: string): string {
  return (tableDef("表1-1")?.fixedRows ?? []).find((r) => r.label === label)?.key ?? label;
}

export interface DefinitionProgress {
  /** 表1-1 里已有内容的定义项数（不含场景名称） */
  filled: number;
  /** 定义已整理（第 1 步的就绪口径） */
  drafted: boolean;
  /** 需要用户表态的项数（清单实际返回的 L1 项，不写死） */
  stanceTotal: number;
  /** 其中已表态（用户确认 / 用户补充）的项数 */
  stanceDone: number;
  /** 还待表态的项数 */
  stancePending: number;
}

/** 由「表1-1 锚行 + 确认清单」派生第 1 步的两个数字口径 */
export function definitionProgress(
  anchor: readonly ApiAnchorRow[],
  checklist: readonly StanceItem[],
): DefinitionProgress {
  const filled = draftedItems(anchor).length;
  const l1 = checklist.filter((c) => c.layer === "L1");
  const done = l1.filter((c) => c.state === "用户确认" || c.state === "用户修改").length;
  return {
    filled,
    drafted: filled > 0,
    stanceTotal: l1.length,
    stanceDone: done,
    stancePending: l1.length - done,
  };
}
