/**
 * @scene/server — 导出 Word（变更表 #133）
 *
 * 「导出到文件」= 把界面所见的交付物按《Word 输出格式规范》写成 .docx，落到用户选的
 * 文件夹里。与 Markdown 导出共用同一份内容（`getReport`），落盘同样走**先读后写**
 * （`safeWriteFileBytes`）：内容一样不碰文件，用户手改过就不覆盖、另存「(应用版 时间)」。
 *
 * 变更表 #136：只有一份交付物，文件名与 Markdown 导出一致，只把扩展名换成 .docx：
 *   `<场景>解决方案.docx`
 */

import { join } from "node:path";
import type { Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { exportFileName, reportMarkdownToDocx, safeWriteFileBytes } from "@scene/infra";
import { getReport } from "./report-service.js";

export interface DocxExportResult {
  /** 实际落盘的文件（被手改过时会是另存名） */
  files: string[];
  /** 没写盘的文件（内容与磁盘上完全一致） */
  unchanged: string[];
  /** 需要提示用户的话（被手改过时） */
  notice?: string;
}

/** 把交付物写成 Word 落到 `dir` */
export async function exportReportDocx(
  db: DbInstance,
  scenario: Scenario,
  dir: string,
): Promise<DocxExportResult> {
  const view = getReport(db, scenario);
  const named = exportFileName(scenario.name); // …解决方案.md
  const path = join(dir, named.replace(/\.md$/, ".docx"));
  const buf = await reportMarkdownToDocx(view.markdown, {
    headerText: named.replace(/\.md$/, ""),
    // 稳定时间（当天零点）：zip 条目不盖「当前时间」，同一份报告每次生成的字节完全一致
    // →「内容没变就不碰文件」才成立
    createdAt: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00`),
  });
  const saved = safeWriteFileBytes(path, buf);
  return {
    files: saved.written ? [saved.path] : [],
    unchanged: saved.written ? [] : [saved.path],
    notice: saved.notice,
  };
}
