/**
 * 已导入资料页：能力重复预览的提示文案。
 *
 * 联网核验下线后，这个提示与核验无关，单独放一个纯函数文件便于单测；
 * 真正的合并动作仍在「能力清单」的「合并重复」。
 */

import type { ApiLibraryDedupeReport } from "../api";

/** 能力重复预览文案（已导入资料页的提示条） */
export function dedupePreviewText(report: ApiLibraryDedupeReport | undefined): string {
  const groups = report?.merged.length ?? 0;
  if (groups === 0) return "能力清单没有同产品线+领域+能力名的重复行";
  return `能力清单有 ${groups} 组重复（同产品线+领域+能力名），到「能力清单」点「合并重复」即可合并`;
}
