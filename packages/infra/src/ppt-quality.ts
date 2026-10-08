/**
 * @scene/infra — PPT 页面质量门禁（变更表 #142 立、#144 升）
 *
 * 渲染完的 SVG 是**可以量的东西**：形状数、文字条数、文字矩形是否出界 / 相互压字、
 * 图标数、颜色数、强调处数。`checkPptDeck` 把这些量成一份确定性问题清单（不靠人眼、不靠模型自评），
 * 让"页面太空 / 挤成一团 / 没图标 / 一层白 / 没有重点"在单测里就暴露，而不是等用户看到 pptx 才发现。
 *
 * 为什么落在基础设施层而不是领域层：判据的输入是**渲染产物**（SVG 字符串），
 * 而依赖方向只允许「基础设施 → 契约」，领域层不能反向依赖基础设施。
 * 判据本身仍是纯函数、可单测（AGENTS.md §三.5：判定不进模型）。
 *
 * 变更表 #144 新增三条：**每页图标 ≥4**（数 `data-icon` 占位；嵌入后数 `<!-- icon: -->` 标记）、
 * **每页不同颜色 ≥6**（数 `#RRGGBB`）、**每页强调 ≥3 处**（数 `<tspan>` 字内强调段 + 16px 以上的粗体字）。
 */

import { PPT_LIMITS } from "@scene/contract";
import { PPT_COLORS, estimateTextWidth } from "./ppt-svg.js";

/** 质量门禁的判据（集中在这里，单测与验收脚本同源） */
export const PPT_QUALITY = {
  /** 每页形状数下限（`<rect|<text|<line|<path|<circle|<polygon` 计数） */
  minShapes: 22,
  /** 画布安全边（文字矩形不许出 1280×720 的这个内缩框） */
  safeMargin: 8,
  /** 压字阈值：两个文字矩形在两个方向上的重叠都超过这个像素数才算相交 */
  overlapTolerance: 4,
  /** 每页图标数下限（页图标 + 块/栏/阶段/层/卡片/清单条 + 结论带 `bulb`，每页至少 4 个） */
  minIconsPerPage: 4,
  /** 每页不同颜色数下限（色阶 + 语义色，一层白不算"有层次"） */
  minColorsPerPage: 6,
  /** 每页强调处数下限（字内强调段 + 粗体重点字） */
  minEmphasisPerPage: 3,
  /** 算"重点粗体字"的最小字号（15px 小注 / 页脚不算） */
  emphasisMinSize: 16,
} as const;

export type PptQualityCode =
  | "页面太空"
  | "缺小节标签"
  | "缺结论带"
  | "文本越界"
  | "文本相交"
  | "信息量不足"
  | "图标不足"
  | "颜色层次不足"
  | "重点不突出";

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

/** 取一个标签属性（缺属性给空串） */
function attrOf(attrs: string, name: string): string {
  return new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
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
  TEXT_RE.lastIndex = 0;
  for (let m = TEXT_RE.exec(svg); m !== null; m = TEXT_RE.exec(svg)) {
    const attrs = m[1]!;
    const baseSize = Number(attrOf(attrs, "font-size"));
    const size0 = Number.isFinite(baseSize) && baseSize > 0 ? baseSize : 0;
    const pieces = piecesOf(m[2]!, size0);
    if (pieces.length === 0) continue;
    const x = Number(attrOf(attrs, "x"));
    const y = Number(attrOf(attrs, "y"));
    const anchor = attrOf(attrs, "text-anchor") || "start";
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
    });
  }
  return out;
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

/** 一页的检查（密度 / 骨架 / 出界 / 相交 / 文字量 / 图标 / 颜色 / 强调） */
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
  if (!hasGroup(svg, "highlight") || !groupHasText(svg, "highlight")) {
    issues.push({ page, code: "缺结论带", detail: "没有底部结论带（highlight）" });
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
  return issues;
}

/**
 * 一份 PPT 的质量门禁（每页一个 SVG 字符串，按顺序给）
 *
 * @returns 问题清单；空数组 = 密度、骨架、边界、压字、信息量、图标、颜色、强调全部合格
 */
export function checkPptDeck(svgs: readonly string[]): PptQualityIssue[] {
  return svgs.flatMap((svg, i) => checkPage(svg, i + 1));
}

/** 语义色令牌（导出脚本 / 验收脚本想按名字取色时用，避免各写一份十六进制） */
export const PPT_SEMANTIC_COLORS = {
  problem: PPT_COLORS.orange,
  value: PPT_COLORS.green,
} as const;
