/**
 * @scene/infra — PPT 质量门禁测试（变更表 #142 立、#144 升）
 *
 * `checkPptDeck` 是确定性的"页面体检"：形状数（页面太空）、小节标签与结论带、
 * 文本出界（8px 安全边）、文本压字（4px 阈值）、文字条数（信息量），
 * #144 追加图标数（图标不足）、颜色数（颜色层次不足）、强调处数（重点不突出）。
 * 这里既测真渲染的页过闸，也测每一类问题**抓得住**（用最小人造 SVG 定位判据）。
 */

import { describe, it, expect } from "vitest";
import { PPT_LIMITS, type PptPage } from "@scene/contract";
import { estimateTextWidth, renderPptDeck } from "./ppt-svg.js";
import {
  PPT_QUALITY,
  checkPptDeck,
  countSvgColors,
  countSvgEmphasis,
  countSvgIcons,
  countSvgShapes,
  countSvgTexts,
  svgTextRects,
} from "./ppt-quality.js";

const FONT = 'Arial, &quot;Microsoft YaHei&quot;, sans-serif';

function text(x: number, y: number, size: number, content: string, anchor?: "middle" | "end"): string {
  const a = anchor ? ` text-anchor="${anchor}"` : "";
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="#37474F"${a}>${content}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill = "#FFFFFF"): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}"/>`;
}

/** 人造页：骨架齐（kicker + highlight），内容由调用方给 */
function pageSvg(content: string, opts: { kicker?: boolean; highlight?: boolean } = {}): string {
  const kicker =
    opts.kicker === false
      ? ""
      : `<g id="kicker">${rect(80, 36, 120, 30, "#E3F2FD")}${text(96, 56, 15, "项目硬规则")}</g>`;
  const band =
    opts.highlight === false
      ? ""
      : `<g id="highlight">${rect(80, 634, 1120, 50, "#E3F2FD")}${text(110, 666, 19, "结论带要有话说")}</g>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    rect(0, 0, 1280, 720),
    kicker,
    `<g id="hd">${text(80, 88, 34, "一页标题")}${text(1200, 56, 15, "第 1 页 / 共 7 页", "end")}</g>`,
    `<g id="body">${content}</g>`,
    band,
    `<g id="footer">${text(80, 700, 13, "场景通 · 智慧会议室")}</g>`,
    `</svg>`,
  ].join("");
}

/** 一页合规的渲染（真渲染器产出，用来对比"过闸"） */
function realPage(): PptPage {
  return {
    layout: "要点清单",
    kicker: "现场现状",
    icon: "presentation",
    title: "现场今天怎么转",
    subtitle: "人工记录、事后补录，数据留不下来",
    blocks: [],
    columns: [],
    stages: [],
    layers: [],
    cards: [],
    table: null,
    chips: [],
    highlight: "记录留不下来，账就算不清",
    bullets: [
      "巡检靠纸质表单，一天一交",
      "数据事后补录，口径对不上",
      "异常靠电话上报，常常漏",
      "台账分散在各班组手里",
      "月底对账翻单据两天起步",
      "班组之间口径不统一",
    ],
  };
}

describe("checkPptDeck — 真渲染的页过闸", () => {
  it("一份 3 页渲染结果 0 问题", () => {
    const svgs = renderPptDeck({ pages: [realPage(), realPage(), realPage()] }, { scenarioName: "智慧会议室" }).map(
      (p) => p.svg,
    );
    expect(checkPptDeck(svgs)).toEqual([]);
  });

  it("空数组 → 没有问题", () => {
    expect(checkPptDeck([])).toEqual([]);
  });
});

describe("checkPptDeck — 兜底要点清单也不许是白页（#142 收尾）", () => {
  const list = (bullets: string[]): PptPage => ({ ...realPage(), layout: "要点清单", bullets });
  const render = (p: PptPage): string =>
    renderPptDeck({ pages: [p] }, { scenarioName: "智慧会议室" })[0]!.svg;

  it("5 条要点：形状数 ≥22、门禁 0 问题（加密后每条三件）", () => {
    const svg = render(
      list([
        "巡检靠纸质表单，一天一交",
        "数据事后补录，口径对不上",
        "异常靠电话上报，常常漏掉",
        "台账分散在各班组手里",
        "月底对账要翻两天单据",
      ]),
    );
    expect(countSvgShapes(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minShapes);
    expect(checkPptDeck([svg])).toEqual([]);
  });

  it("真跑那种只剩 2 条的空页 → 门禁仍然抓得住（#144 后由「信息量不足」兜住）", () => {
    // #144 给每条要点加了图标 + 行前方块，2 条的页形状数已经过了密度线，
    // 但文字条数仍然只有 10 条（< 12）——空页照样被判出来，判据换成更准的「信息量不足」。
    const svg = render(list(["协议未收录的私有协议需另行适配", "老设备不支持远程升级"]));
    expect(countSvgTexts(svg)).toBeLessThan(PPT_LIMITS.minSentencesPerPage);
    expect(checkPptDeck([svg]).map((i) => i.code)).toContain("信息量不足");
  });
});

/**
 * 一个"什么都不缺"的人造页（图标 ≥4 / 颜色 ≥6 / 强调 ≥3 / 形状与文字够）
 *
 * 用来做正例对照：门禁该报的只有坏页，别把好页也带上。
 */
function fullPageSvg(content = "", opts: { bold?: boolean } = {}): string {
  const palette = ["#90CAF9", "#E3F2FD", "#1565C0", "#D6E7F8", "#0D47A1"];
  const rects = Array.from({ length: 24 }, (_, i) => rect(80 + i, 240, 10, 10, palette[i % palette.length]!)).join(
    "",
  );
  const icons = Array.from(
    { length: 4 },
    (_, i) => `<use data-icon="tabler-outline/presentation" x="${100 + i * 40}" y="300" width="22" height="22" fill="#0D47A1"/>`,
  ).join("");
  const bolds =
    opts.bold === false
      ? ""
      : Array.from(
          { length: 12 },
          (_, i) =>
            `<text x="100" y="${360 + i * 20}" font-family="${FONT}" font-size="16" fill="#37474F" font-weight="bold">重点${i}</text>`,
        ).join("");
  return pageSvg(rects + icons + bolds + content);
}

/** 单色页（只有白底与正文灰），用来验证「颜色层次不足」抓得住 */
function monoSvg(content: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    `<g id="kicker">${rect(80, 36, 120, 30)}${text(96, 56, 15, "单色页")}</g>`,
    `<g id="highlight">${rect(80, 634, 1120, 50)}${text(110, 666, 19, "结论带")}</g>`,
    content,
    `</svg>`,
  ].join("");
}

describe("checkPptDeck — 图标（#144：每页 ≥4）", () => {
  it("正例：图标 ≥4 的页不报「图标不足」", () => {
    const svg = fullPageSvg();
    expect(countSvgIcons(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minIconsPerPage);
    expect(checkPptDeck([svg]).map((i) => i.code)).not.toContain("图标不足");
  });

  it("反例：一个图标都没有 → 记「图标不足」", () => {
    const svg = fullPageSvg().replace(/<use data-icon="[^"]*"[^>]*\/>/g, "");
    expect(countSvgIcons(svg)).toBe(0);
    const issues = checkPptDeck([svg]).filter((i) => i.code === "图标不足");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minIconsPerPage));
  });

  it("finalize 嵌入后：有注释按注释数，注释被吃掉就按图标包层数（都不数 fix-rounded 的 path）", () => {
    const withComments = [
      `<!-- icon: tabler-outline/presentation -->`,
      `<g transform="translate(100, 200)" fill="none" stroke="#0D47A1"><path d="M1 1h2v2z"/></g>`,
      `<!-- icon: tabler-outline/bulb -->`,
      `<g transform="translate(100, 300)" fill="none" stroke="#0D47A1"><path d="M3 3h4v4z"/></g>`,
      `<path d="M20 20h10v10z" fill="#E3F2FD"/>`,
    ].join("");
    expect(countSvgIcons(withComments)).toBe(2);

    // 真机形态：技能用 ElementTree 重新序列化，注释没了，但我们的图标包层还在
    const realShape = [
      `<g id="kicker-icon"><g transform="translate(92.0, 40.0)" fill="none" stroke="#0D47A1"><path d="M3.5 5.5l1.5 1.5z"/></g></g>`,
      `<g id="block-1-icon"><g transform="translate(92.0, 173.0)" fill="none" stroke="#0D47A1"><path d="M1 1h2z"/></g></g>`,
      `<g id="block-2-icon"><g transform="translate(92.0, 403.0)" fill="none" stroke="#0D47A1"><path d="M2 2h3z"/></g></g>`,
      `<path d="M20 20h10v10z" fill="#E3F2FD"/>`, // fix-rounded 出来的圆角矩形，不许当图标
    ].join("");
    expect(countSvgIcons(realShape)).toBe(3);
  });
});

describe("checkPptDeck — 页面太空", () => {
  it("形状数少于下限 → 记「页面太空」", () => {
    const svg = pageSvg(text(100, 200, 20, "只有一句话"));
    const issues = checkPptDeck([svg]);
    expect(issues.some((i) => i.code === "页面太空")).toBe(true);
    expect(countSvgShapes(svg)).toBeLessThan(PPT_QUALITY.minShapes);
  });

  it("形状够多就不报（阈值 22）", () => {
    const stuff = Array.from({ length: 22 }, (_, i) => rect(80 + i, 200, 10, 10, "#90CAF9")).join("");
    const svg = pageSvg(stuff);
    expect(countSvgShapes(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minShapes);
    expect(checkPptDeck([svg]).some((i) => i.code === "页面太空")).toBe(false);
  });
});

describe("checkPptDeck — 颜色层次（#144：每页 ≥6）", () => {
  it("正例：色阶 + 语义色的页不报「颜色层次不足」", () => {
    const svg = fullPageSvg();
    expect(countSvgColors(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minColorsPerPage);
    expect(checkPptDeck([svg]).map((i) => i.code)).not.toContain("颜色层次不足");
  });

  it("反例：整页只有一种底色与一种文字色 → 记「颜色层次不足」", () => {
    const stuff = Array.from({ length: 24 }, (_, i) => rect(80 + i, 200, 10, 10)).join("");
    const svg = monoSvg(stuff);
    expect(countSvgColors(svg)).toBeLessThan(PPT_QUALITY.minColorsPerPage);
    const issues = checkPptDeck([svg]).filter((i) => i.code === "颜色层次不足");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minColorsPerPage));
  });
});

describe("checkPptDeck — 强调（#144：每页 ≥3 处）", () => {
  it("正例：粗体重点字与字内强调段都算", () => {
    const svg = fullPageSvg();
    expect(countSvgEmphasis(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minEmphasisPerPage);
    expect(checkPptDeck([svg]).map((i) => i.code)).not.toContain("重点不突出");
  });

  it("反例：整页没有粗体也没有 tspan → 记「重点不突出」", () => {
    const plain = Array.from({ length: 12 }, (_, i) => text(100, 200 + i * 30, 16, `第${i}条内容`)).join("");
    const svg = fullPageSvg(plain, { bold: false });
    expect(countSvgEmphasis(svg)).toBe(0);
    const issues = checkPptDeck([svg]).filter((i) => i.code === "重点不突出");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minEmphasisPerPage));
  });

  it("tspan 只算字内强调，15px 的小注粗体不算（没有区分度）", () => {
    const small = `<text x="100" y="200" font-family="${FONT}" font-size="15" fill="#5A7395" font-weight="bold">小注</text>`;
    expect(countSvgEmphasis(`<svg>${small}</svg>`)).toBe(0);
    const big = `<text x="100" y="200" font-family="${FONT}" font-size="20" fill="#37474F" font-weight="bold">块头</text>`;
    expect(countSvgEmphasis(`<svg>${big}</svg>`)).toBe(1);
  });
});

describe("checkPptDeck — 骨架（小节标签 / 结论带）", () => {
  it("缺 kicker → 记「缺小节标签」；缺 highlight → 记「缺结论带」", () => {
    const stuff = Array.from({ length: 20 }, (_, i) => rect(80 + i, 200, 10, 10)).join("");
    const codes = checkPptDeck([pageSvg(stuff, { kicker: false, highlight: false })]).map((i) => i.code);
    expect(codes).toContain("缺小节标签");
    expect(codes).toContain("缺结论带");
  });

  it("有组但没有文字也算缺（胶囊里必须有字）", () => {
    const svg = pageSvg(
      Array.from({ length: 20 }, (_, i) => rect(80 + i, 200, 10, 10)).join(""),
    ).replace(/<text [^>]*>项目硬规则<\/text>/, "");
    expect(checkPptDeck([svg]).map((i) => i.code)).toContain("缺小节标签");
  });
});

describe("checkPptDeck — 文本越界（8px 安全边）", () => {
  it("贴到画布边缘的文字被记「文本越界」", () => {
    const svg = pageSvg(text(1276, 400, 20, "顶到右边了"));
    const issues = checkPptDeck([svg]).filter((i) => i.code === "文本越界");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("顶到右边了");
  });

  it("锚点 end / middle 也按真实矩形判", () => {
    const ok = pageSvg(text(1272, 400, 20, "贴着安全边", "end"));
    expect(checkPptDeck([ok]).some((i) => i.code === "文本越界")).toBe(false);
    const bad = pageSvg(text(1275, 400, 20, "出界了", "end"));
    expect(checkPptDeck([bad]).some((i) => i.code === "文本越界")).toBe(true);
  });
});

describe("checkPptDeck — 文本压字（4px 阈值）", () => {
  it("两块文字几乎重合 → 记「文本相交」", () => {
    const svg = pageSvg(text(100, 200, 20, "第一块文字") + text(105, 205, 20, "第二块文字"));
    const issues = checkPptDeck([svg]).filter((i) => i.code === "文本相交");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("第一块文字");
  });

  it("横向留 3px（小于阈值）不算相交，摆开了更不算", () => {
    const w = svgTextRects(text(0, 0, 20, "第一块文字"))[0]!.right;
    const gap3 = pageSvg(text(100, 200, 20, "第一块文字") + text(100 + w + 3, 200, 20, "第二块文字"));
    expect(checkPptDeck([gap3]).some((i) => i.code === "文本相交")).toBe(false);
    const apart = pageSvg(text(100, 200, 20, "第一块文字") + text(100, 300, 20, "第二块文字"));
    expect(checkPptDeck([apart]).some((i) => i.code === "文本相交")).toBe(false);
  });
});

describe("checkPptDeck — 信息量（最少 12 条文字）", () => {
  it("文字太少 → 记「信息量不足」，条数上限与契约同源", () => {
    const svg = pageSvg(text(100, 200, 20, "只有一条"));
    const issues = checkPptDeck([svg]).filter((i) => i.code === "信息量不足");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_LIMITS.minSentencesPerPage));
    expect(countSvgTexts(svg)).toBeLessThan(PPT_LIMITS.minSentencesPerPage);
  });

  it("空文字不算条数", () => {
    const svg = pageSvg(text(100, 200, 20, "") + text(100, 240, 20, "有字"));
    expect(countSvgTexts(svg)).toBe(6); // kicker + 标题 + 页码 + 有字 + 结论带 + 页脚
  });

  it("多页问题按页号归位（第 2 页的问题不记到第 1 页）", () => {
    const issues = checkPptDeck([fullPageSvg(), pageSvg(text(100, 200, 20, "少"))]);
    expect(issues.every((i) => i.page === 2)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("svgTextRects — tspan 感知（#144）", () => {
  it("同一行的多个 tspan 合并成一个矩形（不与自身判压字），宽度按各段字号累加", () => {
    const rich = `<text x="100" y="200" font-family="${FONT}" font-size="16" fill="#37474F">前缀<tspan font-size="20" fill="#0D47A1" font-weight="bold">关键词</tspan>正文</text>`;
    const rects = svgTextRects(rich);
    expect(rects).toHaveLength(1);
    const r = rects[0]!;
    expect(r.text).toBe("前缀关键词正文");
    // 垂直范围按最大的字号（20），宽度按各段自己的字号
    expect(r.size).toBe(20);
    expect(r.top).toBeCloseTo(200 - 20 * 0.86);
    expect(r.right - r.left).toBeCloseTo(
      estimateTextWidth("前缀", 16) + estimateTextWidth("关键词", 20) + estimateTextWidth("正文", 16),
    );
    expect(checkPptDeck([pageSvg(rich)]).some((i) => i.code === "文本相交")).toBe(false);
  });

  it("空 tspan 不占宽度、也不算文字条数", () => {
    const svg = pageSvg(
      `<text x="100" y="200" font-family="${FONT}" font-size="16" fill="#37474F">有字<tspan font-size="20" fill="#FF9800">   </tspan></text>`,
    );
    expect(svgTextRects(svg).filter((r) => r.text === "有字")).toHaveLength(1);
  });
});
