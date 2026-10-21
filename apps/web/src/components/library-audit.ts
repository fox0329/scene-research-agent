/**
 * 已导入资料页：存量体检摘要与清单的纯展示逻辑
 *
 * 抽成纯函数的原因：摘要文案与「表 / 行摘要 / 来源 / 问题」四列的口径
 * 要能单测（项目没有 jsdom / Testing Library，组件渲染测试没有现成模式）；
 * 组件只负责把这里的结果画出来。
 */

import type {
  ApiAuditAbsoluteRow,
  ApiAuditConflict,
  ApiAuditUnlocatableRow,
  ApiLibraryAuditReport,
} from "../api";

/** 清单里的一行（表 / 行摘要 / 来源 / 问题） */
export interface AuditDisplayRow {
  table: string;
  summary: string;
  source: string;
  issue: string;
}

/** 摘要行文案：扫描 N 行 · 证据 B x / C y · 缺页码 m 行 · 冲突 k 组 */
export function auditSummaryText(report: ApiLibraryAuditReport): string {
  const { B, C } = report.evidence;
  return (
    `按新标准体检：扫描 ${report.scanned} 行 · 证据 B ${B} / C ${C}` +
    ` · 缺页码 ${report.unlocatable.length} 行` +
    ` · 冲突 ${report.conflicts.length} 组`
  );
}

/** 缺页码清单（来源不可定位；补来源后才能当依据） */
export function auditUnlocatableRows(report: ApiLibraryAuditReport): AuditDisplayRow[] {
  return report.unlocatable.map((row: ApiAuditUnlocatableRow) => ({
    table: row.table,
    summary: row.summary,
    source: row.source || "（空）",
    issue: "来源缺页码/章节号，需补成「文件名:页码」",
  }));
}

/** 绝对化措辞清单（体检会把这些行的证据降为 C，行保留） */
export function auditAbsoluteRows(report: ApiLibraryAuditReport): AuditDisplayRow[] {
  return report.absolute.map((row: ApiAuditAbsoluteRow) => ({
    table: row.table,
    summary: row.summary,
    source: row.source || "（空）",
    issue: `绝对化措辞：${row.term}`,
  }));
}

/** 冲突清单（同键不同值；只报告，由人裁决采信哪份） */
export function auditConflictRows(report: ApiLibraryAuditReport): AuditDisplayRow[] {
  return report.conflicts.map((conflict: ApiAuditConflict) => ({
    table: conflict.table,
    summary: conflict.key,
    source: conflict.values.map((v) => v.source || "（空）").join("；"),
    issue: conflict.values.map((v) => v.value).join(" ／ "),
  }));
}
