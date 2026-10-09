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

/**
 * 上传前预检体积（变更表 #155）：超过上限的文件根本不发请求。
 *
 * 为什么必须在前端拦：服务端 multipart 超限只会回 413（且那时流已被截断、拿不到真实体积），
 * 用户看到的是英文 `request file too large` 或一句"需要 multipart 表单"——既看不懂也不知道
 * 该改什么。前端手里有精确的 `file.size`，能直接说清"多大、上限多少、怎么办"。
 * @param limitMb 与服务端 multipart 同一个口径（契约 `FILE_UPLOAD_LIMIT_MB`）
 */
export function splitOversizeFiles(
  files: File[],
  limitMb: number,
): { ok: File[]; oversize: { name: string; mb: number }[] } {
  const ok: File[] = [];
  const oversize: { name: string; mb: number }[] = [];
  for (const f of files) {
    const mb = f.size / 1024 / 1024;
    if (mb > limitMb) oversize.push({ name: f.name, mb });
    else ok.push(f);
  }
  return { ok, oversize };
}

/** 超限清单 → 一行人类可读文案（含各自体积与处理建议，最多列 3 个） */
export function describeOversize(
  oversize: { name: string; mb: number }[],
  limitMb: number,
): string {
  if (oversize.length === 0) return "";
  const shown = oversize
    .slice(0, 3)
    .map((o) => `${o.name}（${o.mb.toFixed(1)} MB）`)
    .join("、");
  const more = oversize.length > 3 ? ` 等 ${oversize.length} 个` : "";
  return `已跳过 ${oversize.length} 个超过 ${limitMb} MB 上限的文件：${shown}${more}——请压缩或按章节拆分后再上传`;
}
