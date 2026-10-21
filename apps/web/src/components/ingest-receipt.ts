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
 *     资料库表格的信息），免得用户以为文件被吞了；
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

/** 证据等级分布（与服务端 IngestResult.evidenceSummary 同构） */
export interface IngestEvidenceSummary {
  A: number;
  B: number;
  C: number;
  D: number;
}

/** 命中绝对化措辞的行（服务端已降为 C，未删除） */
export interface IngestFlaggedRow {
  table_code: string;
  key: string;
  field: string;
  term: string;
  reason?: string;
}

/** 同键不同值的冲突（服务端保留原值，未覆盖、未新增） */
export interface IngestConflict {
  table_code: string;
  key: string;
  existing: string;
  incoming: string;
  source: string;
}

/** 被门禁挡下的行 */
export interface IngestSkippedRow {
  table_code: string;
  source: string;
  reason: string;
}

/** 入库质量三件套（done 事件逐文件累计后传进来；缺省视为无数据） */
export interface IngestQuality {
  evidenceSummary: IngestEvidenceSummary;
  flaggedRows: IngestFlaggedRow[];
  conflicts: IngestConflict[];
  skippedRows: IngestSkippedRow[];
}

/** 入库收尾要用的文案 */
export interface IngestReceipt {
  /** 【完成】总账行 */
  doneLine: string;
  /** 【注意】0 行文件点名行；没有 0 行文件时为 null（不占一行） */
  emptyLine: string | null;
  /**
   * 质量行：证据分布 + 夸大措辞 + 冲突 + 被挡行，并声明系统的保证边界
   *
   * 用户问「入库有标准吗、怎么保证有效性客观性」——能确定判的（来源可定位、
   * 证据可分级、冲突可见）在这里逐项报数；**不假装能保证材料内容绝对真实**，
   * 那句话必须留在回执里，避免把"系统校验过"误读成"内容是真的"。
   */
  qualityLine: string;
  /** 轻提示（toast）文案 */
  toast: string;
  /** 本次总行数 */
  totalRows: number;
  /** 失败文件数 */
  failedCount: number;
  /** 未产出可校验记录的文件名（**不含**已报错的） */
  emptyFiles: string[];
}

/** 表号 → 用户可见名称（表号只留在接口/数据里，不显示给用户；O3 价格类别已下线） */
const TABLE_LABELS: Record<string, string> = {
  M1: "产品清单",
  M2: "规格书",
  M3: "能力清单",
  M4: "边界与限制",
  M5: "已知限制",
  M6: "报价",
  O1: "认证",
  O2: "案例",
  O4: "SDK",
  O5: "路线图",
  O6: "生态",
};

/** 单表计数拼成 `产品清单×8、规格书×81`；空对象给空串 */
function tableCountsText(tableCounts: Record<string, number>): string {
  return Object.entries(tableCounts)
    .filter(([table]) => table !== "O3")
    .map(([table, count]) => `${TABLE_LABELS[table] ?? table}×${count}`)
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

/** 空证据分布（没有 done 事件 / 旧服务端时用） */
const EMPTY_SUMMARY: IngestEvidenceSummary = { A: 0, B: 0, C: 0, D: 0 };

/** 质量行固定声明：系统保证什么、不保证什么 */
const QUALITY_SCOPE =
  "系统保证可溯源、可分级、冲突可见；材料本身真伪仍需交叉核验。";

/** 证据分布文案：只列有行数的档位，全 0 时明说暂无入库行 */
function evidenceText(summary: IngestEvidenceSummary): string {
  const parts = (["A", "B", "C", "D"] as const)
    .filter((level) => summary[level] > 0)
    .map((level) => `${level} ${summary[level]} 行`);
  return parts.length > 0 ? parts.join(" / ") : "暂无入库行";
}

/**
 * 质量行：证据分布（B/C 等）+ 夸大措辞行数 + 冲突数 + 被挡行数 + 边界声明
 *
 * 例：证据：B 18 行 / C 3 行（夸大措辞 2 行）；冲突 2 条未覆盖；被挡 1 行。
 * 系统保证可溯源、可分级、冲突可见；材料本身真伪仍需交叉核验。
 */
function qualityText(quality: IngestQuality): string {
  const summary = quality.evidenceSummary ?? EMPTY_SUMMARY;
  const flaggedRows = quality.flaggedRows ?? [];
  const conflicts = quality.conflicts?.length ?? 0;
  const skipped = quality.skippedRows?.length ?? 0;
  // 同一行命中多个词只算一行（「夸大措辞 2 行」说的是行数，不是命中次数）
  const flaggedRowCount = new Set(
    flaggedRows.map((row) => `${row.table_code}|${row.key}`),
  ).size;
  // 证据 C 只有两个来源：夸张措辞（已单列）与低权威材料（自媒体/口述/未知）
  const lowAuthority = Math.max(0, (summary.C ?? 0) - flaggedRowCount);
  const detail: string[] = [];
  if (flaggedRowCount > 0) detail.push(`夸大措辞 ${flaggedRowCount} 行`);
  if (lowAuthority > 0) detail.push(`低权威来源 ${lowAuthority} 行`);
  const flagPart = detail.length > 0 ? `（${detail.join("、")}）` : "";
  return (
    `证据：${evidenceText(summary)}${flagPart}；` +
    `冲突 ${conflicts} 条未覆盖；被挡 ${skipped} 行。` +
    QUALITY_SCOPE
  );
}

/** 汇总所有文件的结果，产出收尾文案 */
export function buildIngestReceipt(
  results: readonly FileIngestResult[],
  tableCounts: Record<string, number>,
  quality: IngestQuality = {
    evidenceSummary: EMPTY_SUMMARY,
    flaggedRows: [],
    conflicts: [],
    skippedRows: [],
  },
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
          "文件已解析，但没有可归入资料库表格的信息。",
    qualityLine: qualityText(quality),
    toast:
      `解析完成：入库 ${totalRows} 行${countsPart}` +
      (emptyFiles.length > 0 ? `，${emptyFiles.length} 个文件 0 行` : "") +
      failedPart,
    totalRows,
    failedCount,
    emptyFiles,
  };
}
