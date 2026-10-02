import { describe, it, expect } from "vitest";
import { validateIncomingRows, violationsBrief, mustDowngrade } from "./row-validation.js";

const ok = (table_code: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  table_code,
  fields,
  source: "《白皮书》p.3",
  source_type: "AI提取",
  ...extra,
});

describe("row-validation — 表号", () => {
  it("表号不在本阶段清单内 → 未知表号", () => {
    const v = validateIncomingRows(1, [ok("表3-1", { link: "x" })]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("未知表号");
    expect(v[0]?.detail).toContain("表3-1");
    expect(v[0]?.detail).toContain("不属于阶段 1");
  });

  it("空表号同样报未知表号", () => {
    const v = validateIncomingRows(1, [{ fields: {} }]);
    expect(v[0]?.kind).toBe("未知表号");
    expect(v[0]?.tableCode).toBe("(空)");
  });
});

describe("row-validation — 流程步限定表集", () => {
  it("表1-1 不在本步表集内 → 判为未知表号（第 3 步不该产出场景锚）", () => {
    const step3Tables = ["表1-2", "表1-3"];
    const v = validateIncomingRows(
      1,
      [ok("表1-1", { item: "场景名称", content: "智慧水务" })],
      step3Tables,
    );
    expect(v[0]?.kind).toBe("未知表号");
    expect(v[0]?.detail).toContain("表1-1");
  });

  it("本步表集内的表照常校验（不会误判成未知表号）", () => {
    const v = validateIncomingRows(
      1,
      [
        ok("表1-2", {
          link: "制水",
          is_digital: "可以联网采集",
          owner_now: "值班班组人工抄表",
          current_tool: "纸质记录 + Excel 汇总",
          current_flow: "每班两次人工抄表，下班前录入",
          pain: "数据滞后、易漏抄",
          description: "加药与过滤",
          responsibility: "水厂运行班",
          reason: "现场访谈",
        }),
      ],
      ["表1-2"],
    );
    expect(v.some((x) => x.kind === "未知表号")).toBe(false);
  });
});

describe("row-validation — 必填列", () => {
  it("缺必填列逐项报出（带列名与行号）", () => {
    // 表1-2 必填：link / is_digital / owner_now / current_tool / current_flow / pain
    const v = validateIncomingRows(1, [
      ok("表1-2", { link: "制水", is_digital: "可以联网采集", owner_now: "值班班组" }),
    ]);
    const kinds = v.filter((x) => x.kind === "缺必填列").map((x) => x.column);
    expect(kinds).toContain("current_flow");
    expect(kinds).toContain("current_tool");
    expect(v[0]?.detail).toContain("第 1 行");
  });

  it("「未提供」视为空（与完整度检查同口径）", () => {
    const v = validateIncomingRows(2, [
      ok("表3-1", { link: "设备", gross_margin: "未提供", representative: "某厂" }),
    ]);
    expect(v.some((x) => x.kind === "缺必填列" && x.column === "gross_margin")).toBe(true);
  });

  it("条件必填（requiredWhen）不参与机器校验", () => {
    // 表1-3 的 veto_holder 是条件必填
    const v = validateIncomingRows(1, [
      ok("表1-3", {
        barrier_type: "技术",
        barrier_name: "认证",
        criteria: "GB/T 1",
        current_status: "过得了",
        judgment: "过得了",
      }),
    ]);
    expect(v.some((x) => x.column === "veto_holder")).toBe(false);
  });
});

describe("row-validation — 枚举", () => {
  it("枚举取值非法报出并列出合法值", () => {
    const v = validateIncomingRows(1, [
      ok("表1-3", {
        barrier_type: "合规门槛", // 不在五类内
        barrier_name: "x",
        criteria: "y",
        current_status: "过得了",
        judgment: "过得了",
      }),
    ]);
    const e = v.find((x) => x.kind === "枚举非法");
    expect(e?.column).toBe("barrier_type");
    expect(e?.detail).toContain("行业准入");
  });

  it("枚举为空不报（缺必填列会报）", () => {
    const v = validateIncomingRows(1, [
      ok("表1-3", {
        barrier_type: "",
        barrier_name: "x",
        criteria: "y",
        current_status: "过得了",
        judgment: "过得了",
      }),
    ]);
    expect(v.some((x) => x.kind === "枚举非法")).toBe(false);
    expect(v.some((x) => x.kind === "缺必填列" && x.column === "barrier_type")).toBe(true);
  });
});

describe("row-validation — 来源与证据归属", () => {
  it("重要/支撑表缺来源报出", () => {
    const v = validateIncomingRows(1, [{ table_code: "表1-1", fields: { item: "场景名称", content: "智慧水务" } }]);
    expect(v.some((x) => x.kind === "缺来源")).toBe(true);
  });

  it("过程表不强制来源", () => {
    const v = validateIncomingRows(1, [
      { table_code: "表2-3", fields: { layer: "感知层", components: "仪表", interface: "Modbus" } },
    ]);
    expect(v.some((x) => x.kind === "缺来源")).toBe(false);
  });

  it("模型自称「用户确认」必须报出并降级（证据等级不可被模型污染）", () => {
    const v = validateIncomingRows(1, [
      ok(
        "表1-2",
        { link: "制水", is_digital: "可以联网采集", can_touch: "可以碰", our_role: "辅助", description: "x" },
        { source_type: "用户确认" },
      ),
    ]);
    const s = v.find((x) => x.kind === "自称用户确认");
    expect(s).toBeDefined();
    expect(mustDowngrade(s!)).toBe(true);
    expect(s?.detail).toContain("AI提取/AI推断");
  });

  it("AI提取 / AI推断 是合法来源标记", () => {
    for (const st of ["AI提取", "AI推断"]) {
      const v = validateIncomingRows(5, [
        ok("表6-1", {
          benefit: "省电",
          metric: "kWh",
          baseline: "100",
          expected: "80",
          evidence_level: "C",
          user_feeling: "电费少了",
          how_to_measure: "读电表",
          metric_type: "成本",
        }, { source_type: st }),
      ]);
      expect(v.some((x) => x.kind === "自称用户确认")).toBe(false);
    }
  });
});

describe("row-validation — 汇总", () => {
  it("全通过时概览文案明确", () => {
    const v = validateIncomingRows(5, [
      ok("表6-1", {
        benefit: "省电",
        metric: "kWh",
        baseline: "100",
        expected: "80",
        evidence_level: "C",
        user_feeling: "电费少了",
          how_to_measure: "读电表",
          metric_type: "成本",
      }),
    ]);
    expect(v).toEqual([]);
    expect(violationsBrief(v)).toContain("通过");
  });

  it("违规概览按类型计数", () => {
    const v = validateIncomingRows(1, [
      ok("表1-2", { link: "制水" }),
      { table_code: "表9-9", fields: {} },
    ]);
    const brief = violationsBrief(v);
    expect(brief).toContain("缺必填列");
    expect(brief).toContain("未知表号");
  });
});
