/**
 * @scene/web — 「场景定义」的进度口径（联真 / 演示共用一份）
 *
 * 口径（2026-09-26 用户定稿）：
 *  - 表1-1 = 一份**场景业务画像**：用户只输入「场景名称」，其余 5 项
 *    （场景边界 / 生产对象 / 核心生产系统 / 买方类型 / 采购特征）由智能体从业务角度写
 *  - **不显示待确认**：逐项表态与整表确认的概念都不进用户界面
 *    （服务端的 `confirm_state` 列仍在，只是不再有按钮去写它——就地编辑即确认）
 *
 * 所以本模块只派生两个数：**智能体写了几项**和**用户该给的给没给**。
 * 联真的就绪与提示由服务端 `readyHint` 给；演示态用同一口径在本地推导，
 * 保证两端文案与行为一致。
 */

import { tableDef, type FixedRow } from "@scene/contract";
import type { ApiAnchorRow } from "../api";

/** 只作标题、不算「画像已写出」的那一项（键口径与注册表一致） */
const SCENE_NAME_KEY = "scene_name";

/** 空值口径：空串与「未提供」都不算内容；「待定」算——那是用户明确说"还说不准" */
export function hasDefinitionContent(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return text !== "" && text !== "未提供";
}

function fixedRows(): readonly FixedRow[] {
  return tableDef("表1-1")?.fixedRows ?? [];
}

/** 智能体负责写的项名（业务画像，5 项） */
export function anchorBusinessLabels(): string[] {
  return fixedRows()
    .filter((r) => r.key !== SCENE_NAME_KEY)
    .map((r) => r.label);
}

/** 用户负责输入的项名（只有「场景名称」） */
export function anchorUserLabels(): string[] {
  return fixedRows()
    .filter((r) => r.owner === "用户")
    .map((r) => r.label);
}

/**
 * 表1-1 折叠态摘要口径（中栏折叠行 + 右栏页脚共用一份，避免两处算法漂移）
 *
 * - `filled`：智能体侧已有内容的项数（不含「场景名称」；「待定」算有内容）
 * - `total`：智能体侧应写的项数
 */
export interface AnchorSummary {
  filled: number;
  total: number;
}

export function anchorSummary(
  anchor: readonly Pick<ApiAnchorRow, "item" | "content" | "source_type">[],
): AnchorSummary {
  return {
    filled: draftedItems(anchor as readonly ApiAnchorRow[]).length,
    total: anchorBusinessLabels().length,
  };
}

/** 折叠摘要文案（中栏 / 右栏同一句，防止两处措辞分叉） */
export function anchorFoldSummary(s: AnchorSummary): string {
  return `表1-1 场景概述 · 业务画像已写 ${s.filled}/${s.total} 项`;
}

/** 已写出的业务画像项（有内容即算，含「待定」） */
export function draftedItems(anchor: readonly ApiAnchorRow[]): string[] {
  const names = new Set(anchorBusinessLabels());
  return anchor
    .filter((a) => names.has(a.item) && hasDefinitionContent(a.content))
    .map((a) => a.item);
}

/** 画像是否已写出：智能体侧任一项有内容 */
export function isDefinitionDrafted(anchor: readonly ApiAnchorRow[]): boolean {
  return draftedItems(anchor).length > 0;
}

/** 用户该给但还空着的项（只有场景名称为空时才非空） */
export function userInputMissing(anchor: readonly ApiAnchorRow[]): string[] {
  return anchorUserLabels().filter((label) => {
    const row = anchor.find((a) => a.item === label);
    return !row || !hasDefinitionContent(row.content);
  });
}

/**
 * 有了内容的项都进对照表
 *
 * 用户负责的行永远列出（空着就提示是他的活）；智能体侧只在确实写了时才列出——
 * 写了就让他看一眼、可改，没写的不打扰。
 */
export function definitionScopeLabels(anchor: readonly ApiAnchorRow[]): string[] {
  const user = new Set(anchorUserLabels());
  const filled = new Set(draftedItems(anchor));
  return fixedRows()
    .map((r) => r.label)
    .filter((label) => user.has(label) || filled.has(label));
}

/** 项名 → 固定行 key（对照表 rowKey 用；找不到就回退项名） */
export function definitionRowKey(label: string): string {
  return fixedRows().find((r) => r.label === label)?.key ?? label;
}
