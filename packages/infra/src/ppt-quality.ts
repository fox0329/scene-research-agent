/**
 * @scene/infra — PPT 页面质量门禁（变更表 #142 立、#144 升、#145 升：最小字号 + 版面判据）
 *
 * 渲染完的 SVG 是**可以量的东西**：形状数、文字条数、文字矩形是否出界 / 相互压字、图标数、
 * 颜色数、强调处数、字号、网格对齐、留白、行首标点、孤字行。`checkPptDeck` 把这些量成一份
 * 确定性问题清单（不靠人眼、不靠模型自评），让"页面太空 / 挤成一团 / 没图标 / 一层白 / 没有重点 /
 * 字号太小 / 没对齐 / 内容挤在上半页"在单测里就暴露，而不是等用户看到 pptx 才发现。
 *
 * 为什么落在基础设施层而不是领域层：判据的输入是**渲染产物**（SVG 字符串），
 * 而依赖方向只允许「基础设施 → 契约」，领域层不能反向依赖基础设施。
 * 判据本身仍是纯函数、可单测（AGENTS.md §三.5：判定不进模型）。
 *
 * 判据分两类（变更表 #145，导出链路按这个分类决定"重试 / 修渲染 / 拒绝写出"）：
 *  - **内容类**（`PPT_CONTENT_ISSUES`）：信息量不足、图标不足、重点不突出——是模型没写够，
 *    可以按页点名后让模型重写一次；
 *  - **渲染类**（`PPT_RENDER_ISSUES`）：越界、压字、字号过小、缺骨架、未对齐网格、留白不均、
 *    行首标点、孤字行、颜色层次不足——是**确定性缺陷**，只能改渲染层（`ppt-svg.ts`），
 *    不许靠模型重试掩盖；渲染层修完仍不达标就是我们的 bug，导出时拒绝写出并点名。
 *
 * `PPT_MIN_QUALITY` 是用户定调（#145）的**最低要求**：阈值只许收紧，不许放宽。
 */

import { PPT_LIMITS, PPT_MIN_FONT } from "@scene/contract";
import { PPT_COLORS, PPT_GRID, PPT_MIN_ORPHAN_CHARS, estimateTextWidth, hasLeadingPunct } from "./ppt-svg.js";

/**
 * 最低要求（用户定调：变更表 #145「将这个质量水平作为 PPT 生成的最低要求」）
 *
 * 逐条含义见下面各字段的注释。**调低任何一个数就是降低交付标准**——
 * 导出链路（`apps/server/src/ppt-export.ts`）直接引用这一组阈值。
 */
export const PPT_MIN_QUALITY = {
  /** 一句话说明这组阈值的性质（写进注释也写进代码，防止以后再被关掉） */
  note: "本组阈值是用户定调的 PPT 最低要求（变更表 #145）：只许收紧，不许放宽",
  /** 每页形状数下限（`<rect|<text|<line|<path|<circle|<polygon` 计数） */
  minShapes: 22,
  /** 每页文字条数下限（与契约同源：一页 ≈ 4 块 × 3–4 行） */
  minSentencesPerPage: PPT_LIMITS.minSentencesPerPage,
  /**
   * 每页图标数下限（页图标 + 块/栏/阶段/层/卡片/清单条 + 结论带 `bulb`）
   *
   * 「一页的图标数 ≥ 该页元素数」**不是**这里的一条独立判据（变更表 #151）：领域层 `iconOf`
   * 会给每个元素兜一个图标、渲染层还会画页图标与结论带 `bulb`，那条线在结构上必然成立、
   * 永远判不出来；可达的那条线就是本值（≥4）。同页**图标重复**判在大纲阶段
   * （`checkPptOutlineQuality` 的问题码 `图标重复`）——图标名在大纲里就定了，渲染层只是照抄，
   * 不在两边重复判。
   */
  minIconsPerPage: 3,
  /** 每页不同颜色数下限（色阶 + 语义色，一层白不算"有层次"） */
  minColorsPerPage: 6,
  /** 每页强调处数下限（字内强调段 + 粗体重点字） */
  minEmphasisPerPage: 3,
  /** 内容文字最小字号（契约常量 `PPT_MIN_FONT`；页脚与页码按 `minMetaFontSize`） */
  minFontSize: PPT_LIMITS.minFontSize,
  /** 页脚 / 页码这类元信息文字的最小字号（内容一律 ≥ `minFontSize`） */
  minMetaFontSize: PPT_LIMITS.minMetaFontSize,
  /** 正文内容元素距画布四边的最小距离（版式实际留 80，这里卡 40 的下限） */
  minContentMargin: 40,
  /** 同层级元素落在版式网格上的允许偏差（块 550×216 在 x=80/650、栏 550、层 1120 …） */
  gridTolerance: 2,
  /** 内容区（y=170..620）底部允许的最大空白（超了就是"页面下坠/留白不均"） */
  maxBottomGap: 120,
  /** 换行后最后一行最少几个字（避免孤字行；与渲染层 `PPT_MIN_ORPHAN_CHARS` 同源） */
  minOrphanChars: PPT_MIN_ORPHAN_CHARS,
} as const;

/** 质量门禁的判据（最低要求 + 只影响"怎么判"的技术阈值，单测与验收脚本同源） */
export const PPT_QUALITY = {
  ...PPT_MIN_QUALITY,
  /** 文本不许出 1280×720 画布的绝对安全边（比 `minContentMargin` 更松，管的是"画布外") */
  safeMargin: 8,
  /** 压字阈值：两个文字矩形在两个方向上的重叠都超过这个像素数才算相交 */
  overlapTolerance: 4,
  /** 算"重点粗体字"的最小字号（16px 的正文与 15px 小注 / 页脚不算） */
  emphasisMinSize: 15,
} as const;

export type PptQualityCode =
  | "页面太空"
  | "缺小节标签"
  | "缺一句话总结"
  | "缺页码"
  | "缺封面"
  | "文本越界"
  | "文本相交"
  | "信息量不足"
  | "图标不足"
  | "颜色层次不足"
  | "重点不突出"
  | "字号过小"
  | "超出安全边"
  | "未对齐网格"
  | "留白不均"
  | "行首标点"
  | "孤字行";

/** 内容类问题：模型没写够 / 没给图标 / 没重点——按页点名后可让模型重写一次 */
export const PPT_CONTENT_ISSUES: readonly PptQualityCode[] = ["信息量不足", "图标不足", "重点不突出"];

/**
 * 渲染类问题：确定性缺陷（越界 / 压字 / 字号 / 骨架 / 网格 / 留白 / 标点 / 孤字行 / 颜色）
 *
 * 这类问题**不靠模型重试**：先在渲染层修（`ppt-svg.ts` 的版式与断行），修完再判；
 * 仍不达标就是我们的 bug，导出时拒绝写出并在 notice 里点名（不许静默放过）。
 */
export const PPT_RENDER_ISSUES: readonly PptQualityCode[] = [
  "页面太空",
  "缺小节标签",
  "缺一句话总结",
  "缺页码",
  "缺封面",
  "文本越界",
  "文本相交",
  "颜色层次不足",
  "字号过小",
  "超出安全边",
  "未对齐网格",
  "留白不均",
  "行首标点",
  "孤字行",
];

/** 这条问题是不是"内容类"（该重试） */
export function isPptContentIssue(code: PptQualityCode): boolean {
  return PPT_CONTENT_ISSUES.includes(code);
}

/** 这条问题是不是"渲染类"（该修渲染层，不该重试） */
export function isPptRenderIssue(code: PptQualityCode): boolean {
  return PPT_RENDER_ISSUES.includes(code);
}

export interface PptQualityIssue {
  /** 第几页（1 起） */
  page: number;
  code: PptQualityCode;
  /** 人话说明（带具体数字，便于定位） */
  detail: string;
}

/** 一个文字块在画布上的估算矩形 */
export interface PptTextRect {
  text: string;
  x: number;
  y: number;
  size: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 最内层的 `<g id="…">`（判"同一个换行段"用） */
  group: string;
  /** 从外到内的组 id 路径（认 `footer` / `page-no` / `body` 这类组用） */
  path: readonly string[];
}

/** 一个图形元素在画布上的框（网格对齐 / 安全边 / 留白判据用） */
export interface PptShapeBox {
  /** 元素名：rect / line / circle / polygon */
  kind: string;
  /** 最内层的 `<g id="…">`（`block-1` / `card-2` / `row-3` …） */
  group: string;
  /** 从外到内的组 id 路径 */
  path: readonly string[];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** XML 实体还原（宽度按还原后的字符算，`&amp;` 只占一个字符宽） */
function unescXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 去掉标签只留文字（`<tspan>` 强调段与纯文字一视同仁） */
function stripTags(inner: string): string {
  return inner.replace(/<[^>]*>/g, "");
}

/** 每页形状数（图形元素计数，与验收脚本同一套正则） */
export function countSvgShapes(svg: string): number {
  return (svg.match(/<(rect|text|line|path|circle|polygon)\b/g) ?? []).length;
}

/** `<text>` 与 `<tspan>` 的配对匹配（内容里可以有非定位 `<tspan>` 强调段） */
const TEXT_RE = /<text([^>]*)>([\s\S]*?)<\/text>/g;
const TSPAN_RE = /<tspan([^>]*)>([\s\S]*?)<\/tspan>/g;

/**
 * 一次遍历拿全：`<g id>` / `</g>` / `<text>` / 图形元素（组路径靠栈维护）
 *
 * 组路径是 #145 的判据基础：`footer` / `page-no` 是元信息文字（字号例外），
 * `body` 是内容区（安全边与留白判据的范围），`block-1-line-1-text` 是"同一个换行段"（孤字行判据）。
 */
const TOKEN_RE = /<g\b([^>]*)>|<\/g>|<text\b([^>]*)>([\s\S]*?)<\/text>|<(rect|line|circle|polygon)\b([^>]*?)\/?>/g;

interface SvgToken {
  kind: "text" | "shape";
  attrs: string;
  inner: string;
  name: string;
}

function walkSvg(svg: string, visit: (token: SvgToken, path: readonly string[]) => void): void {
  const stack: string[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(svg); m !== null; m = TOKEN_RE.exec(svg)) {
    if (m[1] !== undefined) {
      stack.push(attrOf(m[1], "id"));
      continue;
    }
    if (m[0] === "</g>") {
      stack.pop();
      continue;
    }
    const path = [...stack];
    if (m[3] !== undefined) visit({ kind: "text", attrs: m[2]!, inner: m[3]!, name: "text" }, path);
    else visit({ kind: "shape", attrs: m[5]!, inner: "", name: m[4]! }, path);
  }
}

/** 取一个标签属性（缺属性给空串） */
function attrOf(attrs: string, name: string): string {
  return new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
}

/** 取一个数值属性（缺 / 非法给 NaN，由调用方判） */
function numOf(attrs: string, name: string): number {
  const raw = attrOf(attrs, name);
  return raw === "" ? Number.NaN : Number(raw);
}

/** 一个 `<text>` 里的一段文字（tspan 段有自己的字号） */
interface Piece {
  text: string;
  size: number;
}

/** 空段不算（`<tspan></tspan>` 与纯空白都不计入宽度与条数） */
function pushPiece(out: Piece[], raw: string, size: number): void {
  const text = unescXml(stripTags(raw));
  if (text.trim() === "") return;
  out.push({ text, size });
}

/** 把一个 `<text>` 的内容拆成若干片段：非定位 `<tspan>` 段用它的字号，其余用父元素字号 */
function piecesOf(inner: string, baseSize: number): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  TSPAN_RE.lastIndex = 0;
  for (let m = TSPAN_RE.exec(inner); m !== null; m = TSPAN_RE.exec(inner)) {
    if (m.index > last) pushPiece(out, inner.slice(last, m.index), baseSize);
    const size = Number(attrOf(m[1]!, "font-size"));
    pushPiece(out, m[2]!, Number.isFinite(size) && size > 0 ? size : baseSize);
    last = m.index + m[0].length;
  }
  if (last < inner.length) pushPiece(out, inner.slice(last), baseSize);
  return out;
}

/**
 * 抠出 SVG 里所有非空 `<text>` 的估算矩形（量尺与渲染共用 `estimateTextWidth`）
 *
 * 一个 `<text>` = 一个矩形（同一行的多个 `<tspan>` 强调段合并计宽，**不互相判压字**）；
 * 垂直范围按段里最大的字号算（20/22px 的强调段比正文高），宽度按各段自己的字号累加。
 */
export function svgTextRects(svg: string): PptTextRect[] {
  const out: PptTextRect[] = [];
  walkSvg(svg, (t, path) => {
    if (t.kind !== "text") return;
    const baseSize = Number(attrOf(t.attrs, "font-size"));
    const size0 = Number.isFinite(baseSize) && baseSize > 0 ? baseSize : 0;
    const pieces = piecesOf(t.inner, size0);
    if (pieces.length === 0) return;
    const x = Number(attrOf(t.attrs, "x"));
    const y = Number(attrOf(t.attrs, "y"));
    const anchor = attrOf(t.attrs, "text-anchor") || "start";
    const size = Math.max(...pieces.map((p) => p.size));
    const w = pieces.reduce((a, p) => a + estimateTextWidth(p.text, p.size), 0);
    const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    out.push({
      text: pieces.map((p) => p.text).join(""),
      x,
      y,
      size,
      left,
      right: left + w,
      // 显式基线：上界按 0.86em 估（CJK 近满框），下界按 0.22em 估
      top: y - size * 0.86,
      bottom: y + size * 0.22,
      group: path[path.length - 1] ?? "",
      path,
    });
  });
  return out;
}

/** 抠出 SVG 里所有图形元素的框（矩形 / 直线 / 圆点 / 多边形；`<path>` 是收尾脚本转出来的，不参与判据） */
export function svgShapeBoxes(svg: string): PptShapeBox[] {
  const out: PptShapeBox[] = [];
  walkSvg(svg, (t, path) => {
    if (t.kind !== "shape") return;
    const box = shapeBoxOf(t.name, t.attrs);
    if (box === null) return;
    out.push({ kind: t.name, group: path[path.length - 1] ?? "", path, ...box });
  });
  return out;
}

/** 一个图形元素的外框（取不到就给 null） */
function shapeBoxOf(
  name: string,
  attrs: string,
): { left: number; top: number; right: number; bottom: number } | null {
  if (name === "rect") {
    const x = numOf(attrs, "x");
    const y = numOf(attrs, "y");
    const w = numOf(attrs, "width");
    const h = numOf(attrs, "height");
    return boxOf([[x, y], [x + w, y + h]]);
  }
  if (name === "line") {
    return boxOf([
      [numOf(attrs, "x1"), numOf(attrs, "y1")],
      [numOf(attrs, "x2"), numOf(attrs, "y2")],
    ]);
  }
  if (name === "circle") {
    const cx = numOf(attrs, "cx");
    const cy = numOf(attrs, "cy");
    const r = numOf(attrs, "r");
    return boxOf([[cx - r, cy - r], [cx + r, cy + r]]);
  }
  const nums = (attrOf(attrs, "points").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return boxOf(pts);
}

/** 一组点 → 外框（含非法值时给 null） */
function boxOf(pts: readonly (readonly [number, number])[]): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if ([...xs, ...ys].some((v) => !Number.isFinite(v))) return null;
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** 页面上的文字条数（非空 `<text>` 计数：形状里出现多少条，就是多少条） */
export function countSvgTexts(svg: string): number {
  return svgTextRects(svg).length;
}

/**
 * 页面上的图标数（变更表 #144）
 *
 * 三种形态都要认（同一条判据在"渲染完 / 收尾后"两处都能用）：
 * ① 渲染产物：数 `<use data-icon="…">` 占位；
 * ② 收尾脚本保留注释的版本：数 `<!-- icon: 名字 -->`；
 * ③ 真技能 `finalize_svg.py`（ElementTree 重新序列化会把注释吃掉，真机已验证）：
 *    数我们自己的图标包层 `<g id="kicker-icon">` / `<g id="block-1-icon">` …
 * ——**不数 `<path>`**：`fix-rounded` 会把圆角矩形也变成 path，数 path 会把它当图标。
 */
export function countSvgIcons(svg: string): number {
  const placeholders = (svg.match(/data-icon="/g) ?? []).length;
  if (placeholders > 0) return placeholders;
  const comments = (svg.match(/<!--\s*icon:/g) ?? []).length;
  if (comments > 0) return comments;
  return (svg.match(/id="[^"]*-icon"/g) ?? []).length;
}

/** 页面用到的不同颜色数（`#RRGGBB` 去重；一层白 = 1） */
export function countSvgColors(svg: string): number {
  const hex = svg.match(/#[0-9A-Fa-f]{6}/g) ?? [];
  return new Set(hex.map((c) => c.toUpperCase())).size;
}

/**
 * 页面的强调处数（变更表 #144）
 *
 * 两种都算"重点"：① **字内强调段**（`<tspan>`：行首关键词 20px 粗深蓝 / 数字 22px 粗橙）；
 * ② **16px 以上的粗体字**（块头 / 卡片数值 / 阶段名 / 表头 / 序号 / 结论带）——
 * 15px 的小注与页脚不算（它们每页都有，量它们没有区分度）。
 */
export function countSvgEmphasis(svg: string): number {
  const inline = (svg.match(/<tspan\b/g) ?? []).length;
  let bold = 0;
  TEXT_RE.lastIndex = 0;
  for (let m = TEXT_RE.exec(svg); m !== null; m = TEXT_RE.exec(svg)) {
    const attrs = m[1]!;
    if (!/font-weight="bold"/.test(attrs)) continue;
    if (Number(attrOf(attrs, "font-size")) < PPT_QUALITY.emphasisMinSize) continue;
    if (piecesOf(m[2]!, 0).length === 0) continue;
    bold += 1;
  }
  return inline + bold;
}

/**
 * 抠出某个 `<g id="…">` 组的完整内容（**按嵌套深度配对 `</g>`**）
 *
 * 不能用 `<g id="x">[\s\S]*?</g>`：骨架组里还有图标子组（`<g id="kicker-icon">`），
 * 非贪婪匹配会停在子组的 `</g>` 上，于是"有字"被判成"没字"（真跑踩过一次）。
 */
function groupContent(svg: string, id: string): string | null {
  const start = svg.indexOf(`<g id="${id}">`);
  if (start < 0) return null;
  const re = /<g\b[^>]*>|<\/g>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(svg); m !== null; m = re.exec(svg)) {
    if (m[0] === "</g>") {
      depth -= 1;
      if (depth === 0) return svg.slice(start, m.index + m[0].length);
    } else {
      depth += 1;
    }
  }
  return svg.slice(start);
}

/** 某个 `<g id="…">` 组里有没有非空文字（小节标签 / 结论带必须真有字） */
function groupHasText(svg: string, id: string): boolean {
  const inner = groupContent(svg, id);
  if (inner === null) return false;
  TEXT_RE.lastIndex = 0;
  for (let t = TEXT_RE.exec(inner); t !== null; t = TEXT_RE.exec(inner)) {
    if (unescXml(stripTags(t[2]!)).trim() !== "") return true;
  }
  return false;
}

function hasGroup(svg: string, id: string): boolean {
  return svg.includes(`<g id="${id}">`);
}

/** 两个矩形的重叠量（两个方向都给出） */
function overlap(a: PptTextRect, b: PptTextRect): { x: number; y: number } {
  return {
    x: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    y: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

// ─── #145 新增判据：字号 / 安全边 / 网格 / 留白 / 行首标点 / 孤字行 ──────────

/** 元信息文字（页脚、页码）：字号允许低一档，其余文字一律 ≥ 内容下限 */
function isMetaText(rect: PptTextRect): boolean {
  return (
    rect.path.includes("footer") ||
    rect.path.includes("page-no") ||
    rect.path.includes("kicker")
  );
}

/** 内容区里的元素（安全边与留白判据只看内容区，骨架贴边是版式本身的选择） */
function inBody(path: readonly string[]): boolean {
  return path.includes("body");
}

/** 字号判据：内容 ≥ `minFontSize`、页脚页码 ≥ `minMetaFontSize` */
function fontSizeIssues(svg: string, page: number): PptQualityIssue[] {
  const out: PptQualityIssue[] = [];
  for (const r of svgTextRects(svg)) {
    const meta = isMetaText(r);
    const min = meta ? PPT_QUALITY.minMetaFontSize : PPT_QUALITY.minFontSize;
    if (r.size >= min) continue;
    out.push({
      page,
      code: "字号过小",
      detail: `${meta ? "页脚/页码" : "内容"}文字「${r.text}」只有 ${r.size}px，小于下限 ${min}px`,
    });
  }
  return out;
}

/** 内容区元素的框（文字矩形 + 图形框） */
function contentBoxes(svg: string): { label: string; left: number; top: number; right: number; bottom: number }[] {
  const texts = svgTextRects(svg)
    .filter((r) => inBody(r.path))
    .map((r) => ({ label: r.group === "" ? "文字" : r.group, left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
  const shapes = svgShapeBoxes(svg)
    .filter((b) => inBody(b.path))
    .map((b) => ({ label: b.group === "" ? b.kind : b.group, left: b.left, top: b.top, right: b.right, bottom: b.bottom }));
  return [...shapes, ...texts];
}

/** 安全边判据：内容元素距画布四边 ≥ `minContentMargin` */
function safeMarginIssues(svg: string, page: number): PptQualityIssue[] {
  const m = PPT_QUALITY.minContentMargin;
  const out: PptQualityIssue[] = [];
  for (const b of contentBoxes(svg)) {
    const out2: string[] = [];
    if (b.left < m) out2.push(`左 ${Math.round(b.left)}`);
    if (b.right > 1280 - m) out2.push(`右 ${Math.round(b.right)}`);
    if (b.top < m) out2.push(`上 ${Math.round(b.top)}`);
    if (b.bottom > 720 - m) out2.push(`下 ${Math.round(b.bottom)}`);
    if (out2.length === 0) continue;
    out.push({
      page,
      code: "超出安全边",
      detail: `${b.label} 越出内容安全边（距边不足 ${m}px：${out2.join("、")}）`,
    });
  }
  return out;
}

/** 留白判据：内容区底部空白 > `maxBottomGap` 就是"内容挤在上半页" */
function balanceIssues(svg: string, page: number): PptQualityIssue[] {
  const boxes = contentBoxes(svg);
  if (boxes.length === 0) return [];
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const gap = PPT_GRID.bodyBottom - bottom;
  if (gap <= PPT_QUALITY.maxBottomGap) return [];
  return [
    {
      page,
      code: "留白不均",
      detail: `内容只铺到 y=${Math.round(bottom)}，内容区（到 y=${PPT_GRID.bodyBottom}）底部空着 ${Math.round(gap)}px（上限 ${PPT_QUALITY.maxBottomGap}px）——页面下坠，应摊开或居中`,
    },
  ];
}

/** 网格判据：同层级元素的 x / 宽度必须落在版式网格上（偏差 > `gridTolerance` 算没对齐） */
function gridIssues(svg: string, page: number): PptQualityIssue[] {
  const boxes = svgShapeBoxes(svg);
  const out: PptQualityIssue[] = [];
  const tol = PPT_QUALITY.gridTolerance;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tol;
  const flag = (id: string, what: string, got: number, want: number): void => {
    out.push({
      page,
      code: "未对齐网格",
      detail: `${id} 的${what}是 ${Math.round(got)}，网格值是 ${Math.round(want)}（偏差 >${tol}px）`,
    });
  };
  /** 组内第一个矩形（各布局的容器矩形都是组内第一个 rect） */
  const firstRect = (id: string): PptShapeBox | undefined =>
    boxes.find((b) => b.group === id && b.kind === "rect");

  const check = (id: string, want: { xs?: readonly number[]; ys?: readonly number[]; w?: number; h?: number }): void => {
    const r = firstRect(id);
    if (r === undefined) return;
    if (want.w !== undefined && !near(r.right - r.left, want.w)) flag(id, "宽", r.right - r.left, want.w);
    if (want.h !== undefined && !near(r.bottom - r.top, want.h)) flag(id, "高", r.bottom - r.top, want.h);
    if (want.xs !== undefined && !want.xs.some((v) => near(r.left, v))) flag(id, "x", r.left, want.xs[0]!);
    if (want.ys !== undefined && !want.ys.some((v) => near(r.top, v))) flag(id, "y", r.top, want.ys[0]!);
  };

  for (let i = 1; i <= PPT_LIMITS.blocks.count; i += 1) {
    check(`block-${i}`, {
      xs: PPT_GRID.block.xs,
      ys: PPT_GRID.block.ys,
      w: PPT_GRID.block.w,
      h: PPT_GRID.block.h,
    });
  }
  for (let i = 1; i <= PPT_LIMITS.columns.count; i += 1) {
    check(`col-${i}`, { xs: PPT_GRID.col.xs, w: PPT_GRID.col.w, h: PPT_GRID.col.h });
  }
  for (let i = 1; i <= PPT_LIMITS.layers.max; i += 1) {
    check(`layer-${i}`, { xs: [PPT_GRID.layer.x], w: PPT_GRID.layer.w });
  }
  for (let i = 1; i <= PPT_LIMITS.bullets.max; i += 1) {
    check(`item-${i}`, { xs: [PPT_GRID.list.x], w: PPT_GRID.list.w });
  }
  for (let i = 1; i <= PPT_LIMITS.table.maxRows; i += 1) {
    check(`row-${i}`, { xs: [PPT_GRID.list.x], w: PPT_GRID.list.w });
  }
  check("table", { xs: [PPT_GRID.list.x], w: PPT_GRID.list.w });

  /** 等分件（卡片 / 阶段）：同页等宽 + 等距 + 起点在内容区左缘 */
  const equalRun = (prefix: string, count: number, gap: number, h: number): void => {
    const items: PptShapeBox[] = [];
    for (let i = 1; i <= count; i += 1) {
      const r = firstRect(`${prefix}-${i}`);
      if (r !== undefined) items.push(r);
    }
    if (items.length === 0) return;
    const w0 = items[0]!.right - items[0]!.left;
    if (!near(items[0]!.left, PPT_GRID.x)) flag(`${prefix}-1`, "x", items[0]!.left, PPT_GRID.x);
    items.forEach((r, i) => {
      const w = r.right - r.left;
      if (!near(w, w0)) flag(`${prefix}-${i + 1}`, "宽", w, w0);
      if (!near(r.bottom - r.top, h)) flag(`${prefix}-${i + 1}`, "高", r.bottom - r.top, h);
      const prev = items[i - 1];
      if (prev !== undefined && !near(r.left - prev.left, w0 + gap)) {
        flag(`${prefix}-${i + 1}`, "间距", r.left - prev.left, w0 + gap);
      }
    });
  };
  equalRun("card", PPT_LIMITS.cards.max, PPT_GRID.card.gap, PPT_GRID.card.h);
  equalRun("stage", PPT_LIMITS.stages.max, PPT_GRID.stage.gap, PPT_GRID.stage.h);
  return out;
}

/** 行首标点判据：任何一行文字都不许以 `，。、；：！？）》」` 开头（中文行首禁则） */
export function findLeadingPunctLines(svg: string): string[] {
  return svgTextRects(svg)
    .filter((r) => hasLeadingPunct(r.text.trim()))
    .map((r) => r.text);
}

/**
 * 孤字行判据：换行后最后一行不足 `minOrphanChars` 个字
 *
 * "同一个换行段"= 同一组（`…-text` / `card-1-value`）+ 同字号 + 同 x + 行距落在 1.1–2.2 倍字号之间；
 * 单行文字不算换行段。**以省略号收尾的行是"放不下压的"**（硬约束允许的压缩），不算孤字行。
 */
export function findOrphanLines(svg: string): string[] {
  const rects = svgTextRects(svg);
  const sameRun = (a: PptTextRect, b: PptTextRect): boolean => {
    if (a.group === "" || a.group !== b.group) return false;
    if (a.size !== b.size) return false;
    if (Math.abs(a.x - b.x) > PPT_QUALITY.gridTolerance) return false;
    const dy = b.y - a.y;
    return dy >= a.size * 1.1 && dy <= a.size * 2.2;
  };
  const out: string[] = [];
  for (let i = 1; i < rects.length; i += 1) {
    const prev = rects[i - 1]!;
    const cur = rects[i]!;
    if (!sameRun(prev, cur)) continue;
    const next = rects[i + 1];
    if (next !== undefined && sameRun(cur, next)) continue; // 不是末行
    if (cur.text.endsWith("…")) continue; // 压缩出来的行，不算孤字
    if (Array.from(cur.text).length < PPT_QUALITY.minOrphanChars) out.push(cur.text);
  }
  return out;
}

/** 一页的检查（密度 / 骨架 / 出界 / 相交 / 信息量 / 图标 / 颜色 / 强调 + #145 六条版面判据） */
function checkPage(svg: string, page: number): PptQualityIssue[] {
  const issues: PptQualityIssue[] = [];
  const shapes = countSvgShapes(svg);
  if (shapes < PPT_QUALITY.minShapes) {
    issues.push({
      page,
      code: "页面太空",
      detail: `只有 ${shapes} 个形状，少于下限 ${PPT_QUALITY.minShapes} 个`,
    });
  }
  if (!hasGroup(svg, "kicker") || !groupHasText(svg, "kicker")) {
    issues.push({ page, code: "缺小节标签", detail: "没有左上角的小节标签胶囊（kicker）" });
  }
  if (!hasGroup(svg, "summary") || !groupHasText(svg, "summary")) {
    issues.push({ page, code: "缺一句话总结", detail: "没有底部一句话总结（summary）" });
  }
  if (!hasGroup(svg, "page-no") || !groupHasText(svg, "page-no")) {
    issues.push({ page, code: "缺页码", detail: "页脚右侧没有「NN / MM」页码（模版基线）" });
  }

  const icons = countSvgIcons(svg);
  if (icons < PPT_QUALITY.minIconsPerPage) {
    issues.push({
      page,
      code: "图标不足",
      detail: `只有 ${icons} 个图标，少于下限 ${PPT_QUALITY.minIconsPerPage} 个（页图标 + 每块/栏/阶段/层/卡片 + 结论带 bulb）`,
    });
  }

  const colors = countSvgColors(svg);
  if (colors < PPT_QUALITY.minColorsPerPage) {
    issues.push({
      page,
      code: "颜色层次不足",
      detail: `只用了 ${colors} 种颜色，少于下限 ${PPT_QUALITY.minColorsPerPage} 种`,
    });
  }

  const emphasis = countSvgEmphasis(svg);
  if (emphasis < PPT_QUALITY.minEmphasisPerPage) {
    issues.push({
      page,
      code: "重点不突出",
      detail: `只有 ${emphasis} 处强调（字内强调段 + ${PPT_QUALITY.emphasisMinSize}px 以上粗体字），少于下限 ${PPT_QUALITY.minEmphasisPerPage} 处`,
    });
  }

  const rects = svgTextRects(svg);
  const margin = PPT_QUALITY.safeMargin;
  for (const r of rects) {
    const out: string[] = [];
    if (r.left < margin) out.push(`左 ${Math.round(r.left)}`);
    if (r.right > 1280 - margin) out.push(`右 ${Math.round(r.right)}`);
    if (r.top < margin) out.push(`上 ${Math.round(r.top)}`);
    if (r.bottom > 720 - margin) out.push(`下 ${Math.round(r.bottom)}`);
    if (out.length > 0) {
      issues.push({
        page,
        code: "文本越界",
        detail: `文字「${r.text}」越出安全边（${out.join("、")}）`,
      });
    }
  }

  const tol = PPT_QUALITY.overlapTolerance;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const o = overlap(rects[i]!, rects[j]!);
      if (o.x > tol && o.y > tol) {
        issues.push({
          page,
          code: "文本相交",
          detail: `「${rects[i]!.text}」与「${rects[j]!.text}」压字（重叠 ${Math.round(o.x)}×${Math.round(o.y)}px）`,
        });
      }
    }
  }

  if (rects.length < PPT_LIMITS.minSentencesPerPage) {
    issues.push({
      page,
      code: "信息量不足",
      detail: `只有 ${rects.length} 条文字，少于 ${PPT_LIMITS.minSentencesPerPage} 条（每页信息量≈4 块 × 3–4 行）`,
    });
  }

  // #145 版面判据（字号 / 安全边 / 网格 / 留白 / 行首标点 / 孤字行）
  issues.push(...fontSizeIssues(svg, page));
  issues.push(...safeMarginIssues(svg, page));
  issues.push(...gridIssues(svg, page));
  issues.push(...balanceIssues(svg, page));
  for (const line of findLeadingPunctLines(svg)) {
    issues.push({ page, code: "行首标点", detail: `文字行「${line}」以标点开头（中文行首禁则）` });
  }
  for (const line of findOrphanLines(svg)) {
    issues.push({
      page,
      code: "孤字行",
      detail: `换行后最后一行只有 ${Array.from(line).length} 个字「${line}」，少于 ${PPT_QUALITY.minOrphanChars} 个字`,
    });
  }
  return issues;
}

/**
 * 一份 PPT 的质量门禁（每页一个 SVG 字符串，按顺序给）
 *
 * @returns 问题清单；空数组 = 密度、骨架、边界、压字、信息量、图标、颜色、强调、字号、
 *          网格对齐、留白、行首标点、孤字行**全部合格**。按 `isPptContentIssue` 分成
 *          "该重试"与"该修渲染层"两类（导出链路据此决定下一步）。
 */
export function checkPptDeck(
  svgs: readonly string[],
  opts: { requireCover?: boolean } = {},
): PptQualityIssue[] {
  const issues = svgs.flatMap((svg, i) => checkPage(svg, i + 1));
  // 模版基线（变更表 #253）：第一页必须是封面，且封面要有四张能力卡（不是空扉页）
  // 单页测试传 `requireCover: false`（测的是页面判据，不是整份结构）
  const cover = svgs[0];
  if (opts.requireCover !== false && (cover === undefined || !hasGroup(cover, "cover-cards"))) {
    issues.push({
      page: 1,
      code: "缺封面",
      detail: "第一页不是封面（模版基线：标题 + 四张能力卡 + 三步落地链 + 一句话总结）",
    });
  }
  return issues;
}

/** 语义色令牌（导出脚本 / 验收脚本想按名字取色时用，避免各写一份十六进制） */
export const PPT_SEMANTIC_COLORS = {
  problem: PPT_COLORS.orange,
  value: PPT_COLORS.green,
} as const;

/** 内容文字最小字号（契约常量的转出，方便调用方只从门禁模块取数） */
export { PPT_MIN_FONT };
