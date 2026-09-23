/**
 * @scene/server — advance-stage command 测试
 *
 * 使用 mock 的 dshClient + db，不实际调用外部服务。
 * 覆盖：阶段 0-2 推进流程、事件流顺序、会话登记。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  DshClient,
  FollowEvent,
  SessionHandle,
  Scenario,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  CostRate,
  OptionalMaterial,
  Conversation,
  Message,
  StageData,
  QualityGate,
} from "@scene/contract";
import type {
  DbInstance,
  Repo,
  StageDataRepo,
  QualityGateRepo,
  MessageRepo,
} from "@scene/infra";

import { createAdvanceStageCommand } from "./advance-stage.js";
import type { AdvanceStageDeps } from "./advance-stage.js";

// ─── Mock 工厂 ─────────────────────────────────────────────

/** 创建可配置的 mock DshClient */
function createMockDshClient(outputText: string): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "mock-session-stage" })),
    prompt: vi.fn(function* (): AsyncIterable<FollowEvent> {
      yield { type: "text", text: outputText };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** 创建 mock 通用 Repo（内存存储） */
function createMockRepo<T extends { id?: string }>(): Repo<T> {
  const store: T[] = [];
  return {
    list: vi.fn(() => [...store]),
    getById: vi.fn((id: string) => store.find((r) => r.id === id)),
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
    update: vi.fn((id: string, patch: Partial<T>) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx < 0) return undefined;
      store[idx] = { ...store[idx]!, ...patch } as T;
      return store[idx];
    }),
    deleteById: vi.fn(() => false),
  };
}

/** 创建 mock StageDataRepo */
function createMockStageDataRepo(): StageDataRepo {
  const store: StageData[] = [];
  return {
    list: vi.fn(() => [...store]),
    listByScenarioStage: vi.fn((scenarioId: string, stage: number) =>
      store.filter(
        (r) => r.scenario_id === scenarioId && r.stage === stage,
      ),
    ),
    insert: vi.fn((row) => {
      const fullRow: StageData = {
        ...row,
        id: `sd-${store.length}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.push(fullRow);
      return fullRow;
    }),
  };
}

/** 创建 mock QualityGateRepo */
function createMockQualityGateRepo(): QualityGateRepo {
  const store: QualityGate[] = [];
  return {
    list: vi.fn(() => [...store]),
    listByScenarioStage: vi.fn((scenarioId: string, stage: number) =>
      store.filter(
        (r) => r.scenario_id === scenarioId && r.stage === stage,
      ),
    ),
    insert: vi.fn((row) => {
      const fullRow: QualityGate = {
        ...row,
        id: `qg-${store.length}`,
        checked_at: new Date().toISOString(),
      };
      store.push(fullRow);
      return fullRow;
    }),
  };
}

/** 创建 mock MessageRepo */
function createMockMessageRepo(): MessageRepo {
  const store: Message[] = [];
  return {
    list: vi.fn(() => [...store]),
    listByConversation: vi.fn((convId: string) =>
      store.filter((m) => m.conversation_id === convId),
    ),
    insert: vi.fn((row) => {
      const fullRow: Message = {
        ...row,
        id: `msg-${store.length}`,
        created_at: new Date().toISOString(),
      };
      store.push(fullRow);
      return fullRow;
    }),
    deleteById: vi.fn(() => false),
    deleteByConversation: vi.fn(() => 0),
  };
}

/** 创建 mock DbInstance（含预填数据） */
function createMockDb(opts: {
  scenario?: Partial<Scenario>;
  products?: Product[];
}): DbInstance {
  const scenario: Scenario = {
    id: "sc-1",
    name: "测试场景",
    product_line_id: "pl-1",
    status: "进行中",
    current_stage: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...opts.scenario,
  };

  const scenarioRepo = createMockRepo<Scenario>();
  (scenarioRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
    (id: string) => (id === scenario.id ? scenario : undefined),
  );
  (scenarioRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([scenario]);

  const productRepo = createMockRepo<Product>();
  (productRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.products ?? [],
  );

  const conversationRepo = createMockRepo<Conversation>();

  return {
    db: {} as never,
    productLineRepo: createMockRepo(),
    productRepo,
    specParamRepo: createMockRepo<SpecParam>(),
    capabilityRepo: createMockRepo<Capability>(),
    boundaryRepo: createMockRepo<Boundary>(),
    limitationRepo: createMockRepo<Limitation>(),
    costRateRepo: createMockRepo<CostRate>(),
    optionalMaterialRepo: createMockRepo<OptionalMaterial>(),
    conversationRepo,
    messageRepo: createMockMessageRepo(),
    scenarioRepo,
    stageDataRepo: createMockStageDataRepo(),
    qualityGateRepo: createMockQualityGateRepo(),
  };
}

/** 辅助：收集 AsyncIterable 的所有产出 */
async function collectEvents(
  iterable: AsyncIterable<FollowEvent>,
): Promise<FollowEvent[]> {
  const events: FollowEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ─── DSH 输出样本 ──────────────────────────────────────────

function makeStage1DshOutput() {
  return {
    rows: [
      {
        table_code: "表1-1",
        fields: {
          scene_name: "智慧园区安防",
          customer_type: "政府/国企",
          use_case: "园区综合安防管理",
          entry_point: "视频监控系统升级",
          value_proposition: "降低安保人力成本 30%",
        },
        source: "需求文档.pdf:5",
      },
      {
        table_code: "表1-3",
        fields: {
          barrier_type: "技术",
          criteria: "AI 识别准确率 ≥ 95%",
          current_status: "满足，已具备",
          judgment: "过得了",
          evidence: "白皮书.pdf:12",
        },
        source: "白皮书.pdf:12",
      },
      {
        table_code: "表1-3",
        fields: {
          barrier_type: "行业准入",
          criteria: "安防资质",
          current_status: "不知道",
          judgment: "不知道",
          evidence: "",
        },
        source: "需求文档.pdf:8",
      },
      {
        table_code: "表1-4",
        fields: {
          barrier_ref: "技术",
          strategy: "直接进入",
          action_items: "准备技术方案",
          owner: "技术组",
          timeline: "2周",
        },
        source: "内部讨论.md:1",
      },
      {
        table_code: "表1-5",
        fields: {
          risk_id: "R1",
          description: "安防资质缺失",
          severity: "高",
          inherited_from: "行业准入",
          mitigation: "寻找有资质的合作伙伴",
        },
        source: "需求文档.pdf:8",
      },
    ],
  };
}

function makeStage2DshOutput() {
  return {
    rows: [
      {
        table_code: "表2-1",
        fields: {
          architecture_name: "分布式视频分析架构",
          components: ["前端摄像头", "边缘计算节点", "中心管理平台"],
          interfaces: "ONVIF/RTSP",
          deployment_model: "混合云",
        },
        source: "架构设计.pptx:3",
      },
      {
        table_code: "表2-4",
        fields: {
          constraint_type: "合规",
          description: "数据不得出境",
          requirement: "数据存储在国内机房",
          compliance_path: "选择国内云服务商",
          owner: "合规组",
        },
        source: "合规要求.pdf:1",
      },
      {
        table_code: "表2-7",
        fields: {
          boundary_area: "安全责任",
          description: "不承担第三方设备的安全责任",
          reason: "无授权",
          alternative: "明确 SLA 边界",
        },
        source: "白皮书.pdf:15",
      },
    ],
  };
}

// ─── 测试用例 ──────────────────────────────────────────────

describe("createAdvanceStageCommand", () => {
  let db: DbInstance;
  let dshClient: DshClient;
  let deps: AdvanceStageDeps;

  describe("阶段 0：材料解析总结", () => {
    beforeEach(() => {
      db = createMockDb({ scenario: { current_stage: 0 } });
      dshClient = createMockDshClient(
        JSON.stringify({
          rows: [
            {
              table_code: "summary",
              fields: { status: "材料完整", coverage: "80%" },
              source: "系统分析:阶段0",
            },
          ],
        }),
      );
      deps = { db, dshClient };
    });

    it("应产出 progress → row → done 事件（无质量关）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 0 }),
      );

      const types = events.map((e) => e.type);
      expect(types[0]).toBe("progress"); // 开始
      expect(types[1]).toBe("progress"); // 调用 AI
      expect(types).toContain("row");
      expect(types).toContain("done");
      // 阶段 0 无质量关 → 不应有 gate/advice
      expect(types).not.toContain("gate");
      expect(types).not.toContain("advice");
    });

    it("应更新 scenario.current_stage 为 1", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 0 }));

      expect(db.scenarioRepo.update).toHaveBeenCalledWith("sc-1", {
        current_stage: 1,
      });
    });

    it("应登记 conversation", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 0 }));

      expect(db.conversationRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario_id: "sc-1",
          title: "阶段 0 · 分析",
          status: "活跃",
          dsh_session_id: "mock-session-stage",
        }),
      );
    });
  });

  describe("阶段 1：门槛筛查", () => {
    beforeEach(() => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createMockDshClient(
        JSON.stringify(makeStage1DshOutput()),
      );
      deps = { db, dshClient };
    });

    it("应产出 progress → row... → gate → advice → done 事件", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const types = events.map((e) => e.type);

      // 事件顺序：progress → progress → row(s) → progress → gate → advice → done
      const firstProgress = types.indexOf("progress");
      const lastRow = types.lastIndexOf("row");
      const gateIdx = types.indexOf("gate");
      const adviceIdx = types.indexOf("advice");
      const doneIdx = types.indexOf("done");

      expect(firstProgress).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstProgress);
      expect(gateIdx).toBeGreaterThan(lastRow);
      expect(adviceIdx).toBeGreaterThan(gateIdx);
      expect(doneIdx).toBeGreaterThan(adviceIdx);
    });

    it("应将 DSH 输出的行写入 stageDataRepo", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      // 5 条 stage1 输出行
      expect(db.stageDataRepo.insert).toHaveBeenCalledTimes(5);

      // 验证第一条
      const firstCall = (db.stageDataRepo.insert as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0];
      expect(firstCall.scenario_id).toBe("sc-1");
      expect(firstCall.stage).toBe(1);
      expect(firstCall.table_code).toBe("表1-1");
      expect(firstCall.source_type).toBe("AI提取");
    });

    it("应将质量关结果写入 qualityGateRepo", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      // 阶段 1 有 10 项质量关
      expect(db.qualityGateRepo.insert).toHaveBeenCalledTimes(10);
    });

    it("应产出 gate 事件含通过数和总数", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const gateEvent = events.find((e) => e.type === "gate") as FollowEvent & {
        results: unknown[];
        passed: number;
        total: number;
      };
      expect(gateEvent).toBeDefined();
      expect(gateEvent.total).toBe(10);
      expect(typeof gateEvent.passed).toBe("number");
    });

    it("应产出 advice 事件含建议三档", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const adviceEvent = events.find((e) => e.type === "advice") as FollowEvent & {
        level: string;
      };
      expect(adviceEvent).toBeDefined();
      expect(["建议通过", "建议有条件通过", "建议不通过"]).toContain(
        adviceEvent.level,
      );
    });

    it("应更新 scenario.current_stage 为 2", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      expect(db.scenarioRepo.update).toHaveBeenCalledWith("sc-1", {
        current_stage: 2,
      });
    });

    it("应记录系统消息到 conversation", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      expect(db.messageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "系统",
          stage: 1,
          content: expect.stringContaining("阶段 1 分析完成"),
        }),
      );
    });
  });

  describe("阶段 2：架构约束分析", () => {
    beforeEach(() => {
      db = createMockDb({ scenario: { current_stage: 2 } });
      dshClient = createMockDshClient(
        JSON.stringify(makeStage2DshOutput()),
      );
      deps = { db, dshClient };
    });

    it("应产出完整事件流（含 gate 和 advice）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 2 }),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain("progress");
      expect(types).toContain("row");
      expect(types).toContain("gate");
      expect(types).toContain("advice");
      expect(types).toContain("done");
    });

    it("应将 3 条行写入 stageDataRepo", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      expect(db.stageDataRepo.insert).toHaveBeenCalledTimes(3);
    });

    it("应将质量关结果写入（阶段 2 有 9 项）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      expect(db.qualityGateRepo.insert).toHaveBeenCalledTimes(9);
    });

    it("应更新 scenario.current_stage 为 3", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      expect(db.scenarioRepo.update).toHaveBeenCalledWith("sc-1", {
        current_stage: 3,
      });
    });
  });

  describe("错误处理", () => {
    it("scenario 不存在时应产出 error 事件", async () => {
      db = createMockDb({});
      // 确保 getById 返回 undefined
      (db.scenarioRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );
      dshClient = createMockDshClient("{}");
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "non-existent", stage: 0 }),
      );

      expect(events[0]!.type).toBe("error");
      expect((events[0] as FollowEvent & { message: string }).message).toContain(
        "不存在",
      );
    });

    it("DSH 返回 error 事件时应传播错误", async () => {
      db = createMockDb({ scenario: { current_stage: 0 } });
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "err-session" })),
        prompt: vi.fn(function* (): AsyncIterable<FollowEvent> {
          yield { type: "error", message: "模型超时" };
        }),
        cancel: vi.fn(async () => {}),
      };
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 0 }),
      );

      // 最后一个事件应是 error（来自 DSH）
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("DSH 返回无效 JSON 时应降级为空行", async () => {
      db = createMockDb({ scenario: { current_stage: 0 } });
      dshClient = createMockDshClient("无法解析的文本");
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 0 }),
      );

      // 无 row 事件
      const rowEvents = events.filter((e) => e.type === "row");
      expect(rowEvents).toHaveLength(0);

      // 但应有 done 事件
      expect(events[events.length - 1]!.type).toBe("done");
    });
  });

  describe("F2 流式续传：事件带递增 id", () => {
    it("每个事件应有递增的 id 字段", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createMockDshClient(
        JSON.stringify(makeStage1DshOutput()),
      );
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      // 每个事件都有 id
      for (const event of events) {
        expect(event.id).toBeDefined();
        expect(typeof event.id).toBe("string");
      }

      // id 递增
      const ids = events.map((e) => Number(e.id));
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
      }
    });
  });

  describe("F2 会话登记：DSH session → conversation", () => {
    it("conversation 应包含正确的 dsh_session_id", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createMockDshClient(
        JSON.stringify(makeStage1DshOutput()),
      );
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      const convCall = (db.conversationRepo.insert as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0];
      expect(convCall.dsh_session_id).toBe("mock-session-stage");
      expect(convCall.title).toContain("阶段 1");
    });
  });
});