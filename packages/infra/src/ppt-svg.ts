/**
 * @scene/infra — PPT 页面渲染（变更表 #141 立、#142 升、#144 升：图标 + 颜色层次 + 字内强调）
 *
 * 把 `@scene/domain` 校验过的大纲**确定性地**画成 1280×720 的 SVG。
 * 模型只产内容，**绝不让模型写 SVG**（渲染进不了判定路径，也让版式对每一页都一致）。
 *
 * 版式口径（变更表 #144，照用户那份高分稿的用量对标，底色仍是纯白）：
 *  - 统一骨架：页顶 8px 渐变主色带 → 小节标签胶囊（左侧 22×22 图标）→ 36px 大标题 + 80×6 橙短横
 *    → 18px 副题 + 右侧技术标签 → 内容区（y=170..620）→ 底部结论带（#E3F2FD + 6px 橙条 + `bulb` 图标）
 *    → 右上 #E3F2FD 页码胶囊 → 左下页脚；
 *  - **图标**：一律内联 `data-icon="tabler-outline/<名字>"` 占位（**渲染层不读技能目录**，
 *    保持渲染确定性）；由导出层在转档前调技能自带的 `finalize_svg.py --only embed-icons fix-rounded`
 *    换成真实图标。每页图标数 ≥4：页图标 + 块/栏/阶段/层/卡片/清单条 + 结论带 `bulb`。
 *  - **颜色层次**：卡底 `#F7FAFE`、卡头 26–34px `#E3F2FD` 横条、左侧 5px 竖条按块轮换
 *    （`#0D47A1`/`#1565C0`/`#42A5F5`/`#FF9800`）并按语气改写（问题橙 / 价值绿）、列间行间 `#D6E7F8` 细分隔线；
 *  - **字内强调**：行首关键词（第一个 `：，、` 之前的 ≤8 字）20px 粗 `#0D47A1` `<tspan>`、
 *    行内第一处数字 22px 粗 `#FF9800` `<tspan>`；非定位 `<tspan>` 在 ppt-master 原生模式里
 *    会保留成同一段落的多个 run（文字仍可编辑），实测见 `docs/PPT输出要求.md` §四。
 *
 * 硬约束（ppt-master 的原生导出模式对这些很敏感）：
 *  - 画布 1280×720（`-f ppt169`）；字体只用 `Arial, "Microsoft YaHei", sans-serif`（无网络字体）；
 *  - **不用** `dominant-baseline`（PPT 里对不齐）、**不用** `<foreignObject>`、**不用** `@font-face`；
 *  - 所有文本 XML 转义；每个成组的块带 `<g id="...">`（导出的动画按 id 分组）；
 *  - 文字按估算宽度换行，画布与容器边界不溢出、**同一页任意两块文字不相交**
 *    （`estimateTextWidth` 与渲染、质量门禁共用同一把尺；强调段按各自字号计宽）。
 *
 * 只有内容页：`pages[0]` 就是第一张（用户定调：不要封面、不要尾页）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PPT_DEFAULT_ICON,
  PPT_ICON_LIB,
  PPT_LIMITS,
  normalizePptIcon,
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

/**
 * 令牌（变更表 #144：色阶补全并真正用起来）
 *
 * 深浅蓝承担"层次"、橙绿承担"重点"：浅蓝底块与深蓝字占大头，橙色做问题与代价、绿色做价值与达标
 * （对标用户参考稿的用量：`#E3F2FD` > `#0D47A1` > `#1565C0` > `#90CAF9` > `#FF9800` > `#FFFFFF` > `#4CAF50`）。
 */
export const PPT_COLORS = {
  /** 主色深蓝（大标题、块头、表头、卡片数值、层头） */
  primary: "#0D47A1",
  /** 次级深蓝（右栏头、标签文字、页码、层头备选） */
  primaryAlt: "#1565C0",
  /** 三档蓝（色阶中层，卡头 / 强调竖条轮换用） */
  blue700: "#1976D2",
  /** 四档蓝（色阶浅层，强调竖条轮换用） */
  blue400: "#42A5F5",
  /** 浅蓝点缀（行前小方块、箭头、阶段卡底） */
  accent: "#90CAF9",
  /** 极浅蓝（胶囊、卡头横条、结论带、组件标签、序号底衬） */
  lightBlue: "#E3F2FD",
  /** 细分隔线（列间 / 行间留白） */
  divider: "#D6E7F8",
  /** 条纹底（块卡、层带、卡片、清单条的填充层次） */
  subtle: "#F7FAFE",
  /** 正文深灰蓝（内容行） */
  text: "#37474F",
  /** 正文灰蓝（副题、小注、卡片说明） */
  muted: "#5A7395",
  /** 问题橙（问题·风险·代价 / 数字强调 / 标题短横） */
  orange: "#FF9800",
  /** 价值绿（价值·收益·达标） */
  green: "#4CAF50",
  /** 页面底色（用户明确要求纯白） */
  bg: "#FFFFFF",
  /** 卡片白（表格偶数行仍用白底） */
  card: "#FFFFFF",
  /** 卡片 / 块描边（极浅蓝） */
  border: "#E3F2FD",
  /** 主色上的字 */
  onPrimary: "#FFFFFF",
} as const;

/**
 * 左侧强调竖条的轮换四色（变更表 #144）
 *
 * **语气优先**：命中问题类关键词 → `#FF9800`；命中价值类 → `#4CAF50`；都不是才按块轮换。
 */
export const PPT_BAR_COLORS = [
  PPT_COLORS.primary,
  PPT_COLORS.primaryAlt,
  PPT_COLORS.blue400,
  PPT_COLORS.orange,
] as const;

/** 问题 / 风险 / 代价类语气（决定竖条用橙） */
export const PPT_TONE_PROBLEM = /问题|痛点|难点|风险|代价|不足|缺失/;

/** 价值 / 收益 / 达标类语气（决定竖条用绿） */
export const PPT_TONE_VALUE = /价值|收益|提升|降低|达标|改善|节省/;

/** 一段文字的语气（决定它所在块的强调色） */
export function pptToneOf(text: string): "problem" | "value" | "neutral" {
  if (PPT_TONE_PROBLEM.test(text)) return "problem";
  if (PPT_TONE_VALUE.test(text)) return "value";
  return "neutral";
}

/** 一块 / 一栏 / 一条的语气色（问题橙、价值绿，其余按序号轮换） */
export function pptBarColor(index: number, text: string): string {
  const tone = pptToneOf(text);
  if (tone === "problem") return PPT_COLORS.orange;
  if (tone === "value") return PPT_COLORS.green;
  return PPT_BAR_COLORS[index % PPT_BAR_COLORS.length]!;
}

// ─── 版面几何（4px 网格；坐标即口径，改这里就是改版式） ──────

const PAD = 80;
/** 内容宽（左右各留 80） */
const CONTENT_W = PPT_CANVAS.width - PAD * 2;
/** 页码右缘 */
const RIGHT = PAD + CONTENT_W;

/** 页顶 8px 通栏渐变主色带（每页一个；`<linearGradient>` 走 ppt-master 的 gradFill） */
const TOP_BAND = { h: 8, id: "pptTopBand" } as const;

/** 页眉：小节标签胶囊（含 22×22 图标）/ 大标题 + 橙短横 / 副题 */
const HEAD = {
  kickerY: 36,
  kickerH: 30,
  kickerIcon: 22,
  kickerIconX: 92,
  kickerTextX: 122,
  kickerSize: 15,
  titleX: PAD,
  // 口径是 88；36px 中文的字面上缘≈基线−31，压在胶囊底（66）上，故下移到 98（留 1px）
  titleY: 98,
  titleSize: 36,
  titleMaxW: 900,
  /** 标题下的橙色圆角短横 */
  titleBarY: 106,
  titleBarW: 80,
  titleBarH: 6,
  subtitleX: PAD,
  subtitleY: 132,
  subtitleSize: 18,
} as const;

/** 右上页码胶囊（#E3F2FD 底） */
const PAGE_NO = { h: 24, rx: 12, padX: 12, size: 15, y: 42 } as const;

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

/** 底部结论带：极浅蓝底 + 6px 橙条 + `bulb` 图标 + 19px 粗深蓝字 */
const BAND = {
  x: PAD,
  y: 634,
  w: CONTENT_W,
  h: 50,
  rx: 10,
  barX: PAD + 10,
  barY: 644,
  barW: 6,
  barH: 30,
  iconSize: 22,
  iconX: PAD + 24,
  iconY: 648,
  textX: PAD + 56,
  textY: 666,
  textSize: 19,
} as const;

/** 每页结论带左侧固定挂 `bulb`（一页一定至少有一个"结论"图标） */
const BAND_ICON = "bulb";

/** 左下页脚 */
const FOOT = { x: PAD, y: 700, size: 13 } as const;

/** 内容区（各布局都排在这条带里） */
const BODY = { top: 170, bottom: 620, h: 450 } as const;

/** 网格要点：2×2，块 550×216；卡头横条 34（装得下 28×28 图标，口径 26） */
const GRID = { w: 550, h: 216, xs: [PAD, PAD + 570], ys: [170, 400], headH: 34 } as const;

/** 双栏对比：左右各 550×450，栏头 52 */
const COLS = { w: 550, h: 450, xs: [PAD, PAD + 570], y: 170, headH: 52, iconSize: 26 } as const;

/** 流程阶段：等分横排 + 右向箭头 */
const STAGE = { y: 200, h: 270, gap: 28, iconSize: 26 } as const;

/** 分层架构：横条 72 高，自上而下堆叠 */
const LAYER = { x: PAD, w: CONTENT_W, h: 72, gap: 20, iconSize: 26 } as const;

/** 数据卡片：等分，300 高 */
const CARD = { y: 200, h: 300, gap: 24, iconSize: 28 } as const;

/** 表格：表头 52、行 56，表头格左侧 14×14 图标 */
const TABLE = { headH: 52, rowH: 56, iconSize: 14, iconGap: 22 } as const;

/** 要点清单：一行 64 高 + 12 间距；图标 22×22 + 44×44 序号底衬 */
const LIST = { rowH: 64, gap: 12, iconSize: 22 } as const;

/** 内容行：方块 6×6、行距 30（网格）/ 32（双栏） */
const ROW_DOT = { size: 6, gap: 18 } as const;

/** 列间 / 行间细分隔线 */
const RULE = { y1: BODY.top + 4, y2: BODY.bottom - 4, xMid: PAD + GRID.w + 10 } as const;

// ─── 字内强调（变更表 #144） ───────────────────────────────

/** 行首关键词的断句符（第一个之前 ≤8 字算关键词） */
const EMPH_BREAKS = "：，、";

/** 行首关键词最多几个字 */
const EMPH_PREFIX_MAX = 8;

/** 关键词字号（其余 16px） */
const EMPH_PREFIX_SIZE = 20;

/** 数字字号（其余 16px） */
const EMPH_NUMBER_SIZE = 22;

/** 数字单位（含 `%` 与中文量词；`万元` 必须排在 `元` 前） */
const NUMBER_UNITS = [
  "万元",
  "小时",
  "%",
  "个",
  "间",
  "倍",
  "天",
  "台",
  "周",
  "月",
  "年",
  "张",
  "层",
  "条",
  "次",
  "人",
  "元",
];

/** 行内第一处数字（含可选单位，允许数字与单位之间有一个空格） */
const NUMBER_RE = new RegExp(`[0-9]+(?:\\.[0-9]+)?(?:\\s?(?:${NUMBER_UNITS.join("|")}))?`);

/** 一段内容的强调点（行首关键词 + 第一处数字） */
export interface PptEmphasis {
  /** 行首关键词（无分隔符 / 前缀超过 8 字时为空串） */
  prefix: string;
  /** 行内第一处数字（含单位；没有则 null） */
  number: string | null;
}

/**
 * 抽出一段内容的强调点（**确定性规则**，不看模型脸色）
 *
 * - 行首关键词：第一个 `：，、` 之前且 ≤8 字的前缀（如「会前准备：」→「会前准备」）；没有分隔符就整行默认样式；
 * - 数字强调：前缀之后（没有前缀就是整行）的第一处数字，带单位一起强调；同一行只强调第一处。
 */
export function pptEmphasisOf(text: string): PptEmphasis {
  const chars = Array.from(text);
  let prefix = "";
  for (const [i, ch] of chars.entries()) {
    if (!EMPH_BREAKS.includes(ch)) continue;
    if (i > 0 && i <= EMPH_PREFIX_MAX) prefix = chars.slice(0, i).join("");
    break;
  }
  const rest = prefix === "" ? text : chars.slice(Array.from(prefix).length + 1).join("");
  const hit = NUMBER_RE.exec(rest);
  const number = hit && hit[0].trim() !== "" ? hit[0] : null;
  return { prefix, number };
}

/** 一处文本 run（字号 / 颜色 / 粗细与所在 `<text>` 不同时写成 `<tspan>`） */
interface Run {
  text: string;
  size?: number;
  fill?: string;
  bold?: boolean;
}

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

interface RichTextOpts {
  x: number;
  y: number;
  size: number;
  fill: string;
  weight?: boolean;
  anchor?: "middle" | "end";
  runs: readonly Run[];
}

/** 把 runs 拼成 `<text>` 的内容（与基准样式相同的 run 直接写文字，不同的写成 `<tspan>`） */
function runsContent(o: RichTextOpts): string {
  const baseBold = o.weight === true;
  return o.runs
    .map((run) => {
      const text = escXml(run.text);
      if (text === "") return "";
      const size = run.size ?? o.size;
      const fill = run.fill ?? o.fill;
      const bold = run.bold ?? baseBold;
      if (size === o.size && fill === o.fill && bold === baseBold) return text;
      const attrs = [`font-size="${size}"`, `fill="${fill}"`];
      if (bold !== baseBold) attrs.push(`font-weight="${bold ? "bold" : "normal"}"`);
      return `<tspan ${attrs.join(" ")}>${text}</tspan>`;
    })
    .join("");
}

/** 带字内强调的 `<text>`（`<tspan>` 非定位，ppt-master 会保留成同一段落的多个 run） */
function richTextEl(o: RichTextOpts): string {
  const content = runsContent(o);
  if (content === "") return "";
  const weight = o.weight ? ' font-weight="bold"' : "";
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : "";
  return `<text x="${o.x}" y="${o.y}" font-family="${FONT_ATTR}" font-size="${o.size}" fill="${o.fill}"${weight}${anchor}>${content}</text>`;
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

/** 一条直线（分隔线、卡片下划线） */
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
function rowDot(x: number, baseline: number, fill: string = PPT_COLORS.accent): string {
  return rect({
    x,
    y: baseline - ROW_DOT.size - 3,
    w: ROW_DOT.size,
    h: ROW_DOT.size,
    fill,
    rx: 1,
  });
}

/**
 * 图标占位（**渲染层只写 `data-icon`，不读技能目录**）
 *
 * 名字先过 `normalizePptIcon`（白名单外的取值回落 `PPT_DEFAULT_ICON`），
 * 具体 SVG 由导出层的 `finalize_svg.py --only embed-icons` 替换。
 */
function iconUse(o: { icon: string; x: number; y: number; size: number; fill: string }): string {
  const name = normalizePptIcon(o.icon);
  return `<use data-icon="${PPT_ICON_LIB}/${name}" x="${o.x}" y="${o.y}" width="${o.size}" height="${o.size}" fill="${o.fill}"/>`;
}

/** 页内图标的 id 前缀（`<g id="icon-…">` 便于导出动画与排查） */
function iconGroup(id: string, svg: string): string {
  return `<g id="${escXml(id)}">${svg}</g>`;
}

// ─── 行排布：容器内不出界、不压字 ──────────────────────────

interface PlacedItem {
  /** 这一条要画的若干行（≤2 行） */
  lines: string[];
  /** 首行基线 */
  y: number;
  /** 这一条的强调点 */
  emph: PptEmphasis;
}

/**
 * 把若干条内容行放进一个竖直容器里
 *
 * 每条最多两行；容器放不下时把它压成一行（带省略号），**不裁字、不出界**。
 * 强调段（20/22px）比正文宽，换行时按"多出来的宽度"扣掉可用宽——保证加粗放大后仍不出容器。
 */
function placeLines(
  texts: readonly string[],
  o: {
    top: number;
    bottom: number;
    rowH: number;
    size: number;
    maxW: number;
    /** `full` = 关键词 + 数字；`number` = 只强调数字（表格单元格） */
    mode?: "full" | "number";
  },
): PlacedItem[] {
  const out: PlacedItem[] = [];
  let cursor = o.top;
  for (const text of texts) {
    const capacity = Math.floor((o.bottom - cursor) / o.rowH) + 1;
    if (capacity <= 0) break;
    if (text === "") continue;
    const emph = o.mode === "number" ? { prefix: "", number: pptEmphasisOf(text).number } : pptEmphasisOf(text);
    const extra =
      (emph.prefix === ""
        ? 0
        : Math.max(0, estimateTextWidth(emph.prefix, EMPH_PREFIX_SIZE) - estimateTextWidth(emph.prefix, o.size))) +
      (emph.number === null
        ? 0
        : Math.max(0, estimateTextWidth(emph.number, EMPH_NUMBER_SIZE) - estimateTextWidth(emph.number, o.size)));
    const wrapped = wrapText(text, o.size, Math.max(40, o.maxW - extra), Math.min(2, capacity));
    out.push({ lines: wrapped, y: cursor, emph });
    cursor += wrapped.length * o.rowH;
  }
  return out;
}

/** 把一行的文字拆成 runs：前缀（可选）+ 数字（只强调第一处）+ 其余 */
function lineRuns(
  line: string,
  o: { size: number; fill: string; emph: PptEmphasis; state: { prefix: boolean; number: boolean } },
): Run[] {
  const runs: Run[] = [];
  let rest = line;
  if (!o.state.prefix && o.emph.prefix !== "" && rest.startsWith(o.emph.prefix)) {
    runs.push({ text: o.emph.prefix, size: EMPH_PREFIX_SIZE, fill: PPT_COLORS.primary, bold: true });
    rest = rest.slice(o.emph.prefix.length);
    o.state.prefix = true;
  }
  if (!o.state.number && o.emph.number !== null && rest.includes(o.emph.number)) {
    const at = rest.indexOf(o.emph.number);
    o.state.number = true;
    return [
      ...runs,
      ...(at > 0 ? [{ text: rest.slice(0, at) }] : []),
      { text: o.emph.number, size: EMPH_NUMBER_SIZE, fill: PPT_COLORS.orange, bold: true },
      ...(rest.slice(at + o.emph.number.length) === "" ? [] : [{ text: rest.slice(at + o.emph.number.length) }]),
    ];
  }
  runs.push({ text: rest });
  return runs;
}

/** 一组内容行（行前小方块 + 正文，含字内强调），块 id 前缀由调用方给 */
function contentLines(
  prefix: string,
  placed: readonly PlacedItem[],
  o: { x: number; size: number; fill: string; rowH: number },
): string {
  return placed
    .map((p, i) => {
      const dots = p.lines.map((_, j) => rowDot(o.x - ROW_DOT.gap, p.y + j * o.rowH)).join("");
      const state = { prefix: false, number: false };
      const texts = p.lines
        .map((text, j) =>
          richTextEl({
            x: o.x,
            y: p.y + j * o.rowH,
            size: o.size,
            fill: o.fill,
            runs: lineRuns(text, { size: o.size, fill: o.fill, emph: p.emph, state }),
          }),
        )
        .join("");
      return [
        `<g id="${escXml(`${prefix}-${i + 1}`)}">`,
        dots,
        `<g id="${escXml(`${prefix}-${i + 1}-text`)}">${texts}</g>`,
        `</g>`,
      ].join("");
    })
    .join("");
}

// ─── 统一骨架 ──────────────────────────────────────────────

/** 页顶 8px 通栏渐变主色带（`<linearGradient>` 走 ppt-master 的 gradFill） */
function topBandEl(): string {
  return [
    `<defs><linearGradient id="${TOP_BAND.id}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${PPT_COLORS.primary}"/>`,
    `<stop offset="1" stop-color="${PPT_COLORS.primaryAlt}"/>`,
    `</linearGradient></defs>`,
    rect({ x: 0, y: 0, w: PPT_CANVAS.width, h: TOP_BAND.h, fill: `url(#${TOP_BAND.id})`, rx: 0 }),
  ].join("");
}

/** 小节标签：左上浅蓝胶囊（左侧 22×22 图标 + 15px 粗字，宽度按字数算） */
function kickerEl(text: string, icon: string): string {
  const w = HEAD.kickerTextX - PAD + estimateTextWidth(text, HEAD.kickerSize) + 14;
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
    iconGroup(
      "kicker-icon",
      iconUse({
        icon,
        x: HEAD.kickerIconX,
        y: HEAD.kickerY + (HEAD.kickerH - HEAD.kickerIcon) / 2,
        size: HEAD.kickerIcon,
        fill: PPT_COLORS.primary,
      }),
    ),
    textEl({
      x: HEAD.kickerTextX,
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

/** 页眉：36px 大标题 + 80×6 橙短横 + 右上页码胶囊 */
function titleEl(page: PptPage, index: number, total: number): string {
  const title = wrapText(page.title, HEAD.titleSize, HEAD.titleMaxW, 1)[0]!;
  const pageText = `第 ${index + 1} 页 / 共 ${total} 页`;
  const noW = estimateTextWidth(pageText, PAGE_NO.size) + PAGE_NO.padX * 2;
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
    rect({
      x: HEAD.titleX,
      y: HEAD.titleBarY,
      w: HEAD.titleBarW,
      h: HEAD.titleBarH,
      fill: PPT_COLORS.orange,
      rx: HEAD.titleBarH / 2,
    }),
    rect({
      x: RIGHT - noW,
      y: PAGE_NO.y,
      w: noW,
      h: PAGE_NO.h,
      fill: PPT_COLORS.lightBlue,
      rx: PAGE_NO.rx,
    }),
    textEl({
      x: RIGHT - PAGE_NO.padX,
      y: PAGE_NO.y + PAGE_NO.h / 2 + PAGE_NO.size * 0.35,
      size: PAGE_NO.size,
      fill: PPT_COLORS.primaryAlt,
      text: pageText,
      anchor: "end",
    }),
    `</g>`,
  ].join("");
}

/** 副题（标题下一行） */
function subtitleEl(text: string, maxW: number): string {
  return textBlock({
    id: "subtitle",
    x: HEAD.titleX,
    y: HEAD.subtitleY,
    size: HEAD.subtitleSize,
    fill: PPT_COLORS.muted,
    lines: wrapText(text, HEAD.subtitleSize, maxW, 1),
    lineHeight: HEAD.subtitleSize + 6,
  });
}

/** 底部结论带：极浅蓝底 + 左侧 6px 橙条 + `bulb` 图标 + 深蓝粗字（每页都有） */
function highlightEl(text: string): string {
  return [
    `<g id="highlight">`,
    rect({ x: BAND.x, y: BAND.y, w: BAND.w, h: BAND.h, fill: PPT_COLORS.lightBlue, rx: BAND.rx }),
    rect({ x: BAND.barX, y: BAND.barY, w: BAND.barW, h: BAND.barH, fill: PPT_COLORS.orange, rx: 3 }),
    iconGroup(
      "highlight-icon",
      iconUse({ icon: BAND_ICON, x: BAND.iconX, y: BAND.iconY, size: BAND.iconSize, fill: PPT_COLORS.primary }),
    ),
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

/** 块 / 栏 / 层 / 清单条的语气文本（块头 + 小注 + 内容行一起判语气） */
function toneTextOf(parts: readonly (string | readonly string[])[]): string {
  return parts
    .map((p) => (Array.isArray(p) ? p.join("｜") : String(p)))
    .join("｜");
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
  return chunks.map((lines, i) => ({
    head: i === 0 ? page.title : "",
    note: "",
    lines,
    icon: page.icon ?? PPT_DEFAULT_ICON,
  }));
}

/**
 * 一块（网格要点的 2×2 单元）
 *
 * 卡底 `#F7FAFE` + 卡头横条 `#E3F2FD`（内含 28×28 图标与 20px 粗块头）+ 左侧 5px 强调竖条
 * （按块轮换四色，命中问题/价值关键词时改橙 / 绿）+ 内容行（行首关键词与数字做字内强调）。
 */
function blockEl(block: PptBlock, i: number, x: number, y: number): string {
  const w = GRID.w;
  const h = GRID.h;
  const bar = pptBarColor(i, toneTextOf([block.head, block.note, block.lines]));
  const textX = x + 50;
  const maxW = w - 50 - 18;
  const top = block.note === "" ? y + 76 : y + 88;
  const placed = placeLines(block.lines, { top, bottom: y + h - 10, rowH: 30, size: 16, maxW });
  return [
    `<g id="block-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.subtle, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: GRID.headH, fill: PPT_COLORS.lightBlue, rx: 10 }),
    rect({ x, y: y + GRID.headH - 10, w, h: 10, fill: PPT_COLORS.lightBlue, rx: 0 }),
    rect({ x, y: y + 8, w: 5, h: h - 16, fill: bar, rx: 2.5 }),
    iconGroup(
      `block-${i + 1}-icon`,
      iconUse({ icon: block.icon, x: x + 12, y: y + 3, size: 28, fill: PPT_COLORS.primary }),
    ),
    textEl({ x: textX, y: y + 24, size: 20, fill: PPT_COLORS.primary, text: block.head, weight: true }),
    textEl({ x: textX, y: y + 52, size: 15, fill: PPT_COLORS.muted, text: block.note }),
    contentLines(`block-${i + 1}-line`, placed, { x: textX, size: 16, fill: PPT_COLORS.text, rowH: 30 }),
    `</g>`,
  ].join("");
}

/** 网格要点：2×2 四块（卡头横条 + 图标 + 强调竖条 + 内容行） */
function renderGrid(page: PptPage): string {
  const blocks = blocksOf(page);
  const cards = blocks
    .slice(0, PPT_LIMITS.blocks.count)
    .map((block, i) => blockEl(block, i, GRID.xs[i % 2]!, GRID.ys[Math.floor(i / 2)]!))
    .join("");
  // 列间 / 行间留白用 #D6E7F8 细分隔线（两块之间才画，三块时竖线照画）
  const rules = [
    line({ x1: RULE.xMid, y1: RULE.y1, x2: RULE.xMid, y2: RULE.y2, stroke: PPT_COLORS.divider }),
    line({ x1: PAD + 4, y1: 393, x2: RIGHT - 4, y2: 393, stroke: PPT_COLORS.divider }),
  ].join("");
  return cards + `<g id="grid-rules">${rules}</g>`;
}

/** 一栏（双栏对比的左右栏，左 #0D47A1 / 右 #1565C0 栏头 + 26×26 白图标） */
function columnEl(col: PptColumn, i: number, x: number): string {
  const y = COLS.y;
  const w = COLS.w;
  const h = COLS.h;
  const fill = i === 0 ? PPT_COLORS.primary : PPT_COLORS.primaryAlt;
  const textX = x + 58;
  const placed = placeLines(col.lines, {
    top: col.note === "" ? y + 84 : y + 104,
    bottom: y + h - 16,
    rowH: 32,
    size: 16,
    maxW: w - 58 - 18,
  });
  return [
    `<g id="col-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.subtle, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: COLS.headH, fill, rx: 10 }),
    rect({ x, y: y + COLS.headH - 10, w, h: 10, fill, rx: 0 }),
    iconGroup(
      `col-${i + 1}-icon`,
      iconUse({
        icon: col.icon,
        x: x + 20,
        y: y + (COLS.headH - COLS.iconSize) / 2,
        size: COLS.iconSize,
        fill: PPT_COLORS.onPrimary,
      }),
    ),
    textEl({ x: textX, y: y + 34, size: 20, fill: PPT_COLORS.onPrimary, text: col.head, weight: true }),
    textEl({ x: textX, y: y + 76, size: 15, fill: PPT_COLORS.muted, text: col.note }),
    contentLines(`col-${i + 1}-line`, placed, { x: textX, size: 16, fill: PPT_COLORS.text, rowH: 32 }),
    `</g>`,
  ].join("");
}

/** 双栏对比：两栏并排 + 栏间 #D6E7F8 细分隔线 */
function renderColumns(page: PptPage): string {
  const cols = page.columns
    .slice(0, PPT_LIMITS.columns.count)
    .map((col, i) => columnEl(col, i, COLS.xs[i]!))
    .join("");
  const rule = line({
    x1: RULE.xMid,
    y1: COLS.y + 4,
    x2: RULE.xMid,
    y2: COLS.y + COLS.h - 4,
    stroke: PPT_COLORS.divider,
  });
  return cols + `<g id="col-rules">${rule}</g>`;
}

/** 一个阶段（顶部图标 + 序号圆点 + 阶段名 + 说明，右侧接箭头） */
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
    iconGroup(
      `stage-${i + 1}-icon`,
      iconUse({
        icon: stage.icon,
        x: cx - STAGE.iconSize / 2,
        y: y + 16,
        size: STAGE.iconSize,
        fill: PPT_COLORS.primary,
      }),
    ),
    circle({ cx, cy: y + 70, r: 20, fill: PPT_COLORS.primary }),
    textEl({
      x: cx,
      y: y + 70 + 18 * 0.35,
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

/** 流程阶段：3–5 个等分横排（浅蓝卡 + 图标 + 主色序号圆点 + 箭头） */
function renderStages(page: PptPage): string {
  const stages = page.stages.slice(0, PPT_LIMITS.stages.max);
  const n = stages.length;
  if (n === 0) return "";
  const gap = STAGE.gap;
  const w = Math.floor((CONTENT_W - gap * (n - 1)) / n);
  return stages.map((stage, i) => stageEl(stage, i, n, PAD + i * (w + gap), w)).join("");
}

/** 一层（左侧强调竖条 + 26×26 图标 + 层名 + 组件胶囊标签） */
function layerEl(layer: PptLayer, i: number, y: number): string {
  const bar = pptBarColor(i, toneTextOf([layer.head, layer.items]));
  const headX = LAYER.x + 58;
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
    rect({ x: LAYER.x, y: y + 18, w: 5, h: LAYER.h - 36, fill: bar, rx: 2.5 }),
    iconGroup(
      `layer-${i + 1}-icon`,
      iconUse({
        icon: layer.icon,
        x: LAYER.x + 22,
        y: y + (LAYER.h - LAYER.iconSize) / 2,
        size: LAYER.iconSize,
        fill: PPT_COLORS.primary,
      }),
    ),
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

/** 一张数据卡片（顶部主色条 + 28×28 图标 + 大数值 + 橙色下划线 + 说明） */
function cardEl(card: PptCard, i: number, x: number, w: number): string {
  const y = CARD.y;
  const h = CARD.h;
  const values = wrapText(card.value, 34, w - 48, 2);
  const labels = wrapText(card.label, 16, w - 40, 2);
  const cx = x + w / 2;
  return [
    `<g id="card-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.subtle, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: 5, fill: PPT_BAR_COLORS[i % PPT_BAR_COLORS.length]!, rx: 2 }),
    iconGroup(
      `card-${i + 1}-icon`,
      iconUse({
        icon: card.icon,
        x: cx - CARD.iconSize / 2,
        y: y + 26,
        size: CARD.iconSize,
        fill: PPT_COLORS.primary,
      }),
    ),
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

/** 表格各列宽（按内容比例分配，最小 96，最后拉满内容宽；表头格留出图标的宽度） */
function columnWidths(table: PptTable): number[] {
  const sizes = table.head.map((h, i) => {
    const cells = table.rows.map((r) => r[i] ?? "");
    const widest = Math.max(
      estimateTextWidth(h, 16),
      ...cells.map((c) => estimateTextWidth(c, 15)),
      40,
    );
    return Math.max(widest + 32 + TABLE.iconGap, 96);
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const widths = sizes.map((s) => Math.floor((s / total) * CONTENT_W));
  widths[widths.length - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  return widths;
}

/**
 * 一个表格单元格：最多两行、垂直居中，只做**数字强调**（格子里是短标签，不做行首关键词）
 *
 * 数字比正文宽，换行前先把多出来的宽度扣掉，保证加粗放大后仍在列宽以内。
 */
function cellEl(text: string, row: number, col: number, x: number, rowY: number, maxW: number): string {
  const emph: PptEmphasis = { prefix: "", number: pptEmphasisOf(text).number };
  const extra =
    emph.number === null
      ? 0
      : Math.max(0, estimateTextWidth(emph.number, EMPH_NUMBER_SIZE) - estimateTextWidth(emph.number, 15));
  const lines = wrapText(text, 15, Math.max(40, maxW - extra), 2);
  const state = { prefix: false, number: false };
  const first = rowY + TABLE.rowH / 2 + 15 * 0.35 - (lines.length - 1) * 11;
  const texts = lines
    .map((line, j) =>
      richTextEl({
        x,
        y: first + j * 22,
        size: 15,
        fill: PPT_COLORS.text,
        runs: lineRuns(line, { size: 15, fill: PPT_COLORS.text, emph, state }),
      }),
    )
    .join("");
  return `<g id="cell-${row}-${col}"><g id="cell-${row}-${col}-text">${texts}</g></g>`;
}

/** 表格：主色表头（每列一个小图标）+ 奇数行浅蓝 / 偶数行白 + 行间细线 */
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
    .map((h, i) => {
      const icon = iconGroup(
        `th-${i + 1}-icon`,
        iconUse({
          icon: table.icons?.[i] ?? PPT_DEFAULT_ICON,
          x: xs[i]! + 14,
          y: BODY.top + (TABLE.headH - TABLE.iconSize) / 2,
          size: TABLE.iconSize,
          fill: PPT_COLORS.onPrimary,
        }),
      );
      return [
        icon,
        textEl({
          x: xs[i]! + 14 + TABLE.iconSize + 8,
          y: BODY.top + TABLE.headH / 2 + 16 * 0.35,
          size: 16,
          fill: PPT_COLORS.onPrimary,
          text: wrapText(h, 16, widths[i]! - 36 - 12, 1)[0]!,
          weight: true,
        }),
      ].join("");
    })
    .join("");
  const rows = table.rows
    .map((row, r) => {
      const y = BODY.top + TABLE.headH + r * TABLE.rowH;
      const fill = r % 2 === 0 ? PPT_COLORS.subtle : PPT_COLORS.card;
      const cells = row
        .map((cell, i) => cellEl(cell, r + 1, i + 1, xs[i]! + 16, y, widths[i]! - 32))
        .join("");
      return [
        `<g id="row-${r + 1}">`,
        rect({ x: PAD, y, w: CONTENT_W, h: TABLE.rowH, fill, rx: 0 }),
        line({ x1: PAD, y1: y + TABLE.rowH, x2: RIGHT, y2: y + TABLE.rowH, stroke: PPT_COLORS.divider }),
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

/** 要点行的断句符（把一条要点拆成「主句 + 次要说明」） */
const ITEM_BREAKS = "：:，,；;、";

/**
 * 一条要点 → 主句 + 次要说明
 *
 * 在第一个"断得出两边"的标点处断（主句 ≥6 字、说明 ≥4 字），断不出就不拆、整条当主句。
 * 这样模型给的 `head：note`（降级路径）天然会拆开，`短句，补充` 也会拆成两行，页面才有层次。
 */
function splitItem(text: string): { head: string; note: string } {
  const chars = Array.from(text);
  for (const [i, ch] of chars.entries()) {
    if (!ITEM_BREAKS.includes(ch)) continue;
    const head = chars.slice(0, i).join("").trim();
    const note = chars.slice(i + 1).join("").trim();
    if (Array.from(head).length >= 6 && Array.from(note).length >= 4) return { head, note };
  }
  return { head: text, note: "" };
}

/**
 * 要点清单（兜底布局）：22×22 图标 + 44×44 序号底衬 + 一行大字 + 次要说明行 + 条间细线
 *
 * 这是兜底版式，但**兜底也不许是一张白页**：每条给足四件（图标 / 序号底衬 / 20px 主句 /
 * 15px 次要说明），条与条之间加一条 1px `#D6E7F8` 分隔线——5 条时形状数也过质量门禁的密度线。
 * 主句做字内强调（行首关键词 + 数字），图标取页图标（同页同款符号，就是"这一页"的记号）。
 */
function renderChecklist(page: PptPage): string {
  const items = checklistLines(page).map(splitItem);
  const n = items.length;
  if (n === 0) return "";
  const gap = LIST.gap;
  const rowH = Math.min(LIST.rowH, Math.floor((BODY.h - gap * (n - 1)) / n));
  const textX = PAD + 118;
  const maxW = CONTENT_W - 118 - 24;
  const icon = page.icon ?? PPT_DEFAULT_ICON;
  return items
    .map((item, i) => {
      const y = BODY.top + i * (rowH + gap);
      const boxY = y + (rowH - 44) / 2;
      const mid = y + rowH / 2;
      const mainTop = item.note === "" ? mid + 20 * 0.35 : mid - 6;
      const placed = placeLines(item.head === "" ? [] : [item.head], {
        top: mainTop,
        // 有说明行时主句只排一行（bottom = top ⇒ 容量 1），否则说明行会被主句第二行压住
        bottom: item.note === "" ? y + rowH - 4 : mainTop,
        rowH: 26,
        size: 20,
        maxW,
      });
      return [
        `<g id="item-${i + 1}">`,
        rect({
          x: PAD,
          y,
          w: CONTENT_W,
          h: rowH,
          fill: PPT_COLORS.subtle,
          stroke: PPT_COLORS.border,
          strokeWidth: 1.5,
          rx: 10,
        }),
        iconGroup(
          `item-${i + 1}-icon`,
          iconUse({ icon, x: PAD + 22, y: mid - LIST.iconSize / 2, size: LIST.iconSize, fill: PPT_COLORS.primary }),
        ),
        rect({ x: PAD + 58, y: boxY, w: 44, h: 44, fill: PPT_COLORS.lightBlue, rx: 10 }),
        textEl({
          x: PAD + 80,
          y: boxY + 22 + 20 * 0.35,
          size: 20,
          fill: PPT_COLORS.primaryAlt,
          text: String(i + 1).padStart(2, "0"),
          weight: true,
          anchor: "middle",
        }),
        contentLines(`item-${i + 1}-main`, placed, {
          x: textX,
          size: 20,
          fill: PPT_COLORS.text,
          rowH: 26,
        }),
        item.note === ""
          ? ""
          : textBlock({
              id: `item-${i + 1}-note`,
              x: textX,
              y: mid + 22,
              size: 15,
              fill: PPT_COLORS.muted,
              lines: wrapText(item.note, 15, maxW, 1),
              lineHeight: 22,
            }),
        i < n - 1
          ? line({
              x1: PAD + 16,
              y1: y + rowH + gap / 2,
              x2: PAD + CONTENT_W - 16,
              y2: y + rowH + gap / 2,
              stroke: PPT_COLORS.divider,
            })
          : "",
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
  const icon = page.icon ?? PPT_DEFAULT_ICON;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${PPT_CANVAS.width}" height="${PPT_CANVAS.height}" viewBox="0 0 ${PPT_CANVAS.width} ${PPT_CANVAS.height}">`,
    rect({ x: 0, y: 0, w: PPT_CANVAS.width, h: PPT_CANVAS.height, fill: PPT_COLORS.bg, rx: 0 }),
    topBandEl(),
    kickerEl(page.kicker ?? "", icon),
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
