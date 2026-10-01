/**
 * @scene/web — 展示层文本口径（元说明兜底剥离 + 长度截断）
 *
 * 为什么要有这一层：
 *  - 老数据里可能残留「（用户未明说，按行业通行情况推断）」这类**元说明**（说明"这句话是
 *    怎么来的"而不是场景本身）。服务端已在新写入时剥离，但**已存在的行**还在库里——
 *    这里只做展示层兜底剥离，**不碰数据库、不改契约**。
 *  - 右栏确认清单不该把锚行整段内容再抄一遍：截断到固定字数，完整内容看中栏表格。
 *
 * 铁律：本模块是纯函数（可单测），不引入第三方依赖。
 */

/**
 * 元说明片段（两两成对：注解里通常前因后果都写全）
 *
 * 例：「用户未明说」+「推断」→ 命中「（用户未明说，按行业通行情况推断）」
 */
const META_PAIRS: readonly (readonly [string, string])[] = [
  ["用户未明说", "推断"],
  ["未明说", "推断"],
  ["按行业", "推断"],
  ["行业惯例", "推断"],
  ["助手", "推断"],
  ["系统", "推断"],
  ["模型", "推断"],
  ["AI", "推断"],
];

/** 元说明词（括号里只有这几个词时，整段括号就是注解，如「（系统自动生成）」） */
const META_WORDS = "推断|猜测|估计|生成|自动|未明说|未明确|行业惯例|通行情况";

/** 元说明注解匹配串 */
const META_ALT = META_PAIRS.map(([a, b]) => `${a}[^（）()]*?${b}`).join("|");

/**
 * 命中的整段括号注解（`u` 旗标下 `\p{Script=Han}` 可用）
 *
 * 只吃括号注解、不吃裸文本：正文里顺手写的「由助手按行业推断」不该被剥（那是正文）。
 * `[^（）()]` 保证匹配同一层括号对，不会跨层吃掉正文。
 */
const META_NOTE_RE = new RegExp(
  `[（(](?:[^（）()]*?(?:${META_ALT})[^（）()]*?|(?:${META_WORDS})+)[）)]`,
  "gu",
);

/** 剥离注解后残留的悬空标点与空格 */
function tidyPunctuation(text: string): string {
  return (
    text
      .replace(/[（(]\s*[）)]/gu, "")
      .replace(/\s{2,}/gu, " ")
      .replace(/[ \t]+([，,。；;、）)])/gu, "$1")
      .replace(/[，,、；;]\s*(?=[，,、；;。！？])/gu, "")
      .replace(/[，,、]\s*$/gu, "")
      .trim()
  );
}

/**
 * 展示层兜底剥离元说明注解
 *
 * 反复替换直到稳定：嵌套/相邻注解一次替换后可能又暴露出新的（或产生空括号）。
 * 只处理**成对**的括号注解，正文里的逗号空格顺手清理。
 */
export function stripMetaNotes(text: string): string {
  let out = text;
  for (let i = 0; i < 6; i += 1) {
    const next = tidyPunctuation(out.replace(META_NOTE_RE, ""));
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 截断到 `max` 字（超出加 …；截断后补齐可能被切开的右括号） */
export function clipText(text: string, max: number): string {
  const plain = stripMetaNotes(text).trim();
  if (plain.length <= max) return plain;
  const head = plain.slice(0, max);
  const opens = (head.match(/[（(]/gu) ?? []).length;
  const closes = (head.match(/[）)]/gu) ?? []).length;
  return `${head}${opens > closes ? "）" : ""}…`;
}

/** 悬浮全文（不截断，只剥注解） */
export function plainText(text: unknown): string {
  return stripMetaNotes(String(text ?? ""));
}
