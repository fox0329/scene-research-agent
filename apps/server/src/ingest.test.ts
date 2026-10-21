/**
 * @scene/server — ingest command 测试
 *
 * 使用 mock 的 docParser / dshClient / db，不实际调用外部服务。
 * 覆盖：正常流程、来源校验、DSH 格式错误降级。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  DshClient,
  SessionHandle,
  FollowEvent,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  OptionalMaterial,
  Conversation,
  Scenario,
} from "@scene/contract";
import type { ParseResult } from "@scene/infra";
import type { DbInstance, Repo } from "@scene/infra";

import { createIngestCommand, consumeDshPrompt } from "./ingest.js";
import type { DocParser, IngestDeps } from "./ingest.js";

// ─── Mock 工厂 ─────────────────────────────────────────────

function makeParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    text: "产品型号：IPC-3000\n发布日期：2025-01\n定位：高端智能摄像头",
    tables: [
      {
        headers: ["参数类别", "参数名称", "参数值", "测量状态"],
        rows: [["计算", "CPU", "4核 ARM", "实测"]],
      },
    ],
    metadata: { pageCount: 3 },
    ...overrides,
  };
}

/** 测试用 DSH 产出：宽松字段类型，便于按用例追加 M6/O3 等行 */
interface TestDshOutput {
  rows: { table_code: string; fields: Record<string, unknown>; source: string }[];
}

function makeDshOutput(): TestDshOutput {
  return {
    rows: [
      {
        table_code: "M1",
        fields: {
          model: "IPC-3000",
          name: "智能摄像头",
          status: "在售",
          launch_date: "2025-01",
          position_desc: "高端",
        },
        source: "whitepaper.pdf:3",
      },
      {
        table_code: "M2",
        fields: {
          product_model: "IPC-3000",
          param_class: "计算",
          param_name: "CPU",
          value: "4核 ARM",
          measured: "实测",
        },
        source: "whitepaper.pdf:5",
      },
      {
        table_code: "M3",
        fields: {
          domain: "视频监控",
          name: "人脸识别",
          description: "支持实时人脸检测与识别",
          maturity: "已交付",
          dependency: "GPU 模块",
        },
        source: "whitepaper.pdf:8",
      },
      {
        table_code: "M4",
        fields: {
          description: "不承担第三方云平台对接",
          reason: "无 SDK 支持",
          has_plan: "无",
          response: "建议客户自行适配",
          owner: "架构组",
        },
        source: "whitepaper.pdf:10",
      },
      {
        table_code: "M5",
        fields: {
          product_name: "IPC-3000",
          description: "夜间低光环境识别率下降",
          impact: "中",
          fix_status: "修复中",
          external_visible: "可提",
          owner: "算法组",
        },
        source: "whitepaper.pdf:12",
      },
      {
        table_code: "O2",
        fields: {
          name: "某市智慧园区",
          scene: "园区视频监控",
          delivered_at: "2024-06",
          acceptance: "500 路接入，验收通过",
          customer: "XX科技",
          scale: "500路",
        },
        source: "案例集.docx:2",
      },
    ],
  };
}

/** 创建可配置的 mock DshClient */
function createMockDshClient(outputText: string): DshClient {
  const events: FollowEvent[] = [
    { type: "text", text: outputText },
    { type: "done" },
  ];

  return {
    createSession: vi.fn(async () => ({ sessionId: "mock-session" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      for (const e of events) {
        yield e;
      }
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** mock 行的公共字段（对齐 @scene/infra BaseRow，该类型未导出故本地声明） */
type MockBaseRow = { id: string; created_at: string; updated_at: string };

/** 创建 mock Repo（记录 insert 调用） */
function createMockRepo<T extends MockBaseRow>(): Repo<T> {
  const store: T[] = [];
  return {
    list: vi.fn(() => [...store]),
    getById: vi.fn(() => undefined),
    insert: vi.fn((row) => {
      const fullRow = {
        ...row,
        id: `mock-${store.length}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T;
      store.push(fullRow);
      return fullRow;
    }),
    update: vi.fn(() => undefined),
    deleteById: vi.fn(() => false),
  };
}

/** 创建 mock DbInstance */
function createMockDb(): DbInstance {
  return {
    db: {} as never,
    productLineRepo: createMockRepo(),
    productRepo: createMockRepo<Product>(),
    specParamRepo: createMockRepo<SpecParam>(),
    capabilityRepo: createMockRepo<Capability>(),
    boundaryRepo: createMockRepo<Boundary>(),
    limitationRepo: createMockRepo<Limitation>(),
    optionalMaterialRepo: createMockRepo<OptionalMaterial>(),
    // ingest 流程不使用的仓库：占位 mock（Conversation 走 Repo，其余用空对象占位）
    conversationRepo: createMockRepo<Conversation>(),
    scenarioRepo: createMockRepo<Scenario>(),
    scenarioBriefRepo: { get: () => undefined, upsert: () => ({}), remove: () => false } as never,
    stageSummaryRepo: { get: () => undefined, upsert: () => ({}), listByScenario: () => [], remove: () => false } as never,
    scenarioStepRepo: {
      completedSteps: () => [],
      complete: () => undefined,
      clearFrom: () => 0,
      deleteByScenario: () => 0,
    } as never,
    messageRepo: {} as DbInstance["messageRepo"],
    stageDataRepo: {} as DbInstance["stageDataRepo"],
    qualityGateRepo: {} as DbInstance["qualityGateRepo"],
    scenarioLinkedLineRepo: { list: () => [], insert: vi.fn(), getById: vi.fn(), update: vi.fn(), deleteById: vi.fn() },
    scenarioMaterialRepo: createMockRepo(),
    // ingests 的价格一律走 M6：报价仓库必须是可断言的 mock，不能占位
    quoteRepo: createMockRepo(),
    researchRepo: {} as never,
  };
}

/** 创建 mock DocParser */
function createMockDocParser(result: ParseResult): DocParser {
  return vi.fn(async () => result);
}

// ─── 测试用例 ──────────────────────────────────────────────

describe("createIngestCommand", () => {
  let db: DbInstance;
  let dshClient: DshClient;
  let docParser: DocParser;
  let deps: IngestDeps;

  beforeEach(() => {
    db = createMockDb();
    const outputText = JSON.stringify(makeDshOutput());
    dshClient = createMockDshClient(outputText);
    docParser = createMockDocParser(makeParseResult());
    deps = { db, dshClient, docParser };
  });

  describe("正常流程：解析→分类→入库→评估", () => {
    it("应返回正确的 rowsInserted 数量", async () => {
      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1(1) + M2(1) + M3(1) + M4(1) + M5(1) + O2(1) = 6（M6 已删，变更表 #106）
      expect(result.rowsInserted).toBe(6);
    });

    it("应将 M1 产品写入 productRepo", async () => {
      const cmd = createIngestCommand(deps);
      await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.productRepo.insert).toHaveBeenCalledTimes(1);
      const call = (db.productRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.model).toBe("IPC-3000");
      expect(call.name).toBe("智能摄像头");
      expect(call.status).toBe("在售");
      expect(call.product_line_id).toBe("pl1");
      expect(call.source).toBe("whitepaper.pdf:3");
      expect(call.source_type).toBe("AI提取");
    });

    it("应将 M2 规格参数写入 specParamRepo，并关联到正确的 product_id", async () => {
      const cmd = createIngestCommand(deps);
      await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.specParamRepo.insert).toHaveBeenCalledTimes(1);
      const call = (db.specParamRepo.insert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(call.param_class).toBe("计算");
      expect(call.param_name).toBe("CPU");
      expect(call.product_id).toBeDefined();
    });

    it("应将 O2 可选材料写入 optionalMaterialRepo", async () => {
      const cmd = createIngestCommand(deps);
      await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.optionalMaterialRepo.insert).toHaveBeenCalledTimes(1);
      const call = (
        db.optionalMaterialRepo.insert as ReturnType<typeof vi.fn>
      ).mock.calls[0]![0];
      expect(call.category).toBe("O2案例");
      expect(call.product_line_id).toBe("pl1");
    });

    it("应返回 QualityAssessment（含 6 个维度）", async () => {
      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.qualityAssessment).toBeDefined();
      expect(result.qualityAssessment.dimensions).toHaveLength(6);
      expect(typeof result.qualityAssessment.passCount).toBe("number");
      expect(typeof result.qualityAssessment.warnCount).toBe("number");
      expect(typeof result.qualityAssessment.failCount).toBe("number");
    });

    it("应返回 CompletenessReport（含 items 和 reminders）", async () => {
      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.completenessReport).toBeDefined();
      expect(result.completenessReport.items.length).toBeGreaterThanOrEqual(7);
      expect(Array.isArray(result.completenessReport.reminders)).toBe(true);
    });
  });

  describe("M4 门禁：不做必须有可定位出处与依据", () => {
    it("缺 reason 的「不做」不入库，并在 skippedRows 里给原因", async () => {
      const output = makeDshOutput();
      output.rows[3]!.fields.reason = "";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.boundaryRepo.insert).not.toHaveBeenCalled();
      expect(result.rowsInserted).toBe(5);
      expect(result.skippedRows).toHaveLength(1);
      expect(result.skippedRows[0]!.table_code).toBe("M4");
      expect(result.skippedRows[0]!.reason).toContain("依据");
    });

    it("出处不可定位（文件名无扩展名且页码非数字）的「不做」不入库", async () => {
      const output = makeDshOutput();
      output.rows[3]!.source = "边界:未知";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.boundaryRepo.insert).not.toHaveBeenCalled();
      expect(result.rowsInserted).toBe(5);
      expect(result.skippedRows[0]!.reason).toContain("来源不可定位");
      expect(result.skippedRows[0]!.reason).toContain("边界:未知");
    });
  });

  describe("报价只进 M6，价格类别已下线", () => {
    it("价格类信息写入 M6；O3 行不再落可选材料", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "O3",
        fields: { item: "IPC-3000", pricing_model: "按台", price: "约 3800 元/台" },
        source: "whitepaper.pdf:14",
      });
      output.rows.push({
        table_code: "M6",
        fields: {
          model: "IPC-3000",
          config: "8G+128G",
          unit_price: "约 3800 元/台",
        },
        source: "whitepaper.pdf:14",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(db.quoteRepo.insert).toHaveBeenCalledTimes(1);
      const quote = (db.quoteRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(quote.model).toBe("IPC-3000");
      expect(quote.unit_price).toBe("约 3800 元/台");
      // 价格口径不进表：材料没给就按「纯设备」落库；有效期可空
      expect(quote.price_scope).toBe("纯设备");
      expect(quote.source).toBe("whitepaper.pdf:14");

      const optionalCategories = (
        db.optionalMaterialRepo.insert as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[0].category);
      expect(optionalCategories).toEqual(["O2案例"]);
      expect(result.tableCounts["M6"]).toBe(1);
      expect(result.tableCounts["O3"]).toBeUndefined();
    });

    it("O3 报价单文件引用也不再写入可选材料（类别已下线）", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "O3",
        fields: { file: "报价单-2026Q1.pdf", note: "含税参考价" },
        source: "报价单-2026Q1.pdf:1",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const categories = (
        db.optionalMaterialRepo.insert as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[0].category);
      expect(categories).toEqual(["O2案例"]);
      expect(categories).not.toContain("O3价格");
    });
  });

  describe("能力清单不再写「不适用场景」", () => {
    it("模型多给的 inapplicable_scene 不落库", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "M3",
        fields: {
          domain: "视频监控",
          name: "客流统计",
          description: "支持客流统计",
          maturity: "已交付",
          inapplicable_scene: "无摄像头的场景",
        },
        source: "whitepaper.pdf:9",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const caps = (db.capabilityRepo.insert as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
      expect(caps.length).toBeGreaterThanOrEqual(2);
      for (const cap of caps) expect(cap).not.toHaveProperty("inapplicable_scene");
    });
  });

  describe("来源校验：缺文件名或页码的行被丢弃", () => {
    it("source 为空字符串的行应被丢弃", async () => {
      const output = makeDshOutput();
      output.rows[0]!.source = "";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1 被丢弃，M2 因无关联的 product_id 也不会写入 → 总数少 2
      expect(result.rowsInserted).toBe(4);
    });

    it("source 缺少页码部分（无冒号）的行应被丢弃", async () => {
      const output = makeDshOutput();
      output.rows[2]!.source = "whitepaper.pdf"; // 缺页码
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M3 被丢弃 → 6 行
      expect(result.rowsInserted).toBe(5);
    });

    it("source 页码为空的行应被丢弃", async () => {
      const output = makeDshOutput();
      output.rows[3]!.source = "whitepaper.pdf:"; // 页码为空
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M4 被丢弃 → 6 行
      expect(result.rowsInserted).toBe(5);
    });

    it("source 文件名为空的行应被丢弃", async () => {
      const output = makeDshOutput();
      output.rows[0]!.source = ":3"; // 文件名为空
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1 被丢弃，M2 也无关联 → 少 2
      expect(result.rowsInserted).toBe(4);
    });

    it("source 含文件名但页码为「未知」→ 不可定位，不入库并给出原因", async () => {
      const output = makeDshOutput();
      output.rows[0]!.source = "whitepaper.pdf:未知";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1 被挡，M2 因无关联产品也不写入 → 4 行
      expect(result.rowsInserted).toBe(4);
      expect(result.skippedRows).toHaveLength(1);
      expect(result.skippedRows[0]!.reason).toContain("来源不可定位");
      expect(result.skippedRows[0]!.reason).toContain("whitepaper.pdf:未知");
      expect(db.productRepo.insert).not.toHaveBeenCalled();
    });

    it.each(["12", "12-14", "8.2", "A.1"])("具体定位符「%s」放行", async (locator) => {
      const output = makeDshOutput();
      output.rows[0]!.source = `whitepaper.pdf:${locator}`;
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.rowsInserted).toBe(6);
      expect(result.skippedRows).toHaveLength(0);
      const call = (db.productRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.source).toBe(`whitepaper.pdf:${locator}`);
    });
  });

  describe("证据等级：材料权威级 + 绝对化措辞（确定性）", () => {
    it("T1 材料（国标）→ evidence_level B", async () => {
      const output = makeDshOutput();
      output.rows[0]!.source = "GB/T 12345:8.2"; // 法规标准 T1，8.2 可定位
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const call = (db.productRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.evidence_level).toBe("B");
      expect(result.evidenceSummary.B).toBeGreaterThanOrEqual(1);
      expect(result.evidenceSummary.C).toBe(0);
    });

    it("T4 材料（口述）→ evidence_level C，并计入 evidenceSummary.C", async () => {
      const output = makeDshOutput();
      output.rows[4]!.source = "用户口述:12"; // M5 一手口述，T4
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const call = (db.limitationRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.evidence_level).toBe("C");
      expect(result.evidenceSummary.C).toBe(1);
      expect(result.evidenceSummary.B).toBe(result.rowsInserted - 1);
    });

    it("含「100%」的行 → 降为 C + flaggedRows 留痕（不删行）", async () => {
      const output = makeDshOutput();
      output.rows[2]!.fields["description"] = "100% 覆盖所有人脸识别场景";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const call = (db.capabilityRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.evidence_level).toBe("C");
      expect(result.rowsInserted).toBe(6); // 不删行
      expect(result.flaggedRows).toContainEqual(
        expect.objectContaining({
          table_code: "M3",
          field: "description",
          term: "100%",
          reason: "绝对化措辞，需核实",
        }),
      );
      expect(result.evidenceSummary.C).toBe(1);
    });
  });

  describe("必填列校验（契约 required）", () => {
    it("缺 required 列 → 不入库，reason 含列中文名", async () => {
      const output = makeDshOutput();
      output.rows[2]!.fields["description"] = ""; // M3 一句话描述（required）
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(db.capabilityRepo.insert).not.toHaveBeenCalled();
      expect(result.rowsInserted).toBe(5);
      expect(result.skippedRows).toHaveLength(1);
      expect(result.skippedRows[0]!.table_code).toBe("M3");
      expect(result.skippedRows[0]!.reason).toContain("缺必填列");
      expect(result.skippedRows[0]!.reason).toContain("一句话描述");
    });

    it("可选材料按类目校验 payload 必填列（O1 缺证书号）", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "O1",
        fields: {
          model: "IPC-3000",
          cert_type: "3C",
          valid_until: "2028-01",
          issuer: "中国质量认证中心",
        },
        source: "认证证书.pdf:1",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(result.skippedRows.some((r) => r.reason.includes("证书号"))).toBe(true);
      expect(result.tableCounts["O1"]).toBeUndefined();
    });
  });

  describe("同键冲突：不覆盖、不新增、留冲突证据", () => {
    it("M2 同 product/class/name 不同值 → 只保留原值，conflicts 1 条", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "M2",
        fields: {
          product_model: "IPC-3000",
          param_class: "计算",
          param_name: "CPU",
          value: "8核 ARM",
          measured: "宣称",
        },
        source: "新规格书.pdf:7",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(db.specParamRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.rowsInserted).toBe(6);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        table_code: "M2",
        existing: "4核 ARM",
        incoming: "8核 ARM",
        source: "新规格书.pdf:7",
      });
    });

    it("M2 同键同值 → 静默跳过，不产生冲突", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "M2",
        fields: {
          product_model: "IPC-3000",
          param_class: "计算",
          param_name: "CPU",
          value: " 4核 ARM ",
          measured: "实测",
        },
        source: "重复材料.pdf:9",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(db.specParamRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.rowsInserted).toBe(6);
      expect(result.conflicts).toHaveLength(0);
    });

    it("M3 同 domain/name 但描述或成熟度不同 → 冲突，保留原值", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "M3",
        fields: {
          domain: "视频监控",
          name: "人脸识别",
          description: "仅支持抓拍，不支持比对",
          maturity: "在研",
        },
        source: "roadmap.pdf:4",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(db.capabilityRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.table_code).toBe("M3");
      expect(result.conflicts[0]!.existing).toContain("支持实时人脸检测与识别");
      expect(result.conflicts[0]!.incoming).toContain("仅支持抓拍");
    });

    it("M4 同 description 但 reason 不同 → 冲突，保留原值", async () => {
      const output = makeDshOutput();
      output.rows.push({
        table_code: "M4",
        fields: {
          description: "不承担第三方云平台对接",
          reason: "商务原因：不在本次范围",
          has_plan: "未定",
          response: "转交生态伙伴",
        },
        source: "会议纪要.docx:3",
      });
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      expect(db.boundaryRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.table_code).toBe("M4");
      expect(result.conflicts[0]!.existing).toBe("无 SDK 支持");
      expect(result.conflicts[0]!.incoming).toBe("商务原因：不在本次范围");
    });
  });

  describe("DSH 产出格式错误的降级", () => {
    it("DSH 返回无效 JSON 时，rowsInserted 应为 0", async () => {
      dshClient = createMockDshClient("这是一段无法解析的文本回复。");
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.rowsInserted).toBe(0);
      // 评估仍应返回（空数据的评估）
      expect(result.qualityAssessment).toBeDefined();
      expect(result.completenessReport).toBeDefined();
    });

    it("DSH 返回 error 事件时，rowsInserted 应为 0", async () => {
      // 构造一个发出 error 事件的 dshClient
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "err-session" })),
        prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
          yield { type: "error", message: "模型超时" };
        }),
        cancel: vi.fn(async () => {}),
      };
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.rowsInserted).toBe(0);
    });

    it("DSH 返回不含 rows 字段的 JSON 时，应降级为空", async () => {
      dshClient = createMockDshClient(JSON.stringify({ result: "ok" }));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      expect(result.rowsInserted).toBe(0);
    });

    it("DSH 返回的 JSON 中 rows 缺少 table_code 的条目应被过滤", async () => {
      const output = {
        rows: [
          {
            table_code: "M1",
            fields: { model: "X-1", name: "Test", status: "在售", launch_date: "2025", position_desc: "test" },
            source: "doc.pdf:1",
          },
          {
            // 缺 table_code
            fields: { model: "X-2" },
            source: "doc.pdf:2",
          },
        ],
      };
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // 只有第一行合法
      expect(result.rowsInserted).toBe(1);
    });
  });

  describe("M2 产品关联", () => {
    it("M2 的 product_model 在 M1 中找不到对应时，该 M2 行不写入", async () => {
      const output = makeDshOutput();
      // 修改 M2 的 product_model 为不存在的型号
      output.rows[1]!.fields["product_model"] = "UNKNOWN-MODEL";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1(1) + M3(1) + M4(1) + M5(1) + O2(1) = 5（M6 已删，变更表 #106）
      expect(result.rowsInserted).toBe(5);
    });
  });

  describe("真文件名（变更表 #156）", () => {
    it("显式给 fileName → prompt 用材料真名，而不是临时落盘名", async () => {
      const cmd = createIngestCommand(deps);
      await cmd.execute({
        filePath: "/var/folders/x/T/ingest-1791527249715-1.pptx",
        productLineId: "pl1",
        fileName: "副本狄耐克鸿蒙智慧医院建设方案.pptx",
      });

      const promptArg = (dshClient.prompt as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![1] as { user: string };
      expect(promptArg.user).toContain("副本狄耐克鸿蒙智慧医院建设方案.pptx");
      // 临时名不许漏进模型（模型会照抄成行的来源标注 → 认不出是哪份材料）
      expect(promptArg.user).not.toContain("ingest-1791527249715-1");
    });

    it("不给 fileName → 退回路径文件名（对话导入等场景本来就是真实路径）", async () => {
      const cmd = createIngestCommand(deps);
      await cmd.execute({ filePath: "/tmp/whitepaper.pdf", productLineId: "pl1" });

      const promptArg = (dshClient.prompt as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![1] as { user: string };
      expect(promptArg.user).toContain("whitepaper.pdf");
    });
  });
});

describe("consumeDshPrompt", () => {
  it("应正确拼接流式文本并解析 JSON", async () => {
    const output = makeDshOutput();
    const jsonStr = JSON.stringify(output);

    // 模拟分 chunk 发送
    const chunk1 = jsonStr.slice(0, 50);
    const chunk2 = jsonStr.slice(50);

    const client: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s1" })),
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text: chunk1 };
        yield { type: "text", text: chunk2 };
        yield { type: "done" };
      }),
      cancel: vi.fn(async () => {}),
    };

    const session: SessionHandle = { sessionId: "s1" };
    const result = await consumeDshPrompt(client, session, "test prompt");

    expect(result.rows).toHaveLength(6);
    expect(result.rows[0]!.table_code).toBe("M1");
  });

  it("应从 markdown 代码块中提取 JSON", async () => {
    const output = makeDshOutput();
    const wrapped = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;

    const client: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s2" })),
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text: wrapped };
        yield { type: "done" };
      }),
      cancel: vi.fn(async () => {}),
    };

    const result = await consumeDshPrompt(client, { sessionId: "s2" }, "test");
    expect(result.rows).toHaveLength(6);
  });

  it("JSON 前有文本前缀时仍应提取", async () => {
    const output = makeDshOutput();
    const withPrefix = `以下是分析结果：\n${JSON.stringify(output)}`;

    const client: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s3" })),
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text: withPrefix };
        yield { type: "done" };
      }),
      cancel: vi.fn(async () => {},
      ),
    };

    const result = await consumeDshPrompt(client, { sessionId: "s3" }, "test");
    expect(result.rows).toHaveLength(6);
  });

  it("流中出现 error 事件应返回空 rows", async () => {
    const client: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s4" })),
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        yield { type: "text", text: '{"rows":[' };
        yield { type: "error", message: "timeout" };
      }),
      cancel: vi.fn(async () => {}),
    };

    const result = await consumeDshPrompt(client, { sessionId: "s4" }, "test");
    expect(result.rows).toHaveLength(0);
  });
});