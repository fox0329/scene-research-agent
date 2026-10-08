/**
 * @scene/server — 导出 Word（变更表 #133）
 *
 * 「导出到文件」= 把界面所见的两份报告按《Word 输出格式规范》写成 .docx，
 * 落到用户选的文件夹里。与 Markdown 导出共用同一份内容（`getReportPair`），
 * 落盘同样走**先读后写**（`safeWriteFileBytes`）：内容一样不碰文件，
 * 用户手改过就不覆盖、另存「(应用版 时间)」。
 *
 * 文件名与 Markdown 导出一致，只把扩展名换成 .docx：
 *   `<场景> 内部调研报告 <日期>.docx` / `<场景> 对外汇报材料 <日期>.docx`
 */

import { join } from "node:path";
import type { Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { exportFileName, reportDateOf, reportMarkdownToDocx, safeWriteFileBytes } from "@scene/infra";
import { getReportPair } from "./report-service.js";

export interface DocxExportResult {
  /** 实际落盘的文件（被手改过时会是另存名） */
  files: string[];
  /** 没写盘的文件（内容与磁盘上完全一致） */
  unchanged: string[];
  /** 需要提示用户的话（被手改过时） */
  notice?: string;
}

/** 把两份报告写成 Word 落到 `dir`；`kinds` 可只导其中一份 */
export async function exportReportDocx(
  db: DbInstance,
  scenario: Scenario,
  dir: string,
  kinds: readonly ("internal" | "external")[] = ["internal", "external"],
): Promise<DocxExportResult> {
  const pair = getReportPair(db, scenario);
  const today = new Date().toISOString().slice(0, 10);
  const files: string[] = [];
  const unchanged: string[] = [];
  const notices: string[] = [];

  for (const kind of kinds) {
    const view = pair[kind];
    const date = reportDateOf(view.markdown, today);
    const named = exportFileName(scenario.name, kind, date); // …md
    const path = join(dir, named.replace(/\.md$/, ".docx"));
    const buf = await reportMarkdownToDocx(view.markdown, {
      headerText: named.replace(/\.md$/, ""),
      // 稳定时间（报告日期，用本地零点）：zip 条目不盖"当前时间"，
      // 同一份报告每次生成的字节完全一致 → 「内容没变就不碰文件」才成立
      createdAt: new Date(`${date}T00:00:00`),
    });
    const saved = safeWriteFileBytes(path, buf);
    if (saved.notice) notices.push(saved.notice);
    if (saved.written) files.push(saved.path);
    else unchanged.push(saved.path);
  }

  return { files, unchanged, notice: notices.length > 0 ? notices.join("；") : undefined };
}
