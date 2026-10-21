/**
 * @scene/domain — PPT 大纲校验测试（变更表 #141 立、#142 升、#144 升、#146 升、#151 升）
 *
 * 覆盖全部判定分支：合法 / 页数越界 clamp / 非法页丢弃 / 缺布局与旧布局名 /
 * 各字段超限截断（且不许把页删空）/ 布局回落（网格不足 3 块 → 要点清单）/ 禁用词 /
 * 旧字段兼容（subtitle ← takeaway、blocks ← bullets）/ 每页有效短句数（空页判定依据）/
 * #144 图标归一（缺 → 兜底、清单外 → 兜底、带库前缀 → 剥前缀、表头列一一对应）。
 *
 * 变更表 #146 追加**大纲质量判据** `checkPptOutlineQuality` 的逐条正反例：
 * 观点型标题 / 记忆点 / 信息量（含版式容量）/ **数字不在正文** / **两页重复** /
 * 叙事顺序 / 自包含 / 图标与版式成套。
 *
 * 变更表 #151 再加两条：④ 的**中文数字**（三成 / 两倍 / 三分之一 / 百分之三十 都算数字，
 * 一致 / 统一 / 一起 / 一线 / 十分 / 万元 一律不误报）与 ⑧ 的**图标重复**（同页两个元素
 * 同一个图标要报；「图标数 ≥ 元素数」结构上必然成立，不单列）。
 */

import { describe, it, expect } from "vitest";
import {
  PPT_DEFAULT_ICON,
  PPT_ICONS,
  PPT_LIMITS,
  PPT_OUTLINE_QUALITY,
  type PptOutline,
  type PptPage,
} from "@scene/contract";
import {
  PPT_OUTLINE_ISSUE_CODES,
  checkPptOutlineQuality,
  hasPptBanned,
  parsePptOutline,
  pptBannedHit,
  pptLayoutSentenceMax,
  pptPageSentences,
  type PptOutlineQualityCode,
  type PptOutlineQualityIssue,
} from "./ppt-outline.js";

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
    expect(r.notes.join("｜")).toContain("少于 7 页下限");
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


describe("parsePptOutline — 图标归一（#144）", () => {
  it("页 / 块 / 栏 / 阶段 / 层 / 卡片 / 表头列的 icon 都原样收下", () => {
    const r = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            icon: "sitemap",
            blocks: [
              { head: "设备台账", note: "谁在现场", icon: "file-text", lines: ["逐台贴码"] },
              { head: "巡检任务", note: "照班次发单", icon: "calendar-check", lines: ["派发到人"] },
              { head: "异常上报", note: "拍照即上报", icon: "alert-triangle", lines: ["必传照片"] },
            ],
          }),
          {
            layout: "双栏对比",
            kicker: "今天与建成后",
            icon: "arrows-split",
            title: "同一件事两种做法",
            subtitle: "左边是今天，右边是建成后",
            columns: [
              { head: "今天", note: "纸质表单", icon: "file-text", lines: ["纸质记录", "人工统计", "事后补录"] },
              { head: "建成后", note: "扫码巡检", icon: "list-check", lines: ["自动采集", "实时看板", "自动派单"] },
            ],
            highlight: "同样的活，换个干法",
          },
          {
            layout: "流程阶段",
            kicker: "推进路径",
            icon: "route",
            title: "四步走到全量覆盖",
            subtitle: "先跑通一层，再复制到全区",
            stages: [
              { head: "样板层", note: "一个楼层先装齐", icon: "building-community" },
              { head: "验证", note: "两周比对纸质记录", icon: "checkup-list" },
              { head: "复制", note: "按楼层分批上线", icon: "devices" },
            ],
            highlight: "先跑通一层，再谈全区",
          },
          {
            layout: "分层架构",
            kicker: "总体架构",
            icon: "hierarchy",
            title: "四层架构怎么落",
            subtitle: "自上而下各司其职",
            layers: [
              { head: "应用层", icon: "chart-bar", items: ["巡检看板", "异常工单"] },
              { head: "平台层", icon: "server", items: ["设备纳管", "规则引擎"] },
              { head: "感知层", icon: "wifi", items: ["扫码终端", "温湿度探头"] },
            ],
            highlight: "分层清楚才好落地",
          },
          {
            layout: "数据卡片",
            kicker: "关键数字",
            icon: "gauge",
            title: "四项变化看得见",
            subtitle: "口径都取自这份报告正文",
            cards: [
              { value: "12 个", label: "纳管楼层", icon: "building-skyscraper" },
              { value: "480 台", label: "纳管设备", icon: "devices" },
              { value: "2 天", label: "对账周期", icon: "clock" },
            ],
            highlight: "变化要能被量出来",
          },
          {
            layout: "表格",
            kicker: "分工与节奏",
            icon: "briefcase",
            title: "谁在哪一步做什么",
            subtitle: "每一行一件交付物",
            table: {
              head: ["阶段", "做什么", "谁负责"],
              icons: ["route", "list-check", "users"],
              rows: [
                ["样板层", "装齐终端并贴码", "运维班"],
                ["单点验证", "比对纸质与系统记录", "信息部"],
              ],
            },
            highlight: "责任到人，节点到周",
          },
        ],
      }),
    );
    expect(r.error).toBeUndefined();
    const [grid, cols, stages, layers, cards, table] = r.outline!.pages;
    expect(grid!.icon).toBe("sitemap");
    expect(grid!.blocks.map((b) => b.icon)).toEqual(["file-text", "calendar-check", "alert-triangle"]);
    expect(cols!.columns.map((c) => c.icon)).toEqual(["file-text", "list-check"]);
    expect(stages!.stages.map((s) => s.icon)).toEqual(["building-community", "checkup-list", "devices"]);
    expect(layers!.layers.map((l) => l.icon)).toEqual(["chart-bar", "server", "wifi"]);
    expect(cards!.cards.map((c) => c.icon)).toEqual(["building-skyscraper", "devices", "clock"]);
    expect(table!.table!.icons).toEqual(["route", "list-check", "users"]);
  });

  it("缺 icon → 兜底 presentation；清单外的名字 → 同样兜底（历史遗留的 device-desktop-video）", () => {
    const r = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            blocks: [
              { head: "设备台账", note: "谁在现场", lines: ["逐台贴码"] },
              { head: "巡检任务", note: "照班次发单", icon: "device-desktop-video", lines: ["派发到人"] },
              { head: "异常上报", note: "拍照即上报", icon: "projector-screen", lines: ["必传照片"] },
            ],
          }),
        ],
      }),
    );
    const icons = r.outline!.pages[0]!.blocks.map((b) => b.icon);
    expect(icons).toEqual([PPT_DEFAULT_ICON, PPT_DEFAULT_ICON, PPT_DEFAULT_ICON]);
    expect(r.outline!.pages[0]!.icon).toBe(PPT_DEFAULT_ICON);
  });

  it("带库前缀的写法剥掉前缀照收；空白 / 非字符串也兜底", () => {
    const r = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            icon: "tabler-outline/cloud",
            blocks: [
              { head: "设备台账", note: "", icon: "  server  ", lines: ["逐台贴码"] },
              { head: "巡检任务", note: "", icon: 42, lines: ["派发到人"] },
              { head: "异常上报", note: "", lines: ["必传照片"] },
            ],
          }),
        ],
      }),
    );
    const icons = r.outline!.pages[0]!.blocks.map((b) => b.icon);
    expect(r.outline!.pages[0]!.icon).toBe("cloud");
    expect(icons).toEqual(["server", PPT_DEFAULT_ICON, PPT_DEFAULT_ICON]);
    // 归一后的名字一定在清单里（渲染层与门禁都按这个假设走）
    for (const name of [r.outline!.pages[0]!.icon, ...icons]) {
      expect(PPT_ICONS as readonly string[]).toContain(name);
    }
  });

  it("表头 icons 少于列数 → 缺的那几列兜底（一列一个，绝不越界）", () => {
    const r = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            layout: "表格",
            blocks: [],
            table: {
              head: ["阶段", "做什么", "谁负责", "周期"],
              icons: ["route"],
              rows: [["样板层", "装齐终端并贴码", "运维班", "第 1 周"]],
            },
          }),
        ],
      }),
    );
    expect(r.outline!.pages[0]!.table!.icons).toEqual([
      "route",
      PPT_DEFAULT_ICON,
      PPT_DEFAULT_ICON,
      PPT_DEFAULT_ICON,
    ]);
  });
});

// ─── 大纲质量判据（变更表 #146） ──────────────────────────────
//
// 每一条判据都要有**正反例**：合格基线 0 问题；一处坏掉就点名到页、点出问题码。
// 关键负例两条：**数字不在正文**（防编造，硬判据）与**两页重复**（同一句话不许出现在两页）。

/** 判据用例里用的"报告正文"（数字都取自这里，6 页页号也在里面） */
const MD = [
  "# 智慧会议室建设工作方案",
  "",
  "本方案共 6 部分。现场纳管设备 480 台，覆盖 12 个会议室，对账周期压到 2 天，只用 1 张表。",
  "第1部分讲现状，第2部分讲问题，第3部分讲方案，第4部分讲建设，第5部分讲价值，第6部分讲节奏。",
  "节省 30% 的巡检工时是客户给的目标。",
].join("\n");

/** 生成器用的词池（组合出互不相同的短句，避免判据之间互相干扰） */
const G_HEADS = [
  "设备台账",
  "巡检任务",
  "异常上报",
  "数据口径",
  "人员分工",
  "系统对接",
  "现场施工",
  "验收标准",
  "培训交接",
  "运维值守",
  "告警处置",
  "报表口径",
];
const G_NOTE_A = ["设备现场", "巡检班次", "异常处置", "数据口径", "人员职责", "系统对接", "施工安排"];
const G_NOTE_B = ["按区域落地", "按班次执行", "按等级通知", "按口径统一", "按岗位分派"];
const G_LINE_A = [
  "逐台贴码登记",
  "照单派发任务",
  "拍照上报异常",
  "一处录入台账",
  "按岗定责到人",
  "按协议对接接口",
  "分批进场施工",
  "逐项核验交付",
  "分批交接培训",
  "轮值留痕值守",
  "分级通知告警",
  "按天核对数据",
];
const G_LINE_B = ["当场留痕", "到人可查", "有据可依", "口径唯一", "边界清楚", "接口明确", "差异可查"];
/** 网格要点四块的图标（变更表 #151：同页不许重复，所以四块四个名字） */
const BLOCK_ICONS = ["file-text", "checkup-list", "database", "clock"] as const;

/**
 * 一页**判据合格**的网格要点页（20 条短句、标题是观点、有记忆点、内容按页号互不相同）
 *
 * 每块给**不同**的图标（变更表 #151 的「图标重复」判据：同页两个元素同一个图标要报），
 * 页图标也不与块图标重样。
 */
function okPage(i: number, over: Partial<PptPage> = {}): PptPage {
  const at = (k: number): number => i * 4 + k;
  return {
    layout: "网格要点",
    kicker: `小节${i + 1}`,
    icon: "list-check",
    title: `第${i + 1}条硬规则管住现场`,
    subtitle: `第${i + 1}批做法写进系统，现场不再靠人记`,
    blocks: [0, 1, 2, 3].map((k) => ({
      head: G_HEADS[at(k) % G_HEADS.length]!,
      note: `${G_NOTE_A[at(k) % G_NOTE_A.length]!}${G_NOTE_B[at(k) % G_NOTE_B.length]!}`,
      icon: BLOCK_ICONS[k % BLOCK_ICONS.length]!,
      lines: [0, 1, 2].map(
        (j) => `${G_LINE_A[(at(k) * 3 + j) % G_LINE_A.length]!}${G_LINE_B[(at(k) * 3 + j) % G_LINE_B.length]!}`,
      ),
    })),
    columns: [],
    stages: [],
    layers: [],
    cards: [],
    table: null,
    chips: [],
    highlight: `第${i + 1}页的一句话结论`,
    ...over,
  };
}

/** 一份判据合格的 n 页大纲 */
function okDeck(n = 6): PptOutline {
  return { pages: Array.from({ length: n }, (_, i) => okPage(i)) };
}

/** 一份判据合格的 n 页大纲 + 把第 at 页换掉 */
function deckWith(at: number, over: Partial<PptPage>, n = 6): PptOutline {
  const deck = okDeck(n);
  deck.pages[at] = okPage(at, over);
  return deck;
}

/** 判据输出里某个问题码的页号（没有就空数组） */
function codesOf(issues: readonly PptOutlineQualityIssue[], code: PptOutlineQualityCode): number[] {
  return issues.filter((i) => i.code === code).map((i) => i.page);
}

/** 封面页（模版 s1：四张能力卡 + 三步链），判据合格 */
function coverPage(over: Partial<PptPage> = {}): PptPage {
  return {
    ...okPage(0),
    layout: "封面",
    title: "一套平台管住全厂的设备与能耗",
    blocks: [0, 1, 2, 3].map((k) => ({
      head: G_HEADS[k]!,
      note: `${G_NOTE_A[k]!}${G_NOTE_B[k]!}`,
      icon: BLOCK_ICONS[k]!,
      lines: [
        `${G_LINE_A[k]!}${G_LINE_B[k]!}`,
        `${G_LINE_A[(k + 3) % G_LINE_A.length]!}${G_LINE_B[(k + 2) % G_LINE_B.length]!}`,
      ],
    })),
    stages: [0, 1, 2].map((k) => ({
      head: G_HEADS[k]!,
      note: `${G_NOTE_A[k]!}，先跑通`,
      icon: ["route", "sitemap", "circle-check"][k]!,
    })),
    chips: ["试点厂", "泵站"],
    ...over,
  };
}

/** 一份 7 页成稿：封面 + 六页网格要点（用于测结构判据） */
function coverDeck(over: Partial<PptPage> = {}): PptOutline {
  const pages = [coverPage(over), ...Array.from({ length: 6 }, (_, i) => okPage(i + 1))];
  return { pages };
}

describe("checkPptOutlineQuality — 模版基线（变更表 #253）", () => {
  it("第一页不是封面 → 记「缺封面」，并点名模版版式", () => {
    const issues = checkPptOutlineQuality(okDeck(7), MD);
    const miss = issues.filter((i) => i.code === "缺封面");
    expect(miss).toHaveLength(1);
    expect(miss[0]!.page).toBe(1);
    expect(miss[0]!.detail).toContain("四张能力卡");
  });

  it("封面内容不齐（只有两张卡）→ 解析时降级，再判「缺封面」", () => {
    const deck = coverDeck({ blocks: okPage(1).blocks.slice(0, 2) });
    const parsed = parsePptOutline(JSON.stringify(deck));
    expect(parsed.outline!.pages[0]!.layout).not.toBe("封面");
    expect(checkPptOutlineQuality(parsed.outline!, MD).map((i) => i.code)).toContain("缺封面");
  });

  it("整份只用一种结构 → 记「版式单一」；换够 4 种就不报", () => {
    expect(checkPptOutlineQuality(coverDeck(), MD).map((i) => i.code)).toContain("版式单一");
    const varied = coverDeck();
    varied.pages[1] = { ...okPage(1), layout: "网格要点" };
    varied.pages[2] = {
      ...okPage(2),
      layout: "双栏对比",
      blocks: [],
      columns: [
        { head: "今天的做法", note: "纸质表单", icon: "file-text", lines: ["纸质表格一天一交", "数据事后补录", "口径各写各的", "对账翻单据"] },
        { head: "建成后的做法", note: "扫码即录", icon: "list-check", lines: ["扫码当场提交", "数据实时入库", "口径系统统一", "对账一键出数"] },
      ],
    };
    varied.pages[3] = {
      ...okPage(3),
      layout: "流程阶段",
      blocks: [],
      stages: [0, 1, 2].map((k) => ({ head: G_HEADS[k]!, note: `${G_NOTE_A[k]!}，一阶段一件事`, icon: ["route", "sitemap", "circle-check"][k]! })),
    };
    varied.pages[4] = {
      ...okPage(4),
      layout: "分层架构",
      blocks: [],
      layers: [0, 1, 2].map((k) => ({ head: G_HEADS[k]!, icon: ["hierarchy", "server", "network"][k]!, items: ["巡检看板", "设备纳管", "扫码终端"] })),
    };
    const codes = checkPptOutlineQuality(varied, MD).map((i) => i.code);
    expect(codes).not.toContain("版式单一");
  });

  it("同一结构连续 3 页 → 记「版式重复」，点名第三页", () => {
    const deck = coverDeck();
    deck.pages[1] = { ...okPage(1), layout: "网格要点" };
    deck.pages[2] = { ...okPage(2), layout: "网格要点" };
    deck.pages[3] = { ...okPage(3), layout: "网格要点" };
    const dup = checkPptOutlineQuality(deck, MD).filter((i) => i.code === "版式重复");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.page).toBe(4);
  });
});

describe("checkPptOutlineQuality — 合格基线与版式容量", () => {
  it("六页合规大纲 → 0 问题（判据不能误杀合格稿）", () => {
    expect(checkPptOutlineQuality(okDeck(), MD)).toEqual([]);
  });

  it("判据只会用声明的那些问题码（问题码清单是判据的对外契约）", () => {
    const issues = checkPptOutlineQuality(deckWith(0, { title: "现状", highlight: "" }), MD);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(PPT_OUTLINE_ISSUE_CODES as readonly string[]).toContain(issue.code);
    }
  });

  it("版式结构上限：网格 28 / 双栏 14 / 阶段 10 / 分层 35 / 卡片 8 / 表格 35 / 清单 6", () => {
    expect(pptLayoutSentenceMax("网格要点")).toBe(28);
    expect(pptLayoutSentenceMax("双栏对比")).toBe(14);
    expect(pptLayoutSentenceMax("流程阶段")).toBe(10);
    expect(pptLayoutSentenceMax("分层架构")).toBe(35);
    expect(pptLayoutSentenceMax("数据卡片")).toBe(8);
    expect(pptLayoutSentenceMax("表格")).toBe(35);
    expect(pptLayoutSentenceMax("要点清单")).toBe(6);
  });

  it("结构上到不了 12 条的版式按「写满」算（数据卡片 4 张 = 8 条就合格）", () => {
    const cards = [0, 1, 2, 3].map((k) => ({
      value: `${k + 1} 张`,
      label: G_HEADS[k]!,
      // 四张各一个图标（变更表 #151：同页图标不许重复）
      icon: ["chart-bar", "trending-up", "target", "gauge"][k]!,
    }));
    const issues = checkPptOutlineQuality(deckWith(0, { layout: "数据卡片", blocks: [], cards }), MD);
    expect(codesOf(issues, "信息量不足")).toEqual([]);
    // 但只给 3 张（6 条 < 8 条）就要报
    const thin = checkPptOutlineQuality(
      deckWith(0, { layout: "数据卡片", blocks: [], cards: cards.slice(0, 3) }),
      MD,
    );
    expect(codesOf(thin, "信息量不足")).toEqual([1]);
  });
});

describe("checkPptOutlineQuality — ① 观点型标题", () => {
  it("章节式空词（现状 / 概述 / 背景 / 小结）一律判不合格", () => {
    for (const title of ["现状", "项目概述", "背景介绍", "本章小结", "现状与问题"]) {
      const issues = checkPptOutlineQuality(deckWith(2, { title }), MD);
      expect(codesOf(issues, "非观点型标题"), title).toEqual([3]);
      expect(issues.find((i) => i.code === "非观点型标题")!.detail).toContain("章节式空词");
    }
  });

  it("名词堆也要报（既不是判断、也没有动词）", () => {
    const issues = checkPptOutlineQuality(deckWith(0, { title: "设备清单" }), MD);
    expect(codesOf(issues, "非观点型标题")).toEqual([1]);
    expect(issues[0]!.detail).toContain("看不出观点");
  });

  it("带判断语气的长标题放行（「现状不改，代价只会更高」不算空词）", () => {
    expect(codesOf(checkPptOutlineQuality(deckWith(0, { title: "现状不改，代价只会更高" }), MD), "非观点型标题")).toEqual([]);
  });

  it("超过 20 字要报「标题超长」", () => {
    const long = "把每一台设备的台账按区域逐台贴码登记并当场确认更新后的责任人";
    expect(Array.from(long).length).toBeGreaterThan(PPT_LIMITS.titleChars);
    expect(codesOf(checkPptOutlineQuality(deckWith(1, { title: long }), MD), "标题超长")).toEqual([2]);
  });

  it("#146 补充：**长标题**不因「没有动词」被误判（「四层架构加一脑一平台」11 字是合格标题）", () => {
    const deck = deckWith(2, { title: "四层架构加一脑一平台" });
    expect(codesOf(checkPptOutlineQuality(deck, MD), "非观点型标题")).toEqual([]);
  });

  it("#146 补充：短标题没判断词仍然判弱（「设备清单」4 字）", () => {
    const deck = deckWith(2, { title: "设备清单" });
    expect(codesOf(checkPptOutlineQuality(deck, MD), "非观点型标题")).toEqual([3]);
  });
});

describe("checkPptOutlineQuality — ② 记忆点", () => {
  it("空记忆点 → 缺记忆点（点名到页）", () => {
    const issues = checkPptOutlineQuality(deckWith(3, { highlight: "" }), MD);
    expect(codesOf(issues, "缺记忆点")).toEqual([4]);
    expect(issues[0]!.detail).toContain("没有记忆点");
  });

  it("记忆点超过 34 字 → 缺记忆点（要短到能记住）", () => {
    const long = "这一页把设备台账巡检任务异常上报数据口径四件事一次说清楚并且每一件都要落到人头上可查";
    expect(Array.from(long).length).toBeGreaterThan(PPT_OUTLINE_QUALITY.highlightChars);
    expect(codesOf(checkPptOutlineQuality(deckWith(0, { highlight: long }), MD), "缺记忆点")).toEqual([1]);
  });
});

describe("checkPptOutlineQuality — ③ 信息量", () => {
  it("有效短句不足 12 条 → 信息量不足（沿用 pptPageSentences 的口径）", () => {
    const thin = deckWith(4, {
      blocks: [0, 1].map((k) => ({
        head: G_HEADS[k]!,
        note: "",
        icon: "file-text",
        lines: [G_LINE_A[k]!],
      })),
    });
    const issues = checkPptOutlineQuality(thin, MD);
    expect(codesOf(issues, "信息量不足")).toEqual([5]);
    expect(issues.find((i) => i.code === "信息量不足")!.detail).toContain("只有 4 条有效短句");
  });
});

describe("checkPptOutlineQuality — ④ 数字只许来自报告正文（防编造，硬判据）", () => {
  it("编造的数字（正文里没有）→ 数字不在正文，点名到页并写出是哪个数", () => {
    const page = okPage(0);
    page.blocks[0]!.lines[0] = "节省 47% 的巡检工时";
    const issues = checkPptOutlineQuality({ pages: [page] }, MD);
    expect(codesOf(issues, "数字不在正文")).toEqual([1]);
    expect(issues[0]!.detail).toContain("47");
  });

  it("正文里有的数字（含 %、量词）一律放行", () => {
    const page = okPage(0);
    page.blocks[0]!.lines = ["现场纳管设备 480 台", "覆盖 12 个会议室", "对账周期压到 2 天", "只留 1 张表", "目标省 30% 工时"];
    page.blocks[1]!.lines = ["第1部分讲现状", "第2部分讲问题", "第3部分讲方案"];
    // 上面把第 1 页的标题/副题/记忆点里的数字也一起对一遍：1–6 都在正文里
    expect(codesOf(checkPptOutlineQuality({ pages: [page] }, MD), "数字不在正文")).toEqual([]);
  });

  it("中文数字只认带量词的写法（「八个环节」可兜「8 个」，「统一」不能兜「1」）", () => {
    // 这一页自己不带别的数字，只留一个 8，测"中文数字兜底"这一件事
    const page = okPage(0, { kicker: "小节", title: "硬规则管住现场", subtitle: "做法写进系统", highlight: "一句话结论" });
    page.blocks[0]!.lines = ["只用8个环节跑完全流程", "口径统一到一处"];
    const noEight = checkPptOutlineQuality({ pages: [page] }, "口径统一到一处。");
    expect(noEight.map((i) => i.code)).toEqual(["数字不在正文"]);
    expect(noEight[0]!.detail).toContain("8");
    const withEight = checkPptOutlineQuality({ pages: [page] }, "全部只用八个环节跑完全流程。");
    expect(codesOf(withEight, "数字不在正文")).toEqual([]);
  });
});

/**
 * 一页只放一句被测文本（其余字段一个数字都没有），返回被判「数字不在正文」的数字串
 *
 * 变更表 #151 的用例都走这里：正例看"哪几个中文数字被当成了数字"，反例看"有没有误判"。
 */
function cnTokensOf(text: string, md: string): string[] {
  const base = okPage(0, {
    kicker: "小节",
    title: "硬规则管住现场",
    subtitle: "做法写进系统",
    highlight: "一句话结论",
  });
  base.blocks = base.blocks.map((b, k) => ({ ...b, lines: k === 0 ? [text] : ["照单派发任务"] }));
  return checkPptOutlineQuality({ pages: [base] }, md)
    .filter((i) => i.code === "数字不在正文")
    .map((i) => /「([^」]+)」/.exec(i.detail)?.[1] ?? "");
}

describe("checkPptOutlineQuality — ④ 数字可溯源：中文数字也算数字（变更表 #151）", () => {
  /** 正例：大纲里这些写法都要被当成数字（正文没写就报、写了就放行） */
  const NUMERIC = [
    "三成",
    "五类",
    "十二项",
    "三十个",
    "两倍",
    "三倍",
    "半小时",
    "三分之一",
    "百分之三十",
  ] as const;

  it("九种中文数字写法都算数字（正文里没有 → 一律报，且点名是哪个数字）", () => {
    for (const token of NUMERIC) {
      const hits = cnTokensOf(`现场按${token}推进`, "正文里没有任何数字。");
      expect(hits, token).toContain(token);
    }
  });

  it("正文里写了同一句中文数字 → 一律放行", () => {
    for (const token of NUMERIC) {
      expect(cnTokensOf(`现场按${token}推进`, `报告正文：现场按${token}推进。`), token).toEqual([]);
    }
  });

  it("正文写阿拉伯数字也认（三成 ↔ 3成、十二项 ↔ 12项、两倍 ↔ 2倍、三十个 ↔ 30个）", () => {
    expect(cnTokensOf("现场按三成推进", "现场按 3成推进。")).toEqual([]);
    expect(cnTokensOf("落实十二项措施", "落实12项措施。")).toEqual([]);
    expect(cnTokensOf("效率提升两倍", "效率提升 2 倍。")).toEqual([]);
    expect(cnTokensOf("留下三十个点位", "留下 30 个点位。")).toEqual([]);
  });

  it("分数与百分比：三分之一 ↔ 1/3 或 3分之一，百分之三十 ↔ 30% 或 百分之30", () => {
    expect(cnTokensOf("工期缩短三分之一", "工期缩短 1/3。")).toEqual([]);
    expect(cnTokensOf("工期缩短三分之一", "工期缩短 3分之一。")).toEqual([]);
    expect(cnTokensOf("覆盖百分之三十的现场", "覆盖 30% 的现场。")).toEqual([]);
    expect(cnTokensOf("覆盖百分之三十的现场", "覆盖百分之30的现场。")).toEqual([]);
    expect(cnTokensOf("覆盖百分之三十的现场", "覆盖百分之三十的现场。")).toEqual([]);
  });

  it("光杆数字只认规范写法（十二 / 三十 / 三十五 / 一百二十 都算数）", () => {
    for (const token of ["十二", "三十", "三十五", "一百二十"] as const) {
      expect(cnTokensOf(`留下${token}点位`, "正文里没有这个数。"), token).toContain(token);
      expect(cnTokensOf(`留下${token}点位`, `留下${token}个点位。`), token).toEqual([]);
    }
  });

  it("反向宽容：正文写「百分之三十」也能兜住大纲里的 30", () => {
    expect(cnTokensOf("目标省 30% 工时", "目标省百分之三十的工时。")).toEqual([]);
  });

  it("detail 与阿拉伯数字同一条口径（同一个问题码、同一句话）", () => {
    const page = okPage(0, {
      kicker: "小节",
      title: "硬规则管住现场",
      subtitle: "做法写进系统",
      highlight: "一句话结论",
    });
    page.blocks[0]!.lines = ["节省 47% 的巡检工时"];
    page.blocks[1]!.lines = ["效率提升两倍"];
    const issues = checkPptOutlineQuality({ pages: [page] }, "正文里没有数字。");
    const arabic = issues.find((i) => i.code === "数字不在正文" && i.detail.includes("47"));
    const chinese = issues.find((i) => i.code === "数字不在正文" && i.detail.includes("两倍"));
    for (const hit of [arabic, chinese]) {
      expect(hit).toBeDefined();
      expect(hit!.detail).toContain("在报告正文里找不到");
      expect(hit!.detail).toContain("不许换算、加总、估");
    }
  });

  /**
   * 反例（**宁可漏判也不误报**）：这些常见词一个都不许被当成数字
   *
   * 靠的是"后面必须跟量词 / 成 / 倍 / 分之"这条语境门槛，不是词表：`一致` / `统一` / `一起` /
   * `一线` / `十分` / `万元` / `千万` / `百般` / `一度` / `进一步` / `一个` 全都没有
   * "数字 + 单位"的结构，所以连进判定的机会都没有。
   */
  const NOT_NUMERIC = [
    "口径一致",
    "标准统一",
    "一起上线",
    "一线品牌",
    "十分重视",
    "金额以万元计",
    "千万不要断电",
    "百般刁难",
    "一成不变",
    "设备一度中断",
    "进一步压缩工期",
    "搭一个平台",
    "一次说清",
    "百万级设备",
    "千米之外",
    "两全其美",
    "五花八门",
  ] as const;

  it("常见写法一律不报（一致 / 统一 / 一起 / 一线 / 十分 / 万元 / 千万 / 百般 …）", () => {
    for (const text of NOT_NUMERIC) {
      expect(cnTokensOf(text, "正文里没有任何数字。"), text).toEqual([]);
    }
  });

  it("单独一个「一」不算数（一个 / 一次 / 一条 / 一处 / 第一类 都是口头语）", () => {
    for (const text of ["一个平台", "一次说清", "一条规则", "一处录入台账", "第一类风险"]) {
      expect(cnTokensOf(text, "正文里没有数字。"), text).toEqual([]);
    }
  });

  it("光杆的 十 / 百 / 千 / 万 只是单位词，不算数字（万元 / 百米 / 千米 / 千万 / 百万 都不报）", () => {
    for (const text of ["金额以万元计", "百米之外", "千米之外", "千万不要断电", "百万级设备"]) {
      expect(cnTokensOf(text, "正文里没有数字。"), text).toEqual([]);
    }
    // 但真的带数字的量词写法照报（十分钟 / 十项 / 三十万台）
    expect(cnTokensOf("十分钟到场", "正文里没有数字。")).toContain("十分钟");
    expect(cnTokensOf("十项措施", "正文里没有数字。")).toContain("十项");
    expect(cnTokensOf("三十万台设备", "正文里没有数字。")).toContain("三十万台");
  });

  it("问题码仍是 `数字不在正文`（中文数字没有新码，口径与阿拉伯数字同一条）", () => {
    for (const token of ["三成", "两倍", "三分之一"] as const) {
      const hits = cnTokensOf(`现场按${token}推进`, "正文里没有数字。");
      expect(hits, token).toContain(token);
    }
    const page = okPage(0, {
      kicker: "小节",
      title: "硬规则管住现场",
      subtitle: "做法写进系统",
      highlight: "一句话结论",
    });
    page.blocks[0]!.lines = ["现场按三成推进"];
    const issues = checkPptOutlineQuality({ pages: [page] }, "正文里没有数字。");
    expect([...new Set(issues.map((i) => i.code))]).toEqual(["数字不在正文"]);
  });
});

describe("checkPptOutlineQuality — ⑤ 页间不重复", () => {
  it("同一句话出现在两页 → 两页重复，并把两个页号都写出来", () => {
    const deck = okDeck();
    const line = "各现场每周五下午集中检查一遍";
    expect(Array.from(line)).toHaveLength(14);
    deck.pages[1]!.blocks[0]!.lines[0] = line;
    deck.pages[4]!.blocks[0]!.lines[0] = line;
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "两页重复")).toEqual([5]);
    expect(issues[0]!.detail).toContain("第 2 页与第 5 页");
  });

  it("短句（去掉标点不足 6 字）允许重名（「今天」「建成后」这类不算重复）", () => {
    const deck = okDeck();
    deck.pages[1]!.blocks[0]!.head = "今天";
    deck.pages[3]!.blocks[1]!.head = "今天";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([]);
  });

  it("#146 补充：**专有名词**在两页各提一次不算重复（「人体存在传感器」）", () => {
    const deck = okDeck();
    deck.pages[3]!.blocks[0]!.lines[0] = "人体存在传感器";
    deck.pages[4]!.blocks[1]!.lines[0] = "人体存在传感器";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([]);
  });

  it("#146 补充：像一句话的重复照报（有标点或有判断词）", () => {
    const deck = okDeck();
    deck.pages[1]!.blocks[0]!.lines[0] = "设备之间互不相通，状态不可见";
    deck.pages[3]!.blocks[0]!.lines[0] = "设备之间互不相通，状态不可见";
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "两页重复")).toEqual([4]);
    expect(issues[0]!.detail).toContain("第 2 页与第 4 页");
  });

  it("#146 补充 2：**短动作短语**不判——「人走自动释放」6 字、命中「走」也不许报", () => {
    const deck = okDeck();
    deck.pages[1]!.blocks[0]!.lines[0] = "人走自动释放";
    deck.pages[3]!.blocks[1]!.lines[0] = "人走自动释放";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([]);
  });

  it("#146 补充 2：短句里有**多字**动作词照报（「做法写进系统」命中「写进」）", () => {
    const deck = okDeck();
    deck.pages[1]!.blocks[0]!.lines[0] = "做法写进系统";
    deck.pages[3]!.blocks[1]!.lines[0] = "做法写进系统";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([4]);
  });

  it("#146 补充：无标点但够长（≥14 字）的整句重复也照报", () => {
    const deck = okDeck();
    const line = "每一台设备都要逐台贴码登记留痕";
    expect(Array.from(line)).toHaveLength(15); // 无标点、无多字动作词 → 只靠"够长"这条
    deck.pages[1]!.blocks[0]!.lines[0] = line;
    deck.pages[3]!.blocks[0]!.lines[0] = line;
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([4]);
  });

  it("#146 补充 4：**短判断句**跨页复述不报（真跑原文「端层不开放第三方认证」，10 字）", () => {
    const deck = okDeck();
    const line = "端层不开放第三方认证";
    expect(Array.from(line)).toHaveLength(10); // 上级口述"11 字"，原文实际 10 字，都远在 14 字线下
    deck.pages[1]!.blocks[0]!.lines[0] = line;
    deck.pages[4]!.blocks[1]!.lines[0] = line;
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([]);
  });

  it("#146 补充 4：**边界 13 字**不报（无标点、无多字判断/动作词，只靠长度这条判）", () => {
    const deck = okDeck();
    const line = "现场每周五下午集中检查一遍";
    expect(Array.from(line)).toHaveLength(13);
    deck.pages[1]!.blocks[0]!.lines[0] = line;
    deck.pages[4]!.blocks[1]!.lines[0] = line;
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([]);
  });

  it("#146 补充 4：**边界 14 字**要报（刚好到线）", () => {
    const deck = okDeck();
    const line = "各现场每周五下午集中检查一遍";
    expect(Array.from(line)).toHaveLength(14);
    deck.pages[1]!.blocks[0]!.lines[0] = line;
    deck.pages[4]!.blocks[1]!.lines[0] = line;
    expect(codesOf(checkPptOutlineQuality(deck, MD), "两页重复")).toEqual([5]);
  });
});

describe("checkPptOutlineQuality — ⑥ 叙事顺序（问题 → 方案 → 价值）", () => {
  /** 只改"这一页的标签"（叙事顺序只看 kicker，归不进才看 title；#146 补充 2） */
  const framed = (i: number, kicker: string, over: Partial<PptPage> = {}): PptPage =>
    okPage(i, { kicker, subtitle: `第${i + 1}批内容写清边界`, ...over });

  it("顺序对：问题页在前、方案页居中、价值页在后 → 不报", () => {
    const deck: PptOutline = {
      pages: [framed(0, "现状与痛点"), framed(1, "建设方案"), framed(2, "价值与收益")],
    };
    expect(codesOf(checkPptOutlineQuality(deck, MD), "叙事顺序错")).toEqual([]);
  });

  it("顺序错：价值页排在方案页与问题页之前 → 点名到页 + 点名触发词", () => {
    const deck: PptOutline = {
      pages: [framed(0, "价值与收益"), framed(1, "建设方案"), framed(2, "现状与痛点")],
    };
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "叙事顺序错")).toEqual([2, 3]);
    expect(issues[0]!.detail).toContain("问题 → 方案 → 价值");
    expect(issues[0]!.detail).toContain("小节标签「建设」");
  });

  it("#146 补充 2：只比**首次出现**——中间插一页保障/风险内容不算错", () => {
    const deck: PptOutline = {
      pages: [
        framed(0, "现状与痛点"),
        framed(1, "建设方案"),
        framed(2, "风险不回升"), // 标题里带「风险」，但 kicker 不是问题组词 → 不参与
        framed(3, "价值与收益"),
      ],
    };
    expect(codesOf(checkPptOutlineQuality(deck, MD), "叙事顺序错")).toEqual([]);
  });

  it("#146 补充 2：末页写「把机制用起来，问题不回潮」**不报**（末页收尾豁免 + 只算开头词）", () => {
    const deck: PptOutline = {
      pages: [
        framed(0, "现状与痛点"),
        framed(1, "建设方案"),
        framed(2, "价值与收益"),
        framed(3, "后续安排", { title: "把机制用起来，问题不回潮" }),
      ],
    };
    expect(codesOf(checkPptOutlineQuality(deck, MD), "叙事顺序错")).toEqual([]);
  });

  it("#146 补充 2：标题写「四类问题一起解决」不算问题页（只看开头词，不是出现过）", () => {
    const deck: PptOutline = {
      pages: [framed(0, "建设方案"), framed(1, "价值与收益")],
    };
    deck.pages[0]!.title = "四类问题一起解决";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "叙事顺序错")).toEqual([]);
  });

  it("#146 补充 2：subtitle / highlight / 块内容一律不参与分类", () => {
    const deck: PptOutline = {
      pages: [
        framed(0, "本节要点", { subtitle: "现状与问题先说清", highlight: "风险先兜住" }),
        framed(1, "落地做法", { highlight: "价值可量化" }),
      ],
    };
    deck.pages[0]!.blocks[0]!.lines[0] = "现状不清就别动手";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "叙事顺序错")).toEqual([]);
  });

  it("#146 补充 2：真正的「价值与收益」排在第 2 页（早于方案页）→ **要报**", () => {
    const deck: PptOutline = {
      pages: [framed(0, "现状与痛点"), framed(1, "价值与收益"), framed(2, "建设方案")],
    };
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "叙事顺序错")).toEqual([3]);
    expect(issues[0]!.detail).toContain("小节标签「建设」");
  });

  it("#146 补充 2：kicker 归不进时看 title；title 也归不进就不判", () => {
    const byTitle: PptOutline = {
      pages: [framed(0, "第一页", { title: "现状与痛点" }), framed(1, "第二页", { title: "建设方案" })],
    };
    expect(codesOf(checkPptOutlineQuality(byTitle, MD), "叙事顺序错")).toEqual([]);
    const neither: PptOutline = {
      pages: [framed(0, "先看清"), framed(1, "动手做")],
    };
    expect(codesOf(checkPptOutlineQuality(neither, MD), "叙事顺序错")).toEqual([]);
  });
});

describe("checkPptOutlineQuality — ⑦ 自包含", () => {
  it("写「详见报告」「谢谢观看」这类话 → 不自包含", () => {
    const deck = okDeck();
    deck.pages[0]!.blocks[0]!.lines[0] = "设备清单详见报告第三章";
    deck.pages[1]!.highlight = "谢谢观看";
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "不自包含")).toEqual([1, 2]);
  });

  it("#146 补充：正文里的「目录」是正当内容词，不报（「按客户目录逐项核定」）", () => {
    const deck = okDeck();
    deck.pages[0]!.blocks[0]!.lines[0] = "按客户信创目录逐项核定型号";
    deck.pages[1]!.title = "按设备目录逐项核对";
    expect(codesOf(checkPptOutlineQuality(deck, MD), "不自包含")).toEqual([]);
  });

  it("#146 补充：「目录」当结构性标签时才报（「内容目录」当标题）", () => {
    const deck = okDeck();
    deck.pages[2]!.title = "内容目录";
    const issues = checkPptOutlineQuality(deck, MD);
    expect(codesOf(issues, "不自包含")).toEqual([3]);
    expect(issues[0]!.detail).toContain("目录页");
  });

  it("#146 补充：同一条问题不重复上报（同一页同一个词命中两次 → 输出 1 条）", () => {
    const deck = okDeck();
    deck.pages[0]!.blocks[0]!.lines[0] = "设备清单参考正文第三章";
    deck.pages[0]!.blocks[0]!.lines[1] = "巡检记录参考正文第四章";
    const issues = checkPptOutlineQuality(deck, MD).filter((i) => i.code === "不自包含");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.page).toBe(1);
    expect(issues[0]!.detail).toContain("参考正文");
  });
});

describe("checkPptOutlineQuality — ⑧ 图标与版式成套", () => {
  it("白名单外的图标名 → 图标不合规", () => {
    const issues = checkPptOutlineQuality(deckWith(2, { icon: "sparkles" }), MD);
    expect(codesOf(issues, "图标不合规")).toEqual([3]);
    expect(issues[0]!.detail).toContain("sparkles");
  });

  it("声明了版式却不给字段 → 版式与字段不成套（沿用既有降级口径，不重复实现）", () => {
    const issues = checkPptOutlineQuality(
      deckWith(4, { layout: "表格", blocks: [], table: null }),
      MD,
    );
    expect(codesOf(issues, "版式与字段不成套")).toEqual([5]);
    expect(issues.find((i) => i.code === "版式与字段不成套")!.detail).toContain("没给合规 table");
  });

  it("同一页两个块用同一个图标 → 图标重复（detail 点名页码与图标名）", () => {
    const page = okPage(0);
    page.blocks[1]!.icon = page.blocks[0]!.icon;
    const issues = checkPptOutlineQuality({ pages: [page] }, MD).filter((i) => i.code === "图标重复");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.page).toBe(1);
    expect(issues[0]!.detail).toContain("第 1 页");
    expect(issues[0]!.detail).toContain(`「${page.blocks[0]!.icon}」`);
    expect(issues[0]!.detail).toContain("用了 2 次");
  });

  it("同页四个块全用同一个图标 → 只报一条，detail 写清用了 4 次", () => {
    const page = okPage(0);
    for (const b of page.blocks) b.icon = "file-text";
    const issues = checkPptOutlineQuality({ pages: [page] }, MD).filter((i) => i.code === "图标重复");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("「file-text」用了 4 次");
  });

  it("页图标与块图标撞了也要报（页图标也是这一页的图标）", () => {
    const page = okPage(0);
    page.blocks[2]!.icon = page.icon;
    expect(codesOf(checkPptOutlineQuality({ pages: [page] }, MD), "图标重复")).toEqual([1]);
  });

  it("同页每个块 / 栏 / 阶段 / 层 / 卡片 / 表列各一个不同图标 → 不报", () => {
    expect(codesOf(checkPptOutlineQuality(okDeck(), MD), "图标重复")).toEqual([]);
    // 表头列与页图标、列间都不许撞：四列四个名字，页图标是第五个
    const table = okPage(0, {
      blocks: [],
      table: {
        head: ["阶段", "做什么", "谁负责", "验收"],
        icons: ["route", "users", "gauge", "circle-check"],
        rows: [["样板层", "装齐终端并贴码", "运维班", "第 1 周"]],
      },
    });
    expect(codesOf(checkPptOutlineQuality({ pages: [table] }, MD), "图标重复")).toEqual([]);
  });

  it("一页 4 块共用兜底图标 → 报「图标重复」（变更表 #151 的判据分工，不是「图标不足」）", () => {
    // 「每页图标数 ≥ 元素数」不单列：`iconOf` 会给每个元素兜一个图标（`presentation`），
    // 渲染层还会画页图标与结论带 bulb，那条线结构上必然成立；重复用兜底图标才是真问题
    const parsed = parsePptOutline(
      JSON.stringify({
        pages: [
          page({
            blocks: [0, 1, 2, 3].map((k) => ({ head: G_HEADS[k]!, note: "", lines: ["逐台贴码登记"] })),
          }),
        ],
      }),
    );
    const parsedPage = parsed.outline!.pages[0]!;
    expect(parsedPage.blocks.every((b) => b.icon === PPT_DEFAULT_ICON)).toBe(true);
    expect(codesOf(checkPptOutlineQuality({ pages: [parsedPage] }, MD), "图标重复")).toEqual([1]);
  });
});
