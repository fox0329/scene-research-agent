/**
 * @scene/server — 交付物报告服务（变更表 #112）
 *
 * 一份交付物有两个来源，这里统一成一个出口，界面与导出都只认它：
 *  - **正式版**：模型撰写的五章方案，落在 `data/deliverables/<场景>.solution.md`；
 *  - **要点版**：还没生成正式版时，用 `@scene/infra` 的确定性装配（章节 ← 表映射）
 *    即时推导——保证「交付物」这一步任何时候都有东西可看（用户不用先点生成）。
 *
 * 变更表 #136：交付物只有一份「<场景>解决方案」（不再有内部调研版）。旧项目落的是
 * `<场景>.external.md`，读取时兜底认它，改名不会让已有定稿消失。
 *
 * 为什么不落库：报告是**产物**不是业务事实；事实仍在 33 张表里。落文件也让「重新生成
 * 不覆盖历史导出」与「导出即所见」两件事都成立（导出前先取同一份内容）。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReportKind, Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { safeWriteFile, buildReportMarkdown, exportFileName, type ChapterDigest } from "@scene/infra";
import { reportChapterDigest } from "@scene/infra";
import {
  deliverableDir,
  deliverableReportPath,
  legacyDeliverableReportPath,
} from "./deliverable-report.js";

/** 导出目录（调用时读环境变量：测试用临时目录） */
export function exportDir(): string {
  return process.env.EXPORT_DIR ?? join(process.cwd(), "exports");
}

export interface ReportView {
  kind: ReportKind;
  markdown: string;
  /** true = 模型撰写的正式版；false = 确定性要点版 */
  generated: boolean;
  generated_at: string | null;
  /** 该报告用到的章节原料（界面/调试用，不落盘） */
  digest: readonly ChapterDigest[];
}

/** 正式版落盘内容（新路径优先，旧 `.external.md` 兜底） */
function readGenerated(scenarioId: string): { text: string; path: string } | null {
  for (const path of [deliverableReportPath(scenarioId), legacyDeliverableReportPath(scenarioId)]) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.trim() !== "") return { text, path };
  }
  return null;
}

/** 取交付物：正式版优先，没有就即时推导要点版 */
export function getReport(db: DbInstance, scenario: Scenario): ReportView {
  const stageData = db.stageDataRepo.list({
    where: "scenario_id = ?",
    params: [scenario.id],
  });
  const digest = reportChapterDigest(stageData);
  const generated = readGenerated(scenario.id);
  if (generated) {
    return {
      kind: "solution",
      markdown: generated.text,
      generated: true,
      generated_at: statSync(generated.path).mtime.toISOString(),
      digest,
    };
  }
  const markdown = buildReportMarkdown({ scenario, stageSummaries: [], stageData });
  return { kind: "solution", markdown, generated: false, generated_at: null, digest };
}

/**
 * 用户在中栏改完报告正文后保存（变更表 #135）。
 * 落盘同样走先读后写：内容没变不碰文件；文件被应用之外改过则保留那份、新内容另存。
 */
export function saveReportFile(
  scenario: Scenario,
  markdown: string,
): { path: string; written: boolean; overwritten: boolean; notice?: string } {
  const dir = deliverableDir();
  mkdirSync(dir, { recursive: true });
  const saved = safeWriteFile(deliverableReportPath(scenario.id), markdown);
  if (saved.notice) console.warn(`[save] ${saved.notice}`);
  return saved;
}

/** 导出到 `exports/`（写盘内容 = 界面所见）：`<场景>解决方案.md` */
export function writeReportFiles(
  db: DbInstance,
  scenario: Scenario,
): { path: string; notice?: string } {
  const view = getReport(db, scenario);
  const outDir = exportDir();
  mkdirSync(outDir, { recursive: true });
  // 先读后写（变更表 #131）：内容一模一样就一个字节都不动；被手改过就不覆盖用户文件，另存「(应用版 时间)」
  const saved = safeWriteFile(join(outDir, exportFileName(scenario.name)), view.markdown);
  if (saved.notice) console.warn(`[export] ${saved.notice}`);
  return { path: saved.path, notice: saved.notice };
}

/** 交付物是否已生成（界面按钮文案用） */
export function hasGeneratedReport(scenarioId: string): boolean {
  return readGenerated(scenarioId) !== null;
}

export { deliverableDir, deliverableReportPath };
