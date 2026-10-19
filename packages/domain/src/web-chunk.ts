/**
 * web-chunk — 网页正文的确定性切块（变更表 #216）
 *
 * 为什么切块：引用格式是 `文件名:块号`，块号就是"页码"。网页没有打印页，
 * 我们自己切出来的块是**唯一稳定**的定位单位（同一页面在不同窗宽下分页不同，
 * 用 PDF 快照的页码没有语义）。
 *
 * 为什么不用语义分块：语义分块要模型参与，违反 §三.5「判定下沉确定性层」。
 * 这里只按结构切：标题边界 → 空行/段落边界 → 强制切 → 合并过短块。
 *
 * 规则（调研文档 §6.3）：
 *   优先在 `<h1>`–`<h4>` 边界切；其次空行/段落边界；
 *   单块超 1200 字强制切；单块不足 120 字与相邻块合并。
 */

/** 单块上限（字符数） */
export const BLOCK_MAX = 1200;
/** 单块下限：不足就与相邻块合并 */
export const BLOCK_MIN = 120;

/** 一个可定位的块 = 一「页」 */
export interface WebBlock {
  /** 块号，从 1 起，就是引用里的页码 */
  blockNo: number;
  /** 该块所属最近标题（没有则为空） */
  heading: string;
  /** 块正文 */
  text: string;
  /** 在整篇正文中的起止偏移（对齐 Anthropic citations 的语义） */
  charStart: number;
  charEnd: number;
}

/** 标题行识别：`# ` 到 `#### ` 开头的 Markdown 标题 */
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/;

/**
 * 把 Markdown 正文切成块
 *
 * @param markdown - 快照正文（Markdown）
 * @returns 块列表（块号从 1 连续）
 */
export function chunkMarkdown(markdown: string): WebBlock[] {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  if (text.trim() === "") return [];

  // ① 先按标题切成"节"，记录每节的标题
  const sections = splitByHeading(text);

  // ② 每节内按段落切成候选块，过长强制切、过短合并
  const raw: Array<{ heading: string; text: string; charStart: number }> = [];
  for (const sec of sections) {
    for (const piece of splitSection(sec)) {
      raw.push({ heading: sec.heading, text: piece.text, charStart: piece.charStart });
    }
  }

  // ③ 过短的块与相邻块合并（同一节内优先；跨节也能并，但保留前一块的标题）
  const merged = mergeShort(raw);

  // ④ 编号，并丢弃空块
  const out: WebBlock[] = [];
  let no = 1;
  for (const b of merged) {
    const body = b.text.trim();
    if (body === "") continue;
    out.push({
      blockNo: no,
      heading: b.heading,
      text: body,
      charStart: b.charStart,
      charEnd: b.charStart + b.text.length,
    });
    no += 1;
  }
  return out;
}

/** 按标题切节（标题行本身不进正文，作为该节的 heading） */
function splitByHeading(text: string): Array<{ heading: string; text: string; charStart: number }> {
  const lines = text.split("\n");
  const out: Array<{ heading: string; text: string; charStart: number }> = [];
  let heading = "";
  let buf: string[] = [];
  let start = 0;
  let offset = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push({ heading, text: buf.join("\n"), charStart: start });
    buf = [];
  };

  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h && h[2]) {
      flush();
      heading = h[2].trim();
      start = offset + line.length + 1;
    } else {
      if (buf.length === 0) start = offset;
      buf.push(line);
    }
    offset += line.length + 1;
  }
  flush();

  // 开头没有标题的引言部分：heading 为空，保留
  return out;
}

/** 一节内按段落切，超长段落强制切 */
function splitSection(sec: {
  heading: string;
  text: string;
  charStart: number;
}): Array<{ text: string; charStart: number }> {
  const out: Array<{ text: string; charStart: number }> = [];
  const paras = sec.text.split(/\n{2,}/);
  let cursor = sec.charStart;

  for (const p of paras) {
    const piece = p.trim();
    if (piece === "") {
      cursor += p.length + 2;
      continue;
    }
    if (piece.length <= BLOCK_MAX) {
      out.push({ text: piece, charStart: cursor + (p.length - p.trimStart().length) });
    } else {
      // 强制切：优先后标点/句号处断开，避免把句子劈成两半
      let rest = piece;
      let localStart = cursor + (p.length - p.trimStart().length);
      while (rest.length > BLOCK_MAX) {
        const cut = findCutPoint(rest, BLOCK_MAX);
        out.push({ text: rest.slice(0, cut).trim(), charStart: localStart });
        localStart += cut;
        rest = rest.slice(cut).trimStart();
        localStart += 0;
      }
      if (rest.trim() !== "") out.push({ text: rest.trim(), charStart: localStart });
    }
    cursor += p.length + 2;
  }
  return out.filter((x) => x.text.trim() !== "");
}

/** 找强制切点：尽量落在句末标点或换行之后 */
function findCutPoint(s: string, limit: number): number {
  const candidates = ["。", "！", "？", "\n", "；", ".", "!", "?", ";", "，", ","];
  // 从 limit 往前找最近的句末标点，最多回退 30% 的长度
  const floor = Math.floor(limit * 0.7);
  for (let i = limit; i > floor; i--) {
    const ch = s[i - 1];
    if (ch && candidates.includes(ch)) return i;
  }
  return limit;
}

/** 过短的块与相邻块合并 */
function mergeShort(
  blocks: Array<{ heading: string; text: string; charStart: number }>,
): Array<{ heading: string; text: string; charStart: number }> {
  const out: Array<{ heading: string; text: string; charStart: number }> = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const tooShort = b.text.trim().length < BLOCK_MIN;
    // 与上一块同标题 且（当前块过短 或 上一块过短）→ 合并；合并不超上限
    if (
      prev &&
      prev.heading === b.heading &&
      (tooShort || prev.text.trim().length < BLOCK_MIN) &&
      prev.text.length + b.text.length + 1 <= BLOCK_MAX
    ) {
      prev.text = `${prev.text}\n${b.text}`;
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

/**
 * 把块拼回可读正文（从右栏「看原文」展示用）
 *
 * @param blocks - 块列表
 * @param from - 起始块号（含），默认全部
 */
export function blocksToText(blocks: readonly WebBlock[], from = 1): string {
  return blocks
    .filter((b) => b.blockNo >= from)
    .map((b) => (b.heading ? `## ${b.heading}\n\n${b.text}` : b.text))
    .join("\n\n");
}
