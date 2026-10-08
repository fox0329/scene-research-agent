/**
 * @scene/domain — 报告正文形态（变更表 #138）
 *
 * 交付物的**篇幅压缩回炉**只认「压完更短」与「构件不丢」，查不出"句子是不是完整"：
 * 模型为凑字数从句子中间删起，落盘的正文段落就以残标点开头——
 *
 *   `、Teams 等云平台；多园区由 IT、弱电运维（常含外包）与厂商支持；纪要手工或录音转写。`
 *
 * 读者看到的是一段**从半句话开始**的正文（断头段）。本模块是确定性兜底：识别这种段落、
 * 把残句头切掉，并在**装配落盘前**再过一遍（模型初稿 / 压缩稿 / 历史文件都走同一条路）。
 *
 * 纯函数，无 IO；判定落确定性层（AGENTS.md §三.5）。
 */

/**
 * 残标点：正文段落**以这些字符开头**就是被砍断的句子。
 * 半角全角都要认（模型两种都写过）；`（`、`「`、`*`、`-` 不在其中——
 * 正文合法地以这些开头（「（一）…」、引用式开头、列表行），误伤比漏判更糟。
 */
const RESIDUAL_HEADS = "、，。；：）】」』”,.;:)]";

/** 开头的残标点串（修复时整串剥掉，不是只剥一个） */
const RESIDUAL_PREFIX = /^[、，。；：）】」』”,.;:)\]]+/;

/** 句末标点：断头段从开头切到第一个句末标点（**含**） */
const SENTENCE_END = /[；。！？]/;

/** 不以句子开头的行：标题 / 表格行 / 分隔线 / 引用（这些行本来就不成句） */
function isNonProse(firstLine: string): boolean {
  const t = firstLine.trim();
  return (
    t.startsWith("#") || t.startsWith("|") || t.startsWith(">") || /^-{3,}$/.test(t)
  );
}

/** 这一段的段首是不是残标点（空段不算） */
function hasBrokenHead(text: string): boolean {
  const t = text.trim();
  return t !== "" && RESIDUAL_HEADS.includes(t.charAt(0));
}

/**
 * 修一个断头段
 *
 * 从头切到第一个句末标点（含）——那句话本来就是残留的半句；
 * 后面没有内容可留（句末标点就在段尾）时退一步，只剥掉开头的残标点串
 * （`，下一句。` → `下一句。`，正文不能整段丢）。
 *
 * @returns 修好的段落正文；`null` = 切完什么都不剩，这一段该丢
 */
function repairHead(text: string): string | null {
  const t = text.trim();
  const end = SENTENCE_END.exec(t);
  const kept = end && t.slice(end.index + 1).trim() !== "" ? t.slice(end.index + 1) : t;
  // 切点后面可能又跟着残标点（`、甲。，乙`），一并剥掉才能保证幂等
  const fixed = kept.replace(RESIDUAL_PREFIX, "").trim();
  return fixed === "" ? null : fixed;
}

/**
 * 断头段：正文段落以残标点开头（压缩砍断句子的产物）
 *
 * 只认正文段落：按空行分段，跳过标题（`#`）、表格行（`|`）、分隔线（`---`）、引用（`>`）。
 * 段落内的列表行（`- ` / `* ` / `1. `）只要该段**首字符**不是残标点就不算。
 *
 * @returns 每个断头段的**原文**（未修改），按出现顺序
 */
export function brokenProseHeads(markdown: string): string[] {
  const out: string[] = [];
  for (const para of paragraphsOf(markdown)) {
    if (!isNonProse(para[0]!) && hasBrokenHead(para.join("\n"))) out.push(para.join("\n").trim());
  }
  return out;
}

/**
 * 把断头段的残句头切掉，返回修好的正文与修了几处
 *
 * 幂等：修完再修一次 `repaired === 0` 且正文不变。段落之间的空行结构保持原样，
 * 结果整体 `trim()`（空段（切完什么都不剩）连同它前面多出来的空行一起拿掉）。
 */
export function repairProseHeads(markdown: string): { markdown: string; repaired: number } {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let repaired = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.trim() !== "") j += 1;
    const para = lines.slice(i, j);
    const text = para.join("\n").trim();
    if (isNonProse(para[0]!) || !hasBrokenHead(text)) {
      out.push(...para);
      i = j;
      continue;
    }
    const fixed = repairHead(text);
    repaired += 1;
    if (fixed === null) {
      // 整段丢了：顺手收掉前面那一行空行，两段之间仍是一个空行
      if (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    } else {
      out.push(fixed);
    }
    i = j;
  }
  return { markdown: out.join("\n").trim(), repaired };
}

/** 按空行分段（每段是若干非空行；空行不算段） */
function paragraphsOf(markdown: string): string[][] {
  const lines = markdown.split("\n");
  const out: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.trim() !== "") j += 1;
    out.push(lines.slice(i, j));
    i = j;
  }
  return out;
}
