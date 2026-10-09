import { describe, it, expect } from "vitest";
import {
  checkStageCompleteness,
  userGaps,
  agentGaps,
  gapsToSummaryLines,
  gapsBrief,
  isEmptyValue,
  type InfoRow,
} from "./completeness.js";

const row = (o: Record<string, unknown>): InfoRow => ({ source: "《白皮书》p.3", ...o });

describe("completeness — 取值判定", () => {
  it("空值包含 null / undefined / 空串 / 纯空白 / 「未提供」", () => {
    for (const v of [null, undefined, "", "   ", "未提供"]) expect(isEmptyValue(v), String(v)).toBe(true);
    for (const v of [0, "0", "有", "未提及"]) expect(isEmptyValue(v), String(v)).toBe(false);
  });
});

describe("completeness — 阶段级", () => {
  it("阶段 1 无数据时列出 8 张缺表，完整度 0%", () => {
    const r = checkStageCompleteness({ stage: 1, rowsByTable: {} });
    expect(r.expectedTables).toBe(8);
    expect(r.tablesWithData).toBe(0);
    expect(r.missingTables).toHaveLength(8);
    expect(r.missingTables).toContain("表1-1");
    expect(r.percent).toBe(0);
    expect(r.gaps.every((g) => g.kind === "缺表")).toBe(true);
  });

  it("交付物阶段（6）没有信息表，视为齐备（它是文档组装）", () => {
    const r = checkStageCompleteness({ stage: 6, rowsByTable: {} });
    expect(r.expectedTables).toBe(0);
    expect(r.percent).toBe(100);
    expect(r.gaps).toEqual([]);
  });

  it("完整度 = 有数据的表 / 应产出表", () => {
    const r = checkStageCompleteness({
      stage: 5, // 阶段 5 两张表
      rowsByTable: { "表6-1": [row({ benefit: "省电", metric: "kWh", baseline: "100", expected: "80", how_to_measure: "电表", user_feeling: "电费少了" })] },
    });
    expect(r.expectedTables).toBe(2);
    expect(r.tablesWithData).toBe(1);
    expect(r.percent).toBe(50);
  });

  it("缺口全部带属主（用户 / 智能体）——没有属主的缺口不允许产生", () => {
    const r = checkStageCompleteness({ stage: 1, rowsByTable: {} });
    expect(r.gaps.length).toBeGreaterThan(0);
    for (const g of r.gaps) {
      expect(["用户", "智能体"]).toContain(g.owner);
    }
  });
});

describe("completeness — 缺口分属主（智能体的欠账不找用户）", () => {
  it("表1-1 逐固定行判必填，并标出属主", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: { "表1-1": [{ item: "场景名称", content: "智慧水务" }] },
    });
    const boundary = r.gaps.find((g) => g.detail.includes("场景边界"));
    expect(boundary?.owner).toBe("智能体"); // 智能体该写的业务画像
    // 场景名称已给 → 不该冒出"用户欠场景名称"
    expect(r.gaps.some((g) => g.detail.includes("场景名称"))).toBe(false);
  });

  it("场景名称空着才产生「用户」属主的缺口", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: { "表1-1": [{ item: "场景边界", content: "门站、调压站/箱" }] },
    });
    const mine = userGaps(r);
    expect(mine.map((g) => g.detail).join(" ")).toContain("场景名称");
    expect(agentGaps(r).every((g) => g.owner === "智能体")).toBe(true);
  });

  it("来源/推断留痕这类文书缺口一律算智能体的（不给用户看）", () => {
    const r = checkStageCompleteness({
      stage: 0,
      rowsByTable: { M3: [{ domain: "接入", name: "Modbus", maturity: "已交付" }] },
    });
    const kinds = agentGaps(r).map((g) => g.kind);
    expect(kinds).toContain("推断未标注");
    expect(userGaps(r)).toEqual([]);
  });
});

describe("completeness — 单表规则", () => {
  it("必填列空缺按列汇总行数", () => {
    const r = checkStageCompleteness({
      stage: 2,
      rowsByTable: {
        // 表3-5 上游供给格局：link / who_supplies 必填（v1.31 起用现存表做这条用例，原表7-1 已删）
        "表3-5": [
          row({ link: "气体传感器", who_supplies: "", supply_risk: "进口交期长" }),
          row({ link: "", who_supplies: "某厂", supply_risk: "x" }),
        ],
      },
    });
    const g = r.gaps.find((x) => x.kind === "缺必填列" && x.column === "who_supplies");
    expect(g?.count).toBe(1);
    expect(r.gaps.some((x) => x.kind === "缺必填列" && x.column === "link")).toBe(true);
  });

  it("表6-1「基线」挪到右栏补充列后仍是必填：空着照样报缺（变更表 #153）", () => {
    /* 完整度按**列定义**判必填，不看列摆在中栏还是右栏——
       基线挪栏位是为了不占中栏列预算，不是为了放开必填（G-R7 必填优先）。 */
    const r = checkStageCompleteness({
      stage: 5,
      rowsByTable: {
        "表6-1": [
          row({
            benefit: "降低漏损",
            metric: "漏损率",
            baseline: "", // 空着 → 缺必填列
            expected: "12%",
            how_to_measure: "分区计量",
            user_feeling: "水费下降",
          }),
          row({
            benefit: "减少巡线工时",
            metric: "人工工时",
            baseline: "未提供", // 补白也算空（isEmptyValue）
            expected: "省 30%",
            how_to_measure: "工单口径",
            user_feeling: "巡线员少跑腿",
          }),
        ],
      },
    });
    const g = r.gaps.find((x) => x.kind === "缺必填列" && x.column === "baseline");
    expect(g, "基线列必须仍在必填列检查范围内").toBeDefined();
    expect(g?.detail).toContain("基线");
    expect(g?.count).toBe(2);
  });

  it("覆盖度：min-rows（表1-2 业务环节 ≥3）", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: { "表1-2": [row({ link: "制水", can_touch: "可以碰", our_role: "辅助" })] },
    });
    const g = r.gaps.find((x) => x.kind === "覆盖度不足" && x.tableCode === "表1-2");
    expect(g?.detail).toContain("≥3");
    expect(g?.count).toBe(1);
  });

  it("覆盖度：enum-complete（表1-3 五类门槛各 ≥1 行）列出缺类别", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: {
        "表1-3": [
          row({ barrier_type: "技术", criteria: "GB/T 1", judgment: "过得了" }),
          row({ barrier_type: "经济", criteria: "预算 100 万", judgment: "不知道" }),
        ],
      },
    });
    const g = r.gaps.find((x) => x.kind === "覆盖度不足" && x.tableCode === "表1-3");
    expect(g?.detail).toContain("行业准入");
    expect(g?.detail).toContain("生态锁定");
    expect(g?.detail).toContain("一票否决者");
    expect(g?.count).toBe(3);
  });

  it("覆盖度：all-columns-non-empty（表3-4 竞品 A/B/C 均填）", () => {
    const r = checkStageCompleteness({
      stage: 2,
      rowsByTable: {
        "表3-4": [
          row({ dimension: "生态", our: "有", competitor_a: "A", competitor_b: "B", competitor_c: "" }),
        ],
      },
    });
    const g = r.gaps.find((x) => x.kind === "覆盖度不足" && x.detail.includes("竞品 ≥3 家"));
    expect(g?.detail).toContain("竞品 ≥3 家");
    expect(g?.count).toBe(1);
    // 同表另有一条 min-rows 规则（维度 ≥3），两条应分别报出
    expect(r.gaps.some((x) => x.detail.includes("对照维度 ≥3 个"))).toBe(true);
  });

  it("来源齐备：重要/支撑表逐行查 source", () => {
    const rowsNoSource: InfoRow[] = [{ model: "IPC-3000", name: "IPC", status: "在售" }, { model: "SEN-200", name: "SEN", status: "在售", source: "《清单》p.1" }];
    const r = checkStageCompleteness({ stage: 0, rowsByTable: { M1: rowsNoSource } });
    const g = r.gaps.find((x) => x.kind === "缺来源" && x.tableCode === "M1");
    expect(g?.count).toBe(1);
  });

  it("推断未标注：有内容但既无来源也无 source_type", () => {
    const r = checkStageCompleteness({
      stage: 0,
      rowsByTable: { M3: [{ domain: "接入", name: "Modbus", maturity: "已交付" }] },
    });
    expect(r.gaps.some((g) => g.kind === "推断未标注" && g.tableCode === "M3")).toBe(true);
  });

  it("过程表不强制来源（表2-3 缺 source 不报缺来源）", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: { "表2-3": [{ layer: "感知层", components: "仪表", interface: "Modbus" }] },
    });
    expect(r.gaps.some((g) => g.kind === "缺来源" && g.tableCode === "表2-3")).toBe(false);
    expect(r.gaps.some((g) => g.kind === "推断未标注" && g.tableCode === "表2-3")).toBe(false);
  });

  it("条件必填（requiredWhen）不做机器判定，不报缺列", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: {
        "表1-3": [row({ barrier_type: "技术", barrier_name: "认证", criteria: "GB 1", judgment: "过得了" })],
      },
    });
    // veto_holder 是条件必填（生态锁定类除外），不应被当成缺必填列
    expect(r.gaps.some((g) => g.kind === "缺必填列" && g.column === "veto_holder")).toBe(false);
  });
});

describe("completeness — 输出到总结文档", () => {
  it("gapsToSummaryLines 分「需要你补充 / 我将补充」两栏", () => {
    const withGaps = checkStageCompleteness({ stage: 2, rowsByTable: {} });
    const lines = gapsToSummaryLines(withGaps);
    // 缺表/缺必填列都由智能体侧补 → 只出现「我将补充」，不向用户要东西
    expect(lines.some((l) => l.includes("我将补充"))).toBe(true);
    expect(lines.some((l) => l.includes("需要你补充"))).toBe(false);
    const clean = checkStageCompleteness({ stage: 6, rowsByTable: {} }); // 交付物阶段无表 = 齐备
    expect(gapsToSummaryLines(clean)[0]).toContain("齐备");
  });

  it("只有用户属主的缺口才写成「需要你补充」", () => {
    const r = checkStageCompleteness({
      stage: 1,
      rowsByTable: { "表1-1": [{ item: "场景边界", content: "门站" }] },
    });
    const text = gapsToSummaryLines(r).join("\n");
    expect(text).toContain("需要你补充");
    expect(text).toContain("场景名称");
  });

  it("gapsBrief 给出完整度与缺口分类计数", () => {
    const r = checkStageCompleteness({ stage: 0, rowsByTable: {} });
    expect(gapsBrief(r)).toContain("信息完整度 0%");
    expect(gapsBrief(r)).toContain("缺表");
  });

  it("缺口清单不含任何判定措辞（产品不产出判断）", () => {
    const r = checkStageCompleteness({ stage: 1, rowsByTable: {} });
    const text = [...gapsToSummaryLines(r), gapsBrief(r)].join(" ");
    for (const bad of ["建议进", "建议通过", "建议不通过", "不通过", "红线"]) {
      expect(text, bad).not.toContain(bad);
    }
  });
});
