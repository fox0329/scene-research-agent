/**
 * @scene/infra — PPT 页面渲染测试（变更表 #141 立、#142 升）
 *
 * 一份 7 页示例大纲（七种布局各一页）逐项断言：白底、统一骨架（小节标签 / 大标题 / 副题 /
 * 结论带 / 页码 / 页脚）、每页形状数 ≥22、文字条数 ≥12、0 越界、0 压字、
 * XML 转义、`dominant-baseline`/`<foreignObject>`/网络字体一个都没有、落盘文件名。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PPT_LIMITS, type PptOutline, type PptPage } from "@scene/contract";
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
import { checkPptDeck, countSvgShapes, countSvgTexts, svgTextRects } from "./ppt-quality.js";

const SCENARIO = "智慧会议室";

/** 一页的默认值（测试只覆盖要测的字段） */
function page(over: Partial<PptPage> = {}): PptPage {
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
    bullets: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏"],
    ...over,
  };
}

/** 7 页示例大纲：七种布局各一页，每页都写满（密度 ≥22 形状、≥12 条文字） */
function sampleDeck(): PptOutline {
  return {
    pages: [
      page({
        layout: "网格要点",
        kicker: "项目硬规则",
        title: "四条硬规则管住现场",
        subtitle: "把口径写进系统，巡检不再靠人记",
        bullets: [],
        chips: ["扫码巡检", "自动派单"],
        highlight: "口径写进系统，现场按码走",
        blocks: [
          {
            head: "设备台账",
            note: "谁在现场、什么型号",
            lines: ["按区域建台账，逐台贴码", "型号与位置一次录清", "换机改码当场更新"],
          },
          {
            head: "巡检任务",
            note: "照班次自动发单",
            lines: ["每班次派发到人", "漏项当场提醒", "完成时间自动留痕", "任务超时升级到班长"],
          },
          {
            head: "异常上报",
            note: "现场拍照即上报",
            lines: ["异常必传现场照片", "按等级通知到人", "处理过程全程可查"],
          },
          {
            head: "数据口径",
            note: "一处录入全系统共用",
            lines: ["台账只在一处录入", "报表按同一口径出数", "月度对账有据可依", "口径变更留版本记录"],
          },
        ],
      }),
      page({
        layout: "双栏对比",
        kicker: "今天与建成后",
        title: "同一件事两种做法",
        subtitle: "左边是今天的代价，右边是建成后的样子",
        bullets: [],
        chips: ["纸质表单", "实时看板"],
        highlight: "同样的活，换个干法",
        columns: [
          {
            head: "今天的做法",
            note: "纸质表单为主",
            lines: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏", "月底对账翻单据，两天起步"],
          },
          {
            head: "建成后的做法",
            note: "扫码巡检、自动留痕",
            lines: ["扫码巡检，当场提交", "数据实时入库，口径唯一", "异常自动派单到人", "月底一键出账，当天完成"],
          },
        ],
      }),
      page({
        layout: "流程阶段",
        kicker: "推进路径",
        title: "四步走到全量覆盖",
        subtitle: "先在一个楼层跑通，再复制到全区",
        bullets: [],
        highlight: "先跑通一层，再谈全区",
        stages: [
          { head: "样板层建设", note: "一个楼层先装齐，跑通扫码巡检" },
          { head: "单点验证", note: "连续两周比对纸质记录，口径对齐" },
          { head: "分批复制", note: "按楼层分批上线，每批一周" },
          { head: "全区运行", note: "全区纳管，报表自动出数" },
        ],
      }),
      page({
        layout: "分层架构",
        kicker: "总体架构",
        title: "四层架构怎么落",
        subtitle: "每一层各管一段，接口统一",
        bullets: [],
        chips: ["物联网关", "统一纳管"],
        highlight: "层与层之间只认接口",
        layers: [
          { head: "应用层", items: ["巡检看板", "异常工单", "月度报表"] },
          { head: "平台层", items: ["设备纳管", "规则引擎", "数据接口"] },
          { head: "网络层", items: ["物联网关", "室内组网"] },
          { head: "感知层", items: ["扫码终端", "温湿度探头", "门禁读头"] },
        ],
      }),
      page({
        layout: "数据卡片",
        kicker: "关键数字",
        title: "四项变化看得见",
        subtitle: "口径都取自这份报告正文",
        bullets: [],
        highlight: "变化要能被量出来",
        cards: [
          { value: "12 个", label: "纳管楼层" },
          { value: "480 台", label: "纳管设备" },
          { value: "2 天", label: "对账周期" },
          { value: "1 张表", label: "统一口径" },
        ],
      }),
      page({
        layout: "表格",
        kicker: "分工与节奏",
        title: "谁在哪一步做什么",
        subtitle: "每一行一件交付物",
        bullets: [],
        highlight: "责任到人，节点到周",
        table: {
          head: ["阶段", "做什么", "谁负责", "周期", "验收依据"],
          rows: [
            ["样板层", "装齐终端并贴码", "运维班", "第 1 周", "扫码记录连续"],
            ["单点验证", "比对纸质与系统记录", "信息部", "第 2 周", "差异逐条说明"],
            ["分批复制", "按楼层分批上线", "运维班", "第 3–6 周", "每批抽检通过"],
            ["全区运行", "全区纳管出报表", "信息部", "第 7 周", "报表口径一致"],
            ["移交运维", "交接口径与操作手册", "双方", "第 8 周", "培训签到齐全"],
          ],
        },
      }),
      page({
        layout: "要点清单",
        kicker: "下一步",
        title: "接下来先做五件事",
        subtitle: "每一件都能当周落地",
        bullets: [
          "确认样板层的楼层与点位清单",
          "把设备台账按区域补齐并贴码",
          "定下异常分级与通知到人的规则",
          "约定报表口径与对账的时间点",
          "安排运维班的扫码操作培训",
          "留出一周时间做口径比对",
        ],
        highlight: "先落地一周，再看效果",
      }),
    ],
  };
}

describe("renderPptPage — 七种布局", () => {
  const deck = sampleDeck();

  it("七种布局各有一个渲染器，都画得出完整 SVG（画布 1280×720）", () => {
    expect(deck.pages.map((p) => p.layout)).toEqual([
      "网格要点",
      "双栏对比",
      "流程阶段",
      "分层架构",
      "数据卡片",
      "表格",
      "要点清单",
    ]);
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 7, scenarioName: SCENARIO });
      expect(svg.startsWith("<svg "), p.layout).toBe(true);
      expect(svg.endsWith("</svg>"), p.layout).toBe(true);
      expect(svg, p.layout).toContain(`width="${PPT_CANVAS.width}" height="${PPT_CANVAS.height}"`);
      expect(svg, p.layout).toContain(`viewBox="0 0 ${PPT_CANVAS.width} ${PPT_CANVAS.height}"`);
      expect(svg, p.layout).toContain('<g id="body">');
    }
  });

  it("网格要点：2×2 四块，块头、小注、内容行都在", () => {
    const svg = renderPptPage(deck.pages[0]!, { index: 0, total: 7, scenarioName: SCENARIO });
    for (let i = 1; i <= 4; i += 1) expect(svg).toContain(`id="block-${i}"`);
    expect(svg).not.toContain('id="block-5"');
    expect(svg).toContain("设备台账");
    expect(svg).toContain("谁在现场、什么型号");
    expect(svg).toContain("换机改码当场更新");
  });

  it("双栏对比：两栏各自成组、栏头与每一行都在", () => {
    const svg = renderPptPage(deck.pages[1]!, { index: 1, total: 7, scenarioName: SCENARIO });
    expect(svg).toContain('id="col-1"');
    expect(svg).toContain('id="col-2"');
    expect(svg).not.toContain('id="col-3"');
    expect(svg).toContain("今天的做法");
    expect(svg).toContain("建成后的做法");
    expect(svg).toContain(PPT_COLORS.primaryAlt);
  });

  it("流程阶段：等分横排、序号圆点与箭头都在", () => {
    const svg = renderPptPage(deck.pages[2]!, { index: 2, total: 7, scenarioName: SCENARIO });
    for (let i = 1; i <= 4; i += 1) expect(svg).toContain(`id="stage-${i}"`);
    expect(svg).toContain("<circle");
    expect(svg).toContain("<polygon");
    expect(svg).toContain("样板层建设");
    expect(svg).toContain("全区纳管，报表自动出数");
  });

  it("分层架构：每层的层头与组件标签都在", () => {
    const svg = renderPptPage(deck.pages[3]!, { index: 3, total: 7, scenarioName: SCENARIO });
    for (let i = 1; i <= 4; i += 1) expect(svg).toContain(`id="layer-${i}"`);
    expect(svg).toContain('id="layer-1-item-1"');
    expect(svg).toContain("应用层");
    expect(svg).toContain("月度报表");
  });

  it("数据卡片：四张卡片各自成组，数值与说明都在", () => {
    const svg = renderPptPage(deck.pages[4]!, { index: 4, total: 7, scenarioName: SCENARIO });
    for (let i = 1; i <= 4; i += 1) expect(svg).toContain(`id="card-${i}"`);
    expect(svg).not.toContain('id="card-5"');
    expect(svg).toContain("480 台");
    expect(svg).toContain("纳管设备");
  });

  it("表格：表头与数据行成组，行列内容都在", () => {
    const svg = renderPptPage(deck.pages[5]!, { index: 5, total: 7, scenarioName: SCENARIO });
    expect(svg).toContain('id="table"');
    expect(svg).toContain('id="row-1"');
    expect(svg).toContain("验收依据");
    expect(svg).toContain("差异逐条说明");
  });

  it("要点清单：大序号 + 一行大字", () => {
    const svg = renderPptPage(deck.pages[6]!, { index: 6, total: 7, scenarioName: SCENARIO });
    expect(svg).toContain('id="item-1"');
    expect(svg).toContain('id="item-6"');
    expect(svg).toContain(">01<");
    expect(svg).toContain("留出一周时间做口径比对");
  });
});

describe("renderPptPage — 统一骨架与令牌", () => {
  const deck = sampleDeck();

  it("白底 + 极浅蓝层次（每页都有主色 / 浅蓝 / 极浅蓝 / 纯白）", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 7, scenarioName: SCENARIO });
      expect(svg, p.layout).toContain(PPT_COLORS.primary);
      expect(svg, p.layout).toContain(PPT_COLORS.accent);
      expect(svg, p.layout).toContain(PPT_COLORS.lightBlue);
      expect(svg, p.layout).toContain('fill="#FFFFFF"');
      expect(svg, p.layout).not.toContain("#F5F8FC"); // 旧的浅蓝页底已退场
    }
  });

  it("每页都有小节标签胶囊、大标题、副题、结论带、页码与页脚", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 7, scenarioName: SCENARIO });
      expect(svg, p.layout).toContain('<g id="kicker">');
      expect(svg, p.layout).toContain('<g id="hd">');
      expect(svg, p.layout).toContain('<g id="subtitle">');
      expect(svg, p.layout).toContain('<g id="highlight">');
      expect(svg, p.layout).toContain(`第 ${i + 1} 页 / 共 7 页`);
      expect(svg, p.layout).toContain(`场景通 · ${SCENARIO}`);
      expect(svg, p.layout).toContain(escXml(p.kicker));
      expect(svg, p.layout).toContain(escXml(p.highlight));
    }
  });

  it("技术标签贴右排一行（最多 5 个）", () => {
    const svg = renderPptPage(deck.pages[0]!, { index: 0, total: 7, scenarioName: SCENARIO });
    expect(svg).toContain('id="chip-1"');
    expect(svg).toContain('id="chip-2"');
    expect(svg).not.toContain('id="chip-3"');
    expect(svg).toContain("扫码巡检");
  });

  it("没有封面 / 目录 / 尾页字样，也没有 ppt-master 敏感的写法", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 7, scenarioName: SCENARIO });
      for (const banned of ["封面", "目录", "谢谢", "感谢聆听", "结束页"]) {
        expect(svg, `${p.layout} 含「${banned}」`).not.toContain(banned);
      }
      expect(svg, p.layout).not.toContain("dominant-baseline");
      expect(svg, p.layout).not.toContain("foreignObject");
      expect(svg, p.layout).not.toContain("@font-face");
      expect(svg, p.layout).not.toMatch(/href="http|@import|url\(http/); // 无网络资源（xmlns 除外）
    }
  });

  it("XML 转义：& < > \" 都不会破坏 SVG", () => {
    const svg = renderPptPage(
      page({ title: "A&B <方案>", subtitle: '引号 " 与 <标签>', highlight: "口径 < 一致 > 才可对账" }),
      { index: 0, total: 1, scenarioName: '场景"A&B"' },
    );
    expect(svg).toContain("A&amp;B &lt;方案&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain("<方案>");
    expect(escXml("<&>\"'")).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("renderPptPage — 质量门禁（密度 / 出界 / 压字 / 信息量）", () => {
  const deck = sampleDeck();
  const svgs = deck.pages.map((p, i) =>
    renderPptPage(p, { index: i, total: deck.pages.length, scenarioName: SCENARIO }),
  );

  it("每页形状数 ≥22（页面不空）", () => {
    for (const [i, svg] of svgs.entries()) {
      const shapes = countSvgShapes(svg);
      expect(shapes, `第 ${i + 1} 页（${deck.pages[i]!.layout}）只有 ${shapes} 个形状`).toBeGreaterThanOrEqual(
        22,
      );
    }
  });

  it("每页文字条数 ≥12（信息量够）", () => {
    for (const [i, svg] of svgs.entries()) {
      const texts = countSvgTexts(svg);
      expect(texts, `第 ${i + 1} 页只有 ${texts} 条文字`).toBeGreaterThanOrEqual(
        PPT_LIMITS.minSentencesPerPage,
      );
    }
  });

  it("7 页全过门禁：0 越界、0 压字、kicker 与 highlight 都在", () => {
    expect(checkPptDeck(svgs)).toEqual([]);
  });

  it("文本矩形都在画布内（含超长内容）", () => {
    const long = page({
      layout: "网格要点",
      title: "这是一个被截断到二十个字的很长的页面标题示例",
      subtitle: "这一句副题也挺长的，需要用估算宽度换行并且不能溢出画布边界",
      bullets: [],
      blocks: [
        { head: "很长很长的块头", note: "很长很长的小注", lines: ["第一条很长的内容行".repeat(4)] },
        { head: "块二", note: "", lines: ["第二条".repeat(8)] },
        { head: "块三", note: "", lines: ["第三条".repeat(8)] },
        { head: "块四", note: "", lines: ["第四条".repeat(8)] },
      ],
      highlight: "结论带也可以很长很长但一定要被裁到画布以内不出界",
      chips: ["很长的标签甲乙丙丁戊己庚辛", "标签二", "标签三"],
    });
    const table = page({
      layout: "表格",
      title: "表格页",
      bullets: [],
      table: {
        head: ["层次", "承担什么", "谁负责", "周期", "备注"],
        rows: Array.from({ length: 6 }, (_, i) => [`行${i}`, "内容".repeat(20), "信息部", "第1—2个月", "备注"]),
      },
    });
    const svgs2 = [long, table].map((p, i) =>
      renderPptPage(p, { index: i, total: 2, scenarioName: SCENARIO }),
    );
    for (const [i, svg] of svgs2.entries()) {
      for (const r of svgTextRects(svg)) {
        expect(r.left, `第 ${i + 1} 页「${r.text}」超出左边界`).toBeGreaterThanOrEqual(0);
        expect(r.right, `第 ${i + 1} 页「${r.text}」超出右边界`).toBeLessThanOrEqual(PPT_CANVAS.width);
        expect(r.top, `第 ${i + 1} 页「${r.text}」超出上边界`).toBeGreaterThanOrEqual(0);
        expect(r.bottom, `第 ${i + 1} 页「${r.text}」超出下边界`).toBeLessThanOrEqual(PPT_CANVAS.height);
      }
    }
    // 只可能报"信息量不足"，绝不许有越界 / 压字
    const codes = checkPptDeck(svgs2).map((x) => x.code);
    expect(codes).not.toContain("文本越界");
    expect(codes).not.toContain("文本相交");
  });

  it("旧 #141 的页（只有 takeaway/bullets）也画得出来", () => {
    const legacy = page({
      layout: "网格要点",
      kicker: "",
      title: "旧页也要能画",
      subtitle: undefined as unknown as string,
      takeaway: "旧字段的一句话要点",
      bullets: ["旧字段的第一条", "旧字段的第二条", "旧字段的第三条"],
      blocks: [],
      highlight: undefined as unknown as string,
    });
    const svg = renderPptPage(legacy, { index: 0, total: 1, scenarioName: SCENARIO });
    expect(svg).toContain("旧字段的一句话要点");
    expect(svg).toContain("旧字段的第一条");
    expect(svg).toContain('id="block-1"');
    expect(countSvgShapes(svg)).toBeGreaterThan(0);
  });
});

/** 要点清单（兜底版式）在 #142 收尾时加密：每条三件 + 条间分隔线 */
describe("renderPptPage — 要点清单加密", () => {
  const five = [
    "巡检靠纸质表单，一天一交",
    "数据事后补录，口径对不上",
    "异常靠电话上报，常常漏掉",
    "台账分散在各班组手里",
    "月底对账要翻两天单据",
  ];
  const list = (bullets: string[]): PptPage => page({ layout: "要点清单", blocks: [], bullets });

  it("5 条要点也过密度线（≥22 形状）且门禁 0 问题", () => {
    const svg = renderPptPage(list(five), { index: 0, total: 1, scenarioName: SCENARIO });
    const shapes = countSvgShapes(svg);
    expect(shapes, `只有 ${shapes} 个形状`).toBeGreaterThanOrEqual(22);
    expect(countSvgTexts(svg)).toBeGreaterThanOrEqual(PPT_LIMITS.minSentencesPerPage);
    expect(checkPptDeck([svg])).toEqual([]);
  });

  it("每条三件：44×44 序号底衬 + 20px 主句 + 15px 次要说明", () => {
    const svg = renderPptPage(list(five), { index: 0, total: 1, scenarioName: SCENARIO });
    for (let i = 1; i <= five.length; i += 1) {
      expect(svg).toContain(`id="item-${i}"`);
      expect(svg).toContain(`id="item-${i}-text"`);
    }
    // 带逗号的那几条会拆出次要说明行
    expect(svg).toContain('id="item-1-note"');
    expect(svg).toContain("巡检靠纸质表单");
    expect(svg).toContain("一天一交");
    expect(svg).toContain('font-size="15"');
    // 序号底衬 44×44
    expect(svg).toContain('width="44" height="44"');
  });

  it("条间有 n−1 条 1px 浅蓝分隔线，最后一条下面不画", () => {
    const svg = renderPptPage(list(five), { index: 0, total: 1, scenarioName: SCENARIO });
    expect((svg.match(/<line /g) ?? []).length).toBe(five.length - 1);
    expect(svg).toContain(`stroke="${PPT_COLORS.border}" stroke-width="1"`);
  });

  it("断不出两半的短句只画主句（不硬拆、不重复）", () => {
    const short = ["全区纳管出报表", "口径写进系统里", "异常自动派单"];
    const svg = renderPptPage(list(short), { index: 0, total: 1, scenarioName: SCENARIO });
    for (let i = 1; i <= short.length; i += 1) {
      expect(svg).toContain(`id="item-${i}-text"`);
      expect(svg).not.toContain(`id="item-${i}-note"`);
    }
    expect(checkPptDeck([svg]).map((x) => x.code)).not.toContain("文本相交");
  });
});

describe("renderPptDeck / writePptSvgs", () => {
  it("每页一个文件，按 01_page.svg 起编号（没有封面页）", () => {
    const pages = renderPptDeck(sampleDeck(), { scenarioName: SCENARIO });
    expect(pages).toHaveLength(7);
    expect(pages.map((p) => p.file)).toEqual([
      "01_page.svg",
      "02_page.svg",
      "03_page.svg",
      "04_page.svg",
      "05_page.svg",
      "06_page.svg",
      "07_page.svg",
    ]);
    expect(pages[0]!.svg).toContain("四条硬规则管住现场");
  });

  it("写盘落到 <project>/svg_output/，内容与返回值一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-ppt-svg-"));
    try {
      const pages = renderPptDeck(sampleDeck(), { scenarioName: SCENARIO });
      const outDir = writePptSvgs(dir, pages);
      expect(outDir).toBe(join(dir, "svg_output"));
      expect(readdirSync(outDir).sort()).toEqual(pages.map((p) => p.file));
      expect(readFileSync(join(outDir, "01_page.svg"), "utf8")).toBe(pages[0]!.svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("逐页回调汇报进度", () => {
    const seen: number[] = [];
    renderPptDeck(sampleDeck(), { scenarioName: SCENARIO, onPage: (i) => seen.push(i) });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
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

  it("全角比半角宽（同一把尺给换行、溢出与压字判据共用）", () => {
    expect(estimateTextWidth("中中", 20)).toBeGreaterThan(estimateTextWidth("ab", 20));
  });
});
