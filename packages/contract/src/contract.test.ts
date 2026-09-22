import { describe, it, expect } from "vitest";
import type {
  SourceType,
  Authority,
  EvidenceLevel,
  StageId,
  AdviceLevel,
  ProductLine,
  Product,
  SpecParam,
  CostRate,
  QualityGate,
  ApiError,
  SseEventType,
  DecisionAction,
  CostEstimateInput,
  TraceableFields,
} from "@scene/contract";

describe("@scene/contract types", () => {
  it("SourceType 枚举值完整", () => {
    const values: SourceType[] = [
      "AI提取",
      "AI推断",
      "用户确认",
      "用户补充",
    ];
    expect(values).toHaveLength(4);
  });

  it("Authority 枚举值完整", () => {
    const values: Authority[] = ["T1", "T2", "T3", "T4"];
    expect(values).toHaveLength(4);
  });

  it("EvidenceLevel 枚举值完整", () => {
    const values: EvidenceLevel[] = ["A", "B", "C", "D"];
    expect(values).toHaveLength(4);
  });

  it("StageId 包含 0-8", () => {
    const stages: StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    expect(stages).toHaveLength(9);
  });

  it("AdviceLevel 枚举值完整", () => {
    const values: AdviceLevel[] = ["强烈建议", "建议", "可选"];
    expect(values).toHaveLength(3);
  });

  it("ProductLine 结构完整", () => {
    const pl: ProductLine = {
      id: "test-id",
      name: "test-line",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    expect(pl.id).toBe("test-id");
  });

  it("Product 继承 TraceableFields", () => {
    const p: Product & TraceableFields = {
      id: "p1",
      product_line_id: "pl1",
      model: "M100",
      name: "产品A",
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "高端",
      source_type: "AI提取",
    };
    expect(p.source_type).toBe("AI提取");
  });

  it("SpecParam 结构完整", () => {
    const sp: SpecParam = {
      id: "sp1",
      product_id: "p1",
      param_class: "性能",
      param_name: "吞吐量",
      value: "100Gbps",
      measured: "实测",
    };
    expect(sp.measured).toBe("实测");
  });

  it("CostRate 结构完整", () => {
    const cr: CostRate = {
      id: "cr1",
      product_line_id: "pl1",
      category: "实施",
      item: "部署费",
      rate: 5000,
      unit: "人天",
      standard_hours: 8,
      data_source: "历史项目",
    };
    expect(cr.rate).toBe(5000);
  });

  it("QualityGate result 三态", () => {
    const results: QualityGate["result"][] = ["通过", "不通过", "未检"];
    expect(results).toHaveLength(3);
  });

  it("DecisionAction 四种动作", () => {
    const actions: DecisionAction[] = ["继续", "补充", "停止", "重算"];
    expect(actions).toHaveLength(4);
  });

  it("SseEventType 完整", () => {
    const types: SseEventType[] = [
      "text",
      "tool_call",
      "progress",
      "row",
      "gate",
      "advice",
      "done",
      "error",
    ];
    expect(types).toHaveLength(8);
  });

  it("ApiError 结构可构造", () => {
    const err: ApiError = { code: "E001", message: "bad", detail: "extra" };
    expect(err.code).toBe("E001");
  });

  it("CostEstimateInput 结构可构造", () => {
    const input: CostEstimateInput = {
      scenario_id: "s1",
      product_line_id: "pl1",
      labor_items: [{ item: "部署", hours: 8, rate: 5000 }],
      other_costs: [{ item: "差旅", amount: 3000 }],
    };
    expect(input.labor_items).toHaveLength(1);
  });
});