/**
 * @scene/infra — PPT 页面渲染测试（变更表 #141 立、#142 升、#144 升、#145 升）
 *
 * 一份 7 页示例大纲（七种布局各一页）逐项断言：白底、统一骨架（小节标签胶囊 + 图标 /
 * 36px 大标题 / 副题 / 结论带 + `bulb` / 页码胶囊 / 页脚）、每页形状数 ≥22、
 * 文字条数 ≥12、0 越界、0 压字、XML 转义、`dominant-baseline`/`<foreignObject>`/网络字体一个都没有、
 * 落盘文件名；#144 追加：图标占位（名字都在 `PPT_ICONS` 白名单内、每页 ≥4）、颜色层次（每页 ≥6 色、
 * 卡底填充 / 轮换强调竖条 / 细分隔线）、字内强调（行首关键词 `<tspan>`、数字 `<tspan>`、语气色）
 * 与「每页强调 ≥3 处」；#145 追加：**去掉页顶通栏主色带与标题下橙短横**、内容文字一律 ≥ `PPT_MIN_FONT`
 * （只有页脚与页码按 15px 的元信息下限）、断行的行首禁则与孤字行规避、版面集中（网格 / 留白）。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  PPT_DEFAULT_ICON,
  PPT_ICON_LIB,
  PPT_ICONS,
  PPT_LIMITS,
  PPT_MIN_FONT,
  type PptBlock,
  type PptOutline,
  type PptPage,
} from "@scene/contract";
import {
  PPT_BAR_COLORS,
  PPT_CANVAS,
  PPT_COLORS,
  escXml,
  estimateTextWidth,
  PPT_TONE_VALUE,
  pptBarColor,
  pptEmphasisOf,
  pptToneOf,
  PPT_MIN_ORPHAN_CHARS,
  renderPptDeck,
  renderPptPage,
  hasLeadingPunct,
  stripLeadingPunct,
  wrapText,
  writePptSvgs,
} from "./ppt-svg.js";
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

const SCENARIO = "智慧会议室";

/** 一页的默认值（测试只覆盖要测的字段） */
function page(over: Partial<PptPage> = {}): PptPage {
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
        icon: "list-check",
        title: "四条硬规则管住现场",
        subtitle: "把口径写进系统，巡检不再靠人记",
        bullets: [],
        chips: ["扫码巡检", "自动派单"],
        highlight: "口径写进系统，现场按码走",
        blocks: [
          {
            head: "设备台账",
            note: "谁在现场、什么型号",
            icon: "file-text",
            lines: ["按区域建台账，逐台贴码", "型号与位置一次录清", "换机改码当场更新"],
          },
          {
            head: "巡检任务",
            note: "照班次自动发单",
            icon: "calendar-check",
            lines: ["每班次派发到人", "漏项当场提醒", "完成时间自动留痕", "任务超时升级到班长"],
          },
          {
            head: "异常上报",
            note: "现场拍照即上报",
            icon: "alert-triangle",
            lines: ["异常必传现场照片", "按等级通知到人", "处理过程全程可查"],
          },
          {
            head: "数据口径",
            note: "一处录入全系统共用",
            icon: "database",
            lines: ["台账只在一处录入", "报表按同一口径出数", "月度对账有据可依", "口径变更留版本记录"],
          },
        ],
      }),
      page({
        layout: "双栏对比",
        kicker: "今天与建成后",
        icon: "arrows-split",
        title: "同一件事两种做法",
        subtitle: "左边是今天的代价，右边是建成后的样子",
        bullets: [],
        chips: ["纸质表单", "实时看板"],
        highlight: "同样的活，换个干法",
        columns: [
          {
            head: "今天的做法",
            note: "纸质表单为主",
            icon: "file-text",
            lines: ["巡检靠纸质表单，一天一交", "数据事后补录，口径对不上", "异常靠电话上报，常常漏", "月底对账翻单据，两天起步"],
          },
          {
            head: "建成后的做法",
            note: "扫码巡检、自动留痕",
            icon: "list-check",
            lines: ["扫码巡检，当场提交", "数据实时入库，口径唯一", "异常自动派单到人", "月底一键出账，当天完成"],
          },
        ],
      }),
      page({
        layout: "流程阶段",
        kicker: "推进路径",
        icon: "route",
        title: "四步走到全量覆盖",
        subtitle: "先在一个楼层跑通，再复制到全区",
        bullets: [],
        highlight: "先跑通一层，再谈全区",
        stages: [
          { head: "样板层建设", note: "一个楼层先装齐，跑通扫码巡检", icon: "building-community" },
          { head: "单点验证", note: "连续两周比对纸质记录，口径对齐", icon: "checkup-list" },
          { head: "分批复制", note: "按楼层分批上线，每批一周", icon: "devices" },
          { head: "全区运行", note: "全区纳管，报表自动出数", icon: "sitemap" },
        ],
      }),
      page({
        layout: "分层架构",
        kicker: "总体架构",
        icon: "hierarchy",
        title: "四层架构怎么落",
        subtitle: "每一层各管一段，接口统一",
        bullets: [],
        chips: ["物联网关", "统一纳管"],
        highlight: "层与层之间只认接口",
        layers: [
          { head: "应用层", icon: "chart-bar", items: ["巡检看板", "异常工单", "月度报表"] },
          { head: "平台层", icon: "server", items: ["设备纳管", "规则引擎", "数据接口"] },
          { head: "网络层", icon: "antenna", items: ["物联网关", "室内组网"] },
          { head: "感知层", icon: "wifi", items: ["扫码终端", "温湿度探头", "门禁读头"] },
        ],
      }),
      page({
        layout: "数据卡片",
        kicker: "关键数字",
        icon: "gauge",
        title: "四项变化看得见",
        subtitle: "口径都取自这份报告正文",
        bullets: [],
        highlight: "变化要能被量出来",
        cards: [
          { value: "12 个", label: "纳管楼层", icon: "building-skyscraper" },
          { value: "480 台", label: "纳管设备", icon: "devices" },
          { value: "2 天", label: "对账周期", icon: "clock" },
          { value: "1 张表", label: "统一口径", icon: "report-analytics" },
        ],
      }),
      page({
        layout: "表格",
        kicker: "分工与节奏",
        icon: "briefcase",
        title: "谁在哪一步做什么",
        subtitle: "每一行一件交付物",
        bullets: [],
        highlight: "责任到人，节点到周",
        table: {
          head: ["阶段", "做什么", "谁负责", "周期", "验收依据"],
          icons: ["route", "list-check", "users", "clock", "circle-check"],
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
        icon: "list-check",
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
      expect(svg, p.layout).toContain(PPT_COLORS.text);
      expect(svg, p.layout).toContain('fill="#FFFFFF"');
      expect(svg, p.layout).not.toContain("#F5F8FC"); // 旧的浅蓝页底已退场
    }
  });

  it("每页都有小节标签、大标题、副题、一句话总结、页码与页脚", () => {
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: 7, scenarioName: SCENARIO });
      expect(svg, p.layout).toContain('<g id="kicker">');
      expect(svg, p.layout).toContain('<g id="hd">');
      expect(svg, p.layout).toContain('<g id="subtitle">');
      expect(svg, p.layout).toContain('<g id="summary">');
      expect(svg, p.layout).toContain(
        `${String(i + 1).padStart(2, "0")} / ${String(deck.pages.length).padStart(2, "0")}`,
      );
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

  it("每页文字条数 ≥16（信息量够）", () => {
    for (const [i, svg] of svgs.entries()) {
      const texts = countSvgTexts(svg);
      expect(texts, `第 ${i + 1} 页只有 ${texts} 条文字`).toBeGreaterThanOrEqual(
        PPT_LIMITS.minSentencesPerPage,
      );
    }
  });

  it("7 页正文全过门禁：0 越界、0 压字、kicker 与 summary 都在", () => {
    expect(checkPptDeck(svgs, { requireCover: false })).toEqual([]);
  });

  it("#145 版面判据全过：字号 / 安全边 / 网格 / 留白 / 行首标点 / 孤字行", () => {
    const codes = ["字号过小", "超出安全边", "未对齐网格", "留白不均", "行首标点", "孤字行"];
    for (const [i, svg] of svgs.entries()) {
      const found = checkPptDeck([svg], { requireCover: false })
        .filter((x) => codes.includes(x.code))
        .map((x) => `${x.code}：${x.detail}`);
      expect(found, `第 ${i + 1} 页（${deck.pages[i]!.layout}）${found.join("｜")}`).toEqual([]);
    }
  });

  it("内容文字一律 ≥15px，只有页脚与页码按 14px 的元信息下限", () => {
    for (const [i, svg] of svgs.entries()) {
      for (const r of svgTextRects(svg)) {
        const meta =
          r.path.includes("footer") ||
          r.path.includes("page-no") ||
          r.path.includes("kicker");
        const min = meta ? PPT_QUALITY.minMetaFontSize : PPT_MIN_FONT;
        expect(r.size, `第 ${i + 1} 页「${r.text}」只有 ${r.size}px`).toBeGreaterThanOrEqual(min);
      }
      // 页脚与页码确实存在（别用"没有小字号"糊弄过去）
      expect(svg).toContain('<g id="footer">');
      expect(svg).toContain('<g id="page-no">');
    }
  });

  it("#145 去装饰：全篇没有页顶通栏色带、没有标题下橙短横", () => {
    for (const svg of svgs) {
      expect(svg).not.toContain("pptTopBand");
      expect(svg).not.toContain("<linearGradient");
      expect(svg).not.toContain('width="1280" height="8"');
      expect(svg).not.toMatch(/<rect x="80" y="10[0-9]" width="80" height="6"/);
    }
  });

  it("文本矩形都在画布内（含超长内容）", () => {
    const long = page({
      layout: "网格要点",
      title: "这是一个被截断到二十个字的很长的页面标题示例",
      subtitle: "这一句副题也挺长的，需要用估算宽度换行并且不能溢出画布边界",
      bullets: [],
      blocks: [
        { head: "很长很长的块头", note: "很长很长的小注", icon: "file-text", lines: ["第一条很长的内容行".repeat(4)] },
        { head: "块二", note: "", icon: "server", lines: ["第二条".repeat(8)] },
        { head: "块三", note: "", icon: "network", lines: ["第三条".repeat(8)] },
        { head: "块四", note: "", icon: "database", lines: ["第四条".repeat(8)] },
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
        icons: ["hierarchy", "list-check", "users", "clock", "file-text"],
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
    expect(checkPptDeck([svg], { requireCover: false })).toEqual([]);
  });

  it("每条三件：44×44 序号底衬 + 20px 主句 + 16px 次要说明", () => {
    const svg = renderPptPage(list(five), { index: 0, total: 1, scenarioName: SCENARIO });
    for (let i = 1; i <= five.length; i += 1) {
      expect(svg).toContain(`id="item-${i}"`);
      expect(svg).toContain(`id="item-${i}-main-1-text"`);
    }
    // 带逗号的那几条会拆出次要说明行
    expect(svg).toContain('id="item-1-note"');
    expect(svg).toContain("巡检靠纸质表单");
    expect(svg).toContain("一天一交");
    // 次要说明行是内容文字，必须 ≥ 最低字号 16
    expect(svg).toContain('id="item-1-note"');
    expect(svg).toContain(`font-size="${PPT_MIN_FONT}"`);
    // 序号底衬 44×44
    expect(svg).toContain('width="44" height="44"');
  });

  it("条间有 n−1 条 1px 细分隔线（#144 换 #D6E7F8），最后一条下面不画", () => {
    const svg = renderPptPage(list(five), { index: 0, total: 1, scenarioName: SCENARIO });
    expect((svg.match(/<line /g) ?? []).length).toBe(five.length - 1);
    expect(svg).toContain(`stroke="${PPT_COLORS.divider}" stroke-width="1"`);
  });

  it("断不出两半的短句只画主句（不硬拆、不重复）", () => {
    const short = ["全区纳管出报表", "口径写进系统里", "异常自动派单"];
    const svg = renderPptPage(list(short), { index: 0, total: 1, scenarioName: SCENARIO });
    for (let i = 1; i <= short.length; i += 1) {
      expect(svg).toContain(`id="item-${i}-main-1-text"`);
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

describe("wrapText — #145 断行规则（行首禁则 + 孤字行规避）", () => {
  // 20px 字号、宽 100px = 一行 5 个字
  const W = 100;

  it("断点落在标点上：把上一行末字挪下来，新行不以标点开头", () => {
    const lines = wrapText("一二三四五，六七八九十", 20, W, 2);
    expect(hasLeadingPunct(Array.from(lines[1]!)[0]!)).toBe(false);
    expect(lines.join("")).toContain("五，");
  });

  it("末行只剩 1–2 个字就往前挪，挪到 ≥3 个字为止", () => {
    const lines = wrapText("一二三四五六", 20, W, 2);
    expect(lines).toEqual(["一二三", "四五六"]);
    for (const line of lines) {
      expect(Array.from(line).length).toBeGreaterThanOrEqual(PPT_MIN_ORPHAN_CHARS);
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(W);
    }
  });

  it("挪不动（首行只剩 2 个字）就不挪，宁可有孤字行也不溢出", () => {
    const lines = wrapText("一二三四五", 20, W, 2);
    expect(lines).toEqual(["一二三四五"]);
    for (const line of lines) expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(W);
  });

  it("多行都不许以标点开头，且每行都在容器内", () => {
    const text = "协议未收录的私有协议，需另行适配（现场确认），老设备不支持远程升级";
    for (const maxLines of [1, 2, 3, 4]) {
      for (const width of [80, 120, 200, 320]) {
        for (const line of wrapText(text, 16, width, maxLines)) {
          expect(hasLeadingPunct(Array.from(line)[0] ?? "")).toBe(false);
          expect(estimateTextWidth(line, 16)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("排到行数上限还有剩字：末行必须用省略号交代，不许无声丢字", () => {
    const lines = wrapText("一二三四五六七八九十百", 20, W, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });

  it("首字就是标点：先去掉行首标点再排（源文本脏也不出违规行）", () => {
    expect(stripLeadingPunct("，。、一句正文")).toBe("一句正文");
    expect(hasLeadingPunct("，一句")).toBe(true);
    expect(hasLeadingPunct("）一句")).toBe(true); // 收尾标点不许起行，开头的「（」可以
    expect(hasLeadingPunct("一句，正文")).toBe(false);
    expect(wrapText("，一二三四五六七八", 20, W, 2)).toEqual(["一二三四五", "六七八"]);
  });

  it("放得下就一行、不加省略号、不做均衡（短句不许被拆）", () => {
    expect(wrapText("短短一句", 20, W, 2)).toEqual(["短短一句"]);
  });
});


describe("wrapText — #145 属性检查（任意宽度 / 行数下都不出界、不以标点开头）", () => {
  const TEXTS = [
    "协议未收录的私有协议，需另行适配（现场确认），老设备不支持远程升级",
    "，一二三四五六七八九十，一二三四五六七八九十",
    "巡检靠纸质表单一天一交；数据事后补录，口径对不上。异常靠电话上报，常常漏",
    "一二三四五，六七八九十、十一二三四五六七八九：真的很难排好",
  ];

  it("每一种组合下：行数 ≤ 上限、每行都在容器内、行首没有禁则标点", () => {
    for (const text of TEXTS) {
      for (let size = 14; size <= 22; size += 4) {
        for (let w = 48; w <= 320; w += 13) {
          for (let maxLines = 1; maxLines <= 3; maxLines += 1) {
            const lines = wrapText(text, size, w, maxLines);
            const ctx = `「${text}」size=${size} w=${w} maxLines=${maxLines}`;
            expect(lines.length, ctx).toBeLessThanOrEqual(maxLines);
            for (const line of lines) {
              expect(estimateTextWidth(line, size), `出界 ${ctx}：「${line}」`).toBeLessThanOrEqual(w + 0.001);
              expect(hasLeadingPunct(line), `行首标点 ${ctx}：「${line}」`).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("renderPptPage — 图标（#144：用足 ppt-master 的图标库）", () => {
  const deck = sampleDeck();
  const ctx = (i: number): { index: number; total: number; scenarioName: string } => ({
    index: i,
    total: deck.pages.length,
    scenarioName: SCENARIO,
  });
  const svgs = deck.pages.map((p, i) => renderPptPage(p, ctx(i)));

  it("每页图标 ≥3，且每个名字都在 PPT_ICONS 白名单里（渲染产物里没有清单外的名字）", () => {
    for (const [i, svg] of svgs.entries()) {
      const names = [...svg.matchAll(new RegExp(`data-icon="${PPT_ICON_LIB}/([^"]+)"`, "g"))].map((m) => m[1]!);
      expect(countSvgIcons(svg), `第 ${i + 1} 页只有 ${names.length} 个图标`).toBeGreaterThanOrEqual(
        PPT_QUALITY.minIconsPerPage,
      );
      for (const name of names) expect(PPT_ICONS as readonly string[], `${name} 不在清单里`).toContain(name);
    }
  });

  it("图标一律走 data-icon 占位（渲染层不读技能目录：产物里没有真实图标 path）", () => {
    for (const [i, svg] of svgs.entries()) {
      expect(svg, `第 ${i + 1} 页不该出现真实图标`).not.toContain("<path");
      expect(svg, `第 ${i + 1} 页`).toContain(`data-icon="${PPT_ICON_LIB}/`);
    }
  });

  it("清单外的名字（含历史遗留的 device-desktop-video）回落 PPT_DEFAULT_ICON", () => {
    const svg = renderPptPage(
      page({
        layout: "要点清单",
        icon: "device-desktop-video",
        bullets: ["全区纳管出报表", "口径写进系统里", "异常自动派单"],
      }),
      ctx(0),
    );
    expect(svg).toContain(`data-icon="${PPT_ICON_LIB}/${PPT_DEFAULT_ICON}"`);
    expect(svg).not.toContain("device-desktop-video");
    expect(svg).not.toContain("projector-screen");
    expect(svg).not.toContain("whiteboard");
  });

  it("位置与尺寸：页图标 16×16、块头 28×28、卡片 28、表头每列 14", () => {
    const grid = svgs[0]!;
    expect(grid).toContain('id="kicker-icon"');
    expect(grid).toContain('width="16" height="16"');
    for (let i = 1; i <= 4; i += 1) expect(grid).toContain(`id="block-${i}-icon"`);
    expect(grid).toContain(`width="28" height="28" fill="${PPT_COLORS.primary}"`);
    expect(svgs[1]).toContain('id="col-1-icon"');
    expect(svgs[2]).toContain('id="stage-1-icon"');
    expect(svgs[3]).toContain('id="layer-1-icon"');
    expect(svgs[4]).toContain('id="card-1-icon"');
    for (let i = 1; i <= 5; i += 1) expect(svgs[5]).toContain(`id="th-${i}-icon"`);
    expect(svgs[5]).toContain('width="14" height="14"');
    expect(svgs[6]).toContain('id="item-1-icon"');
    // 模版没有底部图标；渲染层也不再挂 bulb（变更表 #253）
    for (const [i, svg] of svgs.entries()) {
      expect(svg, `第 ${i + 1} 页不该再有结论带图标`).not.toContain('id="highlight-icon"');
      expect(svg, `第 ${i + 1} 页要有页图标`).toContain('id="kicker-icon"');
    }
  });
});

describe("renderPptPage — 颜色层次（#144：色阶 + 语义色）", () => {
  const deck = sampleDeck();
  const svgs = deck.pages.map((p, i) =>
    renderPptPage(p, { index: i, total: deck.pages.length, scenarioName: SCENARIO }),
  );

  it("每页至少 6 种颜色", () => {
    for (const [i, svg] of svgs.entries()) {
      const colors = countSvgColors(svg);
      expect(colors, `第 ${i + 1} 页只有 ${colors} 种颜色`).toBeGreaterThanOrEqual(PPT_QUALITY.minColorsPerPage);
    }
  });

  it("页顶没有通栏主色带、右上角没有页码胶囊（模版是页脚 NN / MM）", () => {
    const svg = svgs[0]!;
    expect(svg).not.toContain("pptTopBand");
    expect(svg).not.toContain("<linearGradient");
    expect(svg).not.toContain('width="1280" height="8"');
    expect(svg).toContain('<g id="page-no">');
    expect(svg).toContain("01 / 07");
  });

  it("页码在 <g id=\"page-no\"> 里（元信息文字，15px 走字号例外）", () => {
    for (const svg of svgs) {
      expect(svg).toContain('<g id="page-no">');
      expect(svg).toContain(`font-size="${PPT_QUALITY.minMetaFontSize}"`);
    }
  });

  it("块卡：卡底 #F7FAFE + 卡头 #E3F2FD 横条（34 高）+ 左侧 5px 强调竖条按块轮换四色", () => {
    const svg = svgs[0]!;
    expect(svg).toContain(`fill="${PPT_COLORS.subtle}" stroke="${PPT_COLORS.border}"`);
    expect(svg).toContain('height="34"');
    const bars = [...svg.matchAll(/width="5" height="200" rx="2\.5" fill="([^"]+)"/g)].map((m) => m[1]!);
    expect(bars).toEqual([...PPT_BAR_COLORS]);
  });

  it("语气着色：命中问题词 → 橙条，命中价值词 → 绿条，其余按轮换", () => {
    const blocks: PptBlock[] = [
      { head: "现场问题", note: "今天的难点", icon: "alert-triangle", lines: ["纸质表单，常常漏"] },
      { head: "建成后收益", note: "效率提升", icon: "trending-up", lines: ["扫码提交，当天出数"] },
      { head: "中性块", note: "", icon: "file-text", lines: ["照班次派单"] },
    ];
    const svg = renderPptPage(page({ layout: "网格要点", bullets: [], blocks }), {
      index: 0,
      total: 1,
      scenarioName: SCENARIO,
    });
    const bars = [...svg.matchAll(/width="5" height="200" rx="2\.5" fill="([^"]+)"/g)].map((m) => m[1]!);
    expect(bars).toEqual([PPT_COLORS.orange, PPT_COLORS.green, PPT_BAR_COLORS[2]]);
    expect(pptToneOf("今天的难点")).toBe("problem");
    expect(pptToneOf("效率提升")).toBe("value");
    expect(pptBarColor(0, "没什么语气的块")).toBe(PPT_BAR_COLORS[0]);
    expect(PPT_TONE_VALUE.test("对账改善")).toBe(true);
  });

  it("列间 / 行间用 #D6E7F8 细分隔线（网格与双栏）", () => {
    const grid = svgs[0]!;
    expect(grid).toContain('id="grid-rules"');
    expect(grid).toContain(`stroke="${PPT_COLORS.divider}" stroke-width="1"`);
    expect(svgs[1]).toContain('id="col-rules"');
  });

  it("底部一句话总结：模版式的深灰一行（不做蓝底、不加橙条与图标）", () => {
    const svg = svgs[0]!;
    expect(svg).toContain('<g id="summary">');
    expect(svg).toContain(`font-size="${PPT_MIN_FONT}" fill="${PPT_COLORS.text}"`);
    expect(svg).not.toContain('<g id="highlight">');
  });
});

describe("renderPptPage — 字内强调（#144：重点要突出）", () => {
  const ctx = { index: 0, total: 1, scenarioName: SCENARIO };

  it("pptEmphasisOf：只有第一个 ：，、 之前且 ≤8 字的前缀才算关键词", () => {
    expect(pptEmphasisOf("会前准备：把设备台账补齐")).toEqual({ prefix: "会前准备", number: null });
    expect(pptEmphasisOf("这是一句超过八个字的前缀：说明").prefix).toBe("");
    expect(pptEmphasisOf("没有分隔符的一行")).toEqual({ prefix: "", number: null });
    expect(pptEmphasisOf("设备台账、巡检任务")).toEqual({ prefix: "设备台账", number: null });
  });

  it("pptEmphasisOf：数字带单位一起抽出来，只抽第一处", () => {
    expect(pptEmphasisOf("对账周期从 2 天压到 4 小时").number).toBe("2 天");
    expect(pptEmphasisOf("纳管 480 台设备，覆盖 12 个楼层").number).toBe("480 台");
    expect(pptEmphasisOf("准确率 95%").number).toBe("95%");
    expect(pptEmphasisOf("没有数字的一行")).toEqual({ prefix: "", number: null });
  });

  it("行首关键词：20px 粗深蓝 tspan，其余 16px 正文色", () => {
    const svg = renderPptPage(
      page({
        layout: "网格要点",
        bullets: [],
        blocks: [{ head: "设备台账", note: "", icon: "file-text", lines: ["按区域建台账，逐台贴码"] }],
      }),
      ctx,
    );
    expect(svg).toContain(
      // 分隔符留在正文段里（只把关键词本身加粗放大）
      `<tspan font-size="20" fill="${PPT_COLORS.primary}" font-weight="bold">按区域建台账</tspan>，逐台贴码`,
    );
  });

  it("数字强调：22px 粗橙 tspan，同一行只强调第一处（避免花）", () => {
    const svg = renderPptPage(page({ layout: "要点清单", bullets: ["对账周期从 2 天压到 4 小时"] }), ctx);
    const orange = [
      ...svg.matchAll(new RegExp(`<tspan font-size="22" fill="${PPT_COLORS.orange}" font-weight="bold">([^<]*)</tspan>`, "g")),
    ].map((m) => m[1]!);
    expect(orange).toEqual(["2 天"]);
  });

  it("没有分隔符的行整行默认样式（不硬拆）；超长前缀也不拆", () => {
    const plain = /<g id="item-1-main-1-text">([\s\S]*?)<\/g>/.exec(
      renderPptPage(page({ layout: "要点清单", bullets: ["全区纳管出报表"] }), ctx),
    )![1]!;
    expect(plain).not.toContain("<tspan");

    const long = /<g id="item-1-main-1-text">([\s\S]*?)<\/g>/.exec(
      renderPptPage(page({ layout: "要点清单", bullets: ["这是一句超过八个字的前缀：后面的说明"] }), ctx),
    )![1]!;
    expect(long).not.toContain("<tspan");
  });

  it("标题下不再有橙色短横（#145 用户要求去掉），标题直接接副题", () => {
    const svg = renderPptPage(page(), ctx);
    expect(svg).not.toContain('<rect x="80" y="106" width="80" height="6" rx="3" fill="#FF9800"/>');
    expect(svg).not.toContain("width=\"80\" height=\"6\"");
  });

  it("每页强调 ≥3 处（字内强调段 + 16px 以上粗体重点字）", () => {
    const deck = sampleDeck();
    for (const [i, p] of deck.pages.entries()) {
      const svg = renderPptPage(p, { index: i, total: deck.pages.length, scenarioName: SCENARIO });
      const emphasis = countSvgEmphasis(svg);
      expect(emphasis, `第 ${i + 1} 页（${p.layout}）只有 ${emphasis} 处强调`).toBeGreaterThanOrEqual(
        PPT_QUALITY.minEmphasisPerPage,
      );
    }
  });
});
