/**
 * @scene/domain — PPT 大纲校验测试（变更表 #141 立、#142 升）
 *
 * 覆盖全部判定分支：合法 / 页数越界 clamp / 非法页丢弃 / 缺布局与旧布局名 /
 * 各字段超限截断（且不许把页删空）/ 布局回落（网格不足 3 块 → 要点清单）/ 禁用词 /
 * 旧字段兼容（subtitle ← takeaway、blocks ← bullets）/ 每页有效短句数（空页判定依据）。
 */

import { describe, it, expect } from "vitest";
import { PPT_LIMITS } from "@scene/contract";
import { hasPptBanned, parsePptOutline, pptBannedHit, pptPageSentences } from "./ppt-outline.js";

/** 一页合规的网格要点页（默认布局，字段最全） */
function page(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layout: "网格要点",
    kicker: "项目硬规则",
    title: "四条硬规则管住现场",
    subtitle: "把口径写进系统，巡检不再靠人记",
    blocks: [
      { head: "设备台账", note: "谁在现场", lines: ["逐台贴码", "型号一次录清", "换机当场更新"] },
      { head: "巡检任务", note: "照班次发单", lines: ["派发到人", "漏项提醒", "时间留痕"] },
      { head: "异常上报", note: "拍照即上报", lines: ["必传照片", "分级通知", "过程可查"] },
      { head: "数据口径", note: "一处录入", lines: ["只录一次", "同一口径", "对账有据"] },
    ],
    chips: ["扫码巡检"],
    highlight: "口径写进系统，现场按码走",
    ...over,
  };
}

/** 造一份 n 页的大纲 JSON */
function deck(n: number, over: Record<string, unknown> = {}): string {
  const pages = Array.from({ length: n }, (_, i) => page({ title: `第${i + 1}页标题`, ...over }));
  return JSON.stringify({ pages });
}

describe("parsePptOutline — 合法输入", () => {
  it("合规 JSON → 采纳全部页面，字段原样", () => {
    const r = parsePptOutline(deck(7));
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(7);
    expect(r.dropped).toBe(0);
    const p = r.outline!.pages[0]!;
    expect(p.title).toBe("第1页标题");
    expect(p.layout).toBe("网格要点");
    expect(p.kicker).toBe("项目硬规则");
    expect(p.subtitle).toBe("把口径写进系统，巡检不再靠人记");
    expect(p.highlight).toBe("口径写进系统，现场按码走");
    expect(p.blocks).toHaveLength(PPT_LIMITS.blocks.count);
    expect(p.blocks[0]!.lines).toHaveLength(3);
    expect(p.chips).toEqual(["扫码巡检"]);
    expect(p.table).toBeNull();
    expect(p.takeaway).toBe(p.subtitle); // 旧字段镜像
  });

  it("允许 ```json 围栏与前后寒暄（抠出 JSON 即可）", () => {
    const r = parsePptOutline(`好的，这是大纲：\n\`\`\`json\n${deck(5)}\n\`\`\`\n共 5 页。`);
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(5);
  });

  it("七种布局都能通过（各自的组数与内容齐）", () => {
    const raw = JSON.stringify({
      pages: [
        page(),
        page({
          layout: "双栏对比",
          blocks: [],
          columns: [
            { head: "今天", note: "纸质表单", lines: ["纸质记录", "人工统计", "事后补录"] },
            { head: "建成后", note: "扫码巡检", lines: ["自动采集", "实时看板", "自动派单"] },
          ],
        }),
        page({
          layout: "流程阶段",
          blocks: [],
          stages: [
            { head: "样板层", note: "一个楼层先装齐" },
            { head: "验证", note: "两周比对纸质记录" },
            { head: "复制", note: "按楼层分批上线" },
            { head: "全区", note: "全区纳管出报表" },
          ],
        }),
        page({
          layout: "分层架构",
          blocks: [],
          layers: [
            { head: "应用层", items: ["巡检看板", "异常工单"] },
            { head: "平台层", items: ["设备纳管", "规则引擎"] },
            { head: "感知层", items: ["扫码终端", "温湿度探头"] },
          ],
        }),
        page({
          layout: "数据卡片",
          blocks: [],
          cards: [
            { value: "12 个", label: "纳管楼层" },
            { value: "480 台", label: "纳管设备" },
            { value: "2 天", label: "对账周期" },
          ],
        }),
        page({
          layout: "表格",
          blocks: [],
          table: {
            head: ["阶段", "做什么"],
            rows: [
              ["样板层", "装齐终端并贴码"],
              ["单点验证", "比对纸质与系统记录"],
            ],
          },
        }),
        page({ layout: "要点清单", blocks: [], bullets: ["先确认点位清单", "补齐设备台账", "定下异常分级"] }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.error).toBeUndefined();
    expect(r.outline?.pages.map((p) => p.layout)).toEqual([
      "网格要点",
      "双栏对比",
      "流程阶段",
      "分层架构",
      "数据卡片",
      "表格",
      "要点清单",
    ]);
    expect(r.outline?.pages[1]?.columns[0]!.lines).toHaveLength(3);
    expect(r.outline?.pages[2]?.stages).toHaveLength(4);
    expect(r.outline?.pages[3]?.layers[0]!.items).toHaveLength(2);
    expect(r.outline?.pages[4]?.cards).toHaveLength(3);
    expect(r.outline?.pages[5]?.table?.rows).toHaveLength(2);
    expect(r.outline?.pages[6]?.bullets).toHaveLength(3);
  });

  it("旧 #141 的字段兼容：subtitle 缺 → 用 takeaway；缺 blocks → 由 bullets 折块", () => {
    const raw = JSON.stringify({
      pages: [
        { layout: "要点", title: "旧页", takeaway: "旧字段的一句话要点", bullets: ["甲", "乙", "丙"] },
      ],
    });
    const r = parsePptOutline(raw);
    const p = r.outline!.pages[0]!;
    expect(p.subtitle).toBe("旧字段的一句话要点");
    expect(p.layout).toBe("要点清单"); // 旧布局名映射
    expect(p.bullets).toEqual(["甲", "乙", "丙"]);
    expect(r.notes.join("｜")).toContain("旧 bullets");
  });
});

describe("parsePptOutline — 页数 clamp", () => {
  it("超过 10 页 → 截到 10 页，尾部页面记入 dropped 并给提示", () => {
    const r = parsePptOutline(deck(13));
    expect(r.pages).toBe(PPT_LIMITS.maxPages);
    expect(r.dropped).toBe(3);
    expect(r.notes.join("｜")).toContain("超出 10 页上限");
  });

  it("少于 5 页 → 保留（无法凭空造页），只记提示、不算失败", () => {
    const r = parsePptOutline(deck(3));
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(3);
    expect(r.notes.join("｜")).toContain("少于 5 页下限");
  });
});

describe("parsePptOutline — 非法页丢弃 / 缺布局", () => {
  it("非对象、没标题、内容全空的页被丢，其余页照常采纳", () => {
    const raw = JSON.stringify({
      pages: [
        "这一页是字符串",
        { layout: "网格要点", title: "", blocks: [{ head: "x", note: "", lines: ["y"] }] },
        { layout: "网格要点", title: "空页", subtitle: "", blocks: [], bullets: [] },
        page({ title: "留下的这页" }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.dropped).toBe(3);
    expect(r.outline?.pages[0]?.title).toBe("留下的这页");
    expect(r.notes.join("｜")).toContain("已丢弃");
  });

  it("缺 layout → 按兜底布局处理；layout 不认识 → 同样兜底并记提示", () => {
    const missing = parsePptOutline(JSON.stringify({ pages: [page({ layout: undefined })] }));
    expect(missing.outline?.pages[0]?.layout).toBe("要点清单");
    const weird = parsePptOutline(JSON.stringify({ pages: [page({ layout: "鱼骨图" })] }));
    expect(weird.outline?.pages[0]?.layout).toBe("要点清单");
    expect(weird.notes.join("｜")).toContain("按「要点清单」排");
  });

  it("网格不足 3 块 → 降级要点清单（内容搬到 bullets，一条不丢）", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          blocks: [
            { head: "块一", note: "小注", lines: ["行甲", "行乙"] },
            { head: "块二", note: "", lines: ["行丙"] },
          ],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const p = r.outline!.pages[0]!;
    expect(p.layout).toBe("要点清单");
    expect(p.blocks).toEqual([]);
    expect(p.bullets).toEqual(["行甲", "行乙", "行丙"]);
    expect(r.notes.join("｜")).toContain("按「要点清单」排");
  });

  it("恰好 3 块照画（有几块画几块），4 块以上截到 4 块", () => {
    const three = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            blocks: [
              { head: "块一", note: "", lines: ["甲"] },
              { head: "块二", note: "", lines: ["乙"] },
              { head: "块三", note: "", lines: ["丙"] },
            ],
          }),
        ],
      }),
    );
    expect(three.outline?.pages[0]?.layout).toBe("网格要点");
    expect(three.outline?.pages[0]?.blocks).toHaveLength(3);

    const five = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            blocks: Array.from({ length: 5 }, (_, i) => ({ head: `块${i}`, note: "", lines: ["甲"] })),
          }),
        ],
      }),
    );
    expect(five.outline?.pages[0]?.blocks).toHaveLength(PPT_LIMITS.blocks.count);
    expect(five.trimmed).toBeGreaterThan(0);
  });

  it("双栏只有一栏 / 阶段不足 3 个 / 层不足 3 层 / 卡片不足 3 张 / 表格页没有表 → 按要点清单排", () => {
    const raw = JSON.stringify({
      pages: [
        page({ layout: "双栏对比", blocks: [], columns: [{ head: "只有一栏", note: "", lines: ["要点甲"] }] }),
        page({ layout: "流程阶段", blocks: [], stages: [{ head: "只有一个", note: "说明" }] }),
        page({ layout: "分层架构", blocks: [], layers: [{ head: "只有一层", items: ["甲"] }] }),
        page({ layout: "数据卡片", blocks: [], cards: [{ value: "统一纳管", label: "设备台账" }] }),
        page({ layout: "表格", blocks: [], bullets: ["表格没给出来"], table: { head: ["只有一列"], rows: [["x"]] } }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(5);
    const [a, b, c, d, e] = r.outline!.pages;
    expect(a!.layout).toBe("要点清单");
    expect(a!.bullets).toEqual(["要点甲"]);
    expect(b!.layout).toBe("要点清单");
    expect(b!.bullets).toEqual(["只有一个：说明"]);
    expect(c!.layout).toBe("要点清单");
    expect(c!.bullets).toEqual(["只有一层：甲"]);
    expect(d!.layout).toBe("要点清单");
    expect(d!.bullets).toEqual(["统一纳管：设备台账"]);
    expect(e!.layout).toBe("要点清单");
    expect(e!.bullets).toEqual(["表格没给出来"]);
  });
});

describe("parsePptOutline — 字段超限截断", () => {
  it("标题 20 字、副题 32 字、结论带 34 字、小节标签 8 字", () => {
    const long = "字".repeat(60);
    const raw = JSON.stringify({
      pages: [page({ kicker: long, title: long, subtitle: long, highlight: long })],
    });
    const p = parsePptOutline(raw).outline!.pages[0]!;
    expect([...p.kicker]).toHaveLength(PPT_LIMITS.kickerChars);
    expect([...p.title]).toHaveLength(PPT_LIMITS.titleChars);
    expect([...p.subtitle]).toHaveLength(PPT_LIMITS.subtitleChars);
    expect([...p.highlight]).toHaveLength(PPT_LIMITS.highlightChars);
  });

  it("块头 / 小注 / 每块行数 4 条上限、每行 26 字；标签最多 5 个", () => {
    const long = "字".repeat(60);
    const raw = JSON.stringify({
      pages: [
        page({
          chips: Array.from({ length: 8 }, (_, i) => `标签${i}${long}`),
          blocks: Array.from({ length: 4 }, () => ({
            head: long,
            note: long,
            lines: Array.from({ length: 8 }, (_, j) => `${j}号${long}`),
          })),
        }),
      ],
    });
    const p = parsePptOutline(raw).outline!.pages[0]!;
    expect(p.chips).toHaveLength(PPT_LIMITS.chips.max);
    for (const c of p.chips) expect([...c].length).toBeLessThanOrEqual(PPT_LIMITS.chips.chars);
    for (const b of p.blocks) {
      expect([...b.head].length).toBeLessThanOrEqual(PPT_LIMITS.blocks.headChars);
      expect([...b.note].length).toBeLessThanOrEqual(PPT_LIMITS.blocks.noteChars);
      expect(b.lines).toHaveLength(PPT_LIMITS.blocks.maxLines);
      for (const line of b.lines) expect([...line].length).toBeLessThanOrEqual(PPT_LIMITS.blocks.lineChars);
    }
  });

  it("双栏恰取 2 组、每组 5 行上限；阶段截到 5 个；层截到 4 层、每层 4 个组件", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "双栏对比",
          blocks: [],
          columns: [
            { head: "甲".repeat(20), note: "注".repeat(40), lines: ["1", "2", "3", "4", "5", "6", "7"] },
            { head: "乙", note: "", lines: ["1", "2", "3"] },
            { head: "丙", note: "", lines: ["1"] },
          ],
        }),
        page({
          layout: "流程阶段",
          blocks: [],
          stages: Array.from({ length: 7 }, (_, i) => ({ head: `阶段${i}`, note: "说明" })),
        }),
        page({
          layout: "分层架构",
          blocks: [],
          layers: Array.from({ length: 6 }, (_, i) => ({
            head: `层${i}`,
            items: ["一", "二", "三", "四", "五", "六"],
          })),
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const [a, b, c] = r.outline!.pages;
    expect(a!.columns).toHaveLength(2);
    expect(a!.columns[0]!.head).toHaveLength(PPT_LIMITS.columns.headChars);
    expect(a!.columns[0]!.note).toHaveLength(PPT_LIMITS.columns.noteChars);
    expect(a!.columns[0]!.lines).toHaveLength(PPT_LIMITS.columns.maxLines);
    expect(b!.stages).toHaveLength(PPT_LIMITS.stages.max);
    expect(c!.layers).toHaveLength(PPT_LIMITS.layers.max);
    expect(c!.layers[0]!.items).toHaveLength(PPT_LIMITS.layers.maxItems);
  });

  it("卡片取 4 张、值与说明各自截断；表格 ≤6 行 × ≤5 列，表头不足两列视为没有表", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "数据卡片",
          blocks: [],
          cards: Array.from({ length: 6 }, (_, i) => ({
            value: `值${i}${"长".repeat(20)}`,
            label: `说明${i}${"长".repeat(20)}`,
          })),
        }),
        page({
          layout: "表格",
          blocks: [],
          table: {
            head: ["列一", "列二", "列三", "列四", "列五", "列六"],
            rows: Array.from({ length: 9 }, (_, i) => [`行${i}`, "内".repeat(50), "c", "d", "e", "f"]),
          },
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const [a, b] = r.outline!.pages;
    expect(a!.cards).toHaveLength(PPT_LIMITS.cards.max);
    for (const c of a!.cards) {
      expect([...c.value].length).toBeLessThanOrEqual(PPT_LIMITS.cards.valueChars);
      expect([...c.label].length).toBeLessThanOrEqual(PPT_LIMITS.cards.labelChars);
    }
    const t = b!.table!;
    expect(t.head).toHaveLength(PPT_LIMITS.table.maxCols);
    expect(t.rows).toHaveLength(PPT_LIMITS.table.maxRows);
    for (const row of t.rows) {
      expect(row).toHaveLength(t.head.length);
      for (const cell of row) expect([...cell].length).toBeLessThanOrEqual(PPT_LIMITS.table.cellChars);
    }
  });

  it("截断不许把一页删空：超限但仍有内容的页照常采纳", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          title: "标题".repeat(30),
          blocks: [
            { head: "头一", note: "", lines: ["保".repeat(200)] },
            { head: "头二", note: "", lines: ["守".repeat(200)] },
            { head: "头三", note: "", lines: ["住".repeat(200)] },
          ],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.outline!.pages[0]!.blocks[0]!.lines[0]!.length).toBeGreaterThan(0);
  });
});

describe("parsePptOutline — 缺失字段的兜底", () => {
  it("缺 kicker → 用标题前 8 字兜底并记提示（胶囊必须存在）", () => {
    const r = parsePptOutline(JSON.stringify({ pages: [page({ kicker: "" })] }));
    expect(r.outline!.pages[0]!.kicker).toBe("四条硬规则管住现");
    expect(r.notes.join("｜")).toContain("缺小节标签");
  });

  it("缺 highlight → 用副题；副题也缺 → 用标题（每页都要有结论带）", () => {
    const a = parsePptOutline(JSON.stringify({ pages: [page({ highlight: "" })] }));
    expect(a.outline!.pages[0]!.highlight).toBe("把口径写进系统，巡检不再靠人记");
    const b = parsePptOutline(JSON.stringify({ pages: [page({ highlight: "", subtitle: "" })] }));
    expect(b.outline!.pages[0]!.highlight).toBe("四条硬规则管住现场");
  });
});

describe("parsePptOutline — 禁用词（占位 / 决策建议 / 内部痕迹）", () => {
  it("内容行 / 标签里的占位与决策措辞被擦掉，页保留", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          chips: ["扫码巡检", "金额待客户提供"],
          blocks: [
            { head: "块一", note: "", lines: ["现场靠纸质表单", "金额待客户提供", "建议采用试点先行"] },
            { head: "块二", note: "", lines: ["异常靠电话上报"] },
            { head: "块三", note: "", lines: ["台账分散"] },
          ],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.scrubbed).toBe(3);
    expect(r.outline!.pages[0]!.chips).toEqual(["扫码巡检"]);
    expect(r.outline!.pages[0]!.blocks[0]!.lines).toEqual(["现场靠纸质表单"]);
  });

  it("小节标签 / 标题 / 副题 / 结论带里出现禁用词 → 整页丢弃", () => {
    const raw = JSON.stringify({
      pages: [
        page({ kicker: "待客户提供" }),
        page({ title: "金额待客户提供" }),
        page({ subtitle: "建议采用分期建设" }),
        page({ highlight: "推荐采用双活架构" }),
        page({ title: "留下的" }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.dropped).toBe(4);
    expect(r.outline!.pages[0]!.title).toBe("留下的");
  });

  it("表格里命中禁用词的行被擦掉；表头命中则整表作废", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "表格",
          blocks: [],
          table: {
            head: ["层次", "承担什么"],
            rows: [
              ["感知层", "采集现场数据"],
              ["成本", "金额待客户提供"],
            ],
          },
        }),
        page({ layout: "表格", blocks: [], table: { head: ["表2-1", "内容"], rows: [["a", "b"]] } }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.outline!.pages[0]!.table!.rows).toEqual([["感知层", "采集现场数据"]]);
    expect(r.outline!.pages[1]!.layout).toBe("要点清单");
    expect(r.scrubbed).toBe(1);
  });

  it("阶段 / 层里命中禁用词的那一项被擦掉", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "流程阶段",
          blocks: [],
          stages: [
            { head: "样板层", note: "一个楼层先装齐" },
            { head: "验证", note: "待现场勘查确定" },
            { head: "复制", note: "按楼层分批上线" },
            { head: "全区", note: "全区纳管出报表" },
          ],
        }),
        page({
          layout: "分层架构",
          blocks: [],
          layers: [
            { head: "应用层", items: ["巡检看板", "异常工单"] },
            { head: "平台层", items: ["设备纳管", "规则引擎"] },
            { head: "感知层", items: ["扫码终端", "待补齐"] },
          ],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.outline!.pages[0]!.stages).toHaveLength(3);
    expect(r.outline!.pages[1]!.layers[2]!.items).toEqual(["扫码终端"]);
    expect(r.scrubbed).toBe(2);
  });

  it("hasPptBanned / pptBannedHit 认三类禁用词，正常句子不误伤", () => {
    expect(hasPptBanned("预计 181 万元")).toBe(false);
    expect(hasPptBanned("待现场勘查确定")).toBe(true);
    expect(hasPptBanned("推荐采用双活架构")).toBe(true);
    expect(hasPptBanned("表4-1 能力底账")).toBe(true);
    expect(pptBannedHit("出处：某某白皮书")).toBe("出处：");
    expect(pptBannedHit("统一纳管、实时可见")).toBeNull();
  });
});

describe("parsePptOutline — 每页有效短句数（pageSentences，空页判定依据）", () => {
  it("与页同序同长；网格要点 = 块头 + 小注 + 每行", () => {
    const r = parsePptOutline(JSON.stringify({ pages: [page(), page({ title: "第二页" })] }));
    expect(r.pageSentences).toHaveLength(r.pages);
    expect(r.pageSentences).toEqual([20, 20]);
    expect(pptPageSentences(r.outline!.pages[0]!)).toBe(20);
  });

  it("六种布局各自的数法（阶段 head+note / 层 head+组件 / 卡片 value+label / 表格 表头+格 / 清单 每行 / 双栏 head+note+行）", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "流程阶段",
          blocks: [],
          stages: [
            { head: "样板层", note: "先装齐" },
            { head: "验证", note: "比对两周" },
            { head: "复制", note: "分批上线" },
            { head: "全区", note: "纳管出表" },
          ],
        }),
        page({
          layout: "分层架构",
          blocks: [],
          layers: [
            { head: "应用层", items: ["看板", "工单"] },
            { head: "平台层", items: ["纳管", "规则"] },
            { head: "感知层", items: ["终端", "探头"] },
          ],
        }),
        page({
          layout: "数据卡片",
          blocks: [],
          cards: [
            { value: "12 个", label: "楼层" },
            { value: "480 台", label: "设备" },
            { value: "2 天", label: "对账" },
          ],
        }),
        page({
          layout: "表格",
          blocks: [],
          table: { head: ["阶段", "做什么"], rows: [["样板层", "装齐"], ["验证", "比对"]] },
        }),
        page({ layout: "要点清单", blocks: [], bullets: ["甲", "乙", "丙"] }),
        page({
          layout: "双栏对比",
          blocks: [],
          columns: [
            { head: "今天", note: "纸质", lines: ["甲", "乙", "丙"] },
            { head: "建成后", note: "扫码", lines: ["丁", "戊", "己"] },
          ],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pageSentences).toEqual([8, 9, 6, 6, 3, 10]);
  });

  it("表格声明了却没给表 → 降级后按兜底清单数（真跑的空页就是这么来的）", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "表格",
          blocks: [],
          table: null,
          bullets: ["协议未收录的私有协议需另行适配", "老设备不支持远程升级"],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.outline!.pages[0]!.layout).toBe("要点清单");
    expect(r.pageSentences).toEqual([2]);
  });

  it("整体失败时是空数组（调用方不必判空）", () => {
    expect(parsePptOutline("这里没有 JSON").pageSentences).toEqual([]);
    expect(parsePptOutline('{"pages":[]}').pageSentences).toEqual([]);
  });
});

describe("parsePptOutline — 明确失败值", () => {
  it("不是 JSON → outline 为 null 并给原因", () => {
    const r = parsePptOutline("我觉得这份方案很好，不需要 PPT。");
    expect(r.outline).toBeNull();
    expect(r.error).toBe("模型返回里没有 JSON");
    expect(r.pages).toBe(0);
  });

  it("JSON 但缺 pages → 失败", () => {
    const r = parsePptOutline('{"slides":[]}');
    expect(r.outline).toBeNull();
    expect(r.error).toContain("缺少 pages");
  });

  it("pages 为空数组 → 失败", () => {
    const r = parsePptOutline('{"pages":[]}');
    expect(r.outline).toBeNull();
    expect(r.error).toContain("没有可用页面");
  });

  it("pages 里每一页都非法 → 失败（且带丢弃说明）", () => {
    const r = parsePptOutline(JSON.stringify({ pages: [1, "x", { title: "" }] }));
    expect(r.outline).toBeNull();
    expect(r.error).toContain("没有可用页面");
    expect(r.notes.length).toBeGreaterThan(0);
  });
});
