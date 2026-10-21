/**
 * 已导入资料页：联网核验 / 能力重复预览的纯展示逻辑
 *
 * 抽成纯函数的原因：摘要文案与明细列的口径要能单测；项目没有 jsdom，
 * 组件只负责把这里的结果画出来（与 `library-audit.ts` 同口径）。
 */

import type {
  ApiLibraryDedupeReport,
  ApiLibraryVerificationSummary,
  ApiLibraryVerifyDetail,
  ApiVerificationSource,
} from "../api";

/** 核验明细表格的一行 */
export interface VerifyDisplayRow {
  table: string;
  summary: string;
  status: string;
  authority: string;
  sources: ApiVerificationSource[];
  note: string;
}

/**
 * 已核验摘要行：「已核验 x（升 A y）/ 冲突 z / 未核实 w」
 *
 * 与用户口径逐字对应，界面与 toast 共用一套文案。
 */
export function verificationSummaryText(summary: ApiLibraryVerificationSummary): string {
  const conflict = summary.by_status["有冲突"] ?? 0;
  const unverified = summary.by_status["未核实"] ?? 0;
  return `已核验 ${summary.total}（升 A ${summary.upgraded}）/ 冲突 ${conflict} / 未核实 ${unverified}`;
}

/** 核验明细行（表 / 行摘要 / 状态 / 权威 / 来源 / 说明） */
export function verificationRows(
  details: readonly ApiLibraryVerifyDetail[],
): VerifyDisplayRow[] {
  return details.map((detail) => ({
    table: detail.table,
    summary: detail.summary || detail.key_text || detail.row_id,
    status: detail.status,
    authority: detail.authority || "—",
    sources: detail.sources,
    note: detail.note,
  }));
}

/** 来源链接文案：标题优先，没标题就用 URL */
export function sourceLabel(source: ApiVerificationSource): string {
  const title = String(source.title ?? "").trim();
  return title !== "" ? title : source.url;
}

/** 能力重复预览文案（已导入资料页的提示条） */
export function dedupePreviewText(report: ApiLibraryDedupeReport | undefined): string {
  const groups = report?.merged.length ?? 0;
  if (groups === 0) return "能力清单没有同产品线+领域+能力名的重复行";
  return `能力清单有 ${groups} 组重复（同产品线+领域+能力名），到「能力清单」点「合并重复」即可合并`;
}

/** 核验结束的 toast 文案（分批调用累加后的总数） */
export function verifyDoneText(totals: {
  checked: number;
  upgraded: number;
  conflict: number;
  unverified: number;
}): string {
  return `联网核验完成：核验 ${totals.checked} 行，升 A ${totals.upgraded}，冲突 ${totals.conflict}，未核实 ${totals.unverified}`;
}
