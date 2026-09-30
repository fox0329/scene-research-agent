/**
 * @scene/server — 阶段总结文档服务
 *
 * 职责：为一个场景的某个阶段**生成并落库**右栏总结文档（六段骨架）。
 *
 * 设计（对应 04 §五）：
 *  - **确定性生成**：行数据 + 完整度报告 + 注册表 → Markdown，不需要 LLM
 *  - 阶段口径 8 阶段（0-7）；兼容旧数据把 `stage = 8` 视为阶段 7（交付物）
 *  - 交付阶段（无信息表）也生成一份说明，而不是留空
 */

import {
  tablesOfStage,
  type InfoStageId,
  type Scenario,
  type StageId,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  buildStageSummary,
  checkStageCompleteness,
  pendingConfirmationCount,
  type InfoRow,
  type StageCompleteness,
} from "@scene/domain";
import { readAnchorRows, readBrief } from "./scenario-anchor.js";

/** 阶段编号归一：旧编号 8（交付物）合并为 7 */
export function normalizeStage(stage: StageId): InfoStageId {
  return (stage === 8 ? 7 : stage) as InfoStageId;
}

/** 读某阶段各表的行（按注册表的表号；跨阶段的表也按表号取全量） */
export function readStageRowsByTable(
  db: DbInstance,
  scenarioId: string,
  stage: InfoStageId,
): Record<string, InfoRow[]> {
  const out: Record<string, InfoRow[]> = {};
  for (const t of tablesOfStage(stage)) {
    const rows = db.stageDataRepo
      .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, t.code] })
      .map((r) => r.row as InfoRow);
    out[t.code] = rows;
  }
  // 场景锚（表1-1）始终带上：它是全链唯一场景定义，总结里要以它为准
  if (!out["表1-1"]) out["表1-1"] = readAnchorRows(db, scenarioId) as unknown as InfoRow[];
  return out;
}

export interface StageSummaryResult {
  markdown: string;
  completeness: StageCompleteness;
  stage: InfoStageId;
}

/**
 * 生成（并落库）阶段总结文档
 *
 * @param stage 原始阶段编号（可传旧编号 8）
 */
export function generateStageSummary(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
): StageSummaryResult {
  const id = normalizeStage(stage);
  const rowsByTable = readStageRowsByTable(db, scenario.id, id);
  const completeness = checkStageCompleteness({
    stage: id,
    rowsByTable,
    pendingConfirmations: pendingConfirmationCount(rowsByTable),
  });
  const brief = readBrief(db, scenario.id);
  const productLine = db.productLineRepo.getById(scenario.product_line_id);
  const markdown = buildStageSummary({
    stage: id,
    scenarioName: scenario.name,
    productLineName: productLine?.name,
    rowsByTable,
    completeness,
    briefRawText: brief?.raw_text,
  });
  db.stageSummaryRepo.upsert(scenario.id, id, markdown);
  return { markdown, completeness, stage: id };
}

/** 读已落库的总结；没有则即时生成（保证右栏永远有内容） */
export function getOrGenerateStageSummary(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
): StageSummaryResult & { cached: boolean } {
  const id = normalizeStage(stage);
  const existing = db.stageSummaryRepo.get(scenario.id, id);
  if (existing) {
    // 缓存命中也要给出最新完整度（缺口可能因编辑而变化）
    const rowsByTable = readStageRowsByTable(db, scenario.id, id);
    const completeness = checkStageCompleteness({
      stage: id,
      rowsByTable,
      pendingConfirmations: pendingConfirmationCount(rowsByTable),
    });
    return { markdown: existing.content, completeness, stage: id, cached: true };
  }
  return { ...generateStageSummary(db, scenario, id), cached: false };
}

/** 阶段面板用：只给完整度（不做 LLM、不写库） */
export function stageCompletenessOf(
  db: DbInstance,
  scenarioId: string,
  stage: StageId,
): StageCompleteness {
  const id = normalizeStage(stage);
  const rowsByTable = readStageRowsByTable(db, scenarioId, id);
  return checkStageCompleteness({
    stage: id,
    rowsByTable,
    pendingConfirmations: pendingConfirmationCount(rowsByTable),
  });
}
