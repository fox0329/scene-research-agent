/**
 * @scene/infra — PPT 页面渲染（变更表 #141）
 *
 * 把 `@scene/domain` 校验过的大纲**确定性地**画成 1280×720 的 SVG（默认用 ppt-master 技能里
 * `bilibili-blue` 模版的设计语言：深蓝主色 + 浅蓝点缀 + 极浅蓝底 + 白卡片）。
 * 模型只产内容，**绝不让模型写 SVG**（渲染进不了判定路径，也让版式对每一页都一致）。
 *
 * 硬约束（ppt-master 的原生导出模式对这些很敏感）：
 *  - 画布 1280×720（`-f ppt169`）；字体只用 `Arial, "Microsoft YaHei", sans-serif`（无网络字体）；
 *  - **不用** `dominant-baseline`（PPT 里对不齐）、**不用** `<foreignObject>`、**不用** `@font-face`；
 *  - 所有文本 XML 转义；每个成组的块带 `<g id="...">`（导出的动画按 id 分组）；
 *  - 文字按估算宽度换行，画布边界不溢出（`estimateTextWidth` 与渲染共用同一把尺）。
 *
 * 只有内容页：`pages[0]` 就是第一张（用户定调：不要封面、不要尾页）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PptCard, PptColumn, PptLayout, PptOutline, PptPage, PptTable } from "@scene/contract";

// ─── 画布与配色（bilibili-blue 令牌，集中在这里，渲染函数不写死颜色） ──

/** 画布尺寸（ppt169 格式，与 ppt-master 的 `-f ppt169` 对齐） */
export const PPT_CANVAS = { width: 1280, height: 720 } as const;

/** 字体：模版原文照抄（不用网络字体、不注册 @font-face） */
export const PPT_FONT = 'Arial, "Microsoft YaHei", sans-serif';

/** 属性里的字体（引号要转义） */
const FONT_ATTR = "Arial, &quot;Microsoft YaHei&quot;, sans-serif";

/** 令牌（取自技能里 `templates/decks/bilibili-blue/01_cover.svg`） */
export const PPT_COLORS = {
  /** 主色深蓝（页眉标题、主色条、表头） */
  primary: "#0D47A1",
  /** 封面渐变的另一端（内容页做次级深蓝） */
  primaryAlt: "#1565C0",
  /** 浅蓝点缀（页序标签、底纹、强调线） */
  accent: "#90CAF9",
  /** 正文深灰 */
  text: "#37474F",
  /** 内容页底色（极浅蓝） */
  bg: "#F5F8FC",
  /** 卡片白 */
  card: "#FFFFFF",
  /** 淡蓝描边 */
  border: "#BBDEFB",
  /** 主色上的字 */
  onPrimary: "#FFFFFF",
} as const;

// ─── 版面几何（4px 网格） ──────────────────────────────────

const PAD = 64;
/** 内容宽（左右各留 64） */
const CONTENT_W = PPT_CANVAS.width - PAD * 2;
const HEADER = {
  titleY: 76,
  titleSize: 38,
  tagY: 70,
  tagSize: 19,
  barX: PAD,
  barY: 106,
  barW: 4,
  barH: 30,
  takeawayX: PAD + 20,
  takeawayY: 130,
  takeawaySize: 21,
} as const;
/** 正文区（上下界之间排内容） */
const BODY = { top: 176, bottom: 604 } as const;
/** 底部三条极淡波纹（照 01_cover.svg 的写法，描边换成本页主色才看得见） */
const WAVES = [628, 644, 660] as const;
const FOOTER = { x: PAD, y: 700, size: 14 } as const;

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
 * 估算一段文本的像素宽（渲染换行与「不溢出画布」的粗判**共用同一把尺**）
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

/** 一个 `<text>`（不写 dominant-baseline：PPT 导出对不齐） */
function textEl(o: TextOpts): string {
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
  rx?: number;
}): string {
  const stroke = o.stroke ? ` stroke="${o.stroke}" stroke-width="1"` : "";
  return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.rx ?? 8}" fill="${o.fill}"${stroke}/>`;
}

/** 页眉：左上标题（主色 bold）+ 右上页序标签（浅蓝） */
function header(page: PptPage, index: number, total: number): string {
  const titleLines = wrapText(page.title, HEADER.titleSize, CONTENT_W - 260, 1);
  return [
    `<g id="hd">`,
    rect({ x: 0, y: 0, w: PPT_CANVAS.width, h: 6, fill: PPT_COLORS.primary, rx: 0 }),
    textEl({
      x: PAD,
      y: HEADER.titleY,
      size: HEADER.titleSize,
      fill: PPT_COLORS.primary,
      text: titleLines[0]!,
      weight: true,
    }),
    textEl({
      x: PPT_CANVAS.width - PAD,
      y: HEADER.tagY,
      size: HEADER.tagSize,
      fill: PPT_COLORS.accent,
      text: `第 ${index + 1} 页 / 共 ${total} 页`,
      anchor: "end",
    }),
    `</g>`,
  ].join("");
}

/** 标题下一行：一句话要点（左侧 4px 浅蓝竖条） */
function takeawayLine(page: PptPage): string {
  const lines = wrapText(page.takeaway, HEADER.takeawaySize, CONTENT_W - 40, 1);
  return [
    `<g id="takeaway">`,
    rect({
      x: HEADER.barX,
      y: HEADER.barY,
      w: HEADER.barW,
      h: HEADER.barH,
      fill: PPT_COLORS.accent,
      rx: 2,
    }),
    textEl({
      x: HEADER.takeawayX,
      y: HEADER.takeawayY,
      size: HEADER.takeawaySize,
      fill: PPT_COLORS.text,
      text: lines[0]!,
    }),
    `</g>`,
  ].join("");
}

/** 底板 + 三条极淡波纹 + 左下角「场景通 · <场景名>」 */
function footer(scenarioName: string): string {
  const waves = WAVES.map(
    (y, i) =>
      `<path d="M 0 ${y} C 106.67 ${y - 20} 213.33 ${y - 20} 320 ${y} C 426.67 ${y + 20} 533.33 ${y + 20} 640 ${y} C 746.67 ${y - 20} 853.33 ${y - 20} 960 ${y} C 1066.67 ${y + 20} 1173.33 ${y + 20} 1280 ${y}" fill="none" stroke="${PPT_COLORS.primary}" stroke-width="1.5" stroke-opacity="${[0.15, 0.1, 0.06][i]}"/>`,
  ).join("");
  return [
    `<g id="deco">${waves}</g>`,
    textBlock({
      id: "footer",
      x: FOOTER.x,
      y: FOOTER.y,
      size: FOOTER.size,
      fill: PPT_COLORS.accent,
      lines: [`场景通 · ${scenarioName}`],
      lineHeight: FOOTER.size + 2,
    }),
  ].join("");
}

// ─── 五种布局 ──────────────────────────────────────────────

/** 要点：白卡片 + 左侧浅蓝竖条，一行一条 */
function renderBullets(page: PptPage): string {
  const rows = page.bullets.slice(0, 5);
  const gap = 12;
  const rowH = Math.min(72, Math.floor((BODY.bottom - BODY.top - gap * (rows.length - 1)) / rows.length));
  return rows
    .map((bullet, i) => {
      const y = BODY.top + i * (rowH + gap);
      const size = 22;
      const lines = wrapText(bullet, size, CONTENT_W - 96, 2);
      return [
        `<g id="bullet-${i + 1}">`,
        rect({ x: PAD, y, w: CONTENT_W, h: rowH, fill: PPT_COLORS.card, stroke: PPT_COLORS.border }),
        rect({ x: PAD + 16, y: y + 16, w: 4, h: rowH - 32, fill: PPT_COLORS.accent, rx: 2 }),
        textBlock({
          id: `bullet-${i + 1}-text`,
          x: PAD + 36,
          y: y + rowH / 2 - (lines.length - 1) * 14 + 8,
          size,
          fill: PPT_COLORS.text,
          lines,
          lineHeight: 28,
        }),
        `</g>`,
      ].join("");
    })
    .join("");
}

/** 一栏（双栏对比的左右栏） */
function renderColumn(col: PptColumn, i: number, x: number, w: number): string {
  const top = BODY.top;
  const h = BODY.bottom - BODY.top;
  const headSize = 24;
  const heads = wrapText(col.head, headSize, w - 48, 1);
  const lines = col.bullets.slice(0, 3);
  const body = lines
    .map((b, j) => {
      const wrapped = wrapText(b, 20, w - 80, 2);
      const y = top + 112 + j * 76;
      return [
        rect({ x: x + 28, y: y - 7, w: 8, h: 8, fill: PPT_COLORS.accent, rx: 4 }),
        textBlock({
          id: `col-${i + 1}-item-${j + 1}`,
          x: x + 52,
          y: y + 8,
          size: 20,
          fill: PPT_COLORS.text,
          lines: wrapped,
          lineHeight: 26,
        }),
      ].join("");
    })
    .join("");
  return [
    `<g id="col-${i + 1}">`,
    rect({ x, y: top, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border }),
    rect({ x, y: top, w, h: 64, fill: i === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt, rx: 8 }),
    textEl({
      x: x + 24,
      y: top + 42,
      size: headSize,
      fill: PPT_COLORS.onPrimary,
      text: heads[0]!,
      weight: true,
    }),
    body,
    `</g>`,
  ].join("");
}

/** 双栏对比：两栏并排 */
function renderColumns(page: PptPage): string {
  const cols = page.columns.slice(0, 2);
  const gap = 24;
  const w = Math.floor((CONTENT_W - gap) / 2);
  return cols.map((col, i) => renderColumn(col, i, PAD + i * (w + gap), w)).join("");
}

/** 一张数据卡片 */
function renderCard(card: PptCard, i: number, x: number, w: number): string {
  const top = BODY.top + 24;
  const h = BODY.bottom - BODY.top - 48;
  const valueSize = 40;
  const valueLines = wrapText(card.value, valueSize, w - 48, 2);
  const labelLines = wrapText(card.label, 21, w - 48, 2);
  return [
    `<g id="card-${i + 1}">`,
    rect({ x, y: top, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border }),
    rect({ x, y: top, w, h: 6, fill: i % 2 === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt, rx: 3 }),
    textBlock({
      id: `card-${i + 1}-value`,
      x: x + w / 2,
      y: top + h / 2 - (valueLines.length - 1) * 24,
      size: valueSize,
      fill: PPT_COLORS.primary,
      lines: valueLines,
      lineHeight: 48,
      weight: true,
      anchor: "middle",
    }),
    textBlock({
      id: `card-${i + 1}-label`,
      x: x + w / 2,
      y: top + h / 2 + 56,
      size: 21,
      fill: PPT_COLORS.text,
      lines: labelLines,
      lineHeight: 28,
      anchor: "middle",
    }),
    `</g>`,
  ].join("");
}

/** 数据卡片：3–4 张一行 */
function renderCards(page: PptPage): string {
  const cards = page.cards.slice(0, 4);
  const gap = 24;
  const w = Math.floor((CONTENT_W - gap * (cards.length - 1)) / cards.length);
  return cards.map((card, i) => renderCard(card, i, PAD + i * (w + gap), w)).join("");
}

/** 图文说明右侧的示意图（确定性画出来的层叠结构，不依赖任何图片资源） */
function figurePanel(x: number, w: number): string {
  const top = BODY.top;
  const h = BODY.bottom - BODY.top;
  const bars = [0, 1, 2, 3]
    .map((i) => {
      const bw = w - 96 - i * 36;
      const y = top + 56 + i * 72;
      return rect({
        x: x + 48 + i * 18,
        y,
        w: bw,
        h: 44,
        fill: i % 2 === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt,
        rx: 6,
      });
    })
    .join("");
  return [
    `<g id="figure">`,
    rect({ x, y: top, w, h, fill: PPT_COLORS.card, stroke: PPT_COLORS.border }),
    `<line x1="${x + 48}" y1="${top + 40}" x2="${x + 48}" y2="${top + h - 40}" stroke="${PPT_COLORS.accent}" stroke-width="2" stroke-opacity="0.6"/>`,
    bars,
    `</g>`,
  ].join("");
}

/** 图文说明：左边要点、右边示意图 */
function renderFigure(page: PptPage): string {
  const panelW = 460;
  const textW = CONTENT_W - panelW - 32;
  const rows = page.bullets
    .slice(0, 5)
    .map((b, i) => {
      const y = BODY.top + i * 78;
      const lines = wrapText(b, 21, textW - 40, 2);
      return [
        `<g id="figure-item-${i + 1}">`,
        rect({ x: PAD, y, w: textW, h: 70, fill: PPT_COLORS.card, stroke: PPT_COLORS.border }),
        rect({ x: PAD + 14, y: y + 16, w: 4, h: 38, fill: PPT_COLORS.accent, rx: 2 }),
        textBlock({
          id: `figure-item-${i + 1}-text`,
          x: PAD + 32,
          y: y + 36,
          size: 21,
          fill: PPT_COLORS.text,
          lines,
          lineHeight: 26,
        }),
        `</g>`,
      ].join("");
    })
    .join("");
  return rows + figurePanel(PAD + textW + 32, panelW);
}

/** 表格的列宽（按各列最长内容比例分配，再拉满内容宽） */
function columnWidths(table: PptTable): number[] {
  const sizes = table.head.map((h, i) => {
    const cells = table.rows.map((r) => r[i] ?? "");
    const widest = Math.max(estimateTextWidth(h, 20), ...cells.map((c) => estimateTextWidth(c, 20)));
    return Math.max(widest, 60);
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const widths = sizes.map((s) => Math.floor((s / total) * CONTENT_W));
  widths[widths.length - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  return widths;
}

/** 表格：主色表头 + 交替底色的数据行 */
function renderTable(table: PptTable): string {
  const widths = columnWidths(table);
  const rowH = Math.min(64, Math.floor((BODY.bottom - BODY.top) / (table.rows.length + 1)));
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
        y: BODY.top + rowH / 2 + 7,
        size: 20,
        fill: PPT_COLORS.onPrimary,
        text: wrapText(h, 20, widths[i]! - 32, 1)[0]!,
        weight: true,
      }),
    )
    .join("");
  const rows = table.rows
    .map((row, r) => {
      const y = BODY.top + rowH * (r + 1);
      const fill = r % 2 === 0 ? PPT_COLORS.card : PPT_COLORS.bg;
      const cells = row
        .map((cell, i) =>
          textEl({
            x: xs[i]! + 16,
            y: y + rowH / 2 + 7,
            size: 20,
            fill: PPT_COLORS.text,
            text: wrapText(cell, 20, widths[i]! - 32, 1)[0]!,
          }),
        )
        .join("");
      return `<g id="row-${r + 1}">${rect({ x: PAD, y, w: CONTENT_W, h: rowH, fill, rx: 0, stroke: PPT_COLORS.border })}${cells}</g>`;
    })
    .join("");
  return [
    `<g id="table">`,
    rect({ x: PAD, y: BODY.top, w: CONTENT_W, h: rowH, fill: PPT_COLORS.primary, rx: 0 }),
    headCells,
    rows,
    `</g>`,
  ].join("");
}

/** 布局 → 渲染函数（五种布局各一个） */
export const PPT_LAYOUT_RENDERERS: Record<PptLayout, (page: PptPage) => string> = {
  要点: renderBullets,
  双栏对比: renderColumns,
  数据卡片: renderCards,
  图文说明: renderFigure,
  表格: (page) => (page.table ? renderTable(page.table) : ""),
};

// ─── 组装与落盘 ────────────────────────────────────────────

export interface PptRenderContext {
  index: number;
  total: number;
  scenarioName: string;
}

/** 一页 → 一个完整 SVG 字符串 */
export function renderPptPage(page: PptPage, ctx: PptRenderContext): string {
  const body = PPT_LAYOUT_RENDERERS[page.layout](page);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${PPT_CANVAS.width}" height="${PPT_CANVAS.height}" viewBox="0 0 ${PPT_CANVAS.width} ${PPT_CANVAS.height}">`,
    rect({ x: 0, y: 0, w: PPT_CANVAS.width, h: PPT_CANVAS.height, fill: PPT_COLORS.bg, rx: 0 }),
    header(page, ctx.index, ctx.total),
    takeawayLine(page),
    `<g id="body">${body}</g>`,
    footer(ctx.scenarioName),
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
