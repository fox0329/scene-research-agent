/**
 * @scene/infra — PPT 质量门禁测试（变更表 #142 立、#144 升、#145 升）
 *
 * `checkPptDeck` 是确定性的"页面体检"：形状数（页面太空）、小节标签与结论带、
 * 文本出界（8px 安全边）、文本压字（4px 阈值）、文字条数（信息量），
 * #144 追加图标数（图标不足）、颜色数（颜色层次不足）、强调处数（重点不突出），
 * #145 追加字号（字号过小）、内容安全边（超出安全边）、网格对齐（未对齐网格）、
 * 留白（留白不均）、行首禁则（行首标点）、孤字行（孤字行）——`PPT_MIN_QUALITY` 是最低要求。
 * 这里既测真渲染的页过闸，也测每一类问题**抓得住**（用最小人造 SVG 定位判据）。
 */

import { describe, it, expect } from "vitest";
import { PPT_LIMITS, type PptPage } from "@scene/contract";
import { estimateTextWidth, renderPptDeck } from "./ppt-svg.js";
import {
  PPT_CONTENT_ISSUES,
  PPT_MIN_QUALITY,
  PPT_QUALITY,
  PPT_RENDER_ISSUES,
  checkPptDeck,
  countSvgColors,
  countSvgEmphasis,
  countSvgIcons,
  countSvgShapes,
  countSvgTexts,
  findLeadingPunctLines,
  findOrphanLines,
  isPptContentIssue,
  isPptRenderIssue,
  svgShapeBoxes,
  svgTextRects,
} from "./ppt-quality.js";
import { PPT_MIN_FONT } from "@scene/contract";

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
      : `<g id="kicker">${text(80, 40, 14, "项目硬规则")}</g>`;
  const summary =
    opts.highlight === false
      ? ""
      : `<g id="summary">${text(80, 668, 15, "总结要有一句话")}</g>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    rect(0, 0, 1280, 720),
    kicker,
    `<g id="hd">${text(80, 72, 32, "一页标题")}</g>`,
    `<g id="body">${content}</g>`,
    summary,
    `<g id="footer">${text(80, 700, 14, "场景通 · 智慧会议室")}</g>`,
    `<g id="page-no">${text(1200, 700, 14, "01 / 07", "end")}</g>`,
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

/** 封面页（模版 s1 的版式：四张能力卡 + 三步链 + chips + 总结） */
function coverPage(): PptPage {
  return {
    layout: "封面",
    kicker: "总体方案",
    icon: "target",
    title: "一个平台管住全厂的设备与能耗",
    subtitle: "旁路取数、统一模型、按工艺段算账",
    blocks: [
      { head: "旁路采集不动机组", icon: "plug", note: "不改原 PLC 程序与安全回路", lines: ["从既有通信口取数", "新增点位只做接线与组态"] },
      { head: "统一设备模型", icon: "database", note: "一处建档，全局共用", lines: ["设备、测点、口径一次定清", "报表与看板同源出数"] },
      { head: "按工艺段算能耗", icon: "gauge", note: "吨水电耗可复算", lines: ["分项计量到工艺段", "与电费单逐月对账"] },
      { head: "异常进工单", icon: "alert-triangle", note: "告警到人、处置留痕", lines: ["越限告警经 Webhook 派单", "处置过程可回查"] },
    ],
    columns: [],
    stages: [
      { head: "试点一座厂", icon: "building-community", note: "先跑通采集与出表" },
      { head: "复制到其余厂站", icon: "sitemap", note: "按区域分批上线" },
      { head: "验收与移交", icon: "circle-check", note: "按口径逐项验收" },
    ],
    layers: [],
    cards: [],
    table: null,
    chips: ["试点厂", "泵站", "集团平台"],
    highlight: "先让设备看得见，再让账算得清",
  };
}

/** 单页渲染（真渲染器） */
function realPageSvg(page: PptPage = realPage()): string {
  return renderPptDeck({ pages: [page] }, { scenarioName: "智慧会议室" })[0]!.svg;
}

describe("checkPptDeck — 真渲染的页过闸", () => {
  it("封面 + 两页正文：0 问题", () => {
    const svgs = renderPptDeck({ pages: [coverPage(), realPage(), realPage()] }, { scenarioName: "智慧会议室" }).map(
      (p) => p.svg,
    );
    expect(checkPptDeck(svgs)).toEqual([]);
  });

  it("第一页不是封面 → 记「缺封面」；空数组只记这一条", () => {
    expect(checkPptDeck([realPageSvg()])).toContainEqual(
      expect.objectContaining({ page: 1, code: "缺封面" }),
    );
    expect(checkPptDeck([])).toEqual([expect.objectContaining({ code: "缺封面" })]);
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
    expect(checkPptDeck([svg], { requireCover: false })).toEqual([]);
  });

  it("真跑那种只剩 2 条的空页 → 门禁仍然抓得住（#144 后由「信息量不足」兜住）", () => {
    // #144 给每条要点加了图标 + 行前方块，2 条的页形状数已经过了密度线，
    // 但文字条数仍然只有 10 条（< 12）——空页照样被判出来，判据换成更准的「信息量不足」。
    const svg = render(list(["协议未收录的私有协议需另行适配", "老设备不支持远程升级"]));
    expect(countSvgTexts(svg)).toBeLessThan(PPT_LIMITS.minSentencesPerPage);
    expect(checkPptDeck([svg], { requireCover: false }).map((i) => i.code)).toContain("信息量不足");
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
    `<g id="kicker">${rect(80, 36, 120, 30)}${text(96, 56, 16, "单色页")}</g>`,
    `<g id="highlight">${rect(80, 634, 1120, 50)}${text(110, 666, 19, "结论带")}</g>`,
    content,
    `</svg>`,
  ].join("");
}

describe("checkPptDeck — 图标（#144：每页 ≥4）", () => {
  it("正例：图标 ≥4 的页不报「图标不足」", () => {
    const svg = fullPageSvg();
    expect(countSvgIcons(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minIconsPerPage);
    expect(checkPptDeck([svg], { requireCover: false }).map((i) => i.code)).not.toContain("图标不足");
  });

  it("反例：一个图标都没有 → 记「图标不足」", () => {
    const svg = fullPageSvg().replace(/<use data-icon="[^"]*"[^>]*\/>/g, "");
    expect(countSvgIcons(svg)).toBe(0);
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "图标不足");
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
    const issues = checkPptDeck([svg], { requireCover: false });
    expect(issues.some((i) => i.code === "页面太空")).toBe(true);
    expect(countSvgShapes(svg)).toBeLessThan(PPT_QUALITY.minShapes);
  });

  it("形状够多就不报（阈值 22）", () => {
    const stuff = Array.from({ length: 22 }, (_, i) => rect(80 + i, 200, 10, 10, "#90CAF9")).join("");
    const svg = pageSvg(stuff);
    expect(countSvgShapes(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minShapes);
    expect(checkPptDeck([svg], { requireCover: false }).some((i) => i.code === "页面太空")).toBe(false);
  });
});

describe("checkPptDeck — 颜色层次（#144：每页 ≥6）", () => {
  it("正例：色阶 + 语义色的页不报「颜色层次不足」", () => {
    const svg = fullPageSvg();
    expect(countSvgColors(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minColorsPerPage);
    expect(checkPptDeck([svg], { requireCover: false }).map((i) => i.code)).not.toContain("颜色层次不足");
  });

  it("反例：整页只有一种底色与一种文字色 → 记「颜色层次不足」", () => {
    const stuff = Array.from({ length: 24 }, (_, i) => rect(80 + i, 200, 10, 10)).join("");
    const svg = monoSvg(stuff);
    expect(countSvgColors(svg)).toBeLessThan(PPT_QUALITY.minColorsPerPage);
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "颜色层次不足");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minColorsPerPage));
  });
});

describe("checkPptDeck — 强调（#144：每页 ≥3 处）", () => {
  it("正例：粗体重点字与字内强调段都算", () => {
    const svg = fullPageSvg();
    expect(countSvgEmphasis(svg)).toBeGreaterThanOrEqual(PPT_QUALITY.minEmphasisPerPage);
    expect(checkPptDeck([svg], { requireCover: false }).map((i) => i.code)).not.toContain("重点不突出");
  });

  it("反例：整页没有粗体也没有 tspan → 记「重点不突出」", () => {
    const plain = Array.from({ length: 12 }, (_, i) => text(100, 200 + i * 30, 16, `第${i}条内容`)).join("");
    const svg = fullPageSvg(plain, { bold: false });
    expect(countSvgEmphasis(svg)).toBe(0);
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "重点不突出");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minEmphasisPerPage));
  });

  it("tspan 只算字内强调，14px 的小注粗体不算（没有区分度）", () => {
    const small = `<text x="100" y="200" font-family="${FONT}" font-size="14" fill="#5A7395" font-weight="bold">小注</text>`;
    expect(countSvgEmphasis(`<svg>${small}</svg>`)).toBe(0);
    const big = `<text x="100" y="200" font-family="${FONT}" font-size="20" fill="#37474F" font-weight="bold">块头</text>`;
    expect(countSvgEmphasis(`<svg>${big}</svg>`)).toBe(1);
  });
});

describe("checkPptDeck — 骨架（小节标签 / 结论带）", () => {
  it("缺 kicker → 记「缺小节标签」；缺 summary → 记「缺一句话总结」", () => {
    const stuff = Array.from({ length: 20 }, (_, i) => rect(80 + i, 200, 10, 10)).join("");
    const codes = checkPptDeck([pageSvg(stuff, { kicker: false, highlight: false })]).map((i) => i.code);
    expect(codes).toContain("缺小节标签");
    expect(codes).toContain("缺一句话总结");
  });

  it("有组但没有文字也算缺（胶囊里必须有字）", () => {
    const svg = pageSvg(
      Array.from({ length: 20 }, (_, i) => rect(80 + i, 200, 10, 10)).join(""),
    ).replace(/<text [^>]*>项目硬规则<\/text>/, "");
    expect(checkPptDeck([svg], { requireCover: false }).map((i) => i.code)).toContain("缺小节标签");
  });
});

describe("checkPptDeck — 文本越界（8px 安全边）", () => {
  it("贴到画布边缘的文字被记「文本越界」", () => {
    const svg = pageSvg(text(1276, 400, 20, "顶到右边了"));
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "文本越界");
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
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "文本相交");
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
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "信息量不足");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_LIMITS.minSentencesPerPage));
    expect(countSvgTexts(svg)).toBeLessThan(PPT_LIMITS.minSentencesPerPage);
  });

  it("空文字不算条数", () => {
    const svg = pageSvg(text(100, 200, 20, "") + text(100, 240, 20, "有字"));
    expect(countSvgTexts(svg)).toBe(6); // kicker + 标题 + 页码 + 有字 + 结论带 + 页脚
  });

  it("多页问题按页号归位（第 2 页的问题不记到第 1 页）", () => {
    const issues = checkPptDeck([fullPageSvg(), pageSvg(text(100, 200, 20, "少"))], { requireCover: false });
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

describe("checkPptDeck — 最低要求（变更表 #145：PPT_MIN_QUALITY 是用户定调的下限）", () => {
  it("门禁阈值与最低要求同源（内容 15 / 元信息 14 / 安全边 40 / 网格 2 / 留白 120 / 孤字 3）", () => {
    expect(PPT_QUALITY.minFontSize).toBe(PPT_MIN_FONT);
    expect(PPT_MIN_FONT).toBe(15);
    expect(PPT_QUALITY.minMetaFontSize).toBe(14);
    expect(PPT_QUALITY.minContentMargin).toBe(40);
    expect(PPT_QUALITY.gridTolerance).toBe(2);
    expect(PPT_QUALITY.maxBottomGap).toBe(120);
    expect(PPT_QUALITY.minOrphanChars).toBe(3);
    expect(PPT_MIN_QUALITY.note).toContain("最低要求");
  });

  it("问题分成「内容类（该重试）」与「渲染类（该修渲染层）」，两类不重叠、覆盖全部判据", () => {
    for (const code of PPT_CONTENT_ISSUES) expect(isPptContentIssue(code)).toBe(true);
    for (const code of PPT_CONTENT_ISSUES) expect(isPptRenderIssue(code)).toBe(false);
    for (const code of PPT_RENDER_ISSUES) expect(isPptRenderIssue(code)).toBe(true);
    for (const code of PPT_RENDER_ISSUES) expect(isPptContentIssue(code)).toBe(false);
    // 三个内容类问题就是用户点名的那三个
    expect([...PPT_CONTENT_ISSUES]).toEqual(["信息量不足", "图标不足", "重点不突出"]);
  });
});

describe("checkPptDeck — 字号过小（#253：内容 ≥15、页脚页码 ≥14）", () => {
  it("正例：15px 正文 + 14px 页脚页码不报", () => {
    const svg = pageSvg(text(100, 300, PPT_MIN_FONT, "十六号正文"));
    expect(checkPptDeck([svg], { requireCover: false }).some((i) => i.code === "字号过小")).toBe(false);
  });

  it("反例：14px 的正文被记「字号过小」并点名文字", () => {
    const svg = pageSvg(text(100, 300, 14, "十四号正文"));
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "字号过小");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("十四号正文");
    expect(issues[0]!.detail).toContain(String(PPT_MIN_FONT));
  });

  it("反例：页脚 13px（低于元信息下限 14）也记", () => {
    const svg = pageSvg(text(100, 300, 15, "正文")).replace(
      /<g id="footer">.*?<\/g>/,
      `<g id="footer">${text(80, 700, 13, "场景通")}</g>`,
    );
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "字号过小");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("页脚/页码");
  });

  it("14px 的页码在 <g id=\"page-no\"> 里是元信息，不算过小", () => {
    const svg = pageSvg(text(100, 300, 15, "正文"));
    expect(svg).toContain(`<g id="page-no">`);
    expect(checkPptDeck([svg], { requireCover: false }).some((i) => i.code === "字号过小")).toBe(false);
  });
});

describe("checkPptDeck — 超出安全边（#145：内容元素距边 ≥40）", () => {
  it("正例：内容区里的元素留够 40px 不报", () => {
    const svg = pageSvg(rect(80, 170, 1120, 450, "#E3F2FD"));
    expect(checkPptDeck([svg], { requireCover: false }).some((i) => i.code === "超出安全边")).toBe(false);
  });

  it("反例：内容元素贴到画布边（不足 40px）→ 记「超出安全边」", () => {
    const svg = pageSvg(rect(20, 170, 400, 200, "#E3F2FD"));
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "超出安全边");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.minContentMargin));
  });

  it("骨架（结论带贴到 y=684）不算内容：越界判据只管内容区", () => {
    // 结论带在 <g id="highlight"> 里，离底边 36px——比 40px 还近，但不该被判
    expect(checkPptDeck([fullPageSvg()]).some((i) => i.code === "超出安全边")).toBe(false);
  });
});

describe("checkPptDeck — 未对齐网格（#145：同层级元素落版式网格，偏差 ≤2px）", () => {
  it("正例：块 550×216 落在 x=80/650、y=170/400 不报", () => {
    const good =
      `<g id="block-1">${rect(80, 170, 550, 216)}</g>` + `<g id="block-2">${rect(650, 170, 550, 216)}</g>`;
    expect(checkPptDeck([pageSvg(good)]).some((i) => i.code === "未对齐网格")).toBe(false);
  });

  it("反例：块宽偏了 8px → 记「未对齐网格」并给出网格值", () => {
    const bad = `<g id="block-1">${rect(80, 170, 542, 216)}</g>`;
    const issues = checkPptDeck([pageSvg(bad)]).filter((i) => i.code === "未对齐网格");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("block-1");
    expect(issues[0]!.detail).toContain("550");
  });

  it("反例：卡片不等宽 / 不等距也记（等分件必须同宽同距，起点在内容区左缘）", () => {
    const bad =
      `<g id="card-1">${rect(80, 245, 350, 300)}</g>` +
      `<g id="card-2">${rect(455, 245, 360, 300)}</g>` +
      `<g id="card-3">${rect(840, 245, 360, 300)}</g>`;
    const codes = checkPptDeck([pageSvg(bad)]).filter((i) => i.code === "未对齐网格");
    expect(codes.length).toBeGreaterThan(0);
  });

  it("2px 以内算对齐（阈值同源 gridTolerance）", () => {
    const near = `<g id="block-1">${rect(81, 171, 549, 215)}</g>`;
    expect(checkPptDeck([pageSvg(near)]).some((i) => i.code === "未对齐网格")).toBe(false);
  });
});

describe("checkPptDeck — 留白不均（#145：内容区底部空白 ≤120px）", () => {
  it("正例：内容铺到内容区底部不报", () => {
    const svg = pageSvg(rect(80, 170, 1120, 450, "#E3F2FD"));
    expect(checkPptDeck([svg], { requireCover: false }).some((i) => i.code === "留白不均")).toBe(false);
  });

  it("反例：内容挤在上半页（底部空 300px）→ 记「留白不均」", () => {
    const svg = pageSvg(rect(80, 170, 1120, 150, "#E3F2FD"));
    const issues = checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "留白不均");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain(String(PPT_QUALITY.maxBottomGap));
  });

  it("留白刚好卡在下限（空 120px）不报，121px 就报", () => {
    const ok = pageSvg(rect(80, 170, 1120, 330, "#E3F2FD")); // 底 500，空 120
    expect(checkPptDeck([ok]).some((i) => i.code === "留白不均")).toBe(false);
    const bad = pageSvg(rect(80, 170, 1120, 329, "#E3F2FD")); // 底 499，空 121
    expect(checkPptDeck([bad]).some((i) => i.code === "留白不均")).toBe(true);
  });
});

describe("checkPptDeck — 行首标点（#145：中文行首禁则）", () => {
  it("正例：行首是字，标点都在行内", () => {
    const svg = pageSvg(text(100, 300, 16, "巡检靠纸质表单，一天一交"));
    expect(findLeadingPunctLines(svg)).toEqual([]);
  });

  it("反例：行首是逗号 / 句号 / 右括号都记", () => {
    const svg = pageSvg(text(100, 300, 16, "，一天一交") + text(100, 340, 16, "。补录口径对不上") + text(100, 380, 16, "）都要留痕"));
    const lines = findLeadingPunctLines(svg);
    expect(lines).toHaveLength(3);
    expect(checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "行首标点")).toHaveLength(3);
  });

  it("缩进空格后仍是标点开头也算（trim 后判）", () => {
    const svg = pageSvg(text(100, 300, 16, "　、半角空格在前"));
    expect(findLeadingPunctLines(svg)).toHaveLength(1);
  });
});

describe("checkPptDeck — 孤字行（#145：换行后末行 <3 字）", () => {
  it("正例：同一段两行，末行 4 个字不报", () => {
    const svg = pageSvg(
      `<g id="block-1-line-1-text">` +
        text(100, 300, 16, "巡检靠纸质表单") +
        text(100, 330, 16, "一天一交留痕") +
        `</g>`,
    );
    expect(findOrphanLines(svg)).toEqual([]);
  });

  it("反例：同一段两行末行只有 2 个字 → 记「孤字行」", () => {
    const svg = pageSvg(
      `<g id="block-1-line-1-text">` +
        text(100, 300, 16, "巡检靠纸质表单一天一交") +
        text(100, 330, 16, "留痕") +
        `</g>`,
    );
    const lines = findOrphanLines(svg);
    expect(lines).toEqual(["留痕"]);
    expect(checkPptDeck([svg], { requireCover: false }).filter((i) => i.code === "孤字行")).toHaveLength(1);
  });

  it("单行文字不算换行段（旁边另起一段近处的字也不算）", () => {
    const svg = pageSvg(
      `<g id="block-1-line-1-text">${text(100, 300, 16, "短")}</g>` +
        `<g id="block-2-line-1-text">${text(100, 330, 16, "短")}</g>`,
    );
    expect(findOrphanLines(svg)).toEqual([]);
  });

  it("以省略号收尾的行是压缩痕迹，不算孤字行", () => {
    const svg = pageSvg(
      `<g id="item-1-main-text">` +
        text(100, 300, 20, "巡检靠纸质表单") +
        text(100, 326, 20, "一…") +
        `</g>`,
    );
    expect(findOrphanLines(svg)).toEqual([]);
  });

  it("行距 / 字号 / x 对不上就不算同一段（避免误判相邻的两段文字）", () => {
    const far = pageSvg(
      `<g id="block-1-line-1-text">` + text(100, 300, 16, "巡检靠纸质表单一天一交") + text(100, 420, 16, "留") + `</g>`,
    );
    expect(findOrphanLines(far)).toEqual([]);
    const other = pageSvg(
      `<g id="block-1-line-1-text">` + text(100, 300, 16, "巡检靠纸质表单一天一交") + text(300, 330, 16, "留") + `</g>`,
    );
    expect(findOrphanLines(other)).toEqual([]);
  });
});

describe("svgShapeBoxes — 图形元素的外框（网格 / 安全边 / 留白判据的输入）", () => {
  it("rect / line / circle / polygon 都能抠出来（含组路径）", () => {
    const svg = [
      `<g id="body">`,
      `<g id="layer-1">${rect(80, 260, 1120, 80)}</g>`,
      `<line x1="80" y1="400" x2="1200" y2="400" stroke="#D6E7F8"/>`,
      `<circle cx="100" cy="400" r="6" fill="#0D47A1"/>`,
      `<polygon points="10,10 30,10 20,30" fill="#0D47A1"/>`,
      `</g>`,
    ].join("");
    const boxes = svgShapeBoxes(svg);
    expect(boxes).toHaveLength(4);
    const layer = boxes.find((b) => b.group === "layer-1")!;
    expect([layer.left, layer.top, layer.right, layer.bottom]).toEqual([80, 260, 1200, 340]);
    expect(layer.path).toEqual(["body", "layer-1"]);
    expect(boxes.find((b) => b.kind === "line")!.top).toBe(400);
    expect(boxes.find((b) => b.kind === "circle")!.left).toBe(94);
    expect(boxes.find((b) => b.kind === "polygon")!.bottom).toBe(30);
  });

  it("<path> 不算（fix-rounded 转出来的圆角矩形不是坐标可读的图形）", () => {
    expect(svgShapeBoxes(`<path d="M0 0h10v10z" fill="#E3F2FD"/>`)).toEqual([]);
  });
});
