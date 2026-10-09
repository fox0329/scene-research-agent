/**
 * @scene/server — app 路由测试（T4.1 断点续做）
 *
 * 使用 mock db + mock dshClient，通过 fastify.inject 验证：
 * resume 对账路由、advance SSE 推流、Last-Event-ID 断线重放。
 */

import { describe, it, expect, vi } from "vitest";
import type {
  DshClient,
  FollowEvent,
  Scenario,
  Conversation,
  Message,
  StageData,
} from "@scene/contract";
import type {
  DbInstance,
  Repo,
  StageDataRepo,
  QualityGateRepo,
  MessageRepo,
} from "@scene/infra";
import { createApp } from "./app.js";

// ─── mock 工厂（最小集） ───────────────────────────────────

/** mock 行的公共字段（对齐 @scene/infra BaseRow，该类型未导出故本地声明） */
type MockBaseRow = { id: string; created_at: string; updated_at: string };

function createMockRepo<T extends MockBaseRow>(): Repo<T> & {
  store: T[];
} {
  const store: T[] = [];
  return {
    store,
    list: vi.fn(() => [...store]),
    getById: vi.fn((id: string) => store.find((r) => (r as { id: string }).id === id)),
    insert: vi.fn((row) => {
      const fullRow = {
        ...row,
        id: `m-${store.length}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T;
      store.push(fullRow);
      return fullRow;
    }),
    update: vi.fn((id: string, patch: Partial<T>) => {
      const idx = store.findIndex((r) => (r as { id: string }).id === id);
      if (idx < 0) return undefined;
      store[idx] = { ...store[idx]!, ...patch } as T;
      return store[idx];
    }),
    deleteById: vi.fn(() => false),
  };
}

function createMockDb() {
  const scenarioRepo = createMockRepo<Scenario>();
  const conversationRepo = createMockRepo<Conversation>();
  const stageDataStore: StageData[] = [];
  const messageStore: Message[] = [];

  const stageDataRepo: StageDataRepo = {
    list: vi.fn(() => [...stageDataStore]),
    listByScenarioStage: vi.fn((_s: string, stage: number) =>
      stageDataStore.filter((r) => r.stage === stage),
    ),
    insert: vi.fn((row) => {
      const fullRow = {
        ...row,
        id: `sd-${stageDataStore.length}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as StageData;
      stageDataStore.push(fullRow);
      return fullRow;
    }),
    markStale: vi.fn(() => 0),
    deleteByScenarioStage: vi.fn(() => 0),
    deleteByScenarioStageTable: vi.fn((_s: string, stage: number, tableCode: string) => {
      const before = stageDataStore.length;
      const kept = stageDataStore.filter(
        (r) => !(r.stage === stage && r.table_code === tableCode),
      );
      stageDataStore.length = 0;
      stageDataStore.push(...kept);
      return before - stageDataStore.length;
    }),
    getById: vi.fn(() => undefined),
    update: vi.fn(() => undefined),
  };

  const qualityGateRepo: QualityGateRepo = {
    list: vi.fn(() => []),
    insert: vi.fn((row) => ({ ...row, id: "qg-0", checked_at: "" }) as never),
    listByScenarioStage: vi.fn(() => []),
    deleteByScenarioStage: vi.fn(() => 0),
  };

  const messageRepo: MessageRepo = {
    list: vi.fn(() => [...messageStore]),
    listByConversation: vi.fn((convId: string) =>
      messageStore.filter((m) => m.conversation_id === convId),
    ),
    insert: vi.fn((row) => {
      const fullRow = { ...row, id: `msg-${messageStore.length}` } as Message;
      messageStore.push(fullRow);
      return fullRow;
    }),
    deleteById: vi.fn(() => false),
    deleteByConversation: vi.fn(() => 0),
  };

  const db = {
    db: {} as never,
    productLineRepo: createMockRepo(),
    productRepo: createMockRepo(),
    specParamRepo: createMockRepo(),
    capabilityRepo: createMockRepo(),
    boundaryRepo: createMockRepo(),
    limitationRepo: createMockRepo(),
    optionalMaterialRepo: createMockRepo(),
    conversationRepo,
    messageRepo,
    scenarioRepo,
    scenarioBriefRepo: {
      get: vi.fn(() => undefined),
      upsert: vi.fn((id: string, patch: Record<string, unknown>) => ({ ...patch, scenario_id: id })),
      remove: vi.fn(() => false),
    },
    stageSummaryRepo: {
      get: vi.fn(() => undefined),
      upsert: vi.fn((scenarioId: string, stage: number, content: string) => ({
        scenario_id: scenarioId,
        stage,
        content,
        created_at: "",
        updated_at: "",
      })),
      listByScenario: vi.fn(() => []),
      remove: vi.fn(() => false),
    },
    stageDataRepo,
    qualityGateRepo,
    scenarioLinkedLineRepo: createMockRepo(),
    scenarioMaterialRepo: createMockRepo(),
  } as unknown as DbInstance;

  return { db, scenarioRepo, conversationRepo, stageDataStore, messageStore };
}

/** mock DSH：prompt 输出一段可解析为 rows 的 JSON */
function createMockDshClient(rowsText?: string): DshClient {
  const output =
    rowsText ??
    JSON.stringify({
      rows: [
        {
          // 必须是注册表里属于该阶段的表号，否则会被本地校验拦下、不入库（无 schema 无法渲染）
          table_code: "表1-2",
          fields: {
            link: "视频监控",
            can_touch: "可以碰",
            our_role: "替代",
            description: "园区摄像头接入",
          },
          source: "手册.pdf:1",
        },
      ],
    });
  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-mock" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      yield { type: "text", text: output };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  };
}

function seedScenario(
  repo: Repo<Scenario> & { store: Scenario[] },
  overrides: Partial<Scenario> = {},
): void {
  repo.store.push({
    id: "sc-1",
    name: "测试项目",
    status: "进行中",
    current_stage: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
}

/** 解析 SSE 报文：返回 {id, data} 列表 */
function parseSse(payload: string): Array<{ id?: string; data: FollowEvent }> {
  return payload
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const idMatch = block.match(/^id: (.*)$/m);
      const dataMatch = block.match(/^data: (.*)$/m);
      return {
        id: idMatch?.[1],
        data: JSON.parse(dataMatch?.[1] ?? "{}") as FollowEvent,
      };
    });
}

// ─── health ────────────────────────────────────────────────

describe("GET /api/v1/health", () => {
  it("返回 ok", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

// ─── resume 对账路由 ───────────────────────────────────────

describe("GET /api/v1/projects/:id/resume", () => {
  it("项目不存在 → 404", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/nope/resume",
    });
    expect(res.statusCode).toBe(404);
  });

  it("全新项目 → fresh", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/sc-1/resume",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("fresh");
  });

  it("中断阶段 + 悬空会话 → rerun 并携带悬空 ID", async () => {
    const { db, scenarioRepo, conversationRepo, stageDataStore, messageStore } =
      createMockDb();
    seedScenario(scenarioRepo, { current_stage: 1 });
    const row: StageData = {
      id: "sd-0",
      scenario_id: "sc-1",
      stage: 0,
      table_code: "M1",
      row: { x: 1 },
      is_stale: false,
      source_type: "AI提取",
      source: "手册.pdf:1",
      source_authority: "T3",
      evidence_level: "B",
      created_at: "",
      updated_at: "",
    };
    stageDataStore.push(row);
    conversationRepo.store.push({
      id: "c-crash",
      scenario_id: "sc-1",
      title: "阶段 0 · 分析",
      status: "活跃",
      dsh_session_id: "dsh-crash",
      created_at: "",
      updated_at: "",
    });
    // c-crash 无消息 → 悬空；阶段 0 有行无完成消息 → 需重算
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/sc-1/resume",
    });
    const plan = res.json() as {
      action: string;
      stage: number;
      danglingConversationIds: string[];
    };
    expect(plan.action).toBe("rerun");
    expect(plan.stage).toBe(0);
    expect(plan.danglingConversationIds).toEqual(["c-crash"]);
    expect(messageStore).toHaveLength(0);
  });
});

// ─── rollback 回退路由（T4.2） ─────────────────────────────

describe("POST /api/v1/projects/:id/rollback", () => {
  it("回退成功：返回标记结果并回写 current_stage", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo, { current_stage: 3 });
    const app = createApp({ db, dshClient: createMockDshClient() });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/rollback",
      payload: { targetStage: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      toStage: number;
      markedStages: number[];
      banner: string;
    };
    expect(body.toStage).toBe(1);
    expect(body.markedStages).toEqual([2, 3]);
    expect(body.banner).toContain("待重算");
  });

  it("目标不早于当前阶段 → 400", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo, { current_stage: 1 });
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/rollback",
      payload: { targetStage: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("必须早于");
  });

  it("targetStage 非法/缺失 → 400；场景不存在 → 404", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/rollback",
      payload: {},
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/projects/nope/rollback",
      payload: { targetStage: 0 },
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ─── advance SSE + 断线重放 ───────────────────────────────

describe("POST advance / GET events（SSE 续传）", () => {
  it("阶段编号非法 → 400", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/stages/99/advance",
    });
    expect(res.statusCode).toBe(400);
  });

  it("advance 输出完整 SSE 事件流并以 done 收尾", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/stages/1/advance",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((e) => e.id !== undefined)).toBe(true);
    expect(events[0]!.data.type).toBe("progress");
    expect(events.at(-1)!.data.type).toBe("done");
    expect(events.some((e) => e.data.type === "row")).toBe(true);
    // id 严格递增
    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("重连：Last-Event-ID 之后的事件被增量重放", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/stages/1/advance",
    });
    const all = parseSse(first.payload);
    const midId = all[Math.floor(all.length / 2)]!.id!;

    const replay = await app.inject({
      method: "GET",
      url: `/api/v1/projects/sc-1/stages/1/events?lastEventId=${midId}`,
    });
    expect(replay.statusCode).toBe(200);
    const replayed = parseSse(replay.payload);
    expect(replayed.length).toBeGreaterThan(0);
    expect(Number(replayed[0]!.id)).toBeGreaterThan(Number(midId));
    expect(replayed.at(-1)!.data.type).toBe("done");
  });

  it("Last-Event-ID 走标准请求头同样生效", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });
    await app.inject({
      method: "POST",
      url: "/api/v1/projects/sc-1/stages/0/advance",
    });
    const replay = await app.inject({
      method: "GET",
      url: "/api/v1/projects/sc-1/stages/0/events",
      headers: { "last-event-id": "1" },
    });
    expect(replay.statusCode).toBe(200);
    const replayed = parseSse(replay.payload);
    expect(Number(replayed[0]!.id)).toBe(2);
  });

  it("无可续传的分析流 → 404", async () => {
    const { db, scenarioRepo } = createMockDb();
    seedScenario(scenarioRepo);
    const app = createApp({ db, dshClient: createMockDshClient() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/sc-1/stages/3/events",
    });
    expect(res.statusCode).toBe(404);
  });
});
