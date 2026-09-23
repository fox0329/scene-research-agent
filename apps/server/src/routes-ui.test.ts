/**
 * @scene/server — UI 联真路由测试（M5-T5.2，契约 v1.4）
 *
 * 真实 SQLite（:memory:）+ mock dshClient + mock DSH 配置读取，
 * 通过 fastify.inject 验证：项目 CRUD、阶段面板与单元格编辑、
 * 会话 CRUD + 消息 SSE、资料库 12 表 + F3 失效、知识库、系统设置、
 * 交付物导出与静态托管回退。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent, StageId } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { writeDefaultModel } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";

// ─── infra 配置面 mock（不读真实 .dsh、不探测真实 DSH 端口） ───

vi.mock("@scene/infra", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@scene/infra")>();
  return {
    ...orig,
    getDshPort: () => 59991, // 必然无监听的端口 → system/status 走 error 分支
    listProvidersSummary: () => [
      {
        name: "p-test",
        display_name: "测试供应商",
        api_key_env: "TEST_API_KEY_NOT_SET",
        api_key_set: false,
        models: [{ id: "m-a", name: "M-A" }],
      },
    ],
    getDefaultModelConfig: () => ({ provider: "p-test", model: "m-a" }),
    getProviderConfig: (name: string) => {
      if (name !== "p-test") throw new Error(`供应商 ${name} 未配置`);
      return {
        apiKeyEnv: "TEST_API_KEY_NOT_SET",
        api: "openai-completions" as const,
        models: [{ id: "m-a", name: "M-A" }],
      };
    },
    writeDefaultModel: vi.fn(),
  };
});

// ─── 工厂 ──────────────────────────────────────────────────

function mockDshClient(events: FollowEvent[] = [
  { type: "text", text: "你好" },
  { type: "text", text: "，世界" },
  { type: "done" },
]): DshClient {
  return {
    createSession: vi.fn(async ({ title }: { title: string }) => ({
      sessionId: `dsh-${title}`,
    })),
    prompt: vi.fn(() => (async function* () {
      for (const e of events) yield e;
    })()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: DbInstance;
  dsh: DshClient;
  exportDir: string;
}

function makeHarness(promptEvents?: FollowEvent[]): Harness {
  const db = createDb(":memory:");
  const dsh = mockDshClient(promptEvents);
  const exportDir = mkdtempSync(join(tmpdir(), "scene-export-"));
  process.env.EXPORT_DIR = exportDir;
  const app = createApp({ db, dshClient: dsh, hub: createSseHub() });
  return { app, db, dsh, exportDir };
}

/** 建一条产品线 + 一个场景，返回 id */
function seedScenario(db: DbInstance, name = "测试项目"): {
  productLineId: string;
  scenarioId: string;
} {
  const line = db.productLineRepo.insert({ name: "默认产品线" });
  const scenario = db.scenarioRepo.insert({
    name,
    product_line_id: line.id,
    status: "进行中",
    current_stage: 0,
  });
  return { productLineId: line.id, scenarioId: scenario.id };
}

// ─── 项目路由 ──────────────────────────────────────────────

describe("项目路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("GET /projects 初始为空数组", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("POST /projects 空名 → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("不能为空");
  });

  it("POST /projects 无产品线时自动建默认产品线", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "新场景" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("新场景");
    expect(body.status).toBe("进行中");
    expect(body.product_line_id).toBeTruthy();
    expect(h.db.productLineRepo.getById(body.product_line_id)).toBeDefined();
  });

  it("POST /projects 未知产品线 → 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "x", product_line_id: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /projects 带 stale_count", async () => {
    const { scenarioId } = seedScenario(h.db);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 4 as StageId,
      table_code: "表4-1",
      row: { a: 1 },
      is_stale: true,
    });
    const res = await h.app.inject({ method: "GET", url: "/api/v1/projects" });
    const list = res.json();
    expect(list[0].stale_count).toBe(1);
  });

  it("PATCH /projects 状态非法 → 400；合法更新生效", async () => {
    const { scenarioId } = seedScenario(h.db);
    const bad = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenarioId}`,
      payload: { status: "暂停" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenarioId}`,
      payload: { status: "已完成", name: "改名" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("已完成");
    expect(ok.json().name).toBe("改名");
  });

  it("DELETE /projects 级联删除会话/消息/阶段数据", async () => {
    const { scenarioId } = seedScenario(h.db);
    const conv = h.db.conversationRepo.insert({
      scenario_id: scenarioId,
      title: "t",
      status: "活跃",
      dsh_session_id: "dsh-t",
    });
    h.db.messageRepo.insert({ conversation_id: conv.id, role: "用户", content: "hi" });
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 0 as StageId,
      table_code: "M1",
      row: {},
      is_stale: false,
    });

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${scenarioId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.scenarioRepo.getById(scenarioId)).toBeUndefined();
    expect(h.db.messageRepo.listByConversation(conv.id)).toHaveLength(0);
    expect(h.db.stageDataRepo.listByScenarioStage(scenarioId, 0 as StageId)).toHaveLength(0);
  });

  it("GET /projects/:id/stale 返回受影响阶段与横幅文案", async () => {
    const { scenarioId } = seedScenario(h.db);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 5 as StageId,
      table_code: "表5-1",
      row: {},
      is_stale: true,
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stale`,
    });
    const body = res.json();
    expect(body.stages).toEqual([5]);
    expect(body.banner).toContain("待重算");
  });

  it("POST decide：非法动作 400，继续推进 current_stage", async () => {
    const { scenarioId } = seedScenario(h.db);
    const bad = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/stages/0/decide`,
      payload: { action: "跳过" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/stages/0/decide`,
      payload: { action: "继续" },
    });
    expect(ok.json().current_stage).toBe(1);
  });

  it("GET 阶段面板：行 + 质量关 + 领域层建议", async () => {
    const { scenarioId } = seedScenario(h.db);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1 as StageId,
      table_code: "表1-1",
      row: { k: "v" },
      is_stale: false,
      source_type: "AI提取",
    });
    h.db.qualityGateRepo.insert({
      scenario_id: scenarioId,
      stage: 1 as StageId,
      item_no: "G1-1",
      title: "来源抽查",
      result: "不通过",
      detail: "缺来源",
      evidence_refs: {},
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1`,
    });
    const body = res.json();
    expect(body.rows[0].row).toEqual({ k: "v" });
    expect(body.gates).toHaveLength(1);
    expect(body.advice).toBe("建议不通过");
  });

  it("GET 阶段面板：阶段非法 400 / 场景不存在 404", async () => {
    const { scenarioId } = seedScenario(h.db);
    const bad = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/99`,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await h.app.inject({
      method: "GET",
      url: "/api/v1/projects/nope/stages/1",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH stage-data 单元格：合并 row 并转「用户确认」", async () => {
    const { scenarioId } = seedScenario(h.db);
    const row = h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1 as StageId,
      table_code: "表1-2",
      row: { a: 1, b: 2 },
      is_stale: false,
      source_type: "AI推断",
    });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenarioId}/stage-data/${row.id}`,
      payload: { cell: "b", value: 99 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().row).toEqual({ a: 1, b: 99 });
    expect(res.json().source_type).toBe("用户确认");
  });

  it("PATCH stage-data 缺参 400 / 行不属于场景 404", async () => {
    const { scenarioId } = seedScenario(h.db);
    const noCell = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenarioId}/stage-data/x`,
      payload: {},
    });
    expect(noCell.statusCode).toBe(400);
    const wrong = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenarioId}/stage-data/nope`,
      payload: { cell: "a", value: 1 },
    });
    expect(wrong.statusCode).toBe(404);
  });
});

// ─── 会话路由 ──────────────────────────────────────────────

describe("会话路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("创建会话写入 dsh_session_id，list 只含活跃会话", async () => {
    const { scenarioId } = seedScenario(h.db);
    const created = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/conversations`,
      payload: { title: "进门咨询" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().dsh_session_id).toBe("dsh-进门咨询");

    const list = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/conversations`,
    });
    expect(list.json()).toHaveLength(1);
  });

  it("标题超长 → 400（校验失败）", async () => {
    const { scenarioId } = seedScenario(h.db);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/conversations`,
      payload: { title: "长".repeat(60) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("校验失败");
  });

  it("重命名与归档", async () => {
    const { scenarioId } = seedScenario(h.db);
    const conv = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/conversations`,
      payload: { title: "旧名" },
    });
    const id = conv.json().id as string;
    const renamed = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${id}`,
      payload: { title: "新名" },
    });
    expect(renamed.json().title).toBe("新名");
    const archived = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${id}`,
      payload: { archive: true },
    });
    expect(archived.json().status).toBe("已归档");
  });

  it("删除有消息的会话需 force", async () => {
    const { scenarioId } = seedScenario(h.db);
    const conv = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/conversations`,
      payload: { title: "t" },
    });
    const id = conv.json().id as string;
    h.db.messageRepo.insert({ conversation_id: id, role: "用户", content: "hi" });

    const blocked = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${id}`,
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toContain("force");

    const forced = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${id}?force=true`,
    });
    expect(forced.json().deleted).toBe(true);
    expect(h.db.conversationRepo.getById(id)).toBeUndefined();
  });

  it("POST 消息 → SSE 流式回复并持久化双方消息", async () => {
    const { scenarioId } = seedScenario(h.db);
    const conv = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/conversations`,
      payload: { title: "t" },
    });
    const id = conv.json().id as string;

    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/messages`,
      payload: { content: "在吗" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload).toContain('"type":"text"');
    expect(res.payload).toContain("你好");

    const messages = await h.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${id}/messages`,
    });
    const list = messages.json();
    expect(list.map((m: { role: string }) => m.role)).toEqual(["用户", "系统"]);
    expect(list[1].content).toBe("你好，世界");
  });

  it("空消息 → 400；未知会话 → 404", async () => {
    const empty = await h.app.inject({
      method: "POST",
      url: "/api/v1/conversations/x/messages",
      payload: { content: " " },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await h.app.inject({
      method: "POST",
      url: "/api/v1/conversations/nope/messages",
      payload: { content: "hi" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ─── 资料库路由 ────────────────────────────────────────────

describe("资料库路由", () => {
  let h: Harness;
  let plId: string;
  beforeEach(() => {
    h = makeHarness();
    plId = h.db.productLineRepo.insert({ name: "产品线A" }).id;
  });

  function seedProduct() {
    return h.db.productRepo.insert({
      product_line_id: plId,
      model: "X1",
      name: "型号一",
      status: "在售",
      launch_date: "2026-01-01",
      position_desc: "旗舰",
    });
  }

  it("GET product-lines 带 12 表行数统计", async () => {
    seedProduct();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/library/product-lines",
    });
    const lines = res.json();
    expect(lines[0].row_counts.M1).toBe(1);
    expect(lines[0].row_counts.O1).toBe(0);
  });

  it("POST product-lines 空名 400，合法创建", async () => {
    const bad = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/product-lines",
      payload: { name: "" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/product-lines",
      payload: { name: "产品线B" },
    });
    expect(ok.json().name).toBe("产品线B");
  });

  it("GET tables/M2 按产品线过滤走 product_id 子查询（不报 SQL 错）", async () => {
    const p = seedProduct();
    h.db.specParamRepo.insert({
      product_id: p.id,
      param_class: "性能",
      param_name: "算力",
      value: "10T",
      measured: "宣称",
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/tables/M2?product_line_id=${plId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("GET tables 表编号非法 → 400", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/library/tables/XX" });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH 资料行未知列名 → 400（不进 500）", async () => {
    const p = seedProduct();
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/library/rows/M1/${p.id}`,
      payload: { cell: "不存在的列; DROP", value: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH 资料行合法列 → 更新 + F3 标待重算", async () => {
    const p = seedProduct();
    // 场景与资料行同产品线，才能按产品线归属联动标脏
    const scenario = h.db.scenarioRepo.insert({
      name: "联动场景",
      product_line_id: plId,
      status: "进行中",
      current_stage: 0,
    });
    h.db.stageDataRepo.insert({
      scenario_id: scenario.id,
      stage: 4 as StageId, // M1 → 阶段 4/5（TABLE_DEPENDENCIES）
      table_code: "表4-1",
      row: {},
      is_stale: false,
    });
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/library/rows/M1/${p.id}`,
      payload: { cell: "status", value: "停售" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("停售");
    const stageRow = h.db.stageDataRepo.listByScenarioStage(scenario.id, 4 as StageId)[0]!;
    expect(stageRow.is_stale).toBe(true);
  });

  it("POST rows/O1 → 值整体入 payload；O 表按 category 隔离", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/O1",
      payload: {
        product_line_id: plId,
        values: { cert_name: "ISO9001", cert_body: "SGS" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toBe("O1认证");
    const o1 = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/tables/O1?product_line_id=${plId}`,
    });
    expect(o1.json()).toHaveLength(1);
    // payload JSON 往返：读出为对象而非字符串
    expect(o1.json()[0].payload.cert_name).toBe("ISO9001");
    const o2 = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/tables/O2?product_line_id=${plId}`,
    });
    expect(o2.json()).toHaveLength(0);
  });

  it("POST rows/M1 未知产品线 → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M1",
      payload: { product_line_id: "nope", values: { model: "Y" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE rows：成功删除、未知行 404", async () => {
    const p = seedProduct();
    const ok = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/rows/M1/${p.id}`,
    });
    expect(ok.json().deleted).toBe(true);
    const missing = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/rows/M1/${p.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET quality-summary：无产品线 404，有数据返回两口径", async () => {
    const missing = await h.app.inject({
      method: "GET",
      url: "/api/v1/library/quality-summary",
    });
    expect(missing.statusCode).toBe(404);

    seedProduct();
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/quality-summary?product_line_id=${plId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quality).toBeDefined();
    expect(body.completeness).toBeDefined();
  });
});

// ─── 上传入库（HTTP 面） ───────────────────────────────────

describe("上传入库路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("非 multipart 请求 → 400（不 500）", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/ingest",
      payload: { foo: "bar" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("multipart");
  });

  it("multipart 缺产品线 → 404", async () => {
    const boundary = "----sceneTestBoundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="product_line_id"',
      "",
      "nope",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="t.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/ingest",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.statusCode).toBe(404);
  });

  it("未知入库任务的 events → 404", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/library/ingest/nope/events",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 交付物导出 ────────────────────────────────────────────

describe("交付物导出", () => {
  it("POST export 写出内部/外部两份 md", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "导出场景");
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/deliverables/export`,
    });
    expect(res.statusCode).toBe(200);
    const { internal_path: internal, external_path: external } = res.json();
    expect(existsSync(internal)).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect(readFileSync(internal, "utf-8")).toContain("导出场景");
  });

  it("场景不存在 → 404", async () => {
    const h = makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects/nope/deliverables/export",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 系统路由 ──────────────────────────────────────────────

describe("系统路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("GET system/status：DSH 不可达走 error、DB ok（不依赖真实 DSH）", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/system/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dsh: "error", dsh_port: 59991, db: "ok" });
  });

  it("GET settings：供应商摘要不泄露密钥", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/system/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers[0].name).toBe("p-test");
    expect(body.providers[0].api_key_set).toBe(false);
    expect(body.default_model).toEqual({ provider: "p-test", model: "m-a" });
    expect(JSON.stringify(body)).not.toContain("TEST_API_KEY_NOT_SET=");
  });

  it("PUT settings：合法供应商+模型写回；模型不属于供应商 → 400", async () => {
    const ok = await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/settings",
      payload: { provider: "p-test", model: "m-a" },
    });
    expect(ok.statusCode).toBe(200);
    expect(vi.mocked(writeDefaultModel)).toHaveBeenCalled();

    const badModel = await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/settings",
      payload: { provider: "p-test", model: "m-zzz" },
    });
    expect(badModel.statusCode).toBe(400);

    const missing = await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/settings",
      payload: { provider: "p-test" },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("GET knowledge：返回数组且支持类别过滤", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/knowledge?category=竞品",
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

// ─── 静态托管与错误面 ──────────────────────────────────────

describe("静态托管", () => {
  it("webDist 存在时托管 index.html，SPA 路由回退，API 404 仍走 JSON", async () => {
    const dist = mkdtempSync(join(tmpdir(), "scene-web-"));
    writeFileSync(join(dist, "index.html"), "<html><body>SCENE_UI</body></html>");
    const app = createApp({
      db: createDb(":memory:"),
      dshClient: mockDshClient(),
      hub: createSseHub(),
      webDist: dist,
    });

    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.payload).toContain("SCENE_UI");

    const spa = await app.inject({ method: "GET", url: "/some/front/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.payload).toContain("SCENE_UI");

    const api = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toContain("端点不存在");
  });

  it("未设置 webDist 时页面 404 提示设置 WEB_DIST", async () => {
    const h = makeHarness();
    const res = await h.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("WEB_DIST");
  });
});
