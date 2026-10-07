/**
 * Markdown 文本度量（纯函数，无 IO）
 *
 * 「精要」要的是**叙述**短：表格是结构（架构 / 职责 / 选型 / 步骤），本该有；
 * 流水账是正文把表格里的行又讲一遍。所以篇幅口径一律按「正文（表格不计）」算。
 */

/** 正文字数：不算表格行（`|` 开头）与空白 */
export function proseChars(markdown: string): number {
  return markdown
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join("\n")
    .replace(/\s/g, "").length;
}
