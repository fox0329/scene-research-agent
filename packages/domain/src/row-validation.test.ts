import { describe, it, expect } from "vitest";
import { validateIncomingRows, violationsBrief, mustDowngrade } from "./row-validation.js";
import { flowStep } from "@scene/contract";

const ok = (table_code: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  table_code,
  fields: {
    // v1.27：核实两列是每行的必填项——「合格的一行」必须带核实判定
    verification_verdict: "已核实",
    verification: "准确：与《白皮书》p.3 数值一致；客观：客户自有台账口径；为什么：可复算",
    ...fields,
  },
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
  it("表1-1 不在本步表集内 → 判为未知表号（第 4 步能力匹配不该产出场景锚）", () => {
    const step4Tables = flowStep(4).tables;
    const v = validateIncomingRows(
      3,
      [ok("表1-1", { item: "场景名称", content: "智慧水务" })],
      step4Tables,
    );
    expect(v[0]?.kind).toBe("未知表号");
    expect(v[0]?.detail).toContain("表1-1");
  });

  it("本步表集内的表照常校验（不会误判成未知表号）", () => {
    const v = validateIncomingRows(
      3,
      [
        ok("表1-2", {
          link: "制水",
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
    // 表1-2 必填（阶段 3 客户现状基线）：link / owner_now / current_tool / current_flow / pain
    const v = validateIncomingRows(3, [
      ok("表1-2", { link: "制水", owner_now: "值班班组" }),
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
    const v = validateIncomingRows(3, [
      ok(
        "表1-2",
        { link: "制水", can_touch: "可以碰", our_role: "辅助", description: "x" },
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

  it("核实两列缺一不可（v1.27：每条信息都要带核实判定）", () => {
    const v = validateIncomingRows(5, [
      {
        table_code: "表6-1",
        fields: {
          benefit: "省电",
          metric: "kWh",
          baseline: "100",
          expected: "80",
          evidence_level: "C",
          user_feeling: "电费少了",
          how_to_measure: "读电表",
          metric_type: "成本",
        },
      },
    ]);
    const missing = v.filter((x) => x.kind === "缺必填列").map((x) => x.column);
    expect(missing).toContain("verification_verdict");
    expect(missing).toContain("verification");
  });

  it("把核实推给读者（待核实／建议抽查／请用户确认）→ 核实推诿", () => {
    const punt = (text: string) =>
      validateIncomingRows(5, [ok("表6-1", { benefit: "省电", verification: text })]).find(
        (x) => x.kind === "核实推诿",
      );
    expect(punt("本客户基线未提供，待核实")?.kind).toBe("核实推诿");
    expect(punt("行业通例数据，建议抽查 3 条来源")?.kind).toBe("核实推诿");
    expect(punt("准确：与材料一致；来源待确认")?.kind).toBe("核实推诿");
    expect(punt("请用户确认本项目的实际基线")?.kind).toBe("核实推诿");
    // 如实给结论不算推诿
    expect(punt("准确：材料未给基线；客观：仅模型知识；为什么：无法核实，缺客户台账")).toBeUndefined();
  });

  it("违规概览按类型计数", () => {
    const v = validateIncomingRows(3, [
      ok("表1-2", { link: "制水" }),
      { table_code: "表9-9", fields: {} },
    ]);
    const brief = violationsBrief(v);
    expect(brief).toContain("缺必填列");
    expect(brief).toContain("未知表号");
  });
});
