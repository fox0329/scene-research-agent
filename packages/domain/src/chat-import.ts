/**
 * @scene/domain — 对话消息内文件路径提取（对话即导入）
 *
 * 用户在对话里直接写本地文件路径（如「导入 ~/docs/规格书.pdf 和
 * /tmp/报价.xlsx」），服务端提取路径走 ingest 管线入库——导入入口
 * 内嵌在对话本身，无需任何按钮。
 *
 * 纯函数：不做 IO（文件是否存在由调用方判断），保证可单测。
 */

/** 支持解析入库的文件扩展名（与 ingest 后端口径一致） */
export const IMPORTABLE_EXTS = [".pdf", ".docx", ".xlsx", ".pptx"] as const;

/**
 * 路径正文字符类：非空白、非中英文结束标点/引号括号（允许中文文件名）。
 * 路径后紧贴中文（如「规格书.pdf，再看一下」）在标点处自然截断。
 */
const PATH_TOKEN = /(?:^|[\s"'「『（(=：:])(\/[^\s"'「」『』（）()，。；、：！？…,;:!?…]+|~\/[^\s"'「」『』（）()，。；、：！？…,;:!?…]+)/g;

/**
 * 从消息文本提取可导入的本地文件路径。
 *
 * 识别规则：
 * - 以 `/` 或 `~/` 开头（绝对路径 / 家目录缩写），兼容包裹的引号
 * - 在空白或中英文结束标点处截断（路径后紧贴中文也不受影响）
 * - 扩展名必须在 {@link IMPORTABLE_EXTS} 内；`http(s)://` 等网址天然不匹配
 *   （不以 / 开头），`//x` 形式因含空段被排除
 * - 按出现顺序去重
 *
 * @param text - 用户消息原文
 * @returns 提取到的路径列表（保持出现顺序，无则空数组）
 */
export function extractImportablePaths(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    let candidate = match[1] ?? "";
    // 容错：引号被替换为空格的场景下 token 可能带残留引号
    candidate = candidate.replace(/^[，。；、,;:!？?…]+|[，。；、,;:!？?…]+$/g, "");
    if (candidate.includes("//")) continue;
    const lower = candidate.toLowerCase();
    if (!IMPORTABLE_EXTS.some((ext) => lower.endsWith(ext))) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
  }
  return found;
}

/** 把路径展开为绝对路径（~ 前缀按 env HOME 展开，其余原样返回） */
export function expandHomePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}
