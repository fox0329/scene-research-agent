/**
 * @scene/web — 报告正文的行内格式（用户投诉 v1.34：「预览有问题，还有这个 ** 符号」）
 *
 * 交付物正文是模型写的 Markdown，通篇用 `**结论**` 起句（价值一 / 原则一 / 第一 …）。
 * 中栏渲染器原先只认标题、列表、引用、管道表格，段落文字**原样输出**——于是
 * `**原则一：不替代原系统。**` 在界面上就是带星号的一行，读起来像没渲染完的稿子。
 *
 * 这里把行内粗体切出来（纯函数，可单测），由渲染器包成 `<strong>`。
 * 只认成对的 `**`：落单的星号按普通文字处理，宁可少解析也不吞掉正文。
 */

export interface InlinePart {
  text: string;
  bold: boolean;
}

/**
 * 把 `**粗体**` 切成片段
 *
 * 只认「`**` + 非星号开头 + 惰性到下一个 `**`」：`****`、落单的 `**` 都原样留下，
 * 宁可少解析也不吞掉正文（`**a*b**` 这类内含单个星号的写法仍算粗体）。
 */
const BOLD = /\*\*([^*][\s\S]*?)\*\*/g;

export function splitBold(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const at = m.index;
    if (at > last) parts.push({ text: text.slice(last, at), bold: false });
    parts.push({ text: m[1]!, bold: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts.length > 0 ? parts : [{ text, bold: false }];
}
