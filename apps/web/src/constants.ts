/**
 * 支持解析入库的文件扩展名（与 ingest 后端口径一致：PDF/Word/Excel/PPT）
 */
export const SUPPORTED_EXTS = [".pdf", ".docx", ".xlsx", ".pptx"] as const;

/**
 * 从选择结果取受支持类型的文件；跳过 .DS_Store 等系统文件与其他格式。
 * @returns 受支持文件列表与被跳过的文件名（供调用方逐名提示）
 */
export function pickSupportedFiles(list: FileList | File[]): {
  files: File[];
  skippedNames: string[];
} {
  const files: File[] = [];
  const skippedNames: string[] = [];
  for (const f of Array.from(list)) {
    const lower = f.name.toLowerCase();
    if (SUPPORTED_EXTS.some((ext) => lower.endsWith(ext))) files.push(f);
    else skippedNames.push(f.name);
  }
  return { files, skippedNames };
}

/** 跳过清单 → 一行人类可读文案（超过 5 个只列前 5 + 计数） */
export function describeSkipped(skippedNames: string[]): string {
  if (skippedNames.length === 0) return "";
  const shown = skippedNames.slice(0, 5).join("、");
  const more = skippedNames.length > 5 ? ` 等 ${skippedNames.length} 个` : "";
  return `已跳过 ${skippedNames.length} 个不支持的文件（仅支持 PDF/Word/Excel/PPT）：${shown}${more}`;
}
