/**
 * 支持解析入库的文件扩展名（与 ingest 后端口径一致：PDF/Word/Excel/PPT）
 */
export const SUPPORTED_EXTS = [".pdf", ".docx", ".xlsx", ".pptx"] as const;

/**
 * 从选择结果取受支持类型的文件；跳过 .DS_Store 等系统文件与其他格式。
 * @returns 受支持文件列表与跳过数量（供调用方提示）
 */
export function pickSupportedFiles(list: FileList | File[]): {
  files: File[];
  skipped: number;
} {
  const files: File[] = [];
  let skipped = 0;
  for (const f of Array.from(list)) {
    const lower = f.name.toLowerCase();
    if (SUPPORTED_EXTS.some((ext) => lower.endsWith(ext))) files.push(f);
    else skipped++;
  }
  return { files, skipped };
}
