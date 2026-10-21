import { describe, it, expect } from "vitest";
import {
  assessQuality,
  checkCompleteness,
  spotCheckSources,
  SPOT_CHECK_MIN,
  upsertFromAnalysis,
} from "./material.js";
import type {
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
} from "@scene/contract";
import type {
  AnalysisWriteback,
  MaterialUpdate,
} from "./material.js";

// ─── 工厂函数 ─────────────────────────────────────────────────

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    product_line_id: "pl1",
    model: "IPC-3000",
    name: "智能摄像头",
    status: "在售",
    launch_date: "2025-01",
    position_desc: "高端",
    source_type: "AI提取",
    source: "白皮书.pdf#3",
    source_authority: "T1",
    evidence_level: "A",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeSpecParam(overrides: Partial<SpecParam> = {}): SpecParam {
  return {
    id: "sp1",
    product_id: "p1",
    param_class: "计算",
    param_name: "CPU",
    value: "4核",
    measured: "实测",
    source_type: "AI提取",
    source: "规格书.pdf#5",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "c1",
    product_line_id: "pl1",
    domain: "数据采集",
    name: "温湿度采集",
    description: "实时采集温湿度",
    maturity: "已交付",
    dependency: "SEN-200",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeBoundary(overrides: Partial<Boundary> = {}): Boundary {
  return {
    id: "b1",
    product_line_id: "pl1",
    description: "不承担安防",
    reason: "无资质",
    has_plan: "无",
    response: "建议客户独立采购",
    owner: "产品",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeLimitation(overrides: Partial<Limitation> = {}): Limitation {
  return {
    id: "l1",
    product_line_id: "pl1",
    product_name: "IPC-3000",
    description: "高湿精度漂移",
    impact: "低",
    fix_status: "硬件限制",
    external_visible: "不可提",
    owner: "产品",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

// ─── assessQuality ────────────────────────────────────────────

describe("assessQuality", () => {
  it("全部六维通过 — 完整且规范的数据", () => {
    const products = [
      makeProduct({ id: "p1", source: "s1", status: "在售", launch_date: "2025-01" }),
      makeProduct({ id: "p2", source: "s2", status: "停售", launch_date: "2024-06" }),
    ];
    const specParams = [
      makeSpecParam({ id: "sp1", measured: "实测", source: "s1" }),
      makeSpecParam({ id: "sp2", measured: "实测", source: "s2" }),
    ];
    const boundaries = [makeBoundary({ id: "b1", description: "不承担安防" })];
    const limitations = [makeLimitation({ id: "l1", description: "高湿精度漂移" })];

    const result = assessQuality(products, specParams, boundaries, limitations);

    expect(result.passCount).toBe(6);
    expect(result.warnCount).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.dimensions).toHaveLength(6);
    for (const dim of result.dimensions) {
      expect(dim.status).toBe("pass");
    }
  });

  it("部分维度警告 — 产品状态混合、来源部分缺失", () => {
    const products = [
      makeProduct({ id: "p1", status: "在售", source: "s1", launch_date: "2025-01" }),
      makeProduct({ id: "p2", status: "待确认", source: undefined, launch_date: "2025-01" }),
    ];
    const specParams = [
      makeSpecParam({ id: "sp1", measured: "实测", source: "s1" }),
      makeSpecParam({ id: "sp2", measured: "宣称", source: "s2" }),
    ];
    const boundaries = [makeBoundary()];
    const limitations = [makeLimitation()];

    const result = assessQuality(products, specParams, boundaries, limitations);

    // 状态可分辨：1/2 待确认 → warn
    expect(result.dimensions[0]!.status).toBe("warn");
    expect(result.dimensions[0]!.description).toContain("1/2");
    // 可追溯：1/4 无来源 → warn
    expect(result.dimensions[1]!.status).toBe("warn");
    expect(result.dimensions[1]!.description).toContain("3/4");
    // 可验证：1 实测 / 1 宣称 → warn
    expect(result.dimensions[2]!.status).toBe("warn");
    expect(result.dimensions[2]!.description).toContain("1/2");
    // 有时效：2/2 有日期 → pass
    expect(result.dimensions[3]!.status).toBe("pass");
    // 含边界、含反面：有数据 → pass
    expect(result.dimensions[4]!.status).toBe("pass");
    expect(result.dimensions[5]!.status).toBe("pass");

    expect(result.warnCount).toBe(3);
    expect(result.passCount).toBe(3);
    expect(result.failCount).toBe(0);
  });

  it("全部六维失败 — 无数据", () => {
    const result = assessQuality([], [], [], []);

    expect(result.passCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.failCount).toBe(6);
    for (const dim of result.dimensions) {
      expect(dim.status).toBe("fail");
    }
    // 含边界失败说明应点名边界与限制
    expect(result.dimensions[4]!.description).toContain("边界与限制");
    // 含反面失败说明也点名边界与限制（已合并）
    expect(result.dimensions[5]!.description).toContain("边界与限制");
  });

  it("有产品但无规格参数 — 可验证失败", () => {
    const products = [makeProduct()];
    const result = assessQuality(products, [], [makeBoundary()], [makeLimitation()]);

    // 可验证失败：无规格参数
    expect(result.dimensions[2]!.status).toBe("fail");
    expect(result.dimensions[2]!.description).toContain("无规格参数");
  });

  it("产品状态全部待确认 — 状态可分辨失败", () => {
    const products = [
      makeProduct({ id: "p1", status: "待确认" }),
      makeProduct({ id: "p2", status: "待确认" }),
    ];
    const result = assessQuality(
      products,
      [makeSpecParam()],
      [makeBoundary()],
      [makeLimitation()],
    );

    expect(result.dimensions[0]!.status).toBe("fail");
    expect(result.dimensions[0]!.description).toContain("全部待确认");
  });

  it("边界有数据但无描述 — 含边界警告", () => {
    const products = [makeProduct()];
    const specParams = [makeSpecParam()];
    const boundaries = [makeBoundary({ description: "" })];
    const limitations = [makeLimitation()];

    const result = assessQuality(products, specParams, boundaries, limitations);

    expect(result.dimensions[4]!.status).toBe("warn");
    expect(result.dimensions[4]!.description).toContain("0 条有具体描述");
  });

  it("限制有数据但无描述 — 含反面警告", () => {
    const products = [makeProduct()];
    const specParams = [makeSpecParam()];
    const boundaries = [makeBoundary()];
    const limitations = [makeLimitation({ description: "" })];

    const result = assessQuality(products, specParams, boundaries, limitations);

    expect(result.dimensions[5]!.status).toBe("warn");
    expect(result.dimensions[5]!.description).toContain("0 条有具体描述");
  });

  it("可验证 — 全部实测时通过", () => {
    const specParams = [
      makeSpecParam({ id: "sp1", measured: "实测" }),
      makeSpecParam({ id: "sp2", measured: "实测" }),
    ];
    const result = assessQuality([makeProduct()], specParams, [makeBoundary()], [makeLimitation()]);

    expect(result.dimensions[2]!.status).toBe("pass");
    expect(result.dimensions[2]!.description).toContain("全部 2 个参数已实测验证");
  });

  it("可验证 — 存在未提及时失败", () => {
    const specParams = [
      makeSpecParam({ id: "sp1", measured: "实测" }),
      makeSpecParam({ id: "sp2", measured: "未提及" }),
    ];
    const result = assessQuality([makeProduct()], specParams, [makeBoundary()], [makeLimitation()]);

    expect(result.dimensions[2]!.status).toBe("fail");
    expect(result.dimensions[2]!.description).toContain("未提及");
  });

  it("有时效 — 全部缺失日期时失败", () => {
    const products = [
      makeProduct({ id: "p1", launch_date: "" }),
      makeProduct({ id: "p2", launch_date: "" }),
    ];
    const result = assessQuality(products, [makeSpecParam()], [makeBoundary()], [makeLimitation()]);

    expect(result.dimensions[3]!.status).toBe("fail");
    expect(result.dimensions[3]!.description).toContain("所有产品均无发布日期");
  });

  it("有时效 — 部分缺失日期时警告", () => {
    const products = [
      makeProduct({ id: "p1", launch_date: "2025-01" }),
      makeProduct({ id: "p2", launch_date: "" }),
    ];
    const result = assessQuality(products, [makeSpecParam()], [makeBoundary()], [makeLimitation()]);

    expect(result.dimensions[3]!.status).toBe("warn");
    expect(result.dimensions[3]!.description).toContain("1/2");
  });

  it("可追溯 — 有来源但部分缺失时警告", () => {
    const products = [
      makeProduct({ id: "p1", source: "白皮书.pdf#3" }),
      makeProduct({ id: "p2", source: undefined }),
    ];
    const specParams = [
      makeSpecParam({ id: "sp1", source: "规格书#1" }),
      makeSpecParam({ id: "sp2", source: undefined }),
    ];
    const result = assessQuality(products, specParams, [makeBoundary()], [makeLimitation()]);

    expect(result.dimensions[1]!.status).toBe("warn");
    expect(result.dimensions[1]!.description).toContain("2/4");
  });

  it("结果各维度名称正确", () => {
    const result = assessQuality([], [], [], []);
    const names = result.dimensions.map((d) => d.dimension);
    expect(names).toEqual(["状态可分辨", "可追溯", "可验证", "有时效", "含边界", "含反面"]);
  });
});

// ─── checkCompleteness ────────────────────────────────────────

describe("checkCompleteness", () => {
  it("全部 8 项通过 — 数据齐全", () => {
    const products = [makeProduct()];
    const specParams = [makeSpecParam()];
    const capabilities = [makeCapability()];
    const boundaries = [makeBoundary()];
    const limitations = [makeLimitation()];

    const report = checkCompleteness(products, specParams, capabilities, boundaries, limitations);

    expect(report.items).toHaveLength(7);

    // M1–M4 + M6 全部有数据
    expect(report.items[0]!.status).toBe("✅ 1 项");
    expect(report.items[1]!.status).toBe("✅ 1 个");
    expect(report.items[2]!.status).toBe("✅ 1 项");
    expect(report.items[3]!.status).toBe("✅ 1 条");
    expect(report.items[4]!.status).toBe("✅ 1 条");
    // 来源抽查：产品有来源 → 通过
    expect(report.items[5]!.status).toBe("✅ 已抽查");
    expect(report.items[5]!.risk).toBe("—");

    // 质量六维：全部通过 → 已评估
    expect(report.items[6]!.status).toBe("✅ 已评估");
    expect(report.items[6]!.risk).toBe("—");

    // 无缺失提醒
    expect(report.reminders).toHaveLength(0);
  });

  it("全部 7 项失败 — 完全空数据", () => {
    const report = checkCompleteness([], [], [], [], []);

    expect(report.items).toHaveLength(7);

    // M1–M4 + M6 全部空白
    for (let i = 0; i < 5; i++) {
      expect(report.items[i]!.status).toBe("❌ 空白");
      expect(report.items[i]!.risk).not.toBe("—");
    }

    // 来源抽查：无来源 → 未抽查
    expect(report.items[5]!.status).toBe("⚠️ 未抽查");
    expect(report.items[5]!.risk).toBe("证据可信度未验证");

    // 质量六维：全部失败 → 未评估
    expect(report.items[6]!.status).toBe("❌ 未评估");
    expect(report.items[6]!.risk).toBe("材料质量未评估");

    // 有缺失提醒
    expect(report.reminders.length).toBeGreaterThan(0);
  });

  it("只有产品和规格参数 — M3/M4/M6 空白", () => {
    const report = checkCompleteness([makeProduct()], [makeSpecParam()], [], [], []);

    expect(report.items[0]!.status).toBe("✅ 1 项"); // M1
    expect(report.items[1]!.status).toBe("✅ 1 个"); // M2
    expect(report.items[2]!.status).toBe("❌ 空白"); // M3
    expect(report.items[3]!.status).toBe("❌ 空白"); // M4
    expect(report.items[4]!.status).toBe("❌ 空白"); // M4 限制

    // 来源抽查：产品有来源 → 通过
    expect(report.items[5]!.status).toBe("✅ 已抽查");

    // 质量六维：含边界/含反面会失败 → 未评估
    expect(report.items[6]!.status).toBe("❌ 未评估");

    // 提醒用中文名，不做/限制各点名一次
    const tables = report.reminders.map((r) => r.table);
    expect(tables).toContain("能力清单");
    expect(tables).toContain("边界与限制（不做）");
    expect(tables).toContain("边界与限制（限制）");
  });

  it("检查项 ID 连续 1-7", () => {
    const report = checkCompleteness([], [], [], [], []);
    for (let i = 0; i < 7; i++) {
      expect(report.items[i]!.id).toBe(i + 1);
    }
  });

  it("检查项名称符合 §2.4 规范", () => {
    const report = checkCompleteness([], [], [], [], []);
    expect(report.items[0]!.name).toBe("产品清单已填写");
    expect(report.items[1]!.name).toBe("规格书已填写");
    expect(report.items[2]!.name).toBe("能力清单已填写");
    expect(report.items[3]!.name).toBe("边界与限制（不做）已填写");
    expect(report.items[4]!.name).toBe("边界与限制（限制）已填写");
    expect(report.items[5]!.name).toBe("来源抽查");
    expect(report.items[6]!.name).toBe("质量六维已评估");
  });

  it("缺失风险描述符合 §2.4", () => {
    const report = checkCompleteness([], [], [], [], []);
    expect(report.items[0]!.risk).toBe("阶段三匹配矩阵缺少候选池");
    expect(report.items[1]!.risk).toBe("阶段四选型缺少参数依据");
    expect(report.items[2]!.risk).toBe("阶段三匹配矩阵缺少行");
    expect(report.items[3]!.risk).toContain("门槛扫描");
    expect(report.items[4]!.risk).toBe("阶段四实施风险与验收约束不完整");
  });

  it("缺失提醒结构（表 0-13 格式）", () => {
    const report = checkCompleteness([], [], [], [], []);
    for (const reminder of report.reminders) {
      expect(reminder).toHaveProperty("table");
      expect(reminder).toHaveProperty("missing");
      expect(reminder).toHaveProperty("impact");
      expect(reminder).toHaveProperty("suggestion");
      expect(typeof reminder.table).toBe("string");
      expect(typeof reminder.missing).toBe("string");
      expect(typeof reminder.impact).toBe("string");
      expect(typeof reminder.suggestion).toBe("string");
    }
  });

  it("数量格式正确 — 多项显示数字", () => {
    const products = [makeProduct({ id: "p1" }), makeProduct({ id: "p2" })];
    const specParams = [
      makeSpecParam({ id: "sp1" }),
      makeSpecParam({ id: "sp2" }),
      makeSpecParam({ id: "sp3" }),
    ];
    const report = checkCompleteness(
      products, specParams, [makeCapability()],
      [makeBoundary()], [makeLimitation()],
    );

    expect(report.items[0]!.status).toBe("✅ 2 项");
    expect(report.items[1]!.status).toBe("✅ 3 个");
  });

  it("来源有标注但质量六维部分失败 → 提醒只含六维", () => {
    // 有产品（有来源）但无边界/限制 → 六维 fail
    const report = checkCompleteness(
      [makeProduct({ source: "s1" })],
      [makeSpecParam({ source: "s2" })],
      [makeCapability()],
      [], // 无边界 → 含边界 fail
      [], // 无限制 → 含反面 fail
    );

    // 来源抽查通过
    expect(report.items[5]!.status).toBe("✅ 已抽查");
    // 质量六维未评估
    expect(report.items[6]!.status).toBe("❌ 未评估");

    // 提醒应包含边界与限制与质量六维
    const tables = report.reminders.map((r) => r.table);
    expect(tables).toContain("边界与限制（不做）");
    expect(tables).toContain("资料库");
    // 不应含全局来源提醒
    expect(tables).not.toContain("全局");
  });
});

// ─── upsertFromAnalysis ──────────────────────────────────────

describe("upsertFromAnalysis", () => {
  it("空回写 — 无操作", () => {
    const result = upsertFromAnalysis({});

    expect(result.operations).toHaveLength(0);
    expect(result.summary).toBe("无更新");
  });

  it("能力成熟度变更 — 生成 update_maturity 操作", () => {
    const data: AnalysisWriteback = {
      capabilityMaturityChanges: [
        {
          capabilityId: "c1",
          capabilityName: "温湿度采集",
          newMaturity: "组件具备",
          reason: "阶段 4 匹配分析确认组件已具备",
        },
        {
          capabilityId: "c2",
          capabilityName: "人脸识别",
          newMaturity: "在研",
          reason: "供应商确认在研中",
        },
      ],
    };

    const result = upsertFromAnalysis(data);

    expect(result.operations).toHaveLength(2);

    const op1 = result.operations[0]!;
    expect(op1.type).toBe("update_maturity");
    if (op1.type === "update_maturity") {
      expect(op1.table).toBe("capability");
      expect(op1.targetId).toBe("c1");
      expect(op1.payload.maturity).toBe("组件具备");
      expect(op1.reason).toBe("阶段 4 匹配分析确认组件已具备");
    }

    const op2 = result.operations[1]!;
    if (op2.type === "update_maturity") {
      expect(op2.targetId).toBe("c2");
      expect(op2.payload.maturity).toBe("在研");
    }

    expect(result.summary).toContain("2 项能力成熟度更新");
  });

  it("新边界 — 生成 boundary insert 操作", () => {
    const data: AnalysisWriteback = {
      newBoundaries: [
        {
          product_line_id: "pl1",
          description: "不支持多租户",
          reason: "架构限制",
          has_plan: "无",
          response: "单租户方案",
          owner: "架构组",
        },
      ],
    };

    const result = upsertFromAnalysis(data);

    expect(result.operations).toHaveLength(1);
    const op = result.operations[0]!;
    expect(op.type).toBe("insert");
    expect(op.table).toBe("boundary");
    expect((op.payload as Record<string, unknown>)["description"]).toBe("不支持多租户");
    expect((op.payload as Record<string, unknown>)["product_line_id"]).toBe("pl1");
    expect(result.summary).toContain("1 条新边界");
  });

  it("新限制 — 生成 limitation insert 操作", () => {
    const data: AnalysisWriteback = {
      newLimitations: [
        {
          product_line_id: "pl1",
          product_name: "IPC-3000",
          description: "低温启动延迟",
          impact: "中",
          fix_status: "修复中",
          external_visible: "内部可提",
          owner: "硬件组",
        },
      ],
    };

    const result = upsertFromAnalysis(data);

    expect(result.operations).toHaveLength(1);
    const op = result.operations[0]!;
    expect(op.type).toBe("insert");
    expect(op.table).toBe("limitation");
    expect((op.payload as Record<string, unknown>)["description"]).toBe("低温启动延迟");
    expect(result.summary).toContain("1 条新限制");
  });

  it("混合回写 — 成熟度 + 边界 + 限制", () => {
    const data: AnalysisWriteback = {
      capabilityMaturityChanges: [
        {
          capabilityId: "c1",
          capabilityName: "能力A",
          newMaturity: "已交付",
          reason: "匹配分析",
        },
      ],
      newBoundaries: [
        {
          product_line_id: "pl1",
          description: "边界1",
          reason: "r",
          has_plan: "无",
          response: "r",
          owner: "o",
        },
      ],
      newLimitations: [
        {
          product_line_id: "pl1",
          product_name: "p1",
          description: "限制1",
          impact: "低",
          fix_status: "无计划",
          external_visible: "可提",
          owner: "o",
        },
      ],
    };

    const result = upsertFromAnalysis(data);

    expect(result.operations).toHaveLength(3);

    // 操作类型分布
    const updateOps = result.operations.filter((o) => o.type === "update_maturity");
    const insertOps = result.operations.filter((o) => o.type === "insert");
    expect(updateOps).toHaveLength(1);
    expect(insertOps).toHaveLength(2);

    // insert 操作表分布
    const boundaryOps = insertOps.filter((o) => o.table === "boundary");
    const limitationOps = insertOps.filter((o) => o.table === "limitation");
    expect(boundaryOps).toHaveLength(1);
    expect(limitationOps).toHaveLength(1);

    // 摘要包含三类信息
    expect(result.summary).toContain("1 项能力成熟度更新");
    expect(result.summary).toContain("1 条新边界");
    expect(result.summary).toContain("1 条新限制");
  });

  it("空数组回写 — 无操作", () => {
    const data: AnalysisWriteback = {
      capabilityMaturityChanges: [],
      newBoundaries: [],
      newLimitations: [],
    };

    const result = upsertFromAnalysis(data);

    expect(result.operations).toHaveLength(0);
    expect(result.summary).toBe("无更新");
  });

  it("insert 操作 payload 不含 id/created_at/updated_at", () => {
    const data: AnalysisWriteback = {
      newBoundaries: [
        {
          product_line_id: "pl1",
          description: "边界",
          reason: "r",
          has_plan: "无",
          response: "r",
          owner: "o",
        },
      ],
    };

    const result = upsertFromAnalysis(data);
    const payload = result.operations[0]!.payload as Record<string, unknown>;

    // 不应包含 infra 管理的字段
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("created_at");
    expect(payload).not.toHaveProperty("updated_at");
  });

  it("返回值是纯数据（不包含函数或不可序列化内容）", () => {
    const data: AnalysisWriteback = {
      capabilityMaturityChanges: [
        { capabilityId: "c1", capabilityName: "n", newMaturity: "已交付", reason: "r" },
      ],
    };

    const result = upsertFromAnalysis(data);
    const serialized = JSON.parse(JSON.stringify(result)) as MaterialUpdate;

    expect(serialized.operations).toHaveLength(1);
    expect(serialized.summary).toBe("待执行：1 项能力成熟度更新");
  });

  it("update_maturity payload 精确结构", () => {
    const data: AnalysisWriteback = {
      capabilityMaturityChanges: [
        { capabilityId: "c1", capabilityName: "n", newMaturity: "在研", reason: "r" },
      ],
    };

    const result = upsertFromAnalysis(data);
    const op = result.operations[0]!;

    expect(op.type).toBe("update_maturity");
    // payload 只有 maturity 一个字段
    expect(Object.keys(op.payload)).toEqual(["maturity"]);
  });
});
// ─── 来源抽查真核对（G-R3，变更表 #211） ─────────────────────

/** 假材料库：refs 是"存在的出处"，contents 是"该出处页面里有的原文" */
function fakeLookup(refs: string[], contents: Record<string, string[]>) {
  return {
    hasSource: (ref: string) => refs.includes(ref),
    hasContent: (ref: string, snippet: string) =>
      (contents[ref] ?? []).some((page) => page.includes(snippet)),
  };
}

describe("spotCheckSources", () => {
  it("出处存在且原文确有该内容 → verified", () => {
    const report = spotCheckSources(
      fakeLookup(["白皮书.pdf#3"], { "白皮书.pdf#3": ["智能摄像头 高端定位 面向工业场景"] }),
      {
        products: [makeProduct()],
        specParams: [],
        capabilities: [],
        boundaries: [],
        limitations: [],
      },
      1,
    );
    expect(report.items[0]?.verdict).toBe("verified");
    expect(report.verified).toBe(1);
    expect(report.failed).toBe(0);
  });

  it("出处查不到 → missing（材料已删或页码写错）", () => {
    const report = spotCheckSources(fakeLookup([], {}), {
      products: [makeProduct()],
      specParams: [],
      capabilities: [],
      boundaries: [],
      limitations: [],
    });
    expect(report.items[0]?.verdict).toBe("missing");
    expect(report.items[0]?.detail).toContain("查不到");
    expect(report.failed).toBe(1);
  });

  it("出处存在但那页没这句话 → mismatch（页码错或内容被改写）", () => {
    const report = spotCheckSources(
      fakeLookup(["白皮书.pdf#3"], { "白皮书.pdf#3": ["完全不相干的一段话"] }),
      {
        products: [makeProduct()],
        specParams: [],
        capabilities: [],
        boundaries: [],
        limitations: [],
      },
      1,
    );
    expect(report.items[0]?.verdict).toBe("mismatch");
    expect(report.failed).toBe(1);
  });

  it("默认抽 3 条（G-R3 覆盖要求）", () => {
    expect(SPOT_CHECK_MIN).toBe(3);
    const report = spotCheckSources(
      fakeLookup(["白皮书.pdf#3", "规格书.pdf#5", "能力表.pdf#3"], {
        "白皮书.pdf#3": ["智能摄像头 高端定位"],
        "规格书.pdf#5": ["CPU 4核 实测"],
        "能力表.pdf#3": ["温湿度采集 实时采集温湿度"],
      }),
      {
        products: [makeProduct()],
        specParams: [makeSpecParam()],
        capabilities: [makeCapability({ source: "能力表.pdf#3" })],
        boundaries: [],
        limitations: [],
      },
    );
    expect(report.checked).toBe(3);
    expect(report.covered).toBe(true);
  });

  it("同一出处只抽一次（同页抽两条等于只抽一条）", () => {
    const report = spotCheckSources(
      fakeLookup(["白皮书.pdf#3"], { "白皮书.pdf#3": ["智能摄像头 高端定位"] }),
      {
        products: [makeProduct(), makeProduct({ id: "p2", model: "IPC-4000" })],
        specParams: [],
        capabilities: [],
        boundaries: [],
        limitations: [],
      },
    );
    expect(report.checked).toBe(1);
  });

  it("没有出处的记录不参与抽查（不算查过）", () => {
    const report = spotCheckSources(fakeLookup([], {}), {
      products: [makeProduct({ source: undefined })],
      specParams: [],
      capabilities: [],
      boundaries: [],
      limitations: [],
    });
    expect(report.checked).toBe(0);
    expect(report.covered).toBe(false);
  });

  it("覆盖不足时 covered=false（不谎称查够了）", () => {
    const report = spotCheckSources(
      fakeLookup(["白皮书.pdf#3"], { "白皮书.pdf#3": ["智能摄像头 高端定位"] }),
      {
        products: [makeProduct()],
        specParams: [],
        capabilities: [],
        boundaries: [],
        limitations: [],
      },
    );
    expect(report.checked).toBe(1);
    expect(report.covered).toBe(false);
  });
});

describe("checkCompleteness 的第 6 项（来源抽查）接真核对", () => {
  it("全过 → ✅ 已核对 N 条，原文一致", () => {
    const spot = spotCheckSources(
      fakeLookup(["白皮书.pdf#3"], { "白皮书.pdf#3": ["智能摄像头 高端定位"] }),
      {
        products: [makeProduct()],
        specParams: [],
        capabilities: [],
        boundaries: [],
        limitations: [],
      },
      1,
    );
    const report = checkCompleteness(
      [makeProduct()],
      [],
      [],
      [],
      [],
      spot,
    );
    const item = report.items.find((i) => i.id === 6);
    expect(item?.status).toContain("原文一致");
    expect(item?.risk).toBe("—");
  });

  it("有对不上 → ❌ 并给出条数（不粉饰成已抽查）", () => {
    const spot = spotCheckSources(fakeLookup([], {}), {
      products: [makeProduct()],
      specParams: [],
      capabilities: [],
      boundaries: [],
      limitations: [],
    });
    const report = checkCompleteness([makeProduct()], [], [], [], [], spot);
    const item = report.items.find((i) => i.id === 6);
    expect(item?.status).toContain("❌");
    expect(item?.status).toContain("1 条对不上");
    expect(report.reminders.some((r) => r.missing.includes("对不上"))).toBe(true);
  });

  it("不传抽查结果时退回旧口径（标了来源就算已抽查）", () => {
    const report = checkCompleteness([makeProduct()], [], [], [], []);
    const item = report.items.find((i) => i.id === 6);
    expect(item?.status).toBe("✅ 已抽查");
  });
});
