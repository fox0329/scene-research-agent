import { describe, it, expect } from "vitest";
import {
  STAGE0_TABLES,
  STAGE1_TABLES,
  STAGE2_TABLES,
  STAGE3_TABLES,
  STAGE4_TABLES,
  STAGE5_TABLES,
  STAGE6_TABLES,
  STAGE7_TABLES,
  STAGE8_TABLES,
  FLOW_STEPS,
  flowStepOfTable,
  flowStepLabel,
} from "@scene/contract";
import type {
  SourceType,
  Authority,
  EvidenceLevel,
  StageId,
  ProductLine,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  OptionalMaterial,
  Scenario,
  StageData,
  Conversation,
  Message,
  QualityGate,
  ApiError,
  SseEventType,
  DecisionAction,
  DshClient,
  SystemStatus,
  ModelConfig,
} from "@scene/contract";

describe("@scene/contract 通用枚举", () => {
  it("SourceType 四种来源", () => {
    const v: SourceType[] = ["AI提取", "AI推断", "用户确认", "用户补充"];
    expect(v).toHaveLength(4);
  });

  it("Authority T1-T4", () => {
    const v: Authority[] = ["T1", "T2", "T3", "T4"];
    expect(v).toHaveLength(4);
  });

  it("EvidenceLevel A-D", () => {
    const v: EvidenceLevel[] = ["A", "B", "C", "D"];
    expect(v).toHaveLength(4);
  });

  it("StageId 0-5（现行 6 个阶段：价值验证阶段已删除）", () => {
    const v: StageId[] = [0, 1, 2, 3, 4, 5];
    expect(v).toHaveLength(6);
  });

  it("DecisionAction 四种动作", () => {
    const v: DecisionAction[] = ["继续", "补充", "停止", "重算"];
    expect(v).toHaveLength(4);
  });

  it("SseEventType 不再含建议类事件（信息版口径）", () => {
    const v: SseEventType[] = [
      "text",
      "tool_call",
      "progress",
      "row",
      "completeness",
      "summary",
      "done",
      "error",
    ];
    expect(v).toHaveLength(8);
    expect(v).not.toContain("advice" as SseEventType);
  });
});

describe("@scene/contract 表编号常量", () => {
  it("STAGE0 12 张表", () => {
    expect(STAGE0_TABLES).toHaveLength(11); // M6 内部费率已删（变更表 #106）
    expect(STAGE0_TABLES[0]).toBe("M1");
    expect(STAGE0_TABLES[10]).toBe("O6");
  });

  it("STAGE1 5 张表", () => {
    expect(STAGE1_TABLES).toHaveLength(5);
    expect(STAGE1_TABLES[0]).toBe("表1-1");
  });

  it("STAGE2 8 张表", () => {
    expect(STAGE2_TABLES).toHaveLength(8);
  });

  it("STAGE3 5 张表（2026-10-20 用户定调不超过 5 张）", () => {
    expect(STAGE3_TABLES).toHaveLength(5);
    expect(STAGE3_TABLES).toEqual(["表3-1", "表3-2", "表3-3", "表3-5", "表3-8"]);
  });

  it("STAGE4 4 张表（4-5 已并入 4-4）", () => {
    expect(STAGE4_TABLES).toHaveLength(4);
    expect(STAGE4_TABLES[0]).toBe("表4-1");
  });

  it("STAGE5 7 张表", () => {
    expect(STAGE5_TABLES).toHaveLength(6); // 表5-5 已删（变更表 #105）
    expect(STAGE5_TABLES[0]).toBe("表5-1");
  });

  it("STAGE6 7 张表", () => {
    expect(STAGE6_TABLES).toHaveLength(7);
    expect(STAGE6_TABLES[0]).toBe("表6-1");
  });

  it("STAGE7 3 张表", () => {
    expect(STAGE7_TABLES).toHaveLength(3);
    expect(STAGE7_TABLES[0]).toBe("表7-1");
  });

  it("STAGE8 2 张表", () => {
    expect(STAGE8_TABLES).toHaveLength(2);
    expect(STAGE8_TABLES[0]).toBe("表8-内部");
    expect(STAGE8_TABLES[1]).toBe("表8-对外");
  });
});

describe("@scene/contract 表号 → 流程步（横幅文案用）", () => {
  it("每个流程步都能按表集反查到，且步号唯一递增", () => {
    const ids = FLOW_STEPS.map((s) => s.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("阶段 1 的两步靠表集区分：表1-1 归第 1 步，其余归第 2 步", () => {
    expect(flowStepOfTable("表1-1")?.id).toBe(1);
    expect(flowStepOfTable("表1-3")?.id).toBe(2);
    /* 表1-2 环节现状已移到阶段 3（能力匹配，第 4 步）；表2-7 已删除（变更表 #226）、表3-6 并入表3-4：
       阶段 1–2 只梳理场景与行业本身，不碰客户现状（用户定调 2026-10-14） */
    expect(flowStepOfTable("表1-2")?.id).toBe(4);
  });

  it("阶段 3/4 的表分别落在第 4 步与第 5 步（用户看到的就是这两步）", () => {
    expect(flowStepOfTable("表4-1")?.id).toBe(4);
    expect(flowStepOfTable("表4-4")?.id).toBe(4);
    expect(flowStepOfTable("表5-1")?.id).toBe(5);
    expect(flowStepOfTable("表5-4")?.id).toBe(5);
  });

  it("库表（M*）与未知表号不落在任何一步（它们不是场景阶段产出）", () => {
    expect(flowStepOfTable("M1")).toBeUndefined();
    expect(flowStepOfTable("表9-9")).toBeUndefined();
  });

  it("称谓含步号与名称，用户能对上流程轴", () => {
    const step = flowStepOfTable("表5-1")!;
    expect(flowStepLabel(step)).toBe("第 5 步 方案与实现");
  });
});

describe("@scene/contract 产品资料库接口", () => {
  it("ProductLine 结构完整", () => {
    const v: ProductLine = { id: "1", name: "产品线A", created_at: "", updated_at: "" };
    expect(v.name).toBe("产品线A");
  });

  it("Product 继承 TraceableFields", () => {
    const v: Product = {
      id: "p1", product_line_id: "pl1", model: "M100", name: "产品A",
      status: "在售", launch_date: "2025-01", position_desc: "高端定位",
      source_type: "AI提取",
      created_at: "", updated_at: "",
    };
    expect(v.source_type).toBe("AI提取");
  });

  it("SpecParam 含 measured 枚举", () => {
    const v: SpecParam = {
      id: "sp1", product_id: "p1", param_class: "计算", param_name: "CPU",
      value: "4核", measured: "实测",
      created_at: "", updated_at: "",
    };
    expect(v.measured).toBe("实测");
  });

  it("Capability maturity 四档", () => {
    const v: Capability = {
      id: "c1", product_line_id: "pl1", domain: "数据采集", name: "温湿度采集",
      description: "实时采集", maturity: "已交付", dependency: "SEN-200",
      created_at: "", updated_at: "",
    };
    expect(v.maturity).toBe("已交付");
  });

  it("Boundary has_plan 三档", () => {
    const v: Boundary = {
      id: "b1", product_line_id: "pl1", description: "不承担安防", reason: "无资质",
      has_plan: "无", response: "建议客户独立采购", owner: "产品",
      created_at: "", updated_at: "",
    };
    expect(v.has_plan).toBe("无");
  });

  it("Limitation impact+fix_status+visibility", () => {
    const v: Limitation = {
      id: "l1", product_line_id: "pl1", product_name: "IPC-3000",
      description: "高湿精度漂移", impact: "低", fix_status: "硬件限制",
      external_visible: "不可提", owner: "产品",
      created_at: "", updated_at: "",
    };
    expect(v.impact).toBe("低");
  });


  it("OptionalMaterial category 六种", () => {
    const cats: OptionalMaterial["category"][] = ["O1认证", "O2案例", "O3价格", "O4SDK", "O5路线图", "O6生态"];
    expect(cats).toHaveLength(6);
  });
});

describe("@scene/contract 场景分析接口", () => {
  it("Scenario status 三态 + current_stage", () => {
    const v: Scenario = {
      id: "s1", name: "智慧会议室",
      status: "进行中", current_stage: 2, created_at: "", updated_at: "",
    };
    expect(v.current_stage).toBe(2);
  });

  it("StageData 含 table_code 和 is_stale", () => {
    const v: StageData = {
      id: "sd1", scenario_id: "s1", stage: 1, table_code: "表1-3",
      row: { barrier: "协议私有", status: "过得了" }, is_stale: false,
      created_at: "", updated_at: "",
    };
    expect(v.table_code).toBe("表1-3");
    expect(v.is_stale).toBe(false);
  });

  it("Conversation status + dsh_session_id", () => {
    const v: Conversation = {
      id: "c1", scenario_id: "s1", title: "补充 M4 边界", status: "活跃",
      dsh_session_id: "dsh-sess-001", created_at: "", updated_at: "",
    };
    expect(v.status).toBe("活跃");
  });

  it("Message role 二态 + table_ref", () => {
    const v: Message = {
      id: "m1", conversation_id: "c1", role: "用户",
      content: "帮我看下竞争格局", table_ref: "表1-3:row2", created_at: "",
    };
    expect(v.role).toBe("用户");
  });

  it("QualityGate result 三态", () => {
    const v: QualityGate = {
      id: "qg1", scenario_id: "s1", stage: 1, item_no: "1",
      title: "来源抽查≥3条", result: "通过", detail: "抽查5条一致",
      evidence_refs: {}, checked_at: "",
    };
    expect(v.result).toBe("通过");
  });
});

describe("@scene/contract API 类型", () => {
  it("ApiError 结构", () => {
    const v: ApiError = { code: "E001", message: "bad request" };
    expect(v.code).toBe("E001");
  });

  it("DshClient 接口方法存在", () => {
    // 类型检查即可，运行时验证需要 mock
    type HasMethods = Pick<DshClient, "createSession" | "prompt" | "cancel">;
    const _check: HasMethods = {} as DshClient;
    expect(_check).toBeDefined();
  });

  it("SystemStatus dsh+db 二态", () => {
    const v: SystemStatus = { dsh: "ok", dsh_port: 46171, db: "ok" };
    expect(v.dsh).toBe("ok");
  });

  it("ModelConfig 三字段", () => {
    const v: ModelConfig = { provider: "talkweb", default_model: "deepseek-v4-pro", analysis_model: "deepseek-v4-pro" };
    expect(v.provider).toBe("talkweb");
  });
});