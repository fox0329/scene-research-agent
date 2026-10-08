/**
 * @scene/infra — PPT 页面渲染（变更表 #141 立、#142 升：白底 + 高密度密排）
 *
 * 把 `@scene/domain` 校验过的大纲**确定性地**画成 1280×720 的 SVG。
 * 模型只产内容，**绝不让模型写 SVG**（渲染进不了判定路径，也让版式对每一页都一致）。
 *
 * 版式口径（变更表 #142，照用户那份高分稿的结构语法，但**底色改纯白**）：
 *  - 统一骨架：小节标签胶囊 → 34px 大标题 → 18px 副题 → 内容区（y=170..620）
 *    → 底部结论带（#E3F2FD + 4px 橙条）→ 右上页码 → 左下页脚；
 *  - 七种布局：网格要点（2×2） / 双栏对比 / 流程阶段 / 分层架构 / 数据卡片 / 表格 / 要点清单；
 *  - 密排靠浅蓝卡片与色块建立层次（白底不再是"一片白"），每页 22 个以上形状、12 条以上文字。
 *
 * 硬约束（ppt-master 的原生导出模式对这些很敏感）：
 *  - 画布 1280×720（`-f ppt169`）；字体只用 `Arial, "Microsoft YaHei", sans-serif`（无网络字体）；
 *  - **不用** `dominant-baseline`（PPT 里对不齐）、**不用** `<foreignObject>`、**不用** `@font-face`；
 *  - 所有文本 XML 转义；每个成组的块带 `<g id="...">`（导出的动画按 id 分组）；
 *  - 文字按估算宽度换行，画布与容器边界不溢出、**同一页任意两块文字不相交**
 *    （`estimateTextWidth` 与渲染、质量门禁共用同一把尺）。
 *
 * 只有内容页：`pages[0]` 就是第一张（用户定调：不要封面、不要尾页）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PPT_LIMITS,
  type PptBlock,
  type PptCard,
  type PptColumn,
  type PptLayer,
  type PptLayout,
  type PptOutline,
  type PptPage,
  type PptStage,
  type PptTable,
} from "@scene/contract";

// ─── 画布与配色（令牌集中在这里，渲染函数不写死颜色） ────────

/** 画布尺寸（ppt169 格式，与 ppt-master 的 `-f ppt169` 对齐） */
export const PPT_CANVAS = { width: 1280, height: 720 } as const;

/** 字体：中文优先微软雅黑，缺了回落 Arial / sans-serif（不用网络字体、不注册 @font-face） */
export const PPT_FONT = 'Arial, "Microsoft YaHei", sans-serif';

/** 术语 / 代码行可用的等宽字体（属性里用，引号已转义） */
export const PPT_FONT_MONO = 'Consolas, monospace';

/** 属性里的字体（引号要转义） */
const FONT_ATTR = "Arial, &quot;Microsoft YaHei&quot;, sans-serif";

/** 令牌（变更表 #142：白底 + 浅蓝层次，照用户参考稿的配色） */
export const PPT_COLORS = {
  /** 主色深蓝（大标题、块头、表头、卡片数值） */
  primary: "#0D47A1",
  /** 次级深蓝（右栏头、标签文字、层头） */
  primaryAlt: "#1565C0",
  /** 浅蓝点缀（块左侧竖条、行前小方块、箭头、页码） */
  accent: "#90CAF9",
  /** 极浅蓝（胶囊、结论带、组件标签、层底衬） */
  lightBlue: "#E3F2FD",
  /** 条纹底（表格奇数行、层带底） */
  subtle: "#F7FAFE",
  /** 正文深灰蓝（内容行） */
  text: "#37474F",
  /** 正文灰蓝（副题、小注、卡片说明） */
  muted: "#5A7395",
  /** 重点橙（结论带竖条、卡片下划线） */
  orange: "#FF9800",
  /** 通过绿（备用：状态类标记） */
  green: "#4CAF50",
  /** 页面底色（用户明确要求纯白） */
  bg: "#FFFFFF",
  /** 卡片白 */
  card: "#FFFFFF",
  /** 卡片 / 块描边（极浅蓝） */
  border: "#E3F2FD",
  /** 主色上的字 */
  onPrimary: "#FFFFFF",
} as const;

// ─── 版面几何（4px 网格；坐标即口径，改这里就是改版式） ──────

const PAD = 80;
/** 内容宽（左右各留 80） */
const CONTENT_W = PPT_CANVAS.width - PAD * 2;
/** 页码右缘 */
const RIGHT = PAD + CONTENT_W;

/** 页眉三联：小节标签胶囊 / 大标题 / 副题 */
const HEAD = {
  kickerY: 36,
  kickerH: 30,
  kickerPadX: 16,
  kickerSize: 15,
  titleX: PAD,
  // 口径是 88；34px 中文的字面上缘≈基线−30，压在胶囊底（66）上，故下移到 98（留 2px）
  titleY: 98,
  titleSize: 34,
  titleMaxW: 900,
  subtitleX: PAD,
  subtitleY: 132,
  subtitleSize: 18,
} as const;

/** 技术/能力标签（贴右、与副题同一行） */
const CHIP = {
  y: 113,
  h: 26,
  rx: 13,
  size: 15,
  padX: 12,
  gap: 8,
  /** 保副题至少这么宽，不然从右往左丢标签 */
  minSubtitleW: 360,
  /** 副题与标签之间的安全间距 */
  minGap: 24,
} as const;

/** 底部结论带 */
const BAND = {
  x: PAD,
  y: 634,
  w: CONTENT_W,
  h: 50,
  rx: 10,
  barX: PAD + 10,
  barY: 644,
  barW: 4,
  barH: 30,
  textX: PAD + 30,
  textY: 666,
  textSize: 19,
} as const;

/** 右上页码 / 左下页脚 */
const PAGE_NO = { x: RIGHT, y: 56, size: 15 } as const;
const FOOT = { x: PAD, y: 700, size: 13 } as const;

/** 内容区（各布局都排在这条带里） */
const BODY = { top: 170, bottom: 620, h: 450 } as const;

/** 网格要点：2×2，块 550×216 */
const GRID = { w: 550, h: 216, xs: [PAD, PAD + 570], ys: [170, 400] } as const;

/** 双栏对比：左右各 550×450，栏头 52 */
const COLS = { w: 550, h: 450, xs: [PAD, PAD + 570], y: 170, headH: 52 } as const;

/** 流程阶段：等分横排 + 右向箭头 */
const STAGE = { y: 200, h: 270, gap: 28 } as const;

/** 分层架构：横条 72 高，自下而上堆叠 */
const LAYER = { x: PAD, w: CONTENT_W, h: 72, gap: 20 } as const;

/** 数据卡片：等分，300 高 */
const CARD = { y: 200, h: 300, gap: 24 } as const;

/** 表格：表头 52、行 56 */
const TABLE = { headH: 52, rowH: 56 } as const;

/** 要点清单：一行 64 高 + 12 间距 */
const LIST = { rowH: 64, gap: 12 } as const;

/** 内容行：方块 6×6、行距 30（网格）/ 32（双栏） */
const ROW_DOT = { size: 6, gap: 18 } as const;

// ─── 文本量尺与转义 ────────────────────────────────────────

/** XML 转义（`&` 必须最先换） */
export function escXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 全角字符（CJK / 全角标点）：按 1em 计宽 */
const FULL_WIDTH = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/;

/**
 * 估算一段文本的像素宽（渲染换行、不溢出画布、不相交判定**共用同一把尺**）
 *
 * SVG 里没有自动换行，所以宽度必须自己算：全角 1em、半角 0.52em。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += FULL_WIDTH.test(ch) ? 1 : 0.52;
  return em * fontSize;
}

/** 把一行文字裁到宽度以内（保留末尾的省略号） */
function shrinkToFit(text: string, fontSize: number, maxWidth: number): string {
  const chars = Array.from(text);
  while (chars.length > 1 && estimateTextWidth(chars.join(""), fontSize) > maxWidth) {
    chars.splice(chars.length - 2, 1);
  }
  return chars.join("");
}

/** 按像素宽换行（最多 maxLines 行，排不下就以省略号收尾） */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  let consumed = 0;
  for (const ch of chars) {
    if (lines.length >= maxLines) break;
    const next = current + ch;
    if (current !== "" && estimateTextWidth(next, fontSize) > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
    consumed += 1;
  }
  if (lines.length < maxLines && current !== "") lines.push(current);
  if (consumed < chars.length && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = shrinkToFit(`${lines[last]}…`, fontSize, maxWidth);
  }
  return lines.length === 0 ? [""] : lines;
}

// ─── SVG 片段 ──────────────────────────────────────────────

interface TextOpts {
  x: number;
  y: number;
  size: number;
  fill: string;
  text: string;
  weight?: boolean;
  anchor?: "middle" | "end";
}

/** 一个 `<text>`（不写 dominant-baseline：PPT 导出对不齐；空串不产元素） */
function textEl(o: TextOpts): string {
  if (o.text === "") return "";
  const weight = o.weight ? ' font-weight="bold"' : "";
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : "";
  return `<text x="${o.x}" y="${o.y}" font-family="${FONT_ATTR}" font-size="${o.size}" fill="${o.fill}"${weight}${anchor}>${escXml(o.text)}</text>`;
}

interface BlockOpts {
  id: string;
  x: number;
  y: number;
  size: number;
  fill: string;
  lines: readonly string[];
  lineHeight: number;
  weight?: boolean;
  anchor?: "middle" | "end";
}

/** 多行文本块（带 `<g id>`，导出的动画会按 id 分组） */
function textBlock(o: BlockOpts): string {
  const lines = o.lines
    .map((line, i) =>
      textEl({
        x: o.x,
        y: o.y + i * o.lineHeight,
        size: o.size,
        fill: o.fill,
        text: line,
        ...(o.weight ? { weight: true } : {}),
        ...(o.anchor ? { anchor: o.anchor } : {}),
      }),
    )
    .join("");
  if (lines === "") return "";
  return `<g id="${escXml(o.id)}">${lines}</g>`;
}

/** 圆角矩形 */
function rect(o: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  rx?: number;
}): string {
  const stroke = o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.strokeWidth ?? 1}"` : "";
  return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.rx ?? 8}" fill="${o.fill}"${stroke}/>`;
}

/** 一条直线（表格分隔、卡片下划线） */
function line(o: { x1: number; y1: number; x2: number; y2: number; stroke: string; width?: number }): string {
  return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="${o.stroke}" stroke-width="${o.width ?? 1}"/>`;
}

/** 圆点（流程阶段序号） */
function circle(o: { cx: number; cy: number; r: number; fill: string }): string {
  return `<circle cx="${o.cx}" cy="${o.cy}" r="${o.r}" fill="${o.fill}"/>`;
}

/** 右向箭头（流程阶段之间的连接件） */
function arrow(o: { x: number; y: number; w: number; h: number; fill: string }): string {
  const mid = o.y + o.h / 2;
  return `<polygon points="${o.x},${o.y} ${o.x + o.w},${mid} ${o.x},${o.y + o.h}" fill="${o.fill}"/>`;
}

/** 内容行前的小方块 */
function rowDot(x: number, baseline: number): string {
  return rect({
    x,
    y: baseline - ROW_DOT.size - 3,
    w: ROW_DOT.size,
    h: ROW_DOT.size,
    fill: PPT_COLORS.accent,
    rx: 1,
  });
}

// ─── 行排布：容器内不出界、不压字 ──────────────────────────

interface PlacedLine {
  /** 这一条要画的若干行（≤2 行） */
  lines: string[];
  /** 首行基线 */
  y: number;
}

/**
 * 把若干条内容行放进一个竖直容器里
 *
 * 每条最多两行；容器放不下时把它压成一行（带省略号），**不裁字、不出界**。
 * 返回的每项都带首行基线，调用方据此画行前小方块。
 */
function placeLines(
  texts: readonly string[],
  o: { top: number; bottom: number; rowH: number; size: number; maxW: number },
): PlacedLine[] {
  const out: PlacedLine[] = [];
  let cursor = o.top;
  for (const text of texts) {
    const capacity = Math.floor((o.bottom - cursor) / o.rowH) + 1;
    if (capacity <= 0) break;
    if (text === "") continue;
    const wrapped = wrapText(text, o.size, o.maxW, Math.min(2, capacity));
    out.push({ lines: wrapped, y: cursor });
    cursor += wrapped.length * o.rowH;
  }
  return out;
}

/** 一组内容行（行前小方块 + 正文），块 id 前缀由调用方给 */
function contentLines(prefix: string, placed: readonly PlacedLine[], o: {
  x: number;
  size: number;
  fill: string;
  rowH: number;
}): string {
  return placed
    .map((p, i) => {
      const dots = p.lines.map((_, j) => rowDot(o.x - ROW_DOT.gap, p.y + j * o.rowH)).join("");
      return [
        `<g id="${escXml(`${prefix}-${i + 1}`)}">`,
        dots,
        textBlock({
          id: `${prefix}-${i + 1}-text`,
          x: o.x,
          y: p.y,
          size: o.size,
          fill: o.fill,
          lines: p.lines,
          lineHeight: o.rowH,
        }),
        `</g>`,
      ].join("");
    })
    .join("");
}

// ─── 统一骨架 ──────────────────────────────────────────────

/** 小节标签：左上浅蓝胶囊（宽度按字数算） */
function kickerEl(text: string): string {
  const w = estimateTextWidth(text, HEAD.kickerSize) + HEAD.kickerPadX * 2;
  return [
    `<g id="kicker">`,
    rect({
      x: PAD,
      y: HEAD.kickerY,
      w,
      h: HEAD.kickerH,
      fill: PPT_COLORS.lightBlue,
      rx: HEAD.kickerH / 2,
    }),
    textEl({
      x: PAD + HEAD.kickerPadX,
      y: HEAD.kickerY + HEAD.kickerH / 2 + HEAD.kickerSize * 0.35,
      size: HEAD.kickerSize,
      fill: PPT_COLORS.primaryAlt,
      text,
      weight: true,
    }),
    `</g>`,
  ].join("");
}

/** 技术/能力标签（贴右、与副题同一行）；返回标签与副题可用宽 */
function chipsEl(chips: readonly string[]): { svg: string; subtitleMaxW: number } {
  const list = chips.slice(0, PPT_LIMITS.chips.max);
  const widths = list.map((c) => estimateTextWidth(c, CHIP.size) + CHIP.padX * 2);
  const totalOf = (k: number): number =>
    widths.slice(0, k).reduce((a, b) => a + b, 0) + CHIP.gap * Math.max(0, k - 1);
  let n = list.length;
  while (n > 0 && CONTENT_W - totalOf(n) - CHIP.minGap < CHIP.minSubtitleW) n -= 1;
  if (n === 0) return { svg: "", subtitleMaxW: CONTENT_W };
  const total = totalOf(n);
  let x = RIGHT - total;
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = widths[i]!;
    parts.push(
      `<g id="chip-${i + 1}">`,
      rect({ x, y: CHIP.y, w, h: CHIP.h, fill: PPT_COLORS.lightBlue, rx: CHIP.rx }),
      textEl({
        x: x + CHIP.padX,
        y: CHIP.y + CHIP.h / 2 + CHIP.size * 0.35,
        size: CHIP.size,
        fill: PPT_COLORS.primaryAlt,
        text: list[i]!,
      }),
      `</g>`,
    );
    x += w + CHIP.gap;
  }
  return { svg: parts.join(""), subtitleMaxW: CONTENT_W - total - CHIP.minGap };
}

/** 页眉：大标题 + 页码 */
function titleEl(page: PptPage, index: number, total: number): string {
  const title = wrapText(page.title, HEAD.titleSize, HEAD.titleMaxW, 1)[0]!;
  return [
    `<g id="hd">`,
    textEl({
      x: HEAD.titleX,
      y: HEAD.titleY,
      size: HEAD.titleSize,
      fill: PPT_COLORS.primary,
      text: title,
      weight: true,
    }),
    textEl({
      x: PAGE_NO.x,
      y: PAGE_NO.y,
      size: PAGE_NO.size,
      fill: PPT_COLORS.accent,
      text: `第 ${index + 1} 页 / 共 ${total} 页`,
      anchor: "end",
    }),
    `</g>`,
  ].join("");
}

/** 副题（标题下一行） */
function subtitleEl(text: string, maxW: number): string {
  return textBlock({
    id: "subtitle",
    x: HEAD.subtitleX,
    y: HEAD.subtitleY,
    size: HEAD.subtitleSize,
    fill: PPT_COLORS.muted,
    lines: wrapText(text, HEAD.subtitleSize, maxW, 1),
    lineHeight: HEAD.subtitleSize + 6,
  });
}

/** 底部结论带：极浅蓝底 + 左侧 4px 橙条 + 深蓝粗字（每页都有） */
function highlightEl(text: string): string {
  return [
    `<g id="highlight">`,
    rect({ x: BAND.x, y: BAND.y, w: BAND.w, h: BAND.h, fill: PPT_COLORS.lightBlue, rx: BAND.rx }),
    rect({ x: BAND.barX, y: BAND.barY, w: BAND.barW, h: BAND.barH, fill: PPT_COLORS.orange, rx: 2 }),
    textEl({
      x: BAND.textX,
      y: BAND.textY,
      size: BAND.textSize,
      fill: PPT_COLORS.primary,
      text: wrapText(text, BAND.textSize, RIGHT - BAND.textX - 24, 1)[0]!,
      weight: true,
    }),
    `</g>`,
  ].join("");
}

/** 左下页脚「场景通 · <场景名>」 */
function footerEl(scenarioName: string): string {
  return textBlock({
    id: "footer",
    x: FOOT.x,
    y: FOOT.y,
    size: FOOT.size,
    fill: PPT_COLORS.accent,
    lines: wrapText(`场景通 · ${scenarioName}`, FOOT.size, CONTENT_W, 1),
    lineHeight: FOOT.size + 2,
  });
}

// ─── 七种布局 ──────────────────────────────────────────────

/** 页内的内容行（布局缺字段时按旧 `bullets` 兜底，直接构造的页也画得出来） */
function bulletsOf(page: PptPage): string[] {
  return page.bullets ?? [];
}

/** 网格要点：没有 `blocks` 时用旧 `bullets` 折成 1–2 块（兼容 #141 的页） */
function blocksOf(page: PptPage): PptBlock[] {
  if (page.blocks && page.blocks.length > 0) return page.blocks.slice(0, PPT_LIMITS.blocks.count);
  const bullets = bulletsOf(page);
  if (bullets.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < bullets.length && chunks.length < 2; i += PPT_LIMITS.blocks.maxLines) {
    chunks.push(bullets.slice(i, i + PPT_LIMITS.blocks.maxLines));
  }
  return chunks.map((lines, i) => ({ head: i === 0 ? page.title : "", note: "", lines }));
}

/** 一块（网格要点的 2×2 单元） */
function blockEl(block: PptBlock, i: number, x: number, y: number): string {
  const w = GRID.w;
  const h = GRID.h;
  const textX = x + 48;
  const maxW = w - 48 - 18;
  const top = block.note === "" ? y + 70 : y + 88;
  const placed = placeLines(block.lines, {
    top,
    bottom: y + h - 10,
    rowH: 30,
    size: 16,
    maxW,
  });
  return [
    `<g id="block-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x: x + 16, y: y + 18, w: 5, h: h - 36, fill: PPT_COLORS.accent, rx: 2.5 }),
    textEl({ x: textX, y: y + 38, size: 20, fill: PPT_COLORS.primary, text: block.head, weight: true }),
    textEl({ x: textX, y: y + 60, size: 15, fill: PPT_COLORS.muted, text: block.note }),
    contentLines(`block-${i + 1}-line`, placed, {
      x: textX,
      size: 16,
      fill: PPT_COLORS.text,
      rowH: 30,
    }),
    `</g>`,
  ].join("");
}

/** 网格要点：2×2 四块（块头 + 小注 + 内容行） */
function renderGrid(page: PptPage): string {
  const blocks = blocksOf(page);
  return blocks
    .slice(0, PPT_LIMITS.blocks.count)
    .map((block, i) => blockEl(block, i, GRID.xs[i % 2]!, GRID.ys[Math.floor(i / 2)]!))
    .join("");
}

/** 一栏（双栏对比的左右栏，左 #0D47A1 / 右 #1565C0 栏头） */
function columnEl(col: PptColumn, i: number, x: number): string {
  const y = COLS.y;
  const w = COLS.w;
  const h = COLS.h;
  const fill = i === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt;
  const textX = x + 48;
  const placed = placeLines(col.lines, {
    top: col.note === "" ? y + 84 : y + 104,
    bottom: y + h - 16,
    rowH: 32,
    size: 16,
    maxW: w - 48 - 18,
  });
  return [
    `<g id="col-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: COLS.headH, fill, rx: 10 }),
    rect({ x, y: y + COLS.headH - 10, w, h: 10, fill, rx: 0 }),
    textEl({ x: x + 24, y: y + 34, size: 20, fill: PPT_COLORS.onPrimary, text: col.head, weight: true }),
    textEl({ x: x + 24, y: y + 76, size: 15, fill: PPT_COLORS.muted, text: col.note }),
    contentLines(`col-${i + 1}-line`, placed, {
      x: textX,
      size: 16,
      fill: PPT_COLORS.text,
      rowH: 32,
    }),
    `</g>`,
  ].join("");
}

/** 双栏对比：两栏并排 */
function renderColumns(page: PptPage): string {
  return page.columns
    .slice(0, PPT_LIMITS.columns.count)
    .map((col, i) => columnEl(col, i, COLS.xs[i]!))
    .join("");
}

/** 一个阶段（序号圆点 + 阶段名 + 说明，右侧接箭头） */
function stageEl(stage: PptStage, i: number, n: number, x: number, w: number): string {
  const y = STAGE.y;
  const h = STAGE.h;
  const cx = x + w / 2;
  const maxW = w - 32;
  const heads = wrapText(stage.head, 18, maxW, 2);
  const notes = wrapText(stage.note, 15, maxW, 2);
  const noteY = y + 124 + (heads.length - 1) * 24 + 30;
  return [
    `<g id="stage-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.lightBlue, rx: 10 }),
    i < n - 1 ? arrow({ x: x + w, y: y + h / 2 - 16, w: STAGE.gap - 6, h: 32, fill: PPT_COLORS.accent }) : "",
    circle({ cx, cy: y + 58, r: 20, fill: PPT_COLORS.primary }),
    textEl({
      x: cx,
      y: y + 58 + 18 * 0.35,
      size: 18,
      fill: PPT_COLORS.onPrimary,
      text: String(i + 1),
      weight: true,
      anchor: "middle",
    }),
    textBlock({
      id: `stage-${i + 1}-head`,
      x: cx,
      y: y + 124,
      size: 18,
      fill: PPT_COLORS.primary,
      lines: heads,
      lineHeight: 24,
      weight: true,
      anchor: "middle",
    }),
    textBlock({
      id: `stage-${i + 1}-note`,
      x: cx,
      y: noteY,
      size: 15,
      fill: PPT_COLORS.muted,
      lines: notes,
      lineHeight: 22,
      anchor: "middle",
    }),
    `</g>`,
  ].join("");
}

/** 流程阶段：3–5 个等分横排（浅蓝箭头底 + 主色序号圆点） */
function renderStages(page: PptPage): string {
  const stages = page.stages.slice(0, PPT_LIMITS.stages.max);
  const n = stages.length;
  if (n === 0) return "";
  const gap = STAGE.gap;
  const w = Math.floor((CONTENT_W - gap * (n - 1)) / n);
  return stages.map((stage, i) => stageEl(stage, i, n, PAD + i * (w + gap), w)).join("");
}

const LAYER_BARS = [PPT_COLORS.primary, PPT_COLORS.primaryAlt, PPT_COLORS.accent, PPT_COLORS.orange] as const;

/** 一层（层名 + 组件胶囊标签） */
function layerEl(layer: PptLayer, i: number, y: number): string {
  const bar = LAYER_BARS[i % LAYER_BARS.length]!;
  const headX = LAYER.x + 37;
  const headW = estimateTextWidth(layer.head, 18);
  const parts: string[] = [];
  let x = headX + headW + 16;
  for (const [j, item] of layer.items.slice(0, PPT_LIMITS.layers.maxItems).entries()) {
    const w = estimateTextWidth(item, 15) + 24;
    if (x + w > LAYER.x + LAYER.w - 16) break; // 放不下就从右往左少画一个（内容不丢，只是不上这一页的这层）
    parts.push(
      `<g id="layer-${i + 1}-item-${j + 1}">`,
      rect({ x, y: y + 22, w, h: 28, fill: PPT_COLORS.lightBlue, rx: 14 }),
      textEl({
        x: x + 12,
        y: y + 22 + 14 + 15 * 0.35,
        size: 15,
        fill: PPT_COLORS.primaryAlt,
        text: item,
      }),
      `</g>`,
    );
    x += w + 10;
  }
  return [
    `<g id="layer-${i + 1}">`,
    rect({ x: LAYER.x, y, w: LAYER.w, h: LAYER.h, fill: PPT_COLORS.subtle, rx: 10 }),
    rect({ x: headX - 21, y: y + 18, w: 5, h: LAYER.h - 36, fill: bar, rx: 2.5 }),
    textEl({
      x: headX,
      y: y + 42,
      size: 18,
      fill: PPT_COLORS.primary,
      text: layer.head,
      weight: true,
    }),
    parts.join(""),
    `</g>`,
  ].join("");
}

/** 分层架构：3–4 层横条自上而下堆叠（层 1 在最上） */
function renderLayers(page: PptPage): string {
  const layers = page.layers.slice(0, PPT_LIMITS.layers.max);
  const n = layers.length;
  if (n === 0) return "";
  const totalH = n * LAYER.h + (n - 1) * LAYER.gap;
  const top = BODY.top + Math.floor((BODY.h - totalH) / 2);
  return layers.map((layer, i) => layerEl(layer, i, top + i * (LAYER.h + LAYER.gap))).join("");
}

/** 一张数据卡片（顶部主色条 + 大数值 + 说明） */
function cardEl(card: PptCard, i: number, x: number, w: number): string {
  const y = CARD.y;
  const h = CARD.h;
  const values = wrapText(card.value, 34, w - 48, 2);
  const labels = wrapText(card.label, 16, w - 40, 2);
  const cx = x + w / 2;
  return [
    `<g id="card-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: 4, fill: i % 2 === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt, rx: 2 }),
    textBlock({
      id: `card-${i + 1}-value`,
      x: cx,
      y: y + 140 - (values.length - 1) * 20,
      size: 34,
      fill: PPT_COLORS.primary,
      lines: values,
      lineHeight: 40,
      weight: true,
      anchor: "middle",
    }),
    line({ x1: cx - 28, y1: y + 186, x2: cx + 28, y2: y + 186, stroke: PPT_COLORS.orange, width: 3 }),
    textBlock({
      id: `card-${i + 1}-label`,
      x: cx,
      y: y + 230,
      size: 16,
      fill: PPT_COLORS.muted,
      lines: labels,
      lineHeight: 24,
      anchor: "middle",
    }),
    `</g>`,
  ].join("");
}

/** 数据卡片：3–4 张等分（数值 34px 主色居中 + 说明） */
function renderCards(page: PptPage): string {
  const cards = page.cards.slice(0, PPT_LIMITS.cards.max);
  const n = cards.length;
  if (n === 0) return "";
  const gap = CARD.gap;
  const w = Math.floor((CONTENT_W - gap * (n - 1)) / n);
  return cards.map((card, i) => cardEl(card, i, PAD + i * (w + gap), w)).join("");
}

/** 表格各列宽（按内容比例分配，最小 80，最后拉满内容宽） */
function columnWidths(table: PptTable): number[] {
  const sizes = table.head.map((h, i) => {
    const cells = table.rows.map((r) => r[i] ?? "");
    const widest = Math.max(
      estimateTextWidth(h, 16),
      ...cells.map((c) => estimateTextWidth(c, 15)),
      40,
    );
    return Math.max(widest + 32, 80);
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const widths = sizes.map((s) => Math.floor((s / total) * CONTENT_W));
  widths[widths.length - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  return widths;
}

/** 表格：主色表头 + 奇数行浅蓝 / 偶数行白的数据行 */
function renderTable(table: PptTable): string {
  if (table === null) return "";
  const widths = columnWidths(table);
  const xs: number[] = [];
  let acc = PAD;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const headCells = table.head
    .map((h, i) =>
      textEl({
        x: xs[i]! + 16,
        y: BODY.top + TABLE.headH / 2 + 16 * 0.35,
        size: 16,
        fill: PPT_COLORS.onPrimary,
        text: wrapText(h, 16, widths[i]! - 32, 1)[0]!,
        weight: true,
      }),
    )
    .join("");
  const rows = table.rows
    .map((row, r) => {
      const y = BODY.top + TABLE.headH + r * TABLE.rowH;
      const fill = r % 2 === 0 ? PPT_COLORS.subtle : PPT_COLORS.card;
      const cells = row
        .map((cell, i) => {
          const lines = wrapText(cell, 15, widths[i]! - 32, 2);
          return textBlock({
            id: `cell-${r + 1}-${i + 1}`,
            x: xs[i]! + 16,
            y: y + TABLE.rowH / 2 + 15 * 0.35 - (lines.length - 1) * 11,
            size: 15,
            fill: PPT_COLORS.text,
            lines,
            lineHeight: 22,
          });
        })
        .join("");
      return [
        `<g id="row-${r + 1}">`,
        rect({ x: PAD, y, w: CONTENT_W, h: TABLE.rowH, fill, rx: 0 }),
        line({ x1: PAD, y1: y + TABLE.rowH, x2: RIGHT, y2: y + TABLE.rowH, stroke: PPT_COLORS.border }),
        cells,
        `</g>`,
      ].join("");
    })
    .join("");
  return [
    `<g id="table">`,
    rect({ x: PAD, y: BODY.top, w: CONTENT_W, h: TABLE.headH, fill: PPT_COLORS.primary, rx: 0 }),
    headCells,
    rows,
    rect({
      x: PAD,
      y: BODY.top,
      w: CONTENT_W,
      h: TABLE.headH + table.rows.length * TABLE.rowH,
      fill: "none",
      stroke: PPT_COLORS.border,
      rx: 0,
    }),
    `</g>`,
  ].join("");
}

/** 要点清单的行（没有 bullets 时把其它布局的内容摊平兜底） */
function checklistLines(page: PptPage): string[] {
  const bullets = bulletsOf(page);
  if (bullets.length > 0) return bullets.slice(0, PPT_LIMITS.bullets.max);
  const out: string[] = [];
  for (const b of page.blocks ?? []) out.push(b.head === "" ? b.lines.join("、") : `${b.head}：${b.lines.join("、")}`);
  for (const c of page.columns ?? []) out.push(`${c.head}：${c.lines.join("、")}`);
  for (const s of page.stages ?? []) out.push(s.note === "" ? s.head : `${s.head}：${s.note}`);
  for (const l of page.layers ?? []) out.push(`${l.head}：${l.items.join("、")}`);
  for (const c of page.cards ?? []) out.push(c.label === "" ? c.value : `${c.value}：${c.label}`);
  return out.slice(0, PPT_LIMITS.bullets.max);
}

/** 要点清单（兜底布局）：大序号 + 一行大字 */
function renderChecklist(page: PptPage): string {
  const lines = checklistLines(page);
  const n = lines.length;
  if (n === 0) return "";
  const gap = LIST.gap;
  const rowH = Math.min(LIST.rowH, Math.floor((BODY.h - gap * (n - 1)) / n));
  return lines
    .map((text, i) => {
      const y = BODY.top + i * (rowH + gap);
      const boxY = y + (rowH - 44) / 2;
      return [
        `<g id="item-${i + 1}">`,
        rect({ x: PAD, y, w: CONTENT_W, h: rowH, fill: PPT_COLORS.card, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
        rect({ x: PAD + 16, y: boxY, w: 44, h: 44, fill: PPT_COLORS.lightBlue, rx: 10 }),
        textEl({
          x: PAD + 38,
          y: boxY + 22 + 20 * 0.35,
          size: 20,
          fill: PPT_COLORS.primaryAlt,
          text: String(i + 1).padStart(2, "0"),
          weight: true,
          anchor: "middle",
        }),
        textBlock({
          id: `item-${i + 1}-text`,
          x: PAD + 80,
          y: y + rowH / 2 + 20 * 0.35,
          size: 20,
          fill: PPT_COLORS.text,
          lines: wrapText(text, 20, CONTENT_W - 80 - 24, 2),
          lineHeight: 26,
        }),
        `</g>`,
      ].join("");
    })
    .join("");
}

/** 布局 → 渲染函数（七种布局各一个） */
export const PPT_LAYOUT_RENDERERS: Record<PptLayout, (page: PptPage) => string> = {
  网格要点: renderGrid,
  双栏对比: renderColumns,
  流程阶段: renderStages,
  分层架构: renderLayers,
  数据卡片: renderCards,
  表格: (page) => (page.table ? renderTable(page.table) : ""),
  要点清单: renderChecklist,
};

// ─── 组装与落盘 ────────────────────────────────────────────

export interface PptRenderContext {
  index: number;
  total: number;
  scenarioName: string;
}

/** 一页 → 一个完整 SVG 字符串 */
export function renderPptPage(page: PptPage, ctx: PptRenderContext): string {
  const render = PPT_LAYOUT_RENDERERS[page.layout] ?? renderChecklist;
  const chips = chipsEl(page.chips ?? []);
  const subtitle = page.subtitle ?? page.takeaway ?? "";
  const highlight = page.highlight ?? subtitle ?? page.title;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${PPT_CANVAS.width}" height="${PPT_CANVAS.height}" viewBox="0 0 ${PPT_CANVAS.width} ${PPT_CANVAS.height}">`,
    rect({ x: 0, y: 0, w: PPT_CANVAS.width, h: PPT_CANVAS.height, fill: PPT_COLORS.bg, rx: 0 }),
    kickerEl(page.kicker ?? ""),
    titleEl(page, ctx.index, ctx.total),
    subtitleEl(subtitle, chips.subtitleMaxW),
    chips.svg,
    `<g id="body">${render(page)}</g>`,
    highlightEl(highlight),
    footerEl(ctx.scenarioName),
    `</svg>`,
  ].join("");
}

/** 一个 svg_output 页文件 */
export interface PptSvgPage {
  file: string;
  svg: string;
}

/** 一份大纲 → 每页一个 SVG（页面文件按 `NN_page.svg` 命名，只有内容页） */
export function renderPptDeck(
  outline: PptOutline,
  opts: { scenarioName: string; onPage?: (index: number, total: number) => void },
): PptSvgPage[] {
  const total = outline.pages.length;
  return outline.pages.map((page, i) => {
    opts.onPage?.(i, total);
    return {
      file: `${String(i + 1).padStart(2, "0")}_page.svg`,
      svg: renderPptPage(page, { index: i, total, scenarioName: opts.scenarioName }),
    };
  });
}

/** 把页面写进 `<projectDir>/svg_output/`（ppt-master 的原生模式只读这里） */
export function writePptSvgs(projectDir: string, pages: readonly PptSvgPage[]): string {
  const outDir = join(projectDir, "svg_output");
  mkdirSync(outDir, { recursive: true });
  for (const page of pages) writeFileSync(join(outDir, page.file), page.svg, "utf8");
  return outDir;
}
