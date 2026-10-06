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

function makeDshOutput() {
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
          project_name: "某市智慧园区",
          client: "XX科技",
          year: "2024",
          scale: "500路",
          summary: "成功交付的大型监控项目",
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

    it("source 含文件名和'未知'页码应被保留", async () => {
      const output = makeDshOutput();
      output.rows[0]!.source = "whitepaper.pdf:未知";
      dshClient = createMockDshClient(JSON.stringify(output));
      deps = { db, dshClient, docParser };

      const cmd = createIngestCommand(deps);
      const result = await cmd.execute({
        filePath: "/tmp/whitepaper.pdf",
        productLineId: "pl1",
      });

      // M1 保留 → 7 行
      expect(result.rowsInserted).toBe(6);
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