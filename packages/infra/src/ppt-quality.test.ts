/**
 * @scene/infra — PPT 质量门禁测试（变更表 #142）
 *
 * `checkPptDeck` 是确定性的"页面体检"：形状数（页面太空）、小节标签与结论带、
 * 文本出界（8px 安全边）、文本压字（4px 阈值）、文字条数（信息量）。
 * 这里既测真渲染的页过闸，也测每一类问题**抓得住**（用最小人造 SVG 定位判据）。
 */

import { describe, it, expect } from "vitest";
import { PPT_LIMITS, type PptPage } from "@scene/contract";
import { renderPptDeck } from "./ppt-svg.js";
import { PPT_QUALITY, checkPptDeck, countSvgShapes, countSvgTexts, svgTextRects } from "./ppt-quality.js";

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

  it("真跑那种只剩 2 条的空页 → 门禁仍然抓得住「页面太空」", () => {
    const svg = render(list(["协议未收录的私有协议需另行适配", "老设备不支持远程升级"]));
    expect(countSvgShapes(svg)).toBeLessThan(PPT_QUALITY.minShapes);
    expect(checkPptDeck([svg]).map((i) => i.code)).toContain("页面太空");
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
    const good = pageSvg(
      Array.from({ length: 22 }, (_, i) => rect(80 + i, 200, 10, 10)).join("") +
        Array.from({ length: 12 }, (_, i) => text(100, 240 + i * 30, 20, `内容${i}`)).join(""),
    );
    const issues = checkPptDeck([good, pageSvg(text(100, 200, 20, "少"))]);
    expect(issues.every((i) => i.page === 2)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});
