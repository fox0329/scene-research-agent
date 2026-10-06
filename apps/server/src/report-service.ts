/**
 * @scene/server — 交付物报告服务（变更表 #112）
 *
 * 一份报告有两个来源，这里统一成一个出口，界面与导出都只认它：
 *  - **正式版**：模型撰写的六章总结，落在 `data/deliverables/<场景>.<kind>.md`；
 *  - **要点版**：还没生成正式版时，用 `@scene/infra` 的确定性装配（章节 ← 表映射）
 *    即时推导——保证"交付物"这一步任何时候都有东西可看（用户不用先点生成）。
 *
 * 为什么不落库：报告是**产物**不是业务事实；事实仍在 33 张表里。落文件也让"重新生成
 * 不覆盖历史导出"与"导出即所见"两件事都成立（导出前先取同一份内容）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { buildReportMarkdown, exportFileName, type ChapterDigest } from "@scene/infra";
import { reportChapterDigest } from "@scene/infra";
import { deliverableDir, deliverableReportPath } from "./deliverable-report.js";

/** 导出目录（调用时读环境变量：测试用临时目录） */
export function exportDir(): string {
  return process.env.EXPORT_DIR ?? join(process.cwd(), "exports");
}

export interface ReportView {
  kind: "internal" | "external";
  markdown: string;
  /** true = 模型撰写的正式版；false = 确定性要点版 */
  generated: boolean;
  generated_at: string | null;
  /** 该报告用到的章节原料（界面/调试用，不落盘） */
  digest: readonly ChapterDigest[];
}

function readGenerated(scenarioId: string, kind: "internal" | "external"): string | null {
  const path = deliverableReportPath(scenarioId, kind);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return text.trim() === "" ? null : text;
}

/** 取一份报告：正式版优先，没有就即时推导要点版 */
export function getReport(db: DbInstance, scenario: Scenario, kind: "internal" | "external"): ReportView {
  const stageData = db.stageDataRepo.list({
    where: "scenario_id = ?",
    params: [scenario.id],
  });
  const digest = reportChapterDigest(kind, stageData);
  const generated = readGenerated(scenario.id, kind);
  if (generated) {
    const path = deliverableReportPath(scenario.id, kind);
    return {
      kind,
      markdown: generated,
      generated: true,
      generated_at: statSync(path).mtime.toISOString(),
      digest,
    };
  }
  const markdown = buildReportMarkdown(
    { scenario, stageSummaries: [], stageData },
    new Date().toISOString().slice(0, 10),
    kind,
  );
  return { kind, markdown, generated: false, generated_at: null, digest };
}

/** 两份报告（界面一次取全） */
export function getReportPair(
  db: DbInstance,
  scenario: Scenario,
): { internal: ReportView; external: ReportView } {
  return {
    internal: getReport(db, scenario, "internal"),
    external: getReport(db, scenario, "external"),
  };
}

/** 导出两份报告到 `exports/`（写盘内容 = 界面所见） */
export function writeReportFiles(
  db: DbInstance,
  scenario: Scenario,
): { internal_path: string; external_path: string } {
  const pair = getReportPair(db, scenario);
  const outDir = exportDir();
  mkdirSync(outDir, { recursive: true });
  const internalPath = join(outDir, exportFileName(scenario.name, "internal"));
  const externalPath = join(outDir, exportFileName(scenario.name, "external"));
  writeFileSync(internalPath, pair.internal.markdown, "utf8");
  writeFileSync(externalPath, pair.external.markdown, "utf8");
  return { internal_path: internalPath, external_path: externalPath };
}

/** 报告是否已生成（界面按钮文案用） */
export function hasGeneratedReport(scenarioId: string): boolean {
  return (
    readGenerated(scenarioId, "internal") !== null && readGenerated(scenarioId, "external") !== null
  );
}

export { deliverableDir, deliverableReportPath };
