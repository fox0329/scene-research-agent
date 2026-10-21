/**
 * @scene/infra — PPT 页面渲染（变更表 #141 立、#142 升、#144 升、#145 升：视觉微调 + 最小字号 + 版面均衡）
 *
 * 把 `@scene/domain` 校验过的大纲**确定性地**画成 1280×720 的 SVG。
 * 模型只产内容，**绝不让模型写 SVG**（渲染进不了判定路径，也让版式对每一页都一致）。
 *
 * 版式口径（变更表 #144 立、#145 微调，照用户那份高分稿的用量对标，底色仍是纯白）：
 *  - 统一骨架（#145 去掉两处装饰）：小节标签胶囊（左侧 22×22 图标）→ 36px 大标题
 *    → 18px 副题 + 右侧技术标签 → 内容区（y=170..620）→ 底部结论带（#E3F2FD + 6px 橙条 + `bulb` 图标）
 *    → 右上 #E3F2FD 页码胶囊 → 左下页脚。**页顶不再有 8px 渐变主色带、标题下不再有橙色短横**
 *    （用户定调：「每页PPT最上面的蓝色窄条可以去掉」「每页标题下面的短橙色横线可以去掉」）；
 *  - **最小字号 16px**（#145，用户定调「最小字体可以调大一点」）：内容类文字一律 ≥ `PPT_MIN_FONT`，
 *    页脚与页码 15px；字号上调后**换行与容量同步重算**——块行距仍 30、栏行距 32、
 *    表格行高按行数摊开（`tableRowH`）、清单行高按条数摊开（`listRowH`）。
 *    放不下就压成一行加省略号，**不出界、不压字、不裁字**（硬约束不变）；
 *  - **版面均衡**（#145）：内容区里 3 块的页面也要铺开——流程阶段 / 数据卡片 / 表格 / 要点清单
 *    一律**竖直居中**并尽量摊开（底部空白 ≤ `PPT_QUALITY.maxBottomGap`），
 *    换行按「行首禁则 + 孤字行避免」二次均衡（`wrapText`）。
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
  PPT_MIN_FONT,
  PPT_TEMPLATE,
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
  /** 主色深蓝（模版 24pt 标题 / 块头 / 卡片数值） */
  primary: PPT_TEMPLATE.colors.primary,
  /** 强调蓝（模版副题、英文小标、右栏头） */
  primaryAlt: PPT_TEMPLATE.colors.accent,
  /** 次强调蓝（模版 s2 副题） */
  blue700: PPT_TEMPLATE.colors.accentAlt,
  /** 浅蓝点缀（行前小方块、箭头、序号） */
  blue400: "#6E8FD6",
  /** 极浅文字（模版序号 01/02 的灰蓝） */
  accent: PPT_TEMPLATE.colors.faint,
  /** 浅底（模版浅蓝底块 / 卡头 / 结论行底衬） */
  lightBlue: PPT_TEMPLATE.colors.light,
  /** 细分隔线 */
  divider: PPT_TEMPLATE.colors.border,
  /** 条纹底（块卡 / 层带 / 卡片 / 清单条的填充层次） */
  subtle: "#F7F9FD",
  /** 正文（模版内容行 %404040） */
  text: PPT_TEMPLATE.colors.text,
  /** 次要文字（模版小注 / 页脚） */
  muted: PPT_TEMPLATE.colors.muted,
  /** 问题橙（问题·风险·代价；模版没有橙，用低饱和暖色做语义区分） */
  orange: "#D9822B",
  /** 价值绿（模版 22943A） */
  green: PPT_TEMPLATE.colors.green,
  /** 页面底色（纯白） */
  bg: "#FFFFFF",
  /** 卡片白 */
  card: "#FFFFFF",
  /** 描边 */
  border: PPT_TEMPLATE.colors.border,
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

/** 页眉：小节标签胶囊（含 22×22 图标）/ 大标题 / 副题 */
const HEAD = {
  /** 小节标签：模版没有胶囊，只有一行 13px 的灰蓝小字（在标题上方，标这一页属于哪一段） */
  kickerY: 30,
  kickerSize: PPT_TEMPLATE.font.microPx,
  titleX: PAD,
  /** 标题基线：模版 24pt 标题距顶 0.36in（≈35px），基线约 72 */
  titleY: 72,
  titleSize: PPT_TEMPLATE.font.titlePx,
  titleMaxW: 1180,
  /** 副题基线：模版 16.5pt 强调句在标题下一行 */
  subtitleY: 108,
  subtitleSize: PPT_TEMPLATE.font.subtitlePx,
} as const;

/** 页脚（模版样式：左产品线、右「NN / MM」，10.5pt 灰色） */
const FOOT = {
  x: PAD,
  y: 700,
  size: PPT_TEMPLATE.font.microPx,
  pageFormat: PPT_TEMPLATE.footer.pageFormat,
} as const;

/** 技术/能力标签（贴右、与副题同一行；标签是内容类文字，≥ PPT_MIN_FONT） */
const CHIP = {
  y: 92,
  h: 26,
  rx: 13,
  size: PPT_MIN_FONT,
  padX: 12,
  gap: 8,
  /** 保副题至少这么宽，不然从右往左丢标签 */
  minSubtitleW: 360,
  /** 副题与标签之间的安全间距 */
  minGap: 24,
} as const;

/** 底部一句话总结：模版 s1/s3 那种深灰一行（不做蓝底、不做橙条、不加图标） */
const SUMMARY = {
  x: PAD,
  y: 654,
  size: PPT_MIN_FONT,
  maxW: CONTENT_W,
} as const;

/** 内容区（各布局都排在这条带里） */
const BODY = { top: 170, bottom: 620, h: 450 } as const;

/** 内容区里竖直居中（#145：块少的页面也要摊开，不许全挤在上半页） */
function centerInBody(h: number): number {
  return BODY.top + Math.floor((BODY.h - h) / 2);
}

/** 网格要点：2×2，块 550×216；卡头横条 34（装得下 28×28 图标，口径 26） */
const GRID = { w: 550, h: 216, xs: [PAD, PAD + 570], ys: [170, 400], headH: 34 } as const;

/** 双栏对比：左右各 550×450，栏头 52 */
const COLS = { w: 550, h: 450, xs: [PAD, PAD + 570], y: 170, headH: 52, iconSize: 26 } as const;

/** 流程阶段：等分横排 + 右向箭头（竖直居中：y=260） */
const STAGE = { h: 270, gap: 28, iconSize: 26 } as const;
const STAGE_Y = centerInBody(STAGE.h);

/** 分层架构：横条 72 高，自上而下堆叠（层数少时整组居中） */
const LAYER = { x: PAD, w: CONTENT_W, h: 72, gap: 20, iconSize: 26 } as const;

/** 数据卡片：等分，300 高（竖直居中：y=245） */
const CARD = { h: 300, gap: 24, iconSize: 28 } as const;
const CARD_Y = centerInBody(CARD.h);

/**
 * 表格：表头 52；行高按行数摊开（#145）
 *
 * 字号从 15 提到 16 后，一行 16px 文字的高度 ≈18px、两行 ≈42px，故下限仍是 56；
 * 行数少时把行高拉长并整表居中（3 行以上封顶 120、1–2 行封顶 176），
 * 让短表也铺开在内容区里（不留大片下坠空白）——判据见 `PPT_QUALITY.maxBottomGap`。
 */
const TABLE = {
  headH: 52,
  rowH: 56,
  /** 3 行以上的表：行高最多拉到 120（内容多时回到 56–66，不硬撑） */
  maxRowH: 120,
  /** 1–2 行的短表：允许拉到 176 并把整表居中，免得只有半页内容还全挤在上半页 */
  maxShortRowH: 176,
  cellSize: PPT_MIN_FONT,
  cellLineH: 24,
  headSize: PPT_MIN_FONT,
  iconSize: 14,
  iconGap: 22,
} as const;

/** 要点清单：一行 64 高 + 12 间距（条数少时拉高并整组居中，封顶 120） */
const LIST = { rowH: 64, maxRowH: 120, gap: 12, iconSize: 22 } as const;

/** 内容行：方块 6×6、行距 30（网格）/ 32（双栏） */
const ROW_DOT = { size: 6, gap: 18 } as const;

/** 列间 / 行间细分隔线 */
const RULE = { y1: BODY.top + 4, y2: BODY.bottom - 4, xMid: PAD + GRID.w + 10 } as const;

/**
 * 版面网格（质量门禁按它判「未对齐网格」，`packages/infra/src/ppt-quality.ts`）
 *
 * 同层级元素（块 / 栏 / 层 / 清单条 / 表格行）的 x 与宽度必须落在这些值上，偏差 >2px 就算没对齐；
 * 卡片与阶段是等分件，判据是"同页等宽 + 等距"。**这里是唯一事实源**：改版式只改上面那些常量。
 */
export const PPT_GRID = {
  /** 内容区左缘与右缘（x 与 x+width） */
  x: PAD,
  w: CONTENT_W,
  /** 内容带（竖直判据的上下界） */
  bodyTop: BODY.top,
  bodyBottom: BODY.bottom,
  /** 网格要点：块 550×216，落位 x=80/650、y=170/400 */
  block: { w: GRID.w, h: GRID.h, xs: GRID.xs, ys: GRID.ys },
  /** 双栏对比：栏 550×450，落位 x=80/650 */
  col: { w: COLS.w, h: COLS.h, xs: COLS.xs },
  /** 分层架构 / 要点清单 / 表格行：整幅内容宽 */
  layer: { x: LAYER.x, w: LAYER.w },
  list: { x: PAD, w: CONTENT_W },
  /** 卡片 / 阶段：等分件（h 与间距固定） */
  card: { h: CARD.h, gap: CARD.gap },
  stage: { h: STAGE.h, gap: STAGE.gap },
} as const;

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

// ─── 断行二次均衡（变更表 #145：行首禁则 + 孤字行） ─────────

/**
 * 行首禁则字符（中文排版：这些标点不许出现在一行开头）
 *
 * 与《解决方案输出要求》的排版口径一致：起首出现这些标点，读者会以为上一行没排完。
 */
export const PPT_LEADING_PUNCT = "，。、；：！？）》」";

/** 这一行是不是以禁则标点开头 */
export function hasLeadingPunct(line: string): boolean {
  return line !== "" && PPT_LEADING_PUNCT.includes(line[0]!);
}

/** 行首禁则：**起首的**标点是排版噪声（模型偶发），渲染层确定性甩掉——只丢标点，不动其余文字 */
export function stripLeadingPunct(text: string): string {
  let out = text;
  while (out !== "" && hasLeadingPunct(out)) out = out.slice(1);
  return out;
}

/** 一行的可见字数（末尾省略号是"压缩痕迹"，不算字） */
function visibleChars(line: string): number {
  return Array.from(line).filter((ch) => ch !== "…").length;
}

/** 换行后最后一行最少几个字（避免孤字行；质量门禁同源） */
export const PPT_MIN_ORPHAN_CHARS = 3;

/** 从上一行末尾匀一个字符到下一行行首（上一行至少留 2 个字，否则不动） */
function shiftDown(lines: string[], i: number, fontSize: number, maxWidth: number): boolean {
  const prev = Array.from(lines[i - 1]!);
  if (prev.length <= 2) return false;
  const moved = prev[prev.length - 1]!;
  const next = moved + lines[i]!;
  // **溢出优先于均衡**：匀下来的字会让下一行出界就不匀（硬约束不让步）
  if (estimateTextWidth(next, fontSize) > maxWidth) return false;
  prev.pop();
  lines[i - 1] = prev.join("");
  lines[i] = next;
  return true;
}

/**
 * 断行后的二次均衡（确定性、只挪字符、不删字）
 *
 * ① **行首禁则**：某一行以禁则标点开头 → 把上一行末字挪下来（最多挪 8 次，挪不动就作罢）；
 * ② **孤字行**：末行不足 3 个字 → 从上一行末尾匀字下来（可能把标点匀下来，故再跑一遍 ①）。
 */
function balanceLines(lines: string[], fontSize: number, maxWidth: number): string[] {
  for (let i = 1; i < lines.length; i += 1) {
    for (let g = 0; g < 8 && hasLeadingPunct(lines[i]!); g += 1) {
      if (!shiftDown(lines, i, fontSize, maxWidth)) break;
    }
  }
  const last = lines.length - 1;
  if (last >= 1) {
    for (let g = 0; g < 8 && visibleChars(lines[last]!) < PPT_MIN_ORPHAN_CHARS; g += 1) {
      if (!shiftDown(lines, last, fontSize, maxWidth)) break;
    }
    for (let g = 0; g < 8 && hasLeadingPunct(lines[last]!); g += 1) {
      if (!shiftDown(lines, last, fontSize, maxWidth)) break;
    }
  }
  return lines;
}

/**
 * 断点落在禁则标点上时，从上一行挪几个字下来，让新行不以标点开头
 *
 * 挪下来的那个字**自己也可能**是标点（`……确认），老设备…` 里的 `）`），所以一直往前挪到挪下来的
 * 那个字不是标点为止（上一行至少留 1 个字；实在挪不动就交给最后那道 `stripLeadingPunct` 兜底）。
 */
function rebreakOnPunct(prev: string[], ch: string): { head: string; tail: string } | null {
  let keep = prev.length - 1;
  while (keep > 1 && hasLeadingPunct(prev[keep]!)) keep -= 1;
  return { head: prev.slice(0, keep).join(""), tail: prev.slice(keep).join("") + ch };
}

/**
 * 按像素宽换行（最多 maxLines 行，排不下就以省略号收尾）
 *
 * 与 #142 的差别有两处：① 断点落在禁则标点上时**当场把上一行末字一起挪下来**（新行不以标点开头，
 * 宽度也仍在容器内）；② 排完做一次二次均衡（孤字行，见 `balanceLines`），最后再甩一遍行首标点
 * （只可能出现在"容器只装得下 1–2 个字"的极端窄格子里，那时挪无可挪）。
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const chars = Array.from(stripLeadingPunct(text));
  const lines: string[] = [];
  let current = "";
  let consumed = 0;
  for (const ch of chars) {
    if (lines.length >= maxLines) break;
    const next = current + ch;
    if (current !== "" && estimateTextWidth(next, fontSize) > maxWidth) {
      const prev = Array.from(current);
      const fixed = hasLeadingPunct(ch) && prev.length > 1 ? rebreakOnPunct(prev, ch) : null;
      if (fixed !== null) {
        lines.push(fixed.head);
        current = fixed.tail;
      } else {
        lines.push(current);
        current = ch;
      }
    } else {
      current = next;
    }
    consumed += 1;
  }
  let leftover = false;
  if (current !== "") {
    if (lines.length < maxLines) lines.push(current);
    else leftover = true; // 排到行数上限还有没排进去的字，必须用省略号交代，不许无声丢字
  }
  if (lines.length > 1) balanceLines(lines, fontSize, maxWidth);
  if (lines.length > 0 && (consumed < chars.length || leftover)) {
    const last = lines.length - 1;
    lines[last] = shrinkToFit(`${lines[last]}…`, fontSize, maxWidth);
  }
  // 最后一道保险：挪无可挪的窄格子里仍可能留下行首标点，此时只丢那个标点（排版噪声，不是内容）
  const cleaned = lines.map(stripLeadingPunct).filter((l) => l !== "" || lines.length === 1);
  return cleaned.length === 0 ? [""] : cleaned;
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
  // 行首禁则：起首的标点甩掉（模型偶发；只丢标点，不动其余文字）
  const text = stripLeadingPunct(o.text);
  if (text === "") return "";
  const weight = o.weight ? ' font-weight="bold"' : "";
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : "";
  return `<text x="${o.x}" y="${o.y}" font-family="${FONT_ATTR}" font-size="${o.size}" fill="${o.fill}"${weight}${anchor}>${escXml(text)}</text>`;
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
  let leading = true;
  return o.runs
    .map((run) => {
      // 行首禁则：整行的第一个非空 run 起首是标点就甩掉（只丢标点，不动其余文字）
      const raw = leading ? stripLeadingPunct(run.text) : run.text;
      if (raw !== "") leading = false;
      const text = escXml(raw);
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

// ─── 统一骨架（变更表 #253：按模版重排） ────────────────────

/**
 * 小节标签：标题上方一行 13px 灰蓝小字
 *
 * 模版里没有胶囊标签；这里保留一行小字承担"读者知道自己在第几段"的作用，
 * 但不占标题位置、不用色块——13px 属元信息（`minMetaFontSize`），不当内容字号判。
 */
function kickerEl(text: string, icon: string): string {
  if (text === "") return "";
  return [
    `<g id="kicker">`,
    `<g id="kicker-icon">`,
    iconUse({
      icon,
      x: HEAD.titleX,
      y: HEAD.kickerY - 13,
      size: 16,
      fill: PPT_COLORS.primaryAlt,
    }),
    `</g>`,
    textBlock({
      id: "kicker-text",
      x: HEAD.titleX + 22,
      y: HEAD.kickerY,
      size: HEAD.kickerSize,
      fill: PPT_COLORS.muted,
      lines: wrapText(text, HEAD.kickerSize, HEAD.titleMaxW, 1),
      lineHeight: HEAD.kickerSize + 4,
    }),
    `</g>`,
  ].join("");
}

/** 技术/能力标签（贴右、与副题同一行；模版做法是浅底小胶囊） */
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
        fill: PPT_COLORS.primary,
        text: list[i]!,
        weight: true,
      }),
      `</g>`,
    );
    x += w + CHIP.gap;
  }
  return { svg: parts.join(""), subtitleMaxW: CONTENT_W - total - CHIP.minGap };
}

/** 页眉：32px 大标题（模版 24pt、深蓝、左上顶格；页码移到页脚右侧） */
function titleEl(page: PptPage): string {
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
    `</g>`,
  ].join("");
}

/** 副题（标题下一行；模版风格：22px 加粗强调蓝） */
function subtitleEl(text: string, maxW: number): string {
  if (text === "") return "";
  return textBlock({
    id: "subtitle",
    x: HEAD.titleX,
    y: HEAD.subtitleY,
    size: HEAD.subtitleSize,
    fill: PPT_COLORS.primaryAlt,
    lines: wrapText(text, HEAD.subtitleSize, maxW, 1),
    lineHeight: HEAD.subtitleSize + 6,
    weight: true,
  });
}

/** 底部一句话总结（模版 s1/s3 的深灰一行；不做蓝底、不加图标） */
function summaryEl(text: string): string {
  if (text === "") return "";
  return textBlock({
    id: "summary",
    x: SUMMARY.x,
    y: SUMMARY.y,
    size: SUMMARY.size,
    fill: PPT_COLORS.text,
    lines: wrapText(text, SUMMARY.size, SUMMARY.maxW, 1),
    lineHeight: SUMMARY.size + 4,
  });
}

/** 页脚：左「场景通 · <场景名>」、右「NN / MM」（模版样式，10.5pt 灰色） */
function footerEl(scenarioName: string, index: number, total: number): string {
  const pageText = `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  return [
    textBlock({
      id: "footer",
      x: FOOT.x,
      y: FOOT.y,
      size: FOOT.size,
      fill: PPT_COLORS.muted,
      lines: wrapText(`场景通 · ${scenarioName}`, FOOT.size, CONTENT_W - 200, 1),
      lineHeight: FOOT.size + 2,
    }),
    `<g id="page-no">`,
    textEl({
      x: RIGHT,
      y: FOOT.y,
      size: FOOT.size,
      fill: PPT_COLORS.muted,
      text: pageText,
      anchor: "end",
    }),
    `</g>`,
  ].join("");
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
  const placed = placeLines(block.lines, { top, bottom: y + h - 10, rowH: 30, size: PPT_MIN_FONT, maxW });
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
    textEl({
      x: textX,
      y: y + 52,
      size: PPT_MIN_FONT,
      fill: PPT_COLORS.muted,
      text: wrapText(block.note, PPT_MIN_FONT, maxW, 1)[0]!,
    }),
    contentLines(`block-${i + 1}-line`, placed, { x: textX, size: PPT_MIN_FONT, fill: PPT_COLORS.text, rowH: 30 }),
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
    size: PPT_MIN_FONT,
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
    textEl({
      x: textX,
      y: y + 76,
      size: PPT_MIN_FONT,
      fill: PPT_COLORS.muted,
      text: wrapText(col.note, PPT_MIN_FONT, w - 58 - 18, 1)[0]!,
    }),
    contentLines(`col-${i + 1}-line`, placed, { x: textX, size: PPT_MIN_FONT, fill: PPT_COLORS.text, rowH: 32 }),
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
  // #145：整排竖直居中（3–5 个阶段都不许缩在内容区上半页）
  const y = STAGE_Y;
  const h = STAGE.h;
  const cx = x + w / 2;
  const maxW = w - 32;
  const heads = wrapText(stage.head, 18, maxW, 2);
  const notes = wrapText(stage.note, PPT_MIN_FONT, maxW, 2);
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
      size: PPT_MIN_FONT,
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
    const w = estimateTextWidth(item, PPT_MIN_FONT) + 24;
    if (x + w > LAYER.x + LAYER.w - 16) break; // 放不下就从右往左少画一个（内容不丢，只是不上这一页的这层）
    parts.push(
      `<g id="layer-${i + 1}-item-${j + 1}">`,
      rect({ x, y: y + 22, w, h: 28, fill: PPT_COLORS.lightBlue, rx: 14 }),
      textEl({
        x: x + 12,
        y: y + 22 + 14 + PPT_MIN_FONT * 0.35,
        size: PPT_MIN_FONT,
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
  // #145：卡片组竖直居中（3 张也不许缩在上半页）
  const y = CARD_Y;
  const h = CARD.h;
  const values = wrapText(card.value, 34, w - 48, 2);
  const labels = wrapText(card.label, 16, w - 40, 2);
  const cx = x + w / 2;
  return [
    `<g id="card-${i + 1}">`,
    rect({ x, y, w, h, fill: PPT_COLORS.subtle, stroke: PPT_COLORS.border, strokeWidth: 1.5, rx: 10 }),
    rect({ x, y, w, h: 5, fill: PPT_BAR_COLORS[i % PPT_BAR_COLORS.length]!, rx: 2 }),
    // 卡片序号（模版矩阵页的 01–04 编号做法）：给卡片一个顺序，也补一格信息
    textEl({
      x: x + w - 20,
      y: y + 34,
      size: PPT_MIN_FONT,
      fill: PPT_COLORS.accent,
      text: String(i + 1).padStart(2, "0"),
      anchor: "end",
      weight: true,
    }),
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
      size: PPT_MIN_FONT,
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
      ...cells.map((c) => estimateTextWidth(c, PPT_MIN_FONT)),
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
 * 数字比正文宽，换行前先把多出来的宽度扣掉，保证加粗放大后仍在列宽以内（#145：字号 15→16）。
 */
function cellEl(
  text: string,
  row: number,
  col: number,
  x: number,
  rowY: number,
  rowH: number,
  maxW: number,
): string {
  const emph: PptEmphasis = { prefix: "", number: pptEmphasisOf(text).number };
  const size = TABLE.cellSize;
  const extra =
    emph.number === null
      ? 0
      : Math.max(0, estimateTextWidth(emph.number, EMPH_NUMBER_SIZE) - estimateTextWidth(emph.number, size));
  const lines = wrapText(text, size, Math.max(40, maxW - extra), 2);
  const state = { prefix: false, number: false };
  // 两行 16px（行距 24）竖直居中：上下各留 ≥7px，行间不压字
  const first = rowY + rowH / 2 + size * 0.35 - ((lines.length - 1) * TABLE.cellLineH) / 2;
  const texts = lines
    .map((line, j) =>
      richTextEl({
        x,
        y: first + j * TABLE.cellLineH,
        size,
        fill: PPT_COLORS.text,
        runs: lineRuns(line, { size, fill: PPT_COLORS.text, emph, state }),
      }),
    )
    .join("");
  return `<g id="cell-${row}-${col}"><g id="cell-${row}-${col}-text">${texts}</g></g>`;
}

/**
 * 表格行高（变更表 #145）：按行数把内容区摊开——行少就拉高（封顶 280）、行多就回到下限
 *
 * 16px 的字两行（行距 24）连字面约 42px，故下限 56 装得下两行；行数少时把行高拉长并**整表居中**，
 * 免得 2–3 行的短表缩在内容区上半页（正是版面判据「留白不均」要抓的那类排版）。
 */
function tableRowH(rows: number): number {
  const fit = Math.floor((BODY.h - TABLE.headH) / Math.max(1, rows));
  const cap = rows >= 3 ? TABLE.maxRowH : TABLE.maxShortRowH;
  return Math.max(TABLE.rowH, Math.min(cap, fit));
}

/** 表格：主色表头（每列一个小图标）+ 奇数行浅蓝 / 偶数行白 + 行间细线（#145：按行数摊开并居中） */
function renderTable(table: PptTable): string {
  if (table === null) return "";
  const rows = table.rows.slice(0, PPT_LIMITS.table.maxRows);
  const rowH = tableRowH(rows.length);
  const top = centerInBody(TABLE.headH + rows.length * rowH);
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
          y: top + (TABLE.headH - TABLE.iconSize) / 2,
          size: TABLE.iconSize,
          fill: PPT_COLORS.onPrimary,
        }),
      );
      return [
        icon,
        textEl({
          x: xs[i]! + 14 + TABLE.iconSize + 8,
          y: top + TABLE.headH / 2 + TABLE.headSize * 0.35,
          size: TABLE.headSize,
          fill: PPT_COLORS.onPrimary,
          text: wrapText(h, TABLE.headSize, widths[i]! - 36 - 12, 1)[0]!,
          weight: true,
        }),
      ].join("");
    })
    .join("");
  const rowEls = rows
    .map((row, r) => {
      const y = top + TABLE.headH + r * rowH;
      const fill = r % 2 === 0 ? PPT_COLORS.subtle : PPT_COLORS.card;
      const cells = row
        .map((cell, i) => cellEl(cell, r + 1, i + 1, xs[i]! + 16, y, rowH, widths[i]! - 32))
        .join("");
      return [
        `<g id="row-${r + 1}">`,
        rect({ x: PAD, y, w: CONTENT_W, h: rowH, fill, rx: 0 }),
        line({ x1: PAD, y1: y + rowH, x2: RIGHT, y2: y + rowH, stroke: PPT_COLORS.divider }),
        cells,
        `</g>`,
      ].join("");
    })
    .join("");
  return [
    `<g id="table">`,
    rect({ x: PAD, y: top, w: CONTENT_W, h: TABLE.headH, fill: PPT_COLORS.primary, rx: 0 }),
    headCells,
    rowEls,
    rect({
      x: PAD,
      y: top,
      w: CONTENT_W,
      h: TABLE.headH + rows.length * rowH,
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
 * 要点清单的行高（变更表 #145）：条数少就拉高（封顶 120），条数多就回到 64
 *
 * 3 条的页面在 #144 里是三条 64px 挤在内容区上半页（下面 200 多 px 空白，排版判据要报"留白不均"）；
 * 现在按条数摊开，配合整组竖直居中，3 条也铺满内容区。
 */
function listRowH(n: number): number {
  const gap = LIST.gap;
  const fit = Math.floor((BODY.h - gap * (n - 1)) / Math.max(1, n));
  return Math.max(LIST.rowH, Math.min(LIST.maxRowH, fit));
}

/**
 * 要点清单（兜底布局）：22×22 图标 + 44×44 序号底衬 + 一行大字 + 次要说明行 + 条间细线
 *
 * 这是兜底版式，但**兜底也不许是一张白页**：每条给足四件（图标 / 序号底衬 / 20px 主句 /
 * 16px 次要说明），条与条之间加一条 1px `#D6E7F8` 分隔线——5 条时形状数也过质量门禁的密度线。
 * 主句做字内强调（行首关键词 + 数字），图标取页图标（同页同款符号，就是"这一页"的记号）。
 */
function renderChecklist(page: PptPage): string {
  const items = checklistLines(page).map(splitItem);
  const n = items.length;
  if (n === 0) return "";
  const gap = LIST.gap;
  const rowH = listRowH(n);
  const top = centerInBody(n * rowH + (n - 1) * gap);
  const textX = PAD + 118;
  const maxW = CONTENT_W - 118 - 24;
  const icon = page.icon ?? PPT_DEFAULT_ICON;
  return items
    .map((item, i) => {
      const y = top + i * (rowH + gap);
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
              size: PPT_MIN_FONT,
              fill: PPT_COLORS.muted,
              lines: wrapText(item.note, PPT_MIN_FONT, maxW, 1),
              lineHeight: 24,
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
// ─── 封面（变更表 #253：照模版 s1 的版式） ──────────────────

/** 封面的四张能力卡：2×2，每张 576×148（模版每张 5.96×1.56in） */
const COVER_CARD = { w: 546, h: 148, xs: [PAD, PAD + 574], ys: [150, 314], icon: 40 } as const;
/** 封面三步落地链：3 个 380×64 的块 */
const COVER_CHAIN = { y: 486, h: 64, gap: 24 } as const;
/** 封面落地版本标签行 */
const COVER_CHIPS = { y: 570, h: 28, gap: 10, padX: 12, size: PPT_MIN_FONT } as const;

/** 封面一张能力卡：图标 + 能力名（20px 粗）+ 一行小标（13px 强调蓝）+ 两行说明（14px） */
function coverCard(block: PptBlock, i: number): string {
  const x = COVER_CARD.xs[i % 2]!;
  const y = COVER_CARD.ys[Math.floor(i / 2)]!;
  const textX = x + 64;
  const maxW = COVER_CARD.w - 64 - 20;
  return [
    `<g id="cover-card-${i + 1}">`,
    rect({
      x,
      y,
      w: COVER_CARD.w,
      h: COVER_CARD.h,
      fill: PPT_COLORS.subtle,
      stroke: PPT_COLORS.border,
      strokeWidth: 1.5,
      rx: 10,
    }),
    iconGroup(
      `cover-card-${i + 1}-icon`,
      iconUse({
        icon: block.icon,
        x: x + 16,
        y: y + 18,
        size: COVER_CARD.icon,
        fill: PPT_COLORS.primary,
      }),
    ),
    textEl({ x: textX, y: y + 40, size: 20, fill: PPT_COLORS.primary, text: block.head, weight: true }),
    textEl({
      x: textX,
      y: y + 64,
      size: PPT_MIN_FONT,
      fill: PPT_COLORS.primaryAlt,
      text: wrapText(block.note, PPT_MIN_FONT, maxW, 1)[0]!,
      weight: true,
    }),
    ...block.lines.slice(0, 2).map((line, j) =>
      textEl({
        x: textX,
        y: y + 94 + j * 24,
        size: PPT_MIN_FONT,
        fill: PPT_COLORS.text,
        text: wrapText(line, PPT_MIN_FONT, maxW, 1)[0]!,
      }),
    ),
    `</g>`,
  ].join("");
}

/** 封面落地的三步链：序号圆点 + 阶段名 + 一句说明（模版 s1 的三段式） */
function coverChain(stages: readonly PptStage[]): string {
  const n = stages.length;
  if (n === 0) return "";
  const w = Math.floor((CONTENT_W - COVER_CHAIN.gap * (n - 1)) / n);
  return stages
    .slice(0, 4)
    .map((stage, i) => {
      const x = PAD + i * (w + COVER_CHAIN.gap);
      return [
        `<g id="cover-step-${i + 1}">`,
        rect({ x, y: COVER_CHAIN.y, w, h: COVER_CHAIN.h, fill: PPT_COLORS.lightBlue, rx: 32 }),
        circle({ cx: x + 32, cy: COVER_CHAIN.y + COVER_CHAIN.h / 2, r: 14, fill: PPT_COLORS.primary }),
        textEl({
          x: x + 32,
          y: COVER_CHAIN.y + COVER_CHAIN.h / 2 + 6,
          size: PPT_MIN_FONT,
          fill: PPT_COLORS.onPrimary,
          text: String(i + 1),
          anchor: "middle",
          weight: true,
        }),
        textEl({
          x: x + 58,
          y: COVER_CHAIN.y + 26,
          size: PPT_MIN_FONT,
          fill: PPT_COLORS.primary,
          text: wrapText(stage.head, PPT_MIN_FONT, w - 74, 1)[0]!,
          weight: true,
        }),
        textEl({
          x: x + 58,
          y: COVER_CHAIN.y + 48,
          size: PPT_MIN_FONT,
          fill: PPT_COLORS.muted,
          text: wrapText(stage.note, PPT_MIN_FONT, w - 74, 1)[0]!,
        }),
        `</g>`,
      ].join("");
    })
    .join("");
}

/** 封面落地版本标签（模版 s1 的「已落地发行版：S9 · 路鸿 · 电鸿…」）：左标签 + 一排浅底胶囊 */
function coverChips(chips: readonly string[]): string {
  if (chips.length === 0) return "";
  const label = "已落地版本：";
  let x = PAD + estimateTextWidth(label, PPT_MIN_FONT);
  const parts = [
    `<g id="cover-chips">`,
    textEl({ x: PAD, y: COVER_CHIPS.y + 19, size: PPT_MIN_FONT, fill: PPT_COLORS.muted, text: label }),
  ];
  for (const [i, chip] of chips.slice(0, PPT_LIMITS.chips.max).entries()) {
    const w = estimateTextWidth(chip, COVER_CHIPS.size) + COVER_CHIPS.padX * 2;
    if (x + w > RIGHT) break;
    parts.push(
      rect({ x, y: COVER_CHIPS.y, w, h: COVER_CHIPS.h, fill: PPT_COLORS.primary, rx: 4 }),
      textEl({ x: x + COVER_CHIPS.padX, y: COVER_CHIPS.y + 19, size: COVER_CHIPS.size, fill: PPT_COLORS.onPrimary, text: chip }),
    );
    x += w + COVER_CHIPS.gap;
    if (i === chips.length - 1) break;
  }
  parts.push(`</g>`);
  return parts.join("");
}

/**
 * 封面（模版 s1 的版式）
 *
 * 标题同一套页眉（24pt），下面的四张能力卡对应 `blocks`（恰好 4 块：四个核心能力），
 * 三步落地链对应 `stages`（3 个），`chips` 是已在同类场景落地的版本/客户，
 * `highlight` 是整份方案的一句话概括（模版 s1 底部那句）。**封面也要写满**——
 * 不是一张只有标题的扉页，这是模版与"空封面"的区别。
 */
function renderCover(page: PptPage): string {
  const blocks = blocksOf(page).slice(0, PPT_LIMITS.blocks.count);
  return [
    `<g id="cover-cards">`,
    blocks.map((b, i) => coverCard(b, i)).join(""),
    `</g>`,
    `<g id="cover-chain">${coverChain(page.stages)}</g>`,
    coverChips(page.chips),
  ].join("");
}

export const PPT_LAYOUT_RENDERERS: Record<PptLayout, (page: PptPage) => string> = {
  封面: renderCover,
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
    kickerEl(page.kicker ?? "", page.icon ?? PPT_DEFAULT_ICON),
    titleEl(page),
    subtitleEl(subtitle, chips.subtitleMaxW),
    chips.svg,
    `<g id="body">${render(page)}</g>`,
    summaryEl(highlight),
    footerEl(ctx.scenarioName, ctx.index, ctx.total),
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
