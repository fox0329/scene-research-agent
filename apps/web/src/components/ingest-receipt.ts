/**
 * @scene/web — 入库回执：逐文件报行数，0 行的文件必须点名（变更表 #210）
 *
 * 起因：上传是**按文件数**报完成的（「【完成】3 个文件 · 共入库 222 行」），但「已导入资料」
 * 那个列表是**从行反推文件**的（`apps/server/src/library-materials.ts`）。于是「上传 3 个、
 * 列表只有 2 个」时，用户拿不到任何解释——既看不出是哪个文件，也分不清是解析失败还是
 * 内容本就无可校验记录。`.pptx` 就是这种情形：能上传、报完成，却一行都不落
 * （DrawingML 表格原先没解析，见 `packages/infra/src/doc-parser.ts`）。
 *
 * 三条口径：
 *  ① **逐文件报**：每跑完一个文件就报它自己的行数，只报总数等于没报；
 *  ② **0 行要说话**：0 行不是失败，但也不能沉默——单独一行点名，并说清原因（没有可归入
 *     M1–M6 / O1–O6 的信息），免得用户以为文件被吞了；
 *  ③ **不重复计数**：已经报过「【错误】」的文件不再进 0 行名单，同一件事只说一遍。
 *
 * 纯函数：不碰 DOM 也不碰网络，组件只负责把事件流喂进来、把返回的文案贴出去。
 */

/** 一个文件的入库结果（跑完一个文件攒一条） */
export interface FileIngestResult {
  /** 文件名（原样，含扩展名） */
  name: string;
  /** 该文件本次落库的行数 */
  rows: number;
  /** 该文件是否报过错（error 事件或抛异常） */
  failed: boolean;
}

/** 入库收尾要用的三行文案 */
export interface IngestReceipt {
  /** 【完成】总账行 */
  doneLine: string;
  /** 【注意】0 行文件点名行；没有 0 行文件时为 null（不占一行） */
  emptyLine: string | null;
  /** 轻提示（toast）文案 */
  toast: string;
  /** 本次总行数 */
  totalRows: number;
  /** 失败文件数 */
  failedCount: number;
  /** 未产出可校验记录的文件名（**不含**已报错的） */
  emptyFiles: string[];
}

/** 单表计数拼成 `M1×8、M2×81`；空对象给空串 */
function tableCountsText(tableCounts: Record<string, number>): string {
  return Object.entries(tableCounts)
    .map(([table, count]) => `${table}×${count}`)
    .join("、");
}

/**
 * 单个文件跑完的那行进度。
 *
 * 失败的文件返回 null——错误行（「【错误】文件名：原因」）已经说过了，不再补一句「0 行」。
 */
export function fileResultLine(result: FileIngestResult): string | null {
  if (result.failed) return null;
  return result.rows > 0 ? `　→ 入库 ${result.rows} 行` : "　→ 0 行（未产出可校验记录）";
}

/** 汇总所有文件的结果，产出收尾文案 */
export function buildIngestReceipt(
  results: readonly FileIngestResult[],
  tableCounts: Record<string, number>,
): IngestReceipt {
  const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
  const failedCount = results.filter((r) => r.failed).length;
  // 失败的文件不进 0 行名单：它的问题已经用「【错误】」报过了
  const emptyFiles = results.filter((r) => !r.failed && r.rows === 0).map((r) => r.name);
  const counts = tableCountsText(tableCounts);
  const countsPart = counts ? `（${counts}）` : "";
  const failedPart = failedCount > 0 ? ` · 失败 ${failedCount} 个` : "";

  return {
    doneLine: `【完成】${results.length} 个文件 · 共入库 ${totalRows} 行${countsPart}${failedPart}`,
    emptyLine:
      emptyFiles.length === 0
        ? null
        : `【注意】${emptyFiles.length} 个文件未产出可校验记录：${emptyFiles.join("、")}。` +
          "文件已解析，但没有可归入 M1–M6 / O1–O6 的信息。",
    toast:
      `解析完成：入库 ${totalRows} 行${countsPart}` +
      (emptyFiles.length > 0 ? `，${emptyFiles.length} 个文件 0 行` : "") +
      failedPart,
    totalRows,
    failedCount,
    emptyFiles,
  };
}
