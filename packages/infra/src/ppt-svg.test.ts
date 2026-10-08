/**
 * @scene/infra — PPT 页面渲染测试（变更表 #141）
 *
 * 五种布局各渲染一页，逐项断言：画布 1280×720、主色与浅蓝都在、XML 转义、
 * 无封面/尾页字样、`dominant-baseline` 与 `<foreignObject>` 一个都没有、
 * 每段文本都落在画布内（粗判）、落盘文件名是 `NN_page.svg`。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { PptOutline, PptPage } from "@scene/contract";
import {
  PPT_CANVAS,
  PPT_COLORS,
  escXml,
  estimateTextWidth,
  renderPptDeck,
  renderPptPage,
  wrapText,
  writePptSvgs,
} from "./ppt-svg.js";

const SCENARIO = "智慧会议室";

function page(over: Partial<PptPage> = {}): PptPage {
  return {
    layout: "要点",
    title: "现场今天怎么转",
    takeaway: "人工记录、事后补录，数据留不下来",
    bullets: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏"],
    columns: [],
    cards: [],
    table: null,
    ...over,
  };
}

/** 一页五种布局都齐的大纲 */
function outline(): PptOutline {
  return {
    pages: [
      page(),
      page({
        layout: "双栏对比",
        title: "今天与建成后",
        bullets: [],
        columns: [
          { head: "今天的做法", bullets: ["纸质表单", "人工统计"] },
          { head: "建成后的做法", bullets: ["自动采集", "实时看板"] },
        ],
      }),
      page({
        layout: "数据卡片",
        title: "三项确定性收益",
        bullets: [],
        cards: [
          { value: "统一纳管", label: "设备台账" },
          { value: "实时可见", label: "运行状态" },
          { value: "闭环处置", label: "异常工单" },
        ],
      }),
      page({
        layout: "图文说明",
        title: "四层架构怎么落",
        bullets: ["感知层部署采集终端", "传输层走物联网关", "平台层做研判分级"],
      }),
      page({
        layout: "表格",
        title: "分工与责任",
        bullets: [],
        table: {
          head: ["层次", "承担什么", "谁负责"],
          rows: [
            ["感知层", "采集现场数据", "运维班"],
            ["平台层", "研判与分级", "信息部"],
          ],
        },
      }),
    ],
  };
}

interface TextNode {
  x: number;
  y: number;
  size: number;
  anchor: string;
  text: string;
}

/** 抠出 SVG 里所有 `<text>` 节点（用于"文本不溢出画布"的粗判） */
function textNodes(svg: string): TextNode[] {
  const out: TextNode[] = [];
  const re = /<text ([^>]*)>([^<]*)<\/text>/g;
  for (let m = re.exec(svg); m !== null; m = re.exec(svg)) {
    const attrs = m[1]!;
    const attr = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    out.push({
      x: Number(attr("x")),
      y: Number(attr("y")),
      size: Number(attr("font-size")),
      anchor: attr("text-anchor") || "start",
      text: m[2]!,
    });
  }
  return out;
}

function assertInsideCanvas(svg: string, label: string): void {
  const nodes = textNodes(svg);
  expect(nodes.length, `${label}: 没有文本`).toBeGreaterThan(0);
  for (const n of nodes) {
    const w = estimateTextWidth(n.text, n.size);
    const left = n.anchor === "end" ? n.x - w : n.anchor === "middle" ? n.x - w / 2 : n.x;
    const right = left + w;
    expect(left, `${label}: 文本「${n.text}」超出左边界`).toBeGreaterThanOrEqual(0);
    expect(right, `${label}: 文本「${n.text}」超出右边界`).toBeLessThanOrEqual(PPT_CANVAS.width);
    expect(n.y, `${label}: 文本「${n.text}」超出下边界`).toBeLessThanOrEqual(PPT_CANVAS.height);
  }
}

describe("renderPptPage — 五种布局", () => {
  const deck = outline();

  it("每种布局都画得出来，且都是完整 SVG（画布 1280×720）", () => {
    const layouts = deck.pages.map((p) => p.layout);
    expect(layouts).toEqual(["要点", "双栏对比", "数据卡片", "图文说明", "表格"]);
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 5, scenarioName: SCENARIO });
      expect(svg.startsWith("<svg "), p.layout).toBe(true);
      expect(svg.endsWith("</svg>"), p.layout).toBe(true);
      expect(svg, p.layout).toContain(`width="${PPT_CANVAS.width}" height="${PPT_CANVAS.height}"`);
      expect(svg, p.layout).toContain(`viewBox="0 0 ${PPT_CANVAS.width} ${PPT_CANVAS.height}"`);
      // 每种布局的构件真的画出来了
      expect(svg, p.layout).toContain(`<g id="body">`);
    }
  });

  it("要点页：每条要点一块卡片，逐条都在", () => {
    const svg = renderPptPage(deck.pages[0]!, { index: 0, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain('id="bullet-1"');
    expect(svg).toContain('id="bullet-3"');
    expect(svg).toContain("巡检靠纸质表单，一天一交");
  });

  it("双栏对比页：两栏各自成组、栏头与条目都在", () => {
    const svg = renderPptPage(deck.pages[1]!, { index: 1, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain('id="col-1"');
    expect(svg).toContain('id="col-2"');
    expect(svg).toContain("今天的做法");
    expect(svg).toContain("建成后的做法");
    expect(svg).not.toContain('id="col-3"');
  });

  it("数据卡片页：3 张卡片各自成组", () => {
    const svg = renderPptPage(deck.pages[2]!, { index: 2, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain('id="card-1"');
    expect(svg).toContain('id="card-3"');
    expect(svg).not.toContain('id="card-4"');
    expect(svg).toContain("统一纳管");
  });

  it("图文说明页：左边要点块 + 右边示意图", () => {
    const svg = renderPptPage(deck.pages[3]!, { index: 3, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain('id="figure"');
    expect(svg).toContain('id="figure-item-1"');
    expect(svg).toContain("感知层部署采集终端");
  });

  it("表格页：表头与数据行成组，行列内容都在", () => {
    const svg = renderPptPage(deck.pages[4]!, { index: 4, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain('id="table"');
    expect(svg).toContain('id="row-1"');
    expect(svg).toContain("承担什么");
    expect(svg).toContain("研判与分级");
  });
});

describe("renderPptPage — 版式硬约束", () => {
  const deck = outline();

  it("含主色深蓝与浅蓝点缀、浅底与白卡片（bilibili-blue 令牌）", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 5, scenarioName: SCENARIO });
      expect(svg, p.layout).toContain(PPT_COLORS.primary);
      expect(svg, p.layout).toContain(PPT_COLORS.accent);
      expect(svg, p.layout).toContain(PPT_COLORS.bg);
      expect(svg, p.layout).toContain(PPT_COLORS.card);
    }
  });

  it("页眉有标题与「第 N 页 / 共 M 页」，底部有「场景通 · <场景名>」与三条波纹", () => {
    const svg = renderPptPage(deck.pages[1]!, { index: 1, total: 5, scenarioName: SCENARIO });
    expect(svg).toContain("第 2 页 / 共 5 页");
    expect(svg).toContain(`场景通 · ${SCENARIO}`);
    const wave = svg.match(/stroke-opacity="0\.15"/g) ?? [];
    expect(wave).toHaveLength(1);
    for (const opacity of ['stroke-opacity="0.15"', 'stroke-opacity="0.1"', 'stroke-opacity="0.06"']) {
      expect(svg).toContain(opacity);
    }
  });

  it("没有封面 / 目录 / 尾页字样，也没有 ppt-master 敏感的写法", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 5, scenarioName: SCENARIO });
      for (const banned of ["封面", "目录", "谢谢", "感谢聆听", "结束页"]) {
        expect(svg, `${p.layout} 含「${banned}」`).not.toContain(banned);
      }
      expect(svg, p.layout).not.toContain("dominant-baseline");
      expect(svg, p.layout).not.toContain("foreignObject");
      expect(svg, p.layout).not.toContain("@font-face");
      expect(svg, p.layout).not.toMatch(/href="http|@import|url\(http/); // 无网络资源（xmlns 除外）
    }
  });

  it("文本全部落在画布内（含超长内容）", () => {
    const long = page({
      layout: "要点",
      title: "这是一个被截断到二十个字的很长的页面标题示例",
      takeaway: "这一句话要点也挺长的，需要用估算宽度换行并且不能溢出画布边界",
      bullets: [
        "第一条很长的要点".repeat(6),
        "第二条".repeat(20),
        "第三条 short",
      ],
    });
    const table = page({
      layout: "表格",
      title: "表格页",
      bullets: [],
      table: {
        head: ["层次", "承担什么", "谁负责", "周期", "备注"],
        rows: Array.from({ length: 6 }, (_, i) => [
          `行${i}`,
          "内容".repeat(20),
          "信息部",
          "第1—2个月",
          "备注",
        ]),
      },
    });
    for (const p of [long, table]) {
      const svg = renderPptPage(p, { index: 0, total: 2, scenarioName: SCENARIO });
      assertInsideCanvas(svg, p.layout);
    }
  });

  it("XML 转义：& < > \" 都不会破坏 SVG", () => {
    const svg = renderPptPage(
      page({ title: "A&B <方案>", takeaway: '引号 " 与 <标签>' }),
      { index: 0, total: 1, scenarioName: '场景"A&B"' },
    );
    expect(svg).toContain("A&amp;B &lt;方案&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain("<方案>");
    expect(escXml("<&>\"'")).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("renderPptDeck / writePptSvgs", () => {
  it("每页一个文件，按 01_page.svg 起编号（没有封面页）", () => {
    const pages = renderPptDeck(outline(), { scenarioName: SCENARIO });
    expect(pages).toHaveLength(5);
    expect(pages.map((p) => p.file)).toEqual([
      "01_page.svg",
      "02_page.svg",
      "03_page.svg",
      "04_page.svg",
      "05_page.svg",
    ]);
    expect(pages[0]!.svg).toContain("现场今天怎么转");
  });

  it("写盘落到 <project>/svg_output/，内容与返回值一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-ppt-svg-"));
    try {
      const pages = renderPptDeck(outline(), { scenarioName: SCENARIO });
      const outDir = writePptSvgs(dir, pages);
      expect(outDir).toBe(join(dir, "svg_output"));
      expect(readdirSync(outDir).sort()).toEqual(pages.map((p) => p.file));
      expect(readFileSync(join(outDir, "01_page.svg"), "utf8")).toBe(pages[0]!.svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wrapText / estimateTextWidth", () => {
  it("按像素宽换行，超行数以省略号收尾", () => {
    const lines = wrapText("一二三四五六七八九十".repeat(3), 20, 100, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    for (const line of lines) expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(100);
  });

  it("放得下就不换行、也不加省略号", () => {
    expect(wrapText("短短一句", 20, 200, 2)).toEqual(["短短一句"]);
  });

  it("空串 → 一个空行（不产生 undefined）", () => {
    expect(wrapText("", 20, 200, 1)).toEqual([""]);
  });

  it("全角比半角宽（同一把尺给换行与溢出判据共用）", () => {
    expect(estimateTextWidth("中中", 20)).toBeGreaterThan(estimateTextWidth("ab", 20));
  });
});
