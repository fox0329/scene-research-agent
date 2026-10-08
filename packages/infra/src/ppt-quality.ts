/**
 * @scene/infra — PPT 页面质量门禁（变更表 #142）
 *
 * 渲染完的 SVG 是**可以量的东西**：形状数、文字条数、文字矩形是否出界 / 相互压字。
 * `checkPptDeck` 把这些量成一份确定性问题清单（不靠人眼、不靠模型自评），
 * 让"页面太空 / 挤成一团"在单测里就暴露，而不是等用户看到 pptx 才发现。
 *
 * 为什么落在基础设施层而不是领域层：判据的输入是**渲染产物**（SVG 字符串），
 * 而依赖方向只允许「基础设施 → 契约」，领域层不能反向依赖基础设施。
 * 判据本身仍是纯函数、可单测（AGENTS.md §三.5：判定不进模型）。
 */

import { PPT_LIMITS } from "@scene/contract";
import { estimateTextWidth } from "./ppt-svg.js";

/** 质量门禁的判据（集中在这里，单测与验收脚本同源） */
export const PPT_QUALITY = {
  /** 每页形状数下限（`<rect|<text|<line|<path|<circle|<polygon` 计数） */
  minShapes: 22,
  /** 画布安全边（文字矩形不许出 1280×720 的这个内缩框） */
  safeMargin: 8,
  /** 压字阈值：两个文字矩形在两个方向上的重叠都超过这个像素数才算相交 */
  overlapTolerance: 4,
} as const;

export type PptQualityCode =
  | "页面太空"
  | "缺小节标签"
  | "缺结论带"
  | "文本越界"
  | "文本相交"
  | "信息量不足";

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

/** 每页形状数（图形元素计数，与验收脚本同一套正则） */
export function countSvgShapes(svg: string): number {
  return (svg.match(/<(rect|text|line|path|circle|polygon)\b/g) ?? []).length;
}

/** 抠出 SVG 里所有非空 `<text>` 的估算矩形（量尺与渲染共用 `estimateTextWidth`） */
export function svgTextRects(svg: string): PptTextRect[] {
  const out: PptTextRect[] = [];
  const re = /<text ([^>]*)>([^<]*)<\/text>/g;
  for (let m = re.exec(svg); m !== null; m = re.exec(svg)) {
    const attrs = m[1]!;
    const attr = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const text = unescXml(m[2]!);
    if (text.trim() === "") continue;
    const x = Number(attr("x"));
    const y = Number(attr("y"));
    const size = Number(attr("font-size"));
    const anchor = attr("text-anchor") || "start";
    const w = estimateTextWidth(text, size);
    const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    out.push({
      text,
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

/** 某个 `<g id="…">` 组里有没有非空文字（小节标签 / 结论带必须真有字） */
function groupHasText(svg: string, id: string): boolean {
  const m = new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`).exec(svg);
  if (m === null) return false;
  return /<text [^>]*>[^<]+<\/text>/.test(m[1]!);
}

function hasGroup(svg: string, id: string): boolean {
  return new RegExp(`<g id="${id}">`).test(svg);
}

/** 两个矩形的重叠量（两个方向都给出） */
function overlap(a: PptTextRect, b: PptTextRect): { x: number; y: number } {
  return {
    x: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    y: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

/** 一页的检查（密度 / 骨架 / 出界 / 相交 / 文字量） */
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
 * @returns 问题清单；空数组 = 密度、骨架、边界、压字、信息量全部合格
 */
export function checkPptDeck(svgs: readonly string[]): PptQualityIssue[] {
  return svgs.flatMap((svg, i) => checkPage(svg, i + 1));
}
