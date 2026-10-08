/**
 * @scene/domain — PPT 大纲校验测试（变更表 #141）
 *
 * 覆盖全部判定分支：合法 / 页数越界 clamp / 非法页丢弃 / 缺 layout /
 * 各字段超限截断（且不许把页删空）/ 非 JSON / 空 pages / 禁用词。
 */

import { describe, it, expect } from "vitest";
import { PPT_LIMITS } from "@scene/contract";
import { hasPptBanned, parsePptOutline, pptBannedHit } from "./ppt-outline.js";

/** 一页最小合规的要点页 */
function page(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layout: "要点",
    title: "现场今天怎么转",
    takeaway: "人工记录、事后补录，数据留不下来",
    bullets: ["巡检靠纸质表单", "数据事后补录", "异常靠电话上报"],
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
    const r = parsePptOutline(deck(6));
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(6);
    expect(r.dropped).toBe(0);
    expect(r.outline?.pages[0]?.title).toBe("第1页标题");
    expect(r.outline?.pages[0]?.layout).toBe("要点");
    expect(r.outline?.pages[0]?.bullets).toHaveLength(3);
    expect(r.outline?.pages[0]?.table).toBeNull();
  });

  it("允许 ```json 围栏与前后寒暄（抠出 JSON 即可）", () => {
    const r = parsePptOutline(`好的，这是大纲：\n\`\`\`json\n${deck(5)}\n\`\`\`\n共 5 页。`);
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(5);
  });

  it("五种布局都能通过（双栏/卡片/表格各自的组数与内容齐）", () => {
    const raw = JSON.stringify({
      pages: [
        page(),
        page({
          layout: "双栏对比",
          columns: [
            { head: "今天", bullets: ["纸质记录", "人工统计"] },
            { head: "建成后", bullets: ["自动采集", "实时看板"] },
          ],
        }),
        page({
          layout: "数据卡片",
          cards: [
            { value: "统一纳管", label: "设备台账" },
            { value: "实时可见", label: "运行状态" },
            { value: "闭环处置", label: "异常工单" },
          ],
        }),
        page({ layout: "图文说明", bullets: ["感知层部署采集终端", "平台层做研判"] }),
        page({
          layout: "表格",
          table: {
            head: ["层次", "承担什么"],
            rows: [
              ["感知层", "采集现场数据"],
              ["平台层", "研判与分级"],
            ],
          },
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.error).toBeUndefined();
    expect(r.outline?.pages.map((p) => p.layout)).toEqual([
      "要点",
      "双栏对比",
      "数据卡片",
      "图文说明",
      "表格",
    ]);
    expect(r.outline?.pages[1]?.columns).toHaveLength(2);
    expect(r.outline?.pages[2]?.cards).toHaveLength(3);
    expect(r.outline?.pages[4]?.table?.rows).toHaveLength(2);
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

describe("parsePptOutline — 非法页丢弃 / 缺 layout", () => {
  it("非对象、没标题、内容全空的页被丢，其余页照常采纳", () => {
    const raw = JSON.stringify({
      pages: [
        "这一页是字符串",
        { layout: "要点", title: "", bullets: ["x"] },
        { layout: "要点", title: "空页", takeaway: "", bullets: [], table: null },
        page({ title: "留下的这页" }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.dropped).toBe(3);
    expect(r.outline?.pages[0]?.title).toBe("留下的这页");
    expect(r.notes.join("｜")).toContain("已丢弃");
  });

  it("缺 layout → 按要点处理", () => {
    const raw = JSON.stringify({ pages: [page({ layout: undefined })] });
    const r = parsePptOutline(raw);
    expect(r.outline?.pages[0]?.layout).toBe("要点");
  });

  it("layout 不认识 → 按要点处理并记提示", () => {
    const raw = JSON.stringify({ pages: [page({ layout: "鱼骨图" })] });
    const r = parsePptOutline(raw);
    expect(r.outline?.pages[0]?.layout).toBe("要点");
    expect(r.notes.join("｜")).toContain("按「要点」排");
  });

  it("双栏只有一栏 / 卡片不足 3 张 / 表格页没有表 → 按要点排（内容搬到 bullets，不丢内容）", () => {
    const raw = JSON.stringify({
      pages: [
        page({ layout: "双栏对比", bullets: [], columns: [{ head: "只有一栏", bullets: ["要点甲"] }] }),
        page({
          layout: "数据卡片",
          bullets: [],
          cards: [{ value: "统一纳管", label: "设备台账" }],
        }),
        page({ layout: "表格", bullets: ["表格没给出来"], table: { head: ["只有一列"], rows: [["x"]] } }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(3);
    const [a, b, c] = r.outline!.pages;
    expect(a!.layout).toBe("要点");
    expect(a!.bullets).toEqual(["要点甲"]);
    expect(b!.layout).toBe("要点");
    expect(b!.bullets).toEqual(["统一纳管：设备台账"]);
    expect(c!.layout).toBe("要点");
    expect(c!.bullets).toEqual(["表格没给出来"]);
  });
});

describe("parsePptOutline — 字段超限截断", () => {
  it("标题 20 字、要点 40 字、每条 ≤40 字、条数截到 5", () => {
    const long = "字".repeat(60);
    const raw = JSON.stringify({
      pages: [
        page({
          title: long,
          takeaway: long,
          bullets: Array.from({ length: 8 }, (_, i) => `${i}号${long}`),
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const p = r.outline!.pages[0]!;
    expect([...p.title]).toHaveLength(PPT_LIMITS.titleChars);
    expect([...p.takeaway]).toHaveLength(PPT_LIMITS.takeawayChars);
    expect(p.bullets).toHaveLength(PPT_LIMITS.bullets.max);
    for (const b of p.bullets) expect([...b].length).toBeLessThanOrEqual(PPT_LIMITS.bullets.chars);
    expect(r.trimmed).toBeGreaterThan(0);
  });

  it("双栏恰取 2 组、每组 ≤3 条；卡片取 4 张、值与说明各自截断", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "双栏对比",
          columns: [
            { head: "甲".repeat(20), bullets: ["1", "2", "3", "4", "5"] },
            { head: "乙", bullets: ["1", "2"] },
            { head: "丙", bullets: ["1"] },
          ],
        }),
        page({
          layout: "数据卡片",
          cards: Array.from({ length: 6 }, (_, i) => ({
            value: `值${i}${"长".repeat(20)}`,
            label: `说明${i}${"长".repeat(20)}`,
          })),
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const [a, b] = r.outline!.pages;
    expect(a!.columns).toHaveLength(2);
    expect(a!.columns[0]!.head).toHaveLength(PPT_LIMITS.columns.headChars);
    expect(a!.columns[0]!.bullets).toHaveLength(PPT_LIMITS.columns.bullets);
    expect(b!.cards).toHaveLength(PPT_LIMITS.cards.max);
    for (const c of b!.cards) {
      expect([...c.value].length).toBeLessThanOrEqual(PPT_LIMITS.cards.valueChars);
      expect([...c.label].length).toBeLessThanOrEqual(PPT_LIMITS.cards.labelChars);
    }
  });

  it("表格：≤6 行 × ≤5 列，单元格截断；表头不足两列视为没有表", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "表格",
          table: {
            head: ["列一", "列二", "列三", "列四", "列五", "列六"],
            rows: Array.from({ length: 9 }, (_, i) => [
              `行${i}`,
              "内".repeat(50),
              "c",
              "d",
              "e",
              "f",
            ]),
          },
        }),
      ],
    });
    const r = parsePptOutline(raw);
    const t = r.outline!.pages[0]!.table!;
    expect(t.head).toHaveLength(PPT_LIMITS.table.maxCols);
    expect(t.rows).toHaveLength(PPT_LIMITS.table.maxRows);
    for (const row of t.rows) {
      expect(row).toHaveLength(t.head.length);
      for (const cell of row) expect([...cell].length).toBeLessThanOrEqual(PPT_LIMITS.table.cellChars);
    }
  });

  it("截断不许把一页删空：超限但仍有内容的页照常采纳", () => {
    const raw = JSON.stringify({
      pages: [page({ title: "标题".repeat(30), bullets: ["保".repeat(200)] })],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.outline!.pages[0]!.bullets).toHaveLength(1);
    expect(r.outline!.pages[0]!.bullets[0]!.length).toBeGreaterThan(0);
  });
});

describe("parsePptOutline — 禁用词（占位 / 决策建议 / 内部痕迹）", () => {
  it("要点里的占位与决策措辞被擦掉，页保留", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          bullets: ["现场靠纸质表单", "金额待客户提供", "建议采用试点先行", "异常靠电话上报"],
        }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.scrubbed).toBe(2);
    expect(r.outline!.pages[0]!.bullets).toEqual(["现场靠纸质表单", "异常靠电话上报"]);
  });

  it("标题或一句话要点里出现禁用词 → 整页丢弃", () => {
    const raw = JSON.stringify({
      pages: [
        page({ title: "金额待客户提供" }),
        page({ takeaway: "建议采用分期建设" }),
        page({ title: "留下的" }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.pages).toBe(1);
    expect(r.dropped).toBe(2);
    expect(r.outline!.pages[0]!.title).toBe("留下的");
  });

  it("表格里命中禁用词的行被擦掉；表头命中则整表作废", () => {
    const raw = JSON.stringify({
      pages: [
        page({
          layout: "表格",
          table: {
            head: ["层次", "承担什么"],
            rows: [
              ["感知层", "采集现场数据"],
              ["成本", "金额待客户提供"],
            ],
          },
        }),
        page({ layout: "表格", table: { head: ["表2-1", "内容"], rows: [["a", "b"]] } }),
      ],
    });
    const r = parsePptOutline(raw);
    expect(r.outline!.pages[0]!.table!.rows).toEqual([["感知层", "采集现场数据"]]);
    // 表头带内部表号 → 没有合规表格 → 按要点排（内容靠 bullets 保留）
    expect(r.outline!.pages[1]!.layout).toBe("要点");
    expect(r.scrubbed).toBe(1);
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
