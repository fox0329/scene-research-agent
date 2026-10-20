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
  Scenario,
  Product,
  SpecParam,
  Capability,
  Boundary,
  Limitation,
  OptionalMaterial,
  Conversation,
  Message,
  StageData,
  StageSummaryRow,
  QualityGate,
} from "@scene/contract";
import type {
  DbInstance,
  Repo,
  StageDataRepo,
  StageSummaryRepo,
  ScenarioStepRepo,
  QualityGateRepo,
  MessageRepo,
} from "@scene/infra";

import {
  createAdvanceStageCommand,
  readyTables,
  repairTruncatedJson,
  resolveSourceType,
} from "./advance-stage.js";
import { extractRowsBestEffort } from "./json-extract.js";
import type { AdvanceStageDeps } from "./advance-stage.js";

// ─── Mock 工厂 ─────────────────────────────────────────────

/** 创建可配置的 mock DshClient */
function createMockDshClient(outputText: string): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "mock-session-stage" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      yield { type: "text", text: outputText };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** 从输出契约里取本次调用允许的表号（按表并发后每次调用只问一张表） */
function allowedTablesOf(outputContract: Record<string, unknown>): string[] {
  const props = outputContract as {
    properties?: { rows?: { items?: { properties?: { table_code?: { enum?: string[] } } } } };
  };
  return props.properties?.rows?.items?.properties?.table_code?.enum ?? [];
}

/**
 * 表感知的 mock DshClient：按本次调用允许的表号，只回该表的行
 *
 * 按表并发生成（v1.22）后，一次分析会发多次"只问一张表"的调用。这个 mock 让既有样本
 * 仍然可用：每个调用只收到属于它自己那张表的行，等价于模型按表分别作答。
 */
function createTableAwareDshClient(output: { rows: Array<Record<string, unknown>> }): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "mock-session-stage" })),
    prompt: vi.fn(async function* (
      _h: unknown,
      input: { outputContract: Record<string, unknown> },
    ): AsyncGenerator<FollowEvent> {
      const allowed = allowedTablesOf(input.outputContract);
      const rows = output.rows.filter((r) => allowed.includes(String(r["table_code"])));
      yield { type: "text", text: JSON.stringify({ rows }) };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** mock 行的公共字段（对齐 @scene/infra BaseRow，该类型未导出故本地声明） */
type MockBaseRow = { id: string; created_at: string; updated_at: string };

/** 创建 mock 通用 Repo（内存存储） */
function createMockRepo<T extends MockBaseRow>(): Repo<T> {
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
    markStale: vi.fn((scenarioId: string, stages: number[], isStale: boolean) => {
      let changes = 0;
      store.forEach((r, i) => {
        if (r.scenario_id === scenarioId && stages.includes(r.stage)) {
          store[i] = { ...r, is_stale: isStale };
          changes++;
        }
      });
      return changes;
    }),
    deleteByScenarioStage: vi.fn((scenarioId: string, stage: number) => {
      const before = store.length;
      const kept = store.filter(
        (r) => !(r.scenario_id === scenarioId && r.stage === stage),
      );
      store.length = 0;
      store.push(...kept);
      return before - store.length;
    }),
    deleteByScenarioStageTable: vi.fn((scenarioId: string, stage: number, tableCode: string) => {
      const before = store.length;
      const kept = store.filter(
        (r) =>
          !(r.scenario_id === scenarioId && r.stage === stage && r.table_code === tableCode),
      );
      store.length = 0;
      store.push(...kept);
      return before - store.length;
    }),
    getById: vi.fn((id: string) => store.find((r) => r.id === id)),
    update: vi.fn((id: string, patch: { row?: Record<string, unknown>; source_type?: string }) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx < 0) return undefined;
      store[idx] = { ...store[idx]!, ...patch } as StageData;
      return store[idx];
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
    deleteByScenarioStage: vi.fn((scenarioId: string, stage: number) => {
      const before = store.length;
      const kept = store.filter(
        (r) => !(r.scenario_id === scenarioId && r.stage === stage),
      );
      store.length = 0;
      store.push(...kept);
      return before - store.length;
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
    optionalMaterialRepo: createMockRepo<OptionalMaterial>(),
    conversationRepo,
    messageRepo: createMockMessageRepo(),
    scenarioRepo,
    scenarioBriefRepo: {
      get: vi.fn(() => undefined),
      upsert: vi.fn(),
      remove: vi.fn(() => false),
    },
    stageSummaryRepo: createMockStageSummaryRepo(),
    scenarioStepRepo: createMockScenarioStepRepo(),
    stageDataRepo: createMockStageDataRepo(),
    qualityGateRepo: createMockQualityGateRepo(),
    scenarioLinkedLineRepo: { list: () => [], insert: vi.fn(), getById: vi.fn(), update: vi.fn(), deleteById: vi.fn() },
    scenarioMaterialRepo: createMockRepo(),
  };
}

/** 阶段总结仓储 mock（内存实现） */
function createMockStageSummaryRepo(): StageSummaryRepo {
  const store = new Map<string, StageSummaryRow>();
  const key = (s: string, st: number): string => `${s}#${st}`;
  return {
    get: vi.fn((scenarioId: string, stage: number) => store.get(key(scenarioId, stage))),
    upsert: vi.fn((scenarioId: string, stage: number, content: string) => {
      const row: StageSummaryRow = {
        scenario_id: scenarioId,
        stage: stage as StageSummaryRow["stage"],
        content,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.set(key(scenarioId, stage), row);
      return row;
    }),
    listByScenario: vi.fn((scenarioId: string) =>
      [...store.values()].filter((r) => r.scenario_id === scenarioId),
    ),
    remove: vi.fn((scenarioId: string, stage: number) => store.delete(key(scenarioId, stage))),
  };
}

/** 场景流程步仓储 mock（内存实现） */
function createMockScenarioStepRepo(): ScenarioStepRepo {
  const done = new Map<string, Set<number>>();
  const get = (id: string): Set<number> => {
    const set = done.get(id) ?? new Set<number>();
    done.set(id, set);
    return set;
  };
  return {
    completedSteps: vi.fn((id: string) => [...get(id)].sort((a, b) => a - b)),
    complete: vi.fn((id: string, step: number) => {
      get(id).add(step);
    }),
    clearFrom: vi.fn((id: string, step: number) => {
      const before = get(id).size;
      for (const s of [...get(id)]) if (s >= step) get(id).delete(s);
      return before - get(id).size;
    }),
    deleteByScenario: vi.fn((id: string) => {
      const n = get(id).size;
      done.delete(id);
      return n;
    }),
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

/**
 * 阶段 1（认识场景）的样例输出
 *
 * 表集 = 表1-1（场景锚，由「场景诉求 → 起草 → 用户确认」写入，**不在本阶段模型产出里**）、
 * 表1-3、表2-2、表2-3、表2-4、表2-5。**客户现状（表1-2 场景环节地图）
 * 已迁到阶段 3**（用户定调 2026-10-14：阶段 1/2 只梳理场景与行业本身），所以这里没有它们的行。
 */
function makeStage1DshOutput() {
  return {
    rows: [
      {
        table_code: "表1-3",
        fields: {
          barrier_type: "技术",
          barrier_name: "AI 识别准确率",
          criteria: "≥ 95%",
          judgment: "过得了",
        },
        source: "白皮书.pdf:12",
      },
      {
        table_code: "表1-3",
        fields: {
          barrier_type: "行业准入",
          barrier_name: "安防工程资质",
          criteria: "需安防资质二级",
          judgment: "绕道",
        },
        source: "资质目录.pdf:2",
      },
      {
        table_code: "表2-2",
        fields: {
          element_name: "网络摄像机",
          element_type: "感知设备",
          function: "视频采集",
        },
        source: "选型手册.pdf:8",
      },
      {
        table_code: "表2-3",
        fields: {
          layer: "感知层",
          components: "摄像机、门禁、周界",
          interface: "ONVIF/RTSP",
        },
        source: "架构设计.pptx:3",
      },
    ],
  };
}

function makeStage2DshOutput() {
  return {
    rows: [
      {
        table_code: "表3-1",
        fields: { link: "视频监控", gross_margin: "35%", representative: "海康/大华" },
        source: "行业报告.pdf:4",
      },
      {
        table_code: "表3-2",
        fields: {
          form: "一体化平台",
          key_points: "软硬一体、统一运维",
          leader: "海康",
          position: "主导",
          our_entry: "从边缘分析切入",
        },
        source: "行业报告.pdf:9",
      },
      {
        table_code: "表3-4",
        fields: {
          dimension: "算法准确率",
          our: "95%",
          competitor_a: "96%",
          competitor_b: "93%",
          competitor_c: "90%",
        },
        source: "测评报告.pdf:3",
      },
    ],
  };
}

/**
 * 阶段 3（能力匹配）的样例输出
 *
 * 表集 = 表1-2（客户现状底数）+ 表4-1..表4-5（我方能力）。
 * 表2-7 交付与运维现状已删除（变更表 #226）。
 * 现状类表（表1-2）在这里是**有客户事实**的正常产出——缺材料那条路径由
 * 「现状类表缺客户材料」用例专门覆盖（整表都是「未提供」时才不落库）。
 */
function makeStage3DshOutput() {
  return {
    rows: [
      {
        table_code: "表1-2",
        fields: {
          link: "视频监控",
          owner_now: "园区安保班组人工值守",
          current_tool: "模拟摄像头 + 本地录像机",
          current_flow: "每班 2 人轮巡，异常靠电话上报",
          pain: "夜间漏报多、录像回查慢",
          description: "园区摄像头接入与智能分析",
          responsibility: "安保部",
          reason: "客户现状访谈记录",
        },
        source: "需求文档.pdf:5",
      },
      {
        table_code: "表4-1",
        fields: {
          ability: "边缘 AI 推理",
          maturity: "已交付",
          limitation: "依赖 NPU 算力，无该硬件时只能回传云端",
          proof: "AI Box 已在 3 个项目交付",
        },
        source: "能力清单.pdf:1",
      },
      {
        table_code: "表4-2",
        fields: {
          link: "视频监控",
          can_touch: "可以碰",
          our_role: "替代",
          role_reason: "AI Box 边缘算力带 6TOPS NPU，已交付",
        },
        source: "能力清单.pdf:2",
      },
      {
        table_code: "表4-3",
        fields: {
          gap_ref: "夜间漏报",
          match: "真能解",
          our_product: "AI Box",
          ability_basis: "边缘 AI 推理",
          boundary_note: "现场需有 PoE 供电",
        },
        source: "能力清单.pdf:3",
      },
      {
        table_code: "表4-4",
        fields: {
          sub_scene: "园区夜间安防",
          value_density: "高",
          fit: "高",
          difficulty: "中",
          stock_maturity: "成熟",
          rank: "1",
        },
        source: "行业报告.pdf:4",
      },
      {
        table_code: "表4-5",
        fields: {
          dimension: "算法准确率",
          weight: "30",
          score: "4",
          basis: "已交付项目实测 95%",
        },
        source: "测评报告.pdf:5",
      },
    ],
  };
}

// ─── 测试用例 ──────────────────────────────────────────────

import { gradeSource } from "@scene/domain";

/**
 * 自检永远不返回的 mock：表格生成正常，进入"生成后自检"就悬挂
 *
 * 实机经过：行早已落库，自检那条链卡住不返回，于是整步、整条 SSE 流、
 * 用户界面一起钉死在"分析中"，用户只能按 F5 才看到早就写好的内容（故障清单 #47）。
 */
function withHangingPostcheck(inner: DshClient): DshClient {
  const base = inner.prompt as unknown as (
    session: unknown,
    req?: { system?: string },
  ) => AsyncIterable<FollowEvent>;
  return {
    ...inner,
    prompt: vi.fn((session: unknown, req?: { system?: string }) => {
      if (String(req?.system ?? "").includes("生成后自检")) {
        return (async function* (): AsyncGenerator<FollowEvent> {
          await new Promise<never>(() => {}); // 悬挂：既不产出也不结束
        })();
      }
      return base(session, req);
    }),
  } as unknown as DshClient;
}

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

    it("阶段 0 是解析入库阶段：不调用模型、不写行，只生成总结并推进", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 0 }),
      );

      const types = events.map((e) => e.type);
      expect(types[0]).toBe("progress");
      expect(types).toContain("summary");
      expect(types).toContain("done");
      expect(types).not.toContain("row");
      expect(types).not.toContain("completeness");
      // 不再有质量关/建议档位事件
      expect(types).not.toContain("gate");
      expect(types).not.toContain("advice");
      // **不调用模型**：材料入库由确定性流水线填充
      expect(dshClient.prompt).not.toHaveBeenCalled();
      expect(dshClient.createSession).not.toHaveBeenCalled();
    });

    it("应更新 scenario.current_stage 为 1", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 0 }));

      expect(db.scenarioRepo.update).toHaveBeenCalledWith("sc-1", {
        current_stage: 1,
      });
    });

    it("不登记分析会话（本阶段没有模型分析）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 0 }));
      expect(db.conversationRepo.insert).not.toHaveBeenCalled();
    });

    it("重算早期阶段不应把 current_stage 拉回（只前进不回退）", async () => {
      db = createMockDb({ scenario: { current_stage: 5 } });
      const cmd = createAdvanceStageCommand({ db, dshClient });
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 0 }));

      expect(db.scenarioRepo.update).not.toHaveBeenCalledWith(
        "sc-1",
        expect.anything(),
      );
    });

    it("老编号 8（交付物）按现行阶段 6 处理、不抛错且不改 current_stage", async () => {
      db = createMockDb({ scenario: { current_stage: 8 as never } });
      const cmd = createAdvanceStageCommand({ db, dshClient });
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 8 as never }),
      );

      expect(events.at(-1)!.type).toBe("done");
      expect(db.scenarioRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("阶段 1：门槛筛查", () => {
    beforeEach(() => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createTableAwareDshClient(makeStage1DshOutput());
      deps = { db, dshClient };
    });

    it("证据分级由领域层派生且列/JSON 一致（变更表 #167）：材料提取→B、推断→C，都不落 D", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));
      const rows = db.stageDataRepo.list();
      // 样本行带可定位出处（如「白皮书.pdf:12」）→ AI提取 → B（间接有据）
      const extracted = rows.find((r) => r.source_authority === "T3");
      expect(extracted?.evidence_level).toBe("B");
      expect(extracted?.row["evidence_level"]).toBe("B");
      expect(extracted?.row["authority"]).toBe("T3");
      // 分析行永不为 D（D 是材料入库的规则，用户定调 v1.35）
      expect(rows.some((r) => r.evidence_level === "D")).toBe(false);
      // 列与行 JSON 两处必须一致，不能"列说 B、JSON 说 C"
      for (const r of rows) {
        expect(r.row["evidence_level"]).toBe(r.evidence_level);
        expect(r.row["authority"]).toBe(r.source_authority);
      }
    });

    it("应产出 progress → row... → completeness → summary → done 事件", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const types = events.map((e) => e.type);

      // 事件顺序：progress → progress → row(s) → completeness → summary → done
      const firstProgress = types.indexOf("progress");
      const lastRow = types.lastIndexOf("row");
      const completenessIdx = types.indexOf("completeness");
      const summaryIdx = types.indexOf("summary");
      const doneIdx = types.indexOf("done");

      expect(firstProgress).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstProgress);
      expect(completenessIdx).toBeGreaterThan(lastRow);
      expect(summaryIdx).toBeGreaterThan(completenessIdx);
      expect(doneIdx).toBeGreaterThan(summaryIdx);
    });

    it("应将 DSH 输出的行写入 stageDataRepo", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      // 4 条 stage1 输出行（表1-3 两条、表2-2、表2-3 各一条；表1-2 已迁到阶段 3）
      expect(db.stageDataRepo.insert).toHaveBeenCalledTimes(4);

      // 验证第一条
      const firstCall = (db.stageDataRepo.insert as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0];
      expect(firstCall.scenario_id).toBe("sc-1");
      expect(firstCall.stage).toBe(1);
      expect(firstCall.table_code).toBe("表1-3");
      expect(firstCall.source_type).toBe("AI提取");
    });

    it("不应再写质量关（旧装置已移除），而应落库阶段总结", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      expect(db.qualityGateRepo.insert).not.toHaveBeenCalled();
      expect(db.stageSummaryRepo.upsert).toHaveBeenCalledTimes(1);
      const call = (db.stageSummaryRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe("sc-1");
      expect(call[1]).toBe(1);
      expect(String(call[2])).toContain("## 五、待补齐信息");
    });

    it("应产出 completeness 事件含缺口清单（不含判定）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const ev = events.find((e) => e.type === "completeness") as FollowEvent & {
        completeness: { expectedTables: number; tablesWithData: number; gaps: unknown[]; percent: number };
        violations: unknown[];
      };
      expect(ev).toBeDefined();
      // 阶段 1 共 6 张表（表1-1、表1-3、表2-2、表2-3、表2-4、表2-5）
      expect(ev.completeness.expectedTables).toBe(6);
      expect(Array.isArray(ev.completeness.gaps)).toBe(true);
      expect(Array.isArray(ev.violations)).toBe(true);
      // 缺口文案不得含通过/不通过等判定
      const text = JSON.stringify(ev.completeness);
      expect(text).not.toContain("建议");
      expect(text).not.toContain("不通过");
    });

    it("不应产出 advice 事件（产品不产出判断）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
      );
      expect(events.some((e) => String(e.type) === "advice")).toBe(false);
    });

    it("按流程步限定表集：本步表集外的产出行不入库（场景锚不重复产出）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      // 第 2 步（认识场景）= 阶段 1 减去场景锚；表1-2 属阶段 3，不在本步
      const step2 = ["表1-3", "表2-2", "表2-3", "表2-4", "表2-5"];
      await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1, tables: step2 }),
      );
      const codes = (db.stageDataRepo.insert as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[0] as { table_code: string }).table_code,
      );
      expect(codes.length).toBeGreaterThan(0);
      // 本步表集内的样例行照常落库
      expect(codes).toContain("表1-3");
      expect(codes).toContain("表2-2");
      // 场景锚（表1-1）属第 1 步，本步不许重复产出
      expect(codes).not.toContain("表1-1");
      // 表集外的表（表1-1 场景锚、以及已迁到阶段 3 的表1-2）一行都不许入库
      expect(codes.every((c) => step2.includes(c))).toBe(true);
    });

    it("重算阶段 1 不丢场景锚（表1-1 常驻，用户确认内容保留）", async () => {
      // 预置一条用户已确认的锚行，模拟阶段 1 之前已完成的场景认识
      db.stageDataRepo.insert({
        scenario_id: "sc-1",
        stage: 1,
        table_code: "表1-1",
        row: { item: "客户类型/行业", content: "政府/国企", source_type: "用户确认" },
        is_stale: false,
        source_type: "用户确认",
      });

      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      // 重算会 deleteByScenarioStage(stage=1)，但锚必须被快照-恢复
      const anchorRows = db.stageDataRepo.list().filter((r) => r.table_code === "表1-1");
      expect(anchorRows).toHaveLength(1);
      expect(anchorRows[0]!.row["content"]).toBe("政府/国企");
      expect(anchorRows[0]!.source_type).toBe("用户确认");
    });

    it("应更新 scenario.current_stage 为 2", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      expect(db.scenarioRepo.update).toHaveBeenCalledWith("sc-1", {
        current_stage: 2,
      });
    });

    it("不再往会话写「阶段完成」系统消息（变更表 #174）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      // 用户定调：「场景下面不需要每个阶段生成一个会话，没有意义」——分析结果有自己的
      // 落点（流程轴进度、右栏阶段总结、阶段数据表），不再借会话承载
      const stages = (db.messageRepo.insert as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as { content?: string })
        .filter((m) => String(m.content ?? "").includes("阶段 1 分析完成"));
      expect(stages).toHaveLength(0);
    });
  });

  describe("阶段 2：架构约束分析", () => {
    beforeEach(() => {
      db = createMockDb({ scenario: { current_stage: 2 } });
      dshClient = createTableAwareDshClient(makeStage2DshOutput());
      deps = { db, dshClient };
    });

    it("应产出完整事件流（含 completeness 和 summary）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 2 }),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain("progress");
      expect(types).toContain("row");
      expect(types).toContain("completeness");
      expect(types).toContain("summary");
      expect(types).toContain("done");
      expect(types).not.toContain("gate");
      expect(types).not.toContain("advice");
    });

    it("生成过程中持续发进度心跳（否则页面长跑时看着像卡死在「分析中」）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 2 }),
      );

      const beats = events.filter(
        (e) =>
          e.type === "progress" &&
          /已输出 \d+ 字/.test(String((e as { message?: string }).message ?? "")),
      );
      expect(beats.length).toBeGreaterThanOrEqual(1);
      // 心跳必须排在"开始生成"之后、写库之前
      const types = events.map((e) => String((e as { message?: string }).message ?? ""));
      expect(types.findIndex((m) => /已输出/.test(m))).toBeGreaterThan(
        types.findIndex((m) => /正在并行生成/.test(m)),
      );
    });

    it("自检卡死也必须收口：到点跳过自检、照常推进并 done（故障清单 #47）", async () => {
      process.env["POSTCHECK_DEADLINE_MS"] = "300";
      process.env["POSTCHECK_HEARTBEAT_MS"] = "100";
      try {
        db = createMockDb({ scenario: { current_stage: 2 } });
        dshClient = withHangingPostcheck(createTableAwareDshClient(makeStage2DshOutput()));
        const cmd = createAdvanceStageCommand({ db, dshClient });

        const events = await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));
        const types = events.map((e) => e.type);
        const messages = events.map((e) => String((e as { message?: string }).message ?? ""));

        // 自检之后的环节一个都不能少：完整度、总结、推进（current_stage 到 3）都要发生
        expect(types).toContain("completeness");
        expect(types).toContain("summary");
        expect(types).toContain("done");
        expect(db.scenarioRepo.update).toHaveBeenCalledWith(
          "sc-1",
          expect.objectContaining({ current_stage: 3 }),
        );
        // 且必须明说"跳过自检"，不许静默
        expect(messages.some((m) => /已跳过自检/.test(m))).toBe(true);
      } finally {
        delete process.env["POSTCHECK_DEADLINE_MS"];
        delete process.env["POSTCHECK_HEARTBEAT_MS"];
      }
    });

    it("应将 3 条行写入 stageDataRepo", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      expect(db.stageDataRepo.insert).toHaveBeenCalledTimes(3);
    });

    /**
     * 事故回归：模型输出被截断 / 不是合法 JSON 时**不许清库**
     *
     * 实机经过：第 3 步重算时模型输出到 18584 字被上限截断（finish_reason=length），
     * parseDshOutput 静默返回 `{rows:[]}`，而当时的顺序是"先删旧数据再插入"——
     * 30 行直接清零，界面还显示「完成，共写入 0 条信息」。现在必须：报错 + 原数据不动。
     */
    it("输出不是合法 JSON：报错且**不清空**本步原有数据", async () => {
      db = createMockDb({ scenario: { current_stage: 2 } });
      const truncated = '{"rows":[{"table_code":"表3-1","fields":{"link":"视频监控"';
      dshClient = createMockDshClient(truncated);
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      const last = events.at(-1)!;
      expect(last.type).toBe("error");
      expect(String((last as { message?: string }).message)).toContain("没有产出可解析");
      expect(db.stageDataRepo.deleteByScenarioStage).not.toHaveBeenCalled();
      expect(db.stageDataRepo.insert).not.toHaveBeenCalled();
    });

    it("finish_reason=length（被输出上限截断）：报错且不清库", async () => {
      db = createMockDb({ scenario: { current_stage: 2 } });
      const validJson = JSON.stringify(makeStage2DshOutput());
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "mock-truncated" })),
        prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
          yield { type: "text", text: validJson };
          yield { type: "done", finishReason: "length" };
        }),
        cancel: vi.fn(async () => {}),
      };
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      const last = events.at(-1)!;
      expect(last.type).toBe("error");
      expect(String((last as { message?: string }).message)).toContain("长度上限截断");
      expect(db.stageDataRepo.deleteByScenarioStage).not.toHaveBeenCalled();
      expect(db.stageDataRepo.insert).not.toHaveBeenCalled();
    });

    it("模型长时间不吐字：按时间补「仍在思考」心跳（前端才看得见「还在动」）", async () => {
      const prev = process.env["STAGE_KEEPALIVE_MS"];
      process.env["STAGE_KEEPALIVE_MS"] = "5";
      try {
        db = createMockDb({ scenario: { current_stage: 2 } });
        const validJson = JSON.stringify(makeStage2DshOutput());
        dshClient = {
          createSession: vi.fn(async () => ({ sessionId: "mock-slow" })),
          prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
            // 像推理型模型那样先静默 40ms（心跳间隔 5ms → 期间应有多次"仍在思考"）
            await new Promise((r) => setTimeout(r, 40));
            yield { type: "text", text: validJson };
            yield { type: "done" };
          }),
          cancel: vi.fn(async () => {}),
        };
        deps = { db, dshClient };

        const cmd = createAdvanceStageCommand(deps);
        const events = await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

        const beats = events.filter(
          (e) => e.type === "progress" && String((e as { message?: string }).message).includes("仍在思考"),
        );
        expect(beats.length).toBeGreaterThan(0);
        // 心跳**不能吞掉真实事件**：模型吐的字必须照常进到文本心跳与落库
        // （曾经的实现每次心跳都重新 iterator.next()，把挂着的那次读取结果丢了，
        //   最后解析不出行、整步分析反而失败）
        expect(events.some((e) => String((e as { message?: string }).message).includes("已输出"))).toBe(true);
        expect(events.at(-1)!.type).toBe("done");
        expect(db.stageDataRepo.insert).toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env["STAGE_KEEPALIVE_MS"];
        else process.env["STAGE_KEEPALIVE_MS"] = prev;
      }
    });

    it("阶段 2 也应落库阶段总结（不再写质量关）", async () => {
      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 2 }));

      expect(db.qualityGateRepo.insert).not.toHaveBeenCalled();
      expect(db.stageSummaryRepo.upsert).toHaveBeenCalledTimes(1);
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
      // 用一个「模型分析」阶段（阶段 0 是解析入库，不调用模型）
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "err-session" })),
        prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
          yield { type: "error", message: "模型超时" };
        }),
        cancel: vi.fn(async () => {}),
      };
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      const events = await collectEvents(
        cmd.execute({ scenarioId: "sc-1", stage: 1 }),
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
      dshClient = createTableAwareDshClient(makeStage1DshOutput());
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

  describe("阶段分析不再登记会话（变更表 #174）", () => {
    it("跑完不建 conversation，但 DSH session 照建（模型调用要用）", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createTableAwareDshClient(makeStage1DshOutput());
      deps = { db, dshClient };

      const cmd = createAdvanceStageCommand(deps);
      await collectEvents(cmd.execute({ scenarioId: "sc-1", stage: 1 }));

      expect(db.conversationRepo.insert).not.toHaveBeenCalled();
      expect(dshClient.createSession).toHaveBeenCalled();
    });
  
  describe("按表并发生成（v1.22）", () => {
    /** 记录同时在跑的调用数，用于证明"确实并发"而不是排队 */
    function createConcurrencyProbe(output: { rows: Array<Record<string, unknown>> }): {
      client: DshClient;
      peak: () => number;
      calls: () => number;
      promptOf: (code: string) => string | undefined;
    } {
      let inFlight = 0;
      let peak = 0;
      let calls = 0;
      const prompted: Array<{ code: string; user: string }> = [];
      const client: DshClient = {
        createSession: vi.fn(async () => ({ sessionId: "mock-concurrent" })),
        prompt: vi.fn(async function* (
          _h: unknown,
          input: { user: string; outputContract: Record<string, unknown> },
        ): AsyncGenerator<FollowEvent> {
          inFlight++;
          peak = Math.max(peak, inFlight);
          calls++;
          prompted.push({ code: allowedTablesOf(input.outputContract)[0] ?? "", user: input.user });
          // 每个调用都等一小会儿：不并发的话峰值只能是 1
          await new Promise((r) => setTimeout(r, 15));
          const allowed = allowedTablesOf(input.outputContract);
          const rows = output.rows.filter((r) => allowed.includes(String(r["table_code"])));
          inFlight--;
          yield { type: "text", text: JSON.stringify({ rows }) };
          yield { type: "done" };
        }),
        cancel: vi.fn(async () => {}),
      };
      const promptOf = (code: string): string | undefined =>
        prompted.find((x) => x.code === code)?.user;
      return { client, peak: () => peak, calls: () => calls, promptOf };
    }

    it("同一批的多张表同时在跑（不是一张一张排队）", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      const probe = createConcurrencyProbe(makeStage1DshOutput());
      deps = { db, dshClient: probe.client };

      await collectEvents(createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }));

      // 阶段 1 共 6 张表：无依赖的那些一起跑（默认上限 5）
      expect(probe.calls()).toBeGreaterThanOrEqual(5);
      expect(probe.peak()).toBeGreaterThanOrEqual(2);
    });

    it("就绪队列：前置一完成就放行下游，不等整轮", () => {
      const codes = ["表1-2", "表2-2", "表2-3", "表2-4"];
      const depsOf = (c: string): readonly string[] =>
        c === "表2-3" || c === "表2-4" ? ["表2-2"] : [];
      // 表2-2 还在跑（已开始、未完成）时下游不许起跑——只判"开始"会让下游拿到空依赖
      expect(
        readyTables({
          codes,
          depsOf,
          started: new Set(["表1-2", "表2-2"]),
          finished: new Set(["表1-2"]),
          limit: 5,
        }),
      ).toEqual([]);
      // 表2-2 完成后，下游立刻放行（不等整轮）
      expect(
        readyTables({
          codes,
          depsOf,
          started: new Set(["表1-2", "表2-2"]),
          finished: new Set(["表1-2", "表2-2"]),
          limit: 5,
        }),
      ).toEqual(["表2-3", "表2-4"]);
      // 表2-2 还没起跑时，先起它
      expect(
        readyTables({
          codes,
          depsOf,
          started: new Set(["表1-2"]),
          finished: new Set(["表1-2"]),
          limit: 5,
        }),
      ).toEqual(["表2-2"]);
      // 环/死锁兜底：两个表互相依赖时谁都不许起跑 → 直接放行，不让分析卡死
      const cyclic = (c: string): readonly string[] => (c === "表1-2" ? ["表1-3"] : ["表1-2"]);
      expect(
        readyTables({
          codes: ["表1-2", "表1-3"],
          depsOf: cyclic,
          started: new Set(),
          finished: new Set(),
          limit: 5,
        }),
      ).toEqual(["表1-2", "表1-3"]);
    });

    it("依赖表跑在它依赖的表之后，并拿到刚生成的行（口径一致）", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      const probe = createConcurrencyProbe(makeStage1DshOutput());
      deps = { db, dshClient: probe.client };

      await collectEvents(createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }));

      // 表2-4（要素间关系）依赖表2-2（要素清单）：它的 prompt 里必须出现表2-2 刚产出的要素名
      const relationPrompt = probe.promptOf("表2-4");
      expect(relationPrompt).toBeDefined();
      const upstreamSection = relationPrompt!.split("## 上游数据")[1] ?? "";
      expect(upstreamSection).toContain("网络摄像机");
      // 表2-2 先跑，它的 prompt 里不该有下游表的内容
      expect(probe.promptOf("表2-2")).toBeDefined();
    });

    it("最后才起始的依赖表也必须落库（不准「全部开始了」就收工）", async () => {
      // 事故回归：调度循环原来以"全部开始"为退出条件，表2-3/表2-4 刚起始就被丢下——
      // 整步报 done、用户却少了两张表的数据（实机：本次只落了 5 张表 60 行）。
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "mock-slow-tail" })),
        prompt: vi.fn(async function* (
          _h: unknown,
          input: { outputContract: Record<string, unknown> },
        ): AsyncGenerator<FollowEvent> {
          const code = allowedTablesOf(input.outputContract)[0] ?? "";
          // 依赖表故意慢：不修的话它们一定还在跑
          await new Promise((r) => setTimeout(r, code === "表2-3" || code === "表2-4" ? 60 : 10));
          const rows = makeStage1DshOutput().rows.filter((r) => r["table_code"] === code);
          yield { type: "text", text: JSON.stringify({ rows }) };
          yield { type: "done" };
        }),
        cancel: vi.fn(async () => {}),
      };
      deps = { db, dshClient };

      const events = await collectEvents(
        createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const rows = events.filter((e) => e.type === "row").map((e) => String(e.tableCode));
      expect(rows).toContain("表2-3"); // 样本里 表2-3 有一行：它必须落库
      expect(db.stageDataRepo.insert).toHaveBeenCalledTimes(4);
      expect(events.at(-1)!.type).toBe("done");
    });

    it("一张表解析不出行时自动重试一次：重试成功就照常落库，不再丢掉这 5 分钟", async () => {
      // 实跑：表3-5 只吐 81 字、表3-6 吐 4.5k 字却解析不出行 → 用户得整步重跑（5 分钟）
      const sample = makeStage1DshOutput();
      let calls = 0;
      const attemptFailures = new Set<string>();
      dshClient = {
        createSession: vi.fn(async () => ({ sessionId: "mock-session-stage" })),
        prompt: vi.fn(async function* (
          _h: unknown,
          input: { outputContract: Record<string, unknown> },
        ): AsyncGenerator<FollowEvent> {
          const allowed = allowedTablesOf(input.outputContract);
          const code = String(allowed[0] ?? "");
          calls += 1;
          // 第一次问 表2-2：回一句废话（解析不出行）；第二次问才回该表的行
          if (code === "表2-2" && !attemptFailures.has(code)) {
            attemptFailures.add(code);
            yield { type: "text", text: "抱歉，这一张我暂时给不出结构化结果。" };
            yield { type: "done" };
            return;
          }
          const rows = sample.rows.filter((r) => allowed.includes(String(r["table_code"])));
          yield { type: "text", text: JSON.stringify({ rows }) };
          yield { type: "done" };
        }),
        cancel: vi.fn(async () => {}),
      } as unknown as DshClient;
      deps = { db, dshClient };

      const events = await collectEvents(
        createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const done = events.find((e) => e.type === "done") as { tablesFailed?: string[] };
      // 重试成功 → 表2-2 不算失败（样本里本来就没覆盖的阶段 1 表不在此列）
      expect(done.tablesFailed ?? []).not.toContain("表2-2");
      const progress = events.filter((e) => e.type === "progress").map((e) => String(e.message));
      expect(progress.some((m) => m.includes("没产出可解析的行，重试一次"))).toBe(true);
      // 表2-2 被问了两次（首发 + 重试），且最终落库
      expect(attemptFailures.has("表2-2")).toBe(true);
      expect(calls).toBeGreaterThan(0);
      const written = (db.stageDataRepo.insert as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String((c[0] as { table_code?: string }).table_code),
      );
      expect(written).toContain("表2-2");
    });

    it("单张表失败不拖垮整步：其余表照常落库，失败表沿用原有内容并明确报出", async () => {
      // 样本里故意缺 表2-2 的行 → 该表这次没有产出
      const partial = makeStage1DshOutput();
      partial.rows = partial.rows.filter((r) => r["table_code"] !== "表2-2");
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createTableAwareDshClient(partial);
      deps = { db, dshClient };

      const events = await collectEvents(
        createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }),
      );

      const done = events.find((e) => e.type === "done") as { tablesFailed?: string[] };
      expect(done.tablesFailed).toContain("表2-2");
      // 失败表**不删**（原有内容保留），成功的表才逐表覆盖
      const deleted = (db.stageDataRepo.deleteByScenarioStageTable as ReturnType<typeof vi.fn>)
        .mock.calls.map((c) => String(c[2]));
      for (const code of done.tablesFailed ?? []) expect(deleted).not.toContain(code);
      // 有产出的表（表1-3）才被清旧写新；没产出的表2-2 一行不删
      expect(deleted).toContain("表1-3");
      expect(deleted).not.toContain("表2-2");
      // 命令别再整阶段删了：那会把失败表的原有内容一起清掉
      expect(db.stageDataRepo.deleteByScenarioStage).not.toHaveBeenCalled();
      expect(db.stageDataRepo.insert).toHaveBeenCalled();
      // 失败必须在进度里说出来，不能悄悄过去
      expect(
        events.some(
          (e) =>
            e.type === "progress" &&
            String((e as { message?: string }).message ?? "").includes("表2-2"),
        ),
      ).toBe(true);
    });

    it("全部表都没产出 → 报错且一行不写、旧数据一行不删", async () => {
      db = createMockDb({ scenario: { current_stage: 1 } });
      dshClient = createMockDshClient("这不是 JSON");
      deps = { db, dshClient };

      const events = await collectEvents(
        createAdvanceStageCommand(deps).execute({ scenarioId: "sc-1", stage: 1 }),
      );

      expect(events.at(-1)!.type).toBe("error");
      expect(db.stageDataRepo.insert).not.toHaveBeenCalled();
      expect(db.stageDataRepo.deleteByScenarioStageTable).not.toHaveBeenCalled();
    });
  });
});
});
// ─── 变更表 #162：来源标记与来源权威性如实化 ──────────────────

describe("resolveSourceType：未声明时按出处如实判定（变更表 #162）", () => {
  it("模型声明优先，原样采用", () => {
    expect(resolveSourceType("AI提取", null)).toBe("AI提取");
    expect(resolveSourceType("AI推断", "文件.pdf:12")).toBe("AI推断");
  });

  it("没声明但给得出「文件名:页码」→ AI提取", () => {
    expect(resolveSourceType(undefined, "开鸿医疗方案.pptx:12")).toBe("AI提取");
    expect(resolveSourceType("", "https://example.com/a")).toBe("AI推断"); // URL 不是材料文件名:页码
  });

  it("没声明且给不出出处 → AI推断（不得声称材料提取）", () => {
    expect(resolveSourceType(undefined, null)).toBe("AI推断");
    expect(resolveSourceType(undefined, "行业通例（模型知识）")).toBe("AI推断");
  });

  it("来源权威性按 G-R1 映射：AI提取→T3，AI推断→T4", () => {
    expect(gradeSource(resolveSourceType(undefined, "文件.pdf:12"))).toBe("T3");
    expect(gradeSource(resolveSourceType(undefined, null))).toBe("T4");
  });
});

/**
 * 故障清单 #65：模型已写到 17 KB 时连接被重置（`terminated`），旧实现整份判作废、
 * 这张表白跑。截断的 JSON 应当抢救出**已完整的行**（只丢最后一个不完整的对象）。
 */
describe("advance-stage — 截断输出抢救（故障清单 #65）", () => {
  it("被截断的 rows 数组：救回已完整的行，丢掉残缺的最后一对象", () => {
    const truncated =
      '{"rows":[{"table_code":"表2-3","fields":{"layer":"感知层","components":"摄像头"}},' +
      '{"table_code":"表2-3","fields":{"layer":"处理层","components":"DSP"}},' +
      '{"table_code":"表2-3","fields":{"layer":"平';
    const out = repairTruncatedJson(truncated) as { rows: unknown[] } | null;
    expect(out).not.toBeNull();
    expect(out!.rows).toHaveLength(2);
  });

  it("输出压根不是 JSON 时返回 null（不许瞎猜）", () => {
    expect(repairTruncatedJson("模型今天不想干活")).toBeNull();
  });
});

describe("json-extract — 逐行抢救（故障清单 #65）", () => {
  it("某一行语法坏掉时：其余行照样救回，坏行被跳过并计数", () => {
    const broken =
      '{"rows": [{"table_code":"表2-3","fields":{"layer":"A"}},' +
      '{"table_code":"表2-3","fields":{"layer":"B" "components":"缺逗号"}},' +
      '{"table_code":"表2-3","fields":{"layer":"C"}}]}';
    const out = extractRowsBestEffort(broken);
    expect(out).not.toBeNull();
    expect(out!.rows).toHaveLength(2);
    expect(out!.skipped).toBe(1);
  });

  it("压根没有 rows 时返回 null（真的没产出，不当格式问题处理）", () => {
    expect(extractRowsBestEffort("模型今天不想干活")).toBeNull();
  });
});

describe("现状类表缺客户材料：不生成占位，改提示需要先补材料", () => {
  let db2: DbInstance;
  let dsh2: DshClient;
  beforeEach(() => {
    /* 客户现状（表1-2）属**阶段 3（能力匹配）**：它是判断"我方能力能否满足"的基线 */
    db2 = createMockDb({ scenario: { current_stage: 3 } });
  });

  it("阶段 3：现状类表有客户事实时照常落库（表1-2 归阶段 3）", async () => {
    dsh2 = createTableAwareDshClient(makeStage3DshOutput());

    const events = await collectEvents(
      createAdvanceStageCommand({ db: db2, dshClient: dsh2 }).execute({ scenarioId: "sc-1", stage: 3 }),
    );

    const written = (db2.stageDataRepo.insert as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { table_code: string; stage: number },
    );
    expect(written.map((r) => r.table_code)).toContain("表1-2");
    expect(written.map((r) => r.table_code)).toContain("表1-2");
    // 客户现状落的是阶段 3（不再写进阶段 1）
    expect(written.every((r) => r.stage === 3)).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
    const done = events.find((e) => e.type === "done") as { tablesNeedMaterial?: string[] };
    // 有客户事实 → 不报"需要补材料"
    expect(done.tablesNeedMaterial ?? []).toEqual([]);
  });

  it("表1-2 整表都是「材料里没有」→ 不写库，done 里报 tablesNeedMaterial", async () => {
    const sample = makeStage3DshOutput();
    /* 表1-2 整表都答"材料里没有"：本次不生成占位，改为提示需要先补客户材料
     * （原用例用表2-7，该表已删除，变更表 #226） */
    const missingMaterialRows = [
      ...sample.rows.filter((r) => String(r["table_code"]) !== "表1-2"),
      {
        table_code: "表1-2",
        fields: {
          link: "会议室设备与系统运维",
          owner_now: "未提供（本客户材料未含）",
          current_flow: "未提供（本客户材料未含）",
        },
        source: "行业通例（模型知识）",
      },
    ];
    dsh2 = {
      createSession: vi.fn(async () => ({ sessionId: "mock-need-material" })),
      prompt: vi.fn(async function* (
        _h: unknown,
        input: { outputContract: Record<string, unknown> },
      ): AsyncGenerator<FollowEvent> {
        const allowed = allowedTablesOf(input.outputContract);
        const rows = missingMaterialRows.filter((r) => allowed.includes(String(r["table_code"])));
        yield { type: "text", text: JSON.stringify({ rows }) };
        yield { type: "done" };
      }),
      cancel: vi.fn(async () => {}),
    } as unknown as DshClient;

    const events = await collectEvents(
      createAdvanceStageCommand({ db: db2, dshClient: dsh2 }).execute({ scenarioId: "sc-1", stage: 3 }),
    );
    const done = events.find((e) => e.type === "done") as { tablesNeedMaterial?: string[]; tablesFailed?: string[] };
    expect(done.tablesNeedMaterial).toContain("表1-2");
    // 缺材料不是失败：不许混进 tablesFailed（否则界面会说"未生成成功、沿用原有内容"，口径不对）
    expect(done.tablesFailed ?? []).not.toContain("表1-2");
    // 表1-2 一行都不写库；同批的表4-x 照常落库（别让它们把 done 变成 error）
    const written = (db2.stageDataRepo.insert as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String((c[0] as { table_code?: string }).table_code),
    );
    expect(written).not.toContain("表1-2");
    expect(written).toContain("表4-1");
    expect(events.at(-1)!.type).toBe("done");
    const progress = events.filter((e) => e.type === "progress").map((e) => String(e.message));
    expect(progress.some((m) => m.includes("需要先补客户材料"))).toBe(true);
  });
});
