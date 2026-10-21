/**
 * @scene/server — UI 联真路由测试（M5-T5.2 + 供应商登记表改造，契约 v1.6）
 *
 * 真实 SQLite（:memory:）+ mock dshClient + SCENE_PROVIDERS_FILE 临时登记表
 * （模型配置应用自持，变更表 #16——不再读 .dsh/settings.yaml），
 * 通过 fastify.inject 验证：项目 CRUD、阶段面板与单元格编辑、
 * 会话 CRUD + 消息 SSE、资料库 12 表 + F3 失效、知识库、供应商登记表、
 * 交付物导出与静态托管回退。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_KINDS } from "@scene/contract";
import type { DshClient, FollowEvent, StageId } from "@scene/contract";
import { buildReportMarkdown, createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { saveReportFile } from "./report-service.js";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";
import { pptRunId } from "./ppt-progress.js";

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
  hub: ReturnType<typeof createSseHub>;
  exportDir: string;
}

function makeHarness(promptEvents?: FollowEvent[], uploadLimitMb?: number): Harness {
  const db = createDb(":memory:");
  const dsh = mockDshClient(promptEvents);
  const exportDir = mkdtempSync(join(tmpdir(), "scene-export-"));
  process.env.EXPORT_DIR = exportDir;
  // 每个 harness 用独立临时登记表：默认"未配置"态，不碰项目 data/
  process.env.SCENE_PROVIDERS_FILE = join(
    mkdtempSync(join(tmpdir(), "scene-providers-")),
    "providers.local.json",
  );
  const hub = createSseHub();
  const app = createApp({ db, dshClient: dsh, hub, uploadLimitMb });
  return { app, db, dsh, hub, exportDir };
}

/** 建一条产品线 + 一个场景，返回 id */
function seedScenario(db: DbInstance, name = "测试项目"): {
  productLineId: string;
  scenarioId: string;
} {
  const line = db.productLineRepo.insert({ name: "默认产品线" });
  const scenario = db.scenarioRepo.insert({
    name,
    status: "进行中",
    current_stage: 0,
  });
  return { productLineId: line.id, scenarioId: scenario.id };
}

// ─── 来源原文（右栏「看原文」，变更表 #179）────────────────

describe("来源原文路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("按来源串取回材料库原文段落；来源自带 URL 就一并给出", async () => {
    const { productLineId } = seedScenario(h.db);
    // 材料库行落库时触发器会把 source/content 写进 source_fts（001_init.sql）
    h.db.productRepo.insert({
      product_line_id: productLineId,
      model: "CT21B",
      name: "在鸿工控机CT21B",
      status: "在售",
      launch_date: "2026-01-01",
      position_desc: "基于 RK3588J 八核处理器，宽温 -40~70℃",
      source: "在鸿工控机CT21B规格参数.docx:1",
      source_type: "AI提取",
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/sources/passages?source=${encodeURIComponent("在鸿工控机CT21B规格参数.docx:1")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("在鸿工控机CT21B规格参数.docx:1");
    expect(body.url).toBeNull();
    expect(body.passages[0].content).toContain("RK3588J");

    // 带链接的来源：原样给出，前端直接新窗口打开
    const withUrl = await h.app.inject({
      method: "GET",
      url: `/api/v1/sources/passages?source=${encodeURIComponent("OpenHarmony 官网 https://www.openharmony.cn/ 2026-09-30")}`,
    });
    expect(withUrl.json().url).toBe("https://www.openharmony.cn/");

    // 没有原文的出处（用户输入 / 模型知识）：不报错，段落为空
    const none = await h.app.inject({
      method: "GET",
      url: `/api/v1/sources/passages?source=${encodeURIComponent("行业通例（模型知识）")}`,
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().passages).toEqual([]);
  });

  it("缺 source → 400（不是 500，也不是空 200）", async () => {
    const bad = await h.app.inject({ method: "GET", url: "/api/v1/sources/passages" });
    expect(bad.statusCode).toBe(400);
  });
});

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

  it("POST /projects：只建场景、**不建**私有库（v3.0 按需创建，变更表 #160）", async () => {
    const before = h.db.productLineRepo.list().length;
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "新场景" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("新场景");
    expect(body.status).toBe("进行中");
    // 不再自动建库：库里一条新线都没有，own_line_id 明确为 null
    expect(h.db.productLineRepo.list().length).toBe(before);
    expect(body.own_line_id).toBeNull();
  });

  it("POST /projects/:id/own-line：按需建私有库、幂等；建完列表接口能看见", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "按需建库场景" },
    });
    const id = created.json().id as string;

    const first = await h.app.inject({ method: "POST", url: `/api/v1/projects/${id}/own-line` });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    const lineId = first.json().own_line_id as string;
    expect(lineId).toBeTruthy();
    // 关系落在 product_line.scenario_id 上（单一属主）
    expect(h.db.productLineRepo.getById(lineId)!.scenario_id).toBe(id);

    // 幂等：再调一次不会多出一条
    const again = await h.app.inject({ method: "POST", url: `/api/v1/projects/${id}/own-line` });
    expect(again.json().own_line_id).toBe(lineId);
    // created 要如实：第二次是"本来就有"，不能骗前端说又建了一个
    expect(again.json().created).toBe(false);
    expect(
      h.db.productLineRepo.list({ where: "scenario_id = ?", params: [id] }),
    ).toHaveLength(1);

    const lines = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${id}/material-sources`,
    });
    expect(lines.json().own.id).toBe(lineId);
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

  it("DELETE /projects 能删掉已推进过的场景（步进记录/场景诉求/质量关一并清）", async () => {
    const { scenarioId } = seedScenario(h.db);
    // 用户真实路径：让智能体写出画像并推进 → scenario_step / scenario_brief 有行
    h.db.scenarioStepRepo.complete(scenarioId, 1);
    h.db.scenarioBriefRepo.upsert(scenarioId, {
      scene_name: "某水厂漏损治理",
      intent: "把夜间最小流量异常定位到分区",
      raw_text: "某水厂漏损治理：把夜间最小流量异常定位到分区",
    });
    h.db.qualityGateRepo.insert({
      scenario_id: scenarioId,
      stage: 1 as StageId,
      item_no: "1",
      title: "来源可溯",
      result: "通过",
      detail: "x",
      evidence_refs: { refs: [] },
    });
    h.db.stageSummaryRepo.upsert(scenarioId, 1 as StageId, "总结");

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${scenarioId}`,
    });
    // 回归：曾经漏删 scenario_step，外键约束让整个删除 500 ——
    // 表现是"左栏的场景怎么都删不掉"（步进过的场景全中）
    expect(res.statusCode).toBe(200);
    expect(h.db.scenarioRepo.getById(scenarioId)).toBeUndefined();
    expect(h.db.scenarioStepRepo.completedSteps(scenarioId)).toHaveLength(0);
    expect(h.db.scenarioBriefRepo.get(scenarioId)).toBeUndefined();
    expect(h.db.qualityGateRepo.listByScenarioStage(scenarioId, 1 as StageId)).toHaveLength(0);
    expect(h.db.stageSummaryRepo.listByScenario(scenarioId)).toHaveLength(0);

    // 再删一次：已经不存在 → 404（而不是 500）
    const again = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${scenarioId}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it("GET /projects/:id/stale：横幅讲用户能对上的流程步（不再是「3、4 阶段」）", async () => {
    const { scenarioId } = seedScenario(h.db);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 4 as StageId,
      table_code: "表5-1",
      row: {},
      is_stale: true,
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stale`,
    });
    const body = res.json();
    expect(body.stages).toEqual([4]);
    expect(body.steps).toEqual([5]);
    expect(body.tables).toEqual(["表5-1"]);
    expect(body.banner).toBe("1 步的分析因资料变更待重算：第 5 步 方案与实现");
  });

  it("GET /projects/:id/stale：多个步按步号升序，且同一阶段的两步分别列出", async () => {
    const { scenarioId } = seedScenario(h.db);
    for (const [stage, code] of [
      [3, "表4-1"],
      [4, "表5-1"],
      [4, "表5-3"],
    ] as const) {
      h.db.stageDataRepo.insert({
        scenario_id: scenarioId,
        stage: stage as StageId,
        table_code: code,
        row: {},
        is_stale: true,
      });
    }
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stale`,
    });
    const body = res.json();
    expect(body.steps).toEqual([4, 5]);
    expect(body.banner).toBe("2 步的分析因资料变更待重算：第 4 步 能力匹配、第 5 步 方案与实现");
  });

  it("POST /projects/:id/stale/ack：清掉待重算标记，分析数据一字未动", async () => {
    const { scenarioId } = seedScenario(h.db);
    const row = h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 4 as StageId,
      table_code: "表5-1",
      row: { layer: "感知层", components: "CT15" },
      is_stale: true,
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/stale/ack`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe(1);
    expect(res.json().stages).toEqual([4]);

    const after = h.db.stageDataRepo.getById(row.id)!;
    expect(after.is_stale).toBe(false);
    expect(after.row).toEqual({ layer: "感知层", components: "CT15" });

    const gone = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stale`,
    });
    expect(gone.json().banner).toBeNull();
  });

  it("POST /projects/:id/stale/ack：场景不存在 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects/不存在/stale/ack",
    });
    expect(res.statusCode).toBe(404);
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

  it("GET 阶段面板：行 + 信息完整度（不再返回质量关与建议）", async () => {
    const { scenarioId } = seedScenario(h.db);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1 as StageId,
      table_code: "表1-3",
      row: { barrier_type: "技术", barrier_name: "AI 识别准确率", criteria: "≥ 95%", judgment: "过得了" },
      is_stale: false,
      source_type: "AI提取",
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1`,
    });
    const body = res.json() as {
      rows: { table_code: string }[];
      completeness: { expectedTables: number; tablesWithData: number; gaps: unknown[] };
      summary_ready: boolean;
    };
    expect(body.rows[0]!.table_code).toBe("表1-3");
    // 阶段 1 共 6 张表（表1-2、表2-7 已移到阶段 3）；完整度只给缺口，不给判定
    expect(body.completeness.expectedTables).toBe(6);
    expect(body.completeness.tablesWithData).toBe(1);
    expect(body.completeness.gaps.length).toBeGreaterThan(0);
    expect(body.summary_ready).toBe(false);
    // 旧字段保留为空值（过渡期兼容）
    expect((body as unknown as { gates: unknown[] }).gates).toEqual([]);
    expect((body as unknown as { advice: unknown }).advice).toBeNull();
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
      table_code: "表1-3",
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

describe("场景资料来源（v2.9 默认引用 + 可取消）", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("新建场景默认引用全部通用库（不做任何操作就是勾选态）", async () => {
    const shared = h.db.productLineRepo.insert({ name: "基础产品资料" });
    const { scenarioId } = seedScenario(h.db, "默认引用场景");
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/material-sources`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { linked: { id: string }[] };
    expect(body.linked.map((l) => l.id)).toContain(shared.id);
  });

  it("PUT 勾选集合：取消的那个通用库被排除，再勾回来恢复", async () => {
    const a = h.db.productLineRepo.insert({ name: "基础产品资料" });
    const b = h.db.productLineRepo.insert({ name: "行业参考库" });
    const { scenarioId } = seedScenario(h.db, "取消引用场景");
    const url = `/api/v1/projects/${scenarioId}/material-sources`;

    // 只勾 a（= 取消 b）
    await h.app.inject({ method: "PUT", url, payload: { linked_line_ids: [a.id] } });
    let linked = (
      (await h.app.inject({ method: "GET", url })).json() as { linked: { id: string }[] }
    ).linked.map((l) => l.id);
    expect(linked).toContain(a.id);
    expect(linked).not.toContain(b.id);

    // 两个都勾回来
    await h.app.inject({ method: "PUT", url, payload: { linked_line_ids: [a.id, b.id] } });
    linked = (
      (await h.app.inject({ method: "GET", url })).json() as { linked: { id: string }[] }
    ).linked.map((l) => l.id);
    expect(linked).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("专属库不可被引用 → 400", async () => {
    const { scenarioId } = seedScenario(h.db, "专属库场景");
    // 专属库 = product_line.scenario_id 指向某个场景
    const own = h.db.productLineRepo.insert({ name: "某场景专属库" });
    h.db.productLineRepo.update(own.id, { scenario_id: scenarioId } as never);
    const res = await h.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${scenarioId}/material-sources`,
      payload: { linked_line_ids: [own.id] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("右栏总结与完整度：只针对当前步骤（v2.9）", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("?step=2 的阶段总结不含用户诉求全文与上下游衔接；缺省（阶段级）才含", async () => {
    const { scenarioId } = seedScenario(h.db, "总结范围场景");
    // 给诉求与一行数据，确保阶段级总结里"本该有"那两段
    await h.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${scenarioId}/brief`,
      payload: { raw_text: "想搞清楚什么：值不值得进" },
    });
    const stepUrl = `/api/v1/projects/${scenarioId}/stages/1/summary?step=2`;
    const stageUrl = `/api/v1/projects/${scenarioId}/stages/1/summary`;

    const stepMd = ((await h.app.inject({ method: "GET", url: stepUrl })).json() as {
      markdown: string;
    }).markdown;
    expect(stepMd).not.toContain("用户诉求（第一输入，唯一基准）");
    expect(stepMd).not.toContain("上下游衔接");
    // 第 2 步的表集不含表1-1（那是第 1 步的表）
    expect(stepMd).not.toContain("表1-1");

    const stageMd = ((await h.app.inject({ method: "GET", url: stageUrl })).json() as {
      markdown: string;
    }).markdown;
    expect(stageMd).toContain("上下游衔接");
  });

  it("?step=2 的完整度只算本步 5 张表（表1-1 归第 1 步）", async () => {
    const { scenarioId } = seedScenario(h.db, "完整度范围场景");
    const stepC = (await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1/completeness?step=2`,
    })).json() as { expectedTables: number };
    const stageC = (await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1/completeness`,
    })).json() as { expectedTables: number };
    expect(stepC.expectedTables).toBe(stageC.expectedTables - 1);
    expect(stepC.expectedTables).toBe(5);
  });

  it("阶段面板 ?step=2 也按本步表集给完整度", async () => {
    const { scenarioId } = seedScenario(h.db, "面板范围场景");
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1?step=2`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { completeness: { expectedTables: number } }).completeness.expectedTables).toBe(5);
  });
});

describe("步骤联网调研（research）路由", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("POST /steps/:step/research 返回 saved/queries（检索不可用时如实给 0 + errors）", async () => {
    const { scenarioId } = seedScenario(h.db, "调研场景");
    // 把引擎固定成「已关闭」：路由测试不许真的联网，也不许伪造结果
    const cfgFile = join(mkdtempSync(join(tmpdir(), "scene-websearch-")), "web-search.local.json");
    writeFileSync(cfgFile, JSON.stringify({ engine: "none" }));
    const prevCfg = process.env.SCENE_WEB_SEARCH_FILE;
    process.env.SCENE_WEB_SEARCH_FILE = cfgFile;
    try {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/steps/2/research`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        saved: number;
        queries: number;
        engine: string;
        errors: string[];
      };
      expect(body.saved).toBe(0);
      expect(body.queries).toBeGreaterThanOrEqual(4);
      expect(body.engine).toBe("none");
      expect(body.errors.length).toBeGreaterThan(0);
      // 检索不可用也要有落点，右栏据此如实说明「为什么没有链接」
      const rows = h.db.researchRepo.listByStep(scenarioId, 2);
      expect(rows.some((r) => r.status === "检索失败")).toBe(true);
    } finally {
      if (prevCfg === undefined) delete process.env.SCENE_WEB_SEARCH_FILE;
      else process.env.SCENE_WEB_SEARCH_FILE = prevCfg;
    }
  });

  it("step 越界 400、项目不存在 404", async () => {
    const { scenarioId } = seedScenario(h.db, "调研越界场景");
    const bad = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/steps/9/research`,
    });
    expect(bad.statusCode).toBe(400);

    const missing = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects/不存在/steps/2/research",
    });
    expect(missing.statusCode).toBe(404);
  });
});

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

  it("POST dedupe-products：同型号行合并 + 重复规格删除（一次清完）", async () => {
    const line = h.db.productLineRepo.insert({ name: "去重线" });
    const mk = (model: string, status: string, created: string) =>
      h.db.productRepo.insert({
        product_line_id: line.id,
        model,
        name: `${model} 产品`,
        status,
        launch_date: "2025-01-01",
        position_desc: "—",
        created_at: created,
      } as never);
    const keep = mk("CT15", "在售", "2026-09-23T10:00");
    const dupe = mk("CT15", "待确认", "2026-09-24T10:00");
    const spec = (pid: string, value: string) =>
      h.db.specParamRepo.insert({
        product_id: pid,
        param_class: "功耗",
        param_name: "电源",
        value,
        measured: "未提及",
      } as never);
    spec(keep.id, "DC24V/1A");
    spec(dupe.id, "DC24V/1A"); // 合并后会与上面那条完全相同 → 应被删掉
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/library/product-lines/${line.id}/dedupe-products`,
    });
    const report = res.json();
    expect(report.products_removed).toBe(1);
    expect(report.specs_removed).toBe(1);
    expect(h.db.productRepo.list({ where: "product_line_id = ?", params: [line.id] })).toHaveLength(1);
  });

  it("POST dedupe-products：整条产品线被合并 → 引用它的场景标待重算（与单元格编辑一致）", async () => {
    const { productLineId, scenarioId } = seedScenario(h.db, "去重联动场景");
    for (const stage of [3, 4] as StageId[]) {
      h.db.stageDataRepo.insert({
        scenario_id: scenarioId,
        stage,
        table_code: stage === 3 ? "表4-1" : "表5-1",
        row: {},
        is_stale: false,
      });
    }
    const mk = (created: string) =>
      h.db.productRepo.insert({
        product_line_id: productLineId,
        model: "CT15",
        name: "CT15 控制器",
        status: "在售",
        launch_date: "2025-01-01",
        position_desc: "—",
        created_at: created,
      } as never);
    mk("2026-09-23T10:00");
    mk("2026-09-24T10:00");

    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/library/product-lines/${productLineId}/dedupe-products`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stale_marked_stages).toEqual([3, 4]);
    expect(h.db.stageDataRepo.listByScenarioStage(scenarioId, 3 as StageId)[0]!.is_stale).toBe(true);
    expect(h.db.stageDataRepo.listByScenarioStage(scenarioId, 4 as StageId)[0]!.is_stale).toBe(true);
  });

  it("POST rows/M2：按 product_id 归属（spec_param 无 product_line_id 列，回归 500）", async () => {
    const p = seedProduct();
    const bad = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M2",
      payload: { product_line_id: plId, values: { param_class: "功耗", param_name: "电源", value: "DC24V" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("product_id");
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M2",
      payload: {
        product_line_id: plId,
        values: { product_id: p.id, param_class: "功耗", param_name: "电源", value: "DC24V" },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().product_id).toBe(p.id);
    // measured 是 NOT NULL 枚举：不给也要有「未提及」兜底（旧实现 500）
    expect(ok.json().measured).toBe("未提及");
  });

  it("POST rows/M1：必填缺失 400 说清缺哪列；缺省值补齐 NOT NULL 列（回归 500）", async () => {
    const noModel = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M1",
      payload: { product_line_id: plId, values: { name: "只有名字" } },
    });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().error).toContain("model");
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M1",
      payload: { product_line_id: plId, values: { model: "M-1" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("待确认");
    expect(ok.json().launch_date).toBe("");
    expect(ok.json().position_desc).toBe("");
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
      status: "进行中",
      current_stage: 0,
    });
    h.db.stageDataRepo.insert({
      scenario_id: scenario.id,
      stage: 4 as StageId, // M1 → 阶段 3、4（TABLE_DEPENDENCIES，0 基阶段 id）
      table_code: "表5-1",
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

  it("PATCH 通用库（scenario_id NULL）的规格行 → 所有引用它的场景都标阶段 3、4；显式排除的场景不标", async () => {
    // 通用库：scenario_id 为 null，被所有场景默认引用（拓维产品就是这种）
    const global = h.db.productLineRepo.insert({ name: "通用产品库" });
    const a = h.db.scenarioRepo.insert({
      name: "场景A",
      status: "进行中",
      current_stage: 4,
    });
    const b = h.db.scenarioRepo.insert({
      name: "场景B（显式排除通用库）",
      status: "进行中",
      current_stage: 4,
    });
    h.db.scenarioLinkedLineRepo.insert({
      scenario_id: b.id,
      product_line_id: global.id,
      excluded: 1, // SQLite 布尔位（0/1）
    });
    for (const sid of [a.id, b.id]) {
      for (const stage of [3, 4] as StageId[]) {
        h.db.stageDataRepo.insert({
          scenario_id: sid,
          stage,
          table_code: stage === 3 ? "表4-3" : "表5-1",
          row: {},
          is_stale: false,
        });
      }
    }
    // 通用库里的产品 + 它的规格行（M2 经 product_id 上溯到通用库）
    const product = h.db.productRepo.insert({
      product_line_id: global.id,
      name: "在鸿 IO 控制器",
      model: "CT15",
      status: "在售",
      launch_date: "2026-01-01",
      position_desc: "通用库产品",
    });
    const specRow = h.db.specParamRepo.insert({
      product_id: product.id,
      param_class: "接口",
      param_name: "网口",
      value: "2 路千兆",
      measured: "未提及",
      source_type: "用户确认",
    } as never);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/library/rows/M2/${specRow.id}`,
      payload: { cell: "value", value: "4 路千兆" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.stageDataRepo.listByScenarioStage(a.id, 3 as StageId)[0]!.is_stale).toBe(true);
    expect(h.db.stageDataRepo.listByScenarioStage(a.id, 4 as StageId)[0]!.is_stale).toBe(true);
    expect(h.db.stageDataRepo.listByScenarioStage(b.id, 4 as StageId)[0]!.is_stale).toBe(false);
  });

  it("PATCH M2 规格行 → 经 product_id 上溯产品线，标阶段 3、4 待重算", async () => {
    const p = seedProduct();
    const scenario = h.db.scenarioRepo.insert({
      name: "规格联动场景",
      status: "进行中",
      current_stage: 4,
    });
    for (const stage of [3, 4] as StageId[]) {
      h.db.stageDataRepo.insert({
        scenario_id: scenario.id,
        stage,
        table_code: "表4-3",
        row: {},
        is_stale: false,
      });
    }
    // spec_param 没有 product_line_id 列（001_init.sql）→ 只能经产品上溯
    const spec = h.db.specParamRepo.insert({
      product_id: p.id,
      param_class: "接口",
      param_name: "网口",
      value: "2 路千兆",
      measured: "未提及",
      source_type: "用户确认",
    } as never);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/library/rows/M2/${spec.id}`,
      payload: { cell: "value", value: "4 路千兆" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.stageDataRepo.listByScenarioStage(scenario.id, 3 as StageId)[0]!.is_stale).toBe(true);
    expect(h.db.stageDataRepo.listByScenarioStage(scenario.id, 4 as StageId)[0]!.is_stale).toBe(true);
  });

  it("PATCH 阶段表单元格 → 下游阶段按依赖标待重算（表2-2 要素清单 → 阶段 2、4）", async () => {
    /* 变更表 #105 前这条用的是 表5-5 → 阶段 5、6；表删了，改用仍在的 表2-2 */
    const scenario = h.db.scenarioRepo.insert({
      name: "要素联动场景",
      status: "进行中",
      current_stage: 4,
    });
    const cell = h.db.stageDataRepo.insert({
      scenario_id: scenario.id,
      stage: 2 as StageId,
      table_code: "表2-2",
      row: { element: "会议室数量", value: "10 间" },
      is_stale: false,
    });
    for (const stage of [2, 4] as StageId[]) {
      h.db.stageDataRepo.insert({
        scenario_id: scenario.id,
        stage,
        table_code: stage === 2 ? "表2-2" : "表5-1",
        row: {},
        is_stale: false,
      });
    }
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${scenario.id}/stage-data/${cell.id}`,
      payload: { cell: "value", value: "12 间" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stale_marked_stages).toEqual([2, 4]);
    expect(h.db.stageDataRepo.listByScenarioStage(scenario.id, 2 as StageId)[0]!.is_stale).toBe(true);
    expect(h.db.stageDataRepo.listByScenarioStage(scenario.id, 4 as StageId)[0]!.is_stale).toBe(true);
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

  it("M6 硬件报价：写入 → 读取 → 改单价（含税/口径/来源）", async () => {
    const p = seedProduct();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M6",
      payload: {
        product_line_id: plId,
        values: {
          model: "X1",
          config: "8G+128G",
          unit_price: "12000–15000",
          price_scope: "含安装",
          valid_until: "2026-12-31",
          source: "报价单.pdf:1",
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const quote = created.json();
    expect(quote.product_id).toBe(p.id);
    expect(quote.price_scope).toBe("含安装");

    const list = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/tables/M6?product_line_id=${plId}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].source).toBe("报价单.pdf:1");

    const patched = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/library/rows/M6/${quote.id}`,
      payload: { cell: "unit_price", value: "11800" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().unit_price).toBe("11800");
  });

  it("M6 报价型号必须能在 M1 找到（凭空建型号 400）", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M6",
      payload: {
        product_line_id: plId,
        values: {
          model: "NOT-EXIST",
          config: "标准",
          unit_price: "100",
          price_scope: "纯设备",
          source: "报价单.pdf:1",
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("M1");
  });

  it("M4 读取层合并 boundary + limitation，并标「类型」= 不做/限制", async () => {
    h.db.boundaryRepo.insert({
      product_line_id: plId,
      description: "不做自建平台二次开发",
      reason: "不做定制",
      has_plan: "无",
      response: "转生态伙伴",
      owner: "售前",
      source_type: "用户确认",
      source: "边界.docx:2",
      evidence_level: "A",
    } as never);
    h.db.limitationRepo.insert({
      product_line_id: plId,
      product_name: "X1",
      description: "无 5G",
      impact: "中",
      fix_status: "无计划",
      external_visible: "内部可提",
      owner: "产品",
      source_type: "用户确认",
      source: "限制.docx:3",
      evidence_level: "A",
    } as never);

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/library/tables/M4?product_line_id=${plId}`,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, string>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type).sort()).toEqual(["不做", "限制"]);
    const no = rows.find((r) => r.type === "不做")!;
    expect(no.target).toBe("公司/业务");
    expect(no.response).toBe("转生态伙伴");
    const limit = rows.find((r) => r.type === "限制")!;
    expect(limit.target).toBe("X1");
    expect(limit.impact).toBe("中");
  });

  it("M4 新增「限制」行落到 limitation 表，读取仍是合并行", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M4",
      payload: {
        product_line_id: plId,
        values: {
          type: "限制",
          target: "X1",
          description: "无 5G",
          impact: "中",
          source: "限制.docx:3",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.limitationRepo.list({ where: "product_line_id = ?", params: [plId] })).toHaveLength(1);
    expect(res.json().type).toBe("限制");
  });
});

// ─── 资料文件清单与删除入口（变更表 #156） ─────────────────
//
// 用户原话「只能选择，不能删除」：这批用例盯的是"删对了没有、拦对了没有"。
// 删除判定（文件名解析 / 全等匹配 / 聚合）在纯模块 library-materials.test.ts 里穷举，
// 这里验证的是**路由接线**：取行范围、返回体、拦截文案、下游标脏。

describe("资料文件删除入口（变更表 #156）", () => {
  let h: Harness;
  /** 专用库（0 行、无引用时一律可删；变更表 #157 起不再按"有没有场景"判） */
  let lineId: string;
  beforeEach(() => {
    h = makeHarness();
    lineId = h.db.productLineRepo.insert({
      name: "专属库",
      scenario_id: "scenario-gone",
    } as never).id;
  });

  /** 造一行 M1（带来源标注，模拟 ingest 落库） */
  function seedProduct(model: string, source: string | null) {
    return h.db.productRepo.insert({
      product_line_id: lineId,
      model,
      name: `${model} 产品`,
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "—",
      source_type: "AI提取",
      source,
    } as never);
  }

  function seedCapability(name: string, source: string | null) {
    return h.db.capabilityRepo.insert({
      product_line_id: lineId,
      domain: "感知",
      name,
      description: "—",
      maturity: "在研",
      dependency: "—",
      source_type: "AI提取",
      source,
    } as never);
  }

  const materials = async (id = lineId) =>
    h.app.inject({ method: "GET", url: `/api/v1/library/materials?product_line_id=${id}` });

  it("GET materials：空线返回 []，缺 product_line_id 400，未知库 404", async () => {
    expect((await materials()).json()).toEqual([]);

    const missing = await h.app.inject({ method: "GET", url: "/api/v1/library/materials" });
    expect(missing.statusCode).toBe(400);
    const nope = await materials("nope");
    expect(nope.statusCode).toBe(404);
  });

  it("GET materials：按来源文件聚合，行数降序，行数之和 = 本库总行数", async () => {
    seedProduct("A1", "方案.pptx:3");
    seedProduct("A2", "方案.pptx:9");
    seedCapability("B1", "认证.pdf:1");
    seedCapability("手工补录", null);

    const res = await materials();
    expect(res.statusCode).toBe(200);
    const groups = res.json() as {
      file: string;
      rows: number;
      tables: Record<string, number>;
      deletable: boolean;
    }[];
    // 行数降序：2 行的方案.pptx 在最前（行数相同的两条按文件名升序，不断言具体次序）
    expect(groups[0]!.file).toBe("方案.pptx");
    expect(new Set(groups.map((g) => g.file))).toEqual(
      new Set(["方案.pptx", "认证.pdf", "（无来源标注）"]),
    );
    expect(groups[0]).toMatchObject({ rows: 2, tables: { M1: 2 }, deletable: true });
    const cert = groups.find((g) => g.file === "认证.pdf")!;
    expect(cert).toMatchObject({ rows: 1, tables: { M3: 1 }, deletable: true });
    expect(groups.find((g) => g.file === "（无来源标注）")).toMatchObject({
      rows: 1,
      deletable: false,
    });
    expect(groups.reduce((s, g) => s + g.rows, 0)).toBe(4);
  });

  it("DELETE materials：只删这个文件的行，a.pdf 不吃 a.pdf.bak", async () => {
    const keepBak = seedProduct("BAK", "a.pdf.bak:1");
    const keepOtherLine = h.db.productRepo.insert({
      product_line_id: h.db.productLineRepo.insert({ name: "另一条线" }).id,
      model: "OTHER",
      name: "别的库",
      status: "在售",
      launch_date: "2025-01-01",
      position_desc: "—",
      source_type: "AI提取",
      source: "a.pdf:1",
    } as never);
    const del1 = seedProduct("A1", "a.pdf:1");
    const del2 = seedCapability("A2", "a.pdf:7");
    seedProduct("TARGET-BAK", "a.pdf.bak:2");

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("a.pdf")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: number; tables: Record<string, number> };
    expect(body.deleted).toBe(2);
    expect(body.tables).toEqual({ M1: 1, M3: 1 });
    // 该删的删了、不该删的一个没动
    expect(h.db.productRepo.getById(del1.id)).toBeUndefined();
    expect(h.db.capabilityRepo.getById(del2.id)).toBeUndefined();
    expect(h.db.productRepo.getById(keepBak.id)).toBeDefined();
    expect(h.db.productRepo.getById(keepOtherLine.id)).toBeDefined();
    // 剩下的清单只剩 a.pdf.bak 两份
    const left = (await materials()).json() as { file: string; rows: number }[];
    expect(left.map((g) => g.file)).toEqual(["a.pdf.bak"]);
    expect(left[0]!.rows).toBe(2);
  });

  it("DELETE materials：删完标下游待重算（与单元格编辑同一口径）", async () => {
    const { scenarioId } = seedScenario(h.db, "删资料联动场景");
    // 让场景挂到这条专属库上（v3.0：关系在 product_line.scenario_id 这一侧）
    h.db.productLineRepo.update(lineId, { scenario_id: scenarioId } as never);
    h.db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 3,
      table_code: "表4-1",
      row: {},
      is_stale: false,
    });
    seedProduct("A1", "方案.pptx:1");

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("方案.pptx")}`,
    });
    expect(res.json().stale_marked_stages).toEqual([3, 4]);
    expect(h.db.stageDataRepo.listByScenarioStage(scenarioId, 3 as StageId)[0]!.is_stale).toBe(true);
  });

  it("DELETE materials：文件不在本库 → 404；无来源行不可按文件删 → 400", async () => {
    seedProduct("A1", "方案.pptx:1");
    const nope = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("没有这个.pdf")}`,
    });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error).toContain("没有这个.pdf");

    const noSource = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("（无来源标注）")}`,
    });
    expect(noSource.statusCode).toBe(400);
    const noFile = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}`,
    });
    expect(noFile.statusCode).toBe(400);
  });

  it("DELETE materials：同一个文件的产品行 + 规格行一起删得掉（变更表 #159 真机 500 的回归）", async () => {
    // 真机现场：60 行 = M1×14 + M2×7 + …，删除返回 500 FOREIGN KEY constraint failed。
    // 原因是删除循环按表定义顺序走（M1 在前），删 M1 时它自己的规格行还指着它。
    const product = seedProduct("A1", "方案.pptx:1");
    h.db.specParamRepo.insert({
      product_id: product.id,
      param_class: "接口",
      param_name: "网口",
      value: "2 路",
      measured: "未提及",
      source_type: "AI提取",
      source: "方案.pptx:3",
    } as never);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("方案.pptx")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(2);
    expect(res.json().tables).toMatchObject({ M1: 1, M2: 1 });
    expect(res.json().cascaded_specs).toBe(0);
    // 外键不再悬空：产品行与规格行都不在库里了
    expect(h.db.productRepo.getById(product.id)).toBeUndefined();
    expect(
      h.db.specParamRepo.list({ where: "product_id = ?", params: [product.id] }),
    ).toHaveLength(0);
  });

  it("DELETE materials：规格来自**别的文件**时连带删掉并如实报数（不再 409 卡住用户）", async () => {
    // 产品行被删了，规格行留着既没用又卡外键；它来自别的文件这件事必须报出来，不能静默
    const product = seedProduct("A1", "方案.pptx:1");
    const other = h.db.specParamRepo.insert({
      product_id: product.id,
      param_class: "接口",
      param_name: "网口",
      value: "2 路",
      measured: "未提及",
      source_type: "AI提取",
      source: "别的资料.pdf:5",
    } as never);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("方案.pptx")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cascaded_specs).toBe(1);
    expect(res.json().tables).toMatchObject({ M1: 1, M2: 1 });
    expect(h.db.specParamRepo.getById(other.id)).toBeUndefined();
  });

  it("DELETE library/rows：单行删除产品行同样先清规格（两条路径一个口径）", async () => {
    const product = seedProduct("A1", "方案.pptx:1");
    const spec = h.db.specParamRepo.insert({
      product_id: product.id,
      param_class: "接口",
      param_name: "网口",
      value: "2 路",
      measured: "未提及",
      source_type: "AI提取",
      source: "方案.pptx:3",
    } as never);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/rows/M1/${product.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, cascaded_specs: 1 });
    expect(h.db.specParamRepo.getById(spec.id)).toBeUndefined();
  });

  it("DELETE product-lines/:id：空库但被活场景当共享输入引用 → 409 并点名场景（#157）", async () => {
    // 「拓维产品」就是这种：靠勾选集合被「智慧会议室」引用。空库也不许删——删了那个场景会少一份输入。
    const { scenarioId } = seedScenario(h.db, "链接来源场景");
    h.db.scenarioLinkedLineRepo.insert({
      scenario_id: scenarioId,
      product_line_id: lineId,
      excluded: 0,
    } as never);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${lineId}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("链接来源场景");
    expect(res.json().error).toContain("共享输入");
    expect(h.db.productLineRepo.getById(lineId)).toBeDefined();
  });

  it("DELETE product-lines/:id：非空 → 409 说清还有几行；删完资料再删即通过", async () => {
    seedProduct("A1", "方案.pptx:1");
    const blocked = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${lineId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("还有 1 行资料");
    expect(blocked.json().error).toContain("先删资料再删库");
    expect(h.db.productLineRepo.getById(lineId)).toBeDefined();

    // 按文件删干净后，删库放行
    await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/materials?product_line_id=${lineId}&file=${encodeURIComponent("方案.pptx")}`,
    });
    const ok = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${lineId}`,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("DELETE product-lines/:id：没有场景、没有行、没被引用的库**可以删**（变更表 #157 修正）", async () => {
    // 用户「新建产品线」出来的库就是这种：scenario_id 为空。旧实现把它当"通用库"一律禁删，
    // 于是用户自己建的库永远删不掉（真机实测踩到）。判据改成看风险：空且没人引用就放行。
    const mine = h.db.productLineRepo.insert({ name: "我新建的库" }).id;
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${mine}`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.productLineRepo.getById(mine)).toBeUndefined();
  });

  it("DELETE product-lines/:id：仍被活场景引用为共享输入 → 409 并点名是哪个场景", async () => {
    // 空库、没有归属关系，但被场景的勾选集合引用着（拓维产品就是这种：1282 行 + 被智慧会议室引用）
    const shared = h.db.productLineRepo.insert({ name: "共享库" }).id;
    const { scenarioId: alive } = seedScenario(h.db, "活场景");
    h.db.scenarioLinkedLineRepo.insert({
      scenario_id: alive,
      product_line_id: shared,
    } as never);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${shared}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("活场景");
    expect(res.json().error).toContain("共享输入");
    expect(h.db.productLineRepo.getById(shared)).toBeDefined();
  });

  it("DELETE product-lines/:id：场景已在勾选集合里取消引用（excluded=1）→ 放行，悬空引用一并清掉", async () => {
    const line = h.db.productLineRepo.insert({ name: "被取消引用的库" }).id;
    const { scenarioId: optOut } = seedScenario(h.db, "取消了的场景");
    h.db.scenarioLinkedLineRepo.insert({
      scenario_id: optOut,
      product_line_id: line,
      excluded: 1,
    } as never);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${line}`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.productLineRepo.getById(line)).toBeUndefined();
    expect(
      h.db.scenarioLinkedLineRepo.list({ where: "product_line_id = ?", params: [line] }),
    ).toHaveLength(0);
  });

  it("DELETE product-lines/:id：空私有库可以删，场景还在（v3.0 变更表 #160）", async () => {
    // 关系在 product_line.scenario_id 这一侧，删库不需要回头改场景，所以场景活着也删得掉
    const scenario = h.db.scenarioRepo.insert({
      name: "要清掉私有库的场景",
      status: "进行中",
      current_stage: 0,
    } as never);
    const owned = h.db.productLineRepo.insert({
      name: "要清掉私有库的场景·专属资料",
      scenario_id: scenario.id,
    } as never).id;

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/product-lines/${owned}`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.productLineRepo.getById(owned)).toBeUndefined();
    // 场景还在，只是回到"没有私有库"的状态
    expect(h.db.scenarioRepo.getById(scenario.id)).toBeDefined();
    expect(
      h.db.productLineRepo.list({ where: "scenario_id = ?", params: [scenario.id] }),
    ).toHaveLength(0);
  });

  it("DELETE product-lines/:id：不存在 → 404", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/v1/library/product-lines/nope",
    });
    expect(res.statusCode).toBe(404);
  });

  it("删除资料行同时清全文索引（否则已删材料的来源自检仍是假阳性）", async () => {
    const product = seedProduct("A1", "方案.pptx:1");
    expect(
      h.db.db.prepare("SELECT 1 FROM source_fts WHERE ref_id = ?").get(product.id),
    ).toBeDefined();

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/library/rows/M1/${product.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(
      h.db.db.prepare("SELECT 1 FROM source_fts WHERE ref_id = ?").get(product.id),
    ).toBeUndefined();
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

  it("file 部件在前、字段在后（浏览器 FormData 顺序）→ query 兜底放行", async () => {
    const line = h.db.productLineRepo.insert({ name: "L-file-first" });
    const boundary = "----sceneTestBoundary";
    // 只有 file 部件，product_line_id 不在 body 里（file() 收不到 file 之后的字段）
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="t.pdf"',
      "Content-Type: application/pdf",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/library/ingest?product_line_id=${line.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().ingest_job_id).toBe("string");
  });

  /**
   * 真实文件名 + 临时文件清理（变更表 #156）
   *
   * 两件事必须一起钉住：
   * ① 落库来源写**材料真名**——上传落盘用的是临时名（`ingest-…`），只把路径交给 ingest 会
   *    让模型照着抄，行的 source 全变成临时名（库里 474 条老数据就是这样，认不出是哪份材料）；
   * ② 任务结束后临时件必须删——留着就是每次上传在盘上多压一份原文。
   */
  it("上传：模型看到的是材料真名；任务跑完临时文件不留在临时目录", async () => {
    const line = h.db.productLineRepo.insert({ name: "L-real-name" });
    const listIngestTmp = () => readdirSync(tmpdir()).filter((f) => f.startsWith("ingest-"));
    const before = listIngestTmp();

    // 用真能解析的样本 PDF（好让流程走到"调模型"这一步），但文件名用中文真名
    const pdf = readFileSync(join(process.cwd(), "scripts/spike/s3/sample.pdf"));
    const boundary = "----sceneRealNameBoundary";
    const body = Buffer.concat([
      Buffer.from(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="副本狄耐克鸿蒙智慧医院建设方案.pdf"',
          "Content-Type: application/pdf",
          "",
          "",
        ].join("\r\n"),
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/library/ingest?product_line_id=${line.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.statusCode).toBe(200);

    // 入库任务是后台跑的：等它真的调过模型
    await vi.waitFor(() => expect(h.dsh.prompt).toHaveBeenCalled(), { timeout: 10_000 });
    const [, promptArg] = (h.dsh.prompt as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]! as [unknown, { user: string }];
    expect(promptArg.user).toContain("副本狄耐克鸿蒙智慧医院建设方案.pdf");
    expect(promptArg.user).not.toContain("ingest-");

    // 任务结束（成功或失败都算）后不许有**新增**的 ingest-* 残留。
    // 只比"新增"不比全集：同文件里别的用例也起过后台入库任务，它们的 finally 会在
    // 任意时刻删掉自己的临时件（这正是本次改动带来的行为），全集比对会互相打架。
    await vi.waitFor(
      () => expect(listIngestTmp().filter((f) => !before.includes(f))).toEqual([]),
      { timeout: 10_000 },
    );
  }, 30_000);

  it("未知入库任务的 events → 404", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/library/ingest/nope/events",
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * 超限（变更表 #156 真机踩到的坑）
   *
   * 流式落盘把 `toBuffer()` 换成了 `pipeline()`，而 `@fastify/multipart` 超限时**不会让
   * pipeline 抛错**——它只把文件流截断并置 `truncated = true`（旧实现是 toBuffer 自己查这个
   * 标记才抛的）。只看异常的话，320 MB 会被当成"上传成功"，写进去的是被截断的前 300 MB。
   * 所以这条用例同时钉住三件事：中文 413、截断标记成 413、不留半截临时文件。
   */
  it("超过上限：中文 413 + 不留半截临时文件（pipeline 不报错，靠 truncated 标记兜住）", async () => {
    const big = makeHarness(undefined, 1); // 上限压到 1 MB，用小 body 验证真行为
    const line = big.db.productLineRepo.insert({ name: "L-oversize" });
    const listIngestTmp = () => readdirSync(tmpdir()).filter((f) => f.startsWith("ingest-"));
    // 上传前的快照（同一台机器上可能已有别的实例留下的 ingest-* 文件，不做绝对断言）
    const before = listIngestTmp();

    const boundary = "----sceneOversizeBoundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="oversize.pdf"',
      "Content-Type: application/pdf",
      "",
      "x".repeat(2 * 1024 * 1024),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await big.app.inject({
      method: "POST",
      url: `/api/v1/library/ingest?product_line_id=${line.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    expect(res.statusCode).toBe(413);
    const payload = res.json() as { code: string; message: string };
    expect(payload.code).toBe("FILE_TOO_LARGE");
    expect(payload.message).toContain("1 MB");
    expect(payload.message).toContain("压缩");
    // 没有 job_id：截断的文件一个字节都不能进 ingest
    expect(payload).not.toHaveProperty("ingest_job_id");
    // /tmp 不留垃圾
    expect(listIngestTmp()).toEqual(before);
  });
});

// ─── 交付物导出 ────────────────────────────────────────────

/**
 * 交付物"已生成"夹具（变更表 #174）
 *
 * 现在未生成时正文为空、导出直接 400，所以导出类用例得先有正式版。用要点版正文
 * 落盘是**故意的**：这些用例验证的是导出链路，不是模型撰写质量。
 */
function generateReports(h: ReturnType<typeof makeHarness>, scenarioId: string): void {
  const scenario = h.db.scenarioRepo.getById(scenarioId)!;
  const stageData = h.db.stageDataRepo.list({ where: "scenario_id = ?", params: [scenarioId] });
  for (const kind of REPORT_KINDS) {
    saveReportFile(scenario, kind, buildReportMarkdown({ scenario, stageSummaries: [], stageData }, kind));
  }
}

describe("交付物导出", () => {
  it("POST export 写出一份 md：<场景>解决方案.md（变更表 #246）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "导出场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-export-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      generateReports(h, scenarioId);
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      expect(res.statusCode).toBe(200);
      const { files } = res.json() as { files: string[] };
      // 只有一份客户端可读的正式交付物
      expect(files).toHaveLength(1);
      for (const f of files) expect(existsSync(f), f).toBe(true);
      expect(files[0]!.endsWith("导出场景解决方案.md")).toBe(true);
      expect(readFileSync(files[0]!, "utf-8")).toContain("## 现状与问题");

      // 再导一次：两份都还在，文件名不变（导出幂等）
      const again = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      expect(again.statusCode).toBe(200);
      const second = again.json() as { files: string[] };
      expect(second.files).toHaveLength(1);
      expect(second.files[0]!.endsWith("导出场景解决方案.md")).toBe(true);
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未生成就导出 → 400，并说清要先「生成报告」（变更表 #174）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "未生成场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-export-blocked-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      const md = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      expect(md.statusCode).toBe(400);
      expect(md.json().error).toContain("生成报告");

      const docx = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
        payload: { dir },
      });
      expect(docx.statusCode).toBe(400);
      expect(docx.json().error).toContain("生成报告");
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("场景不存在 → 404", async () => {
    const h = makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects/nope/deliverables/export",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST export-docx 把交付物按同一版式写成 Word（变更表 #133 / #246）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "Word 场景");
    const dir = mkdtempSync(join(homedir(), ".scene-docx-test-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      generateReports(h, scenarioId);
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
        payload: { dir },
      });
      expect(res.statusCode).toBe(200);
      const { files } = res.json() as { files: string[] };
      // 一份：解决方案（同一个渲染器、同一套 Word 模板）
      expect(files).toHaveLength(1);
      for (const f of files) {
        expect(f.startsWith(dir)).toBe(true);
        expect(f.endsWith(".docx")).toBe(true);
        const head = readFileSync(f).subarray(0, 2).toString("utf8");
        expect(head, f).toBe("PK"); // zip 魔数
      }
      expect(files[0]!.endsWith("Word 场景解决方案.docx")).toBe(true);
      expect(files.some((f) => f.includes("内部调研报告"))).toBe(false);
      expect(files.some((f) => f.includes("对外汇报材料"))).toBe(false);

      // 再导一次：两份报告字节一致 → 一个字节都不该动（变更表 #131 的先读后写）
      const again = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
        payload: { dir },
      });
      expect(again.statusCode).toBe(200);
      const second = again.json() as { files: string[]; unchanged: string[] };
      expect(second.files).toEqual([]);
      expect(second.unchanged.length).toBe(1);
      expect(second.unchanged[0]!.endsWith("Word 场景解决方案.docx")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── 导出 PPT（变更表 #141） ─────────────────────────────

  /** 假技能：导出器只写占位 pptx（真跑用户技能由人工验收，测试不依赖本机） */
  function makeFakeSkill(): string {
    const dir = mkdtempSync(join(tmpdir(), "scene-ppt-skill-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "svg_to_pptx.py"),
      [
        "import pathlib, sys",
        "args = sys.argv[1:]",
        "out = args[args.index('-o') + 1]",
        "pathlib.Path(out).write_bytes(b'PK\\x03\\x04fake')",
      ].join("\n"),
      "utf8",
    );
    return dir;
  }

  /** 合规的 6 页大纲（直接当模型的返回文本） */
  /**
   * 一份**过得了大纲质量判据**的 5 页大纲（变更表 #146）
   *
   * 这条用例只验路由与进度通道，所以给一份第一轮就能通过的稿：标题是观点、每页 20 条短句、
   * 逐页内容不同（带页标记）、**不含数字**（推导出来的正文里没有数字，写了就会判"数字不在正文"）。
   */
  function outlineText(): string {
    const marks = ["甲", "乙", "丙", "丁", "戊"];
    const heads = ["设备台账", "巡检任务", "异常上报", "数据口径"];
    const notes = ["按区域落地", "按班次执行", "按等级通知", "按口径统一"];
    const lines = [
      "逐台贴码当场留痕",
      "照单派发到人可查",
      "拍照上报有据可依",
      "一处录入口径唯一",
      "按岗定责边界清楚",
      "按协议对接接口明确",
      "分批进场进度可控",
      "逐项核验差异可查",
      "分批交接责任到岗",
      "轮值留痕记录完整",
      "分级通知通知到位",
      "按天核对差异可查",
    ];
    const pages = Array.from({ length: 5 }, (_, i) => {
      const mark = marks[i]!;
      return {
        layout: "网格要点",
        kicker: i === 0 ? "现状与痛点" : i <= 2 ? "建设方案" : "价值与收益",
        icon: "list-check",
        title: `${mark}条硬规则管住现场`,
        subtitle: `${mark}批内容写清边界`,
        blocks: [0, 1, 2, 3].map((k) => ({
          head: heads[k]!,
          note: `${notes[k]!}，${mark}组`,
          icon: "file-text",
          lines: [0, 1, 2].map((j) => `${lines[(i * 4 + k * 3 + j) % lines.length]!}，${mark}组`),
        })),
        chips: [],
        highlight: `${mark}页的一句话结论`,
      };
    });
    return JSON.stringify({ pages });
  }

  /** 重放中枢里某个 run 的全部事件（run 结束后 subscribe 会一次性吐完并收尾） */
  async function replay(h: Harness, runId: string): Promise<FollowEvent[]> {
    const out: FollowEvent[] = [];
    const iterable = h.hub.subscribe(runId);
    if (!iterable) return out;
    for await (const event of iterable) out.push(event);
    return out;
  }

  it("POST export-pptx 导出 PPT 到目标目录，进度含「大纲」与「PPTX」两个阶段（变更表 #141）", async () => {
    const h = makeHarness([{ type: "text", text: outlineText() }, { type: "done" }]);
    const { scenarioId } = seedScenario(h.db, "PPT 场景");
    const dir = mkdtempSync(join(homedir(), ".scene-ppt-route-"));
    const skill = makeFakeSkill();
    process.env.PPT_MASTER_DIR = skill;
    process.env.DELIVERABLE_DIR = dir;
    try {
      generateReports(h, scenarioId);
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx`,
        payload: { dir, kind: "solution", run: "route-run-1" },
      });
      expect(res.statusCode).toBe(200);
      const { files, unchanged } = res.json() as { files: string[]; unchanged: string[] };
      expect(unchanged).toEqual([]);
      expect(files).toHaveLength(1);
      expect(files[0]!.startsWith(dir)).toBe(true);
      expect(files[0]!.endsWith("PPT 场景解决方案.pptx")).toBe(true);
      expect(readFileSync(files[0]!).subarray(0, 2).toString("utf8")).toBe("PK");

      // 进度：阶段文案齐，且至少含「大纲」「PPTX」两个关键阶段
      const events = await replay(h, pptRunId("route-run-1"));
      expect(events.length).toBeGreaterThan(3);
      expect(events.every((e) => e.type === "progress")).toBe(true);
      const text = events.map((e) => String(e.message ?? "")).join("｜");
      expect(text).toContain("PPT：正在从正文提取大纲（第 1 轮）…");
      expect(text).toContain("PPT：正在优化大纲…");
      expect(text).toContain("PPT：正在做版面检查…");
      expect(text).toContain("正在转成 PPTX");
      expect(text).toContain("PPT：已导出");

      // 同一 token 也能从 events 端点拿到 SSE 报文（前端就是这么订阅的）
      const sse = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx/events?run=route-run-1`,
      });
      expect(sse.statusCode).toBe(200);
      expect(sse.headers["content-type"]).toContain("text/event-stream");
      expect(sse.payload).toContain("PPTX");
    } finally {
      delete process.env.PPT_MASTER_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(skill, { recursive: true, force: true });
    }
  });

  it("POST export-pptx：kind 缺省按 solution；技能缺失只回 notice（不抛 500）", async () => {
    const h = makeHarness([{ type: "text", text: outlineText() }, { type: "done" }]);
    const { scenarioId } = seedScenario(h.db, "PPT 默认口径");
    const dir = mkdtempSync(join(homedir(), ".scene-ppt-route-"));
    const skill = makeFakeSkill();
    try {
      process.env.PPT_MASTER_DIR = skill;
      process.env.DELIVERABLE_DIR = dir;
      generateReports(h, scenarioId);
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx`,
        payload: { dir, kind: "不认识的档位" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { files: string[] };
      expect(body.files[0]!.endsWith("PPT 默认口径解决方案.pptx")).toBe(true);
      rmSync(body.files[0]!, { force: true });

      // 技能目录不存在 → 只回一条 notice，不产文件、不抛错
      process.env.PPT_MASTER_DIR = join(tmpdir(), "no-such-skill-dir");
      const missing = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx`,
        payload: { dir },
      });
      expect(missing.statusCode).toBe(200);
      const missBody = missing.json() as { files: string[]; notice?: string };
      expect(missBody.files).toEqual([]);
      expect(missBody.notice).toContain("找不到 ppt-master 技能");
      // 不产文件（`.state/` 是先前那次成功导出的指纹目录，不算产物）
      expect(readdirSync(dir).filter((f) => f.endsWith(".pptx"))).toEqual([]);
    } finally {
      delete process.env.PPT_MASTER_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(skill, { recursive: true, force: true });
    }
  });

  it("POST export-pptx：缺目录 400、场景不存在 404、进度端缺 run 400", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "PPT 校验");
    const noDir = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx`,
      payload: {},
    });
    expect(noDir.statusCode).toBe(400);
    const noScenario = await h.app.inject({
      method: "POST",
      url: "/api/v1/projects/nope/deliverables/export-pptx",
      payload: { dir: homedir() },
    });
    expect(noScenario.statusCode).toBe(404);
    const noRun = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/deliverables/export-pptx/events`,
    });
    expect(noRun.statusCode).toBe(400);
    expect(noRun.json().error).toContain("缺少进度通道 run");
  });

  it("PUT deliverables/solution 保存中栏改过的正文（变更表 #135）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "保存场景");
    const dir = mkdtempSync(join(homedir(), ".scene-save-test-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      // 第一次保存：文件不存在 → 新建（落盘名 <id>.solution.md）
      const first = await h.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${scenarioId}/deliverables/solution`,
        payload: { markdown: "# 保存场景解决方案\n\n## 现状\n\n手改的正文\n" },
      });
      expect(first.statusCode).toBe(200);
      const path = join(dir, `${scenarioId}.solution.md`);
      expect(readFileSync(path, "utf8")).toContain("手改的正文");
      // 章标题不带手写序号（「一、」这类编号交给 Word 自动生成）
      expect(readFileSync(path, "utf8")).toContain("## 现状");

      // 内容一模一样 → 不落盘（先读后写）
      const same = await h.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${scenarioId}/deliverables/solution`,
        payload: { markdown: readFileSync(path, "utf8") },
      });
      expect(same.json().written).toBe(false);

      // 读回来：界面显示的正是刚保存的内容
      const view = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables`,
      });
      const reports = (view.json() as { reports: Record<string, { markdown: string }> }).reports;
      expect(reports["solution"]!.markdown).toContain("手改的正文");
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PUT deliverables/solution 保存成功，读回的就是手改稿（变更表 #135 / #246）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "手改场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-put-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      const saved = await h.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${scenarioId}/deliverables/solution`,
        payload: { markdown: "# 手改场景解决方案\n\n## 建设路径\n\n手改的建设路径正文\n" },
      });
      expect(saved.statusCode).toBe(200);
      const body = saved.json() as { path: string; written: boolean; overwritten: boolean };
      expect(body.written).toBe(true);
      expect(body.overwritten).toBe(false);
      expect(body.path).toBe(join(dir, `${scenarioId}.solution.md`));
      expect(readFileSync(body.path, "utf8")).toContain("手改的建设路径正文");

      const view = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables`,
      });
      const reports = (
        view.json() as {
          reports: Record<
            string,
            { markdown: string; chars: number; generated: boolean; generated_at: string | null }
          >;
        }
      ).reports;
      expect(reports["solution"]!.markdown).toContain("手改的建设路径正文");
      expect(reports["solution"]!.generated).toBe(true);
      expect(reports["solution"]!.generated_at).toBeTruthy();
      expect(reports["solution"]!.chars).toBeGreaterThan(0);
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PUT deliverables/:kind 只认 REPORT_KINDS：internal / external / whatever → 400", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "非法口径场景");
    for (const bad of ["internal", "external", "whatever"]) {
      const res = await h.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${scenarioId}/deliverables/${bad}`,
        payload: { markdown: "x" },
      });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toContain("报告类型只能是 solution");
      expect(res.json().error).toContain(bad);
    }
  });

  it("PUT deliverables/:kind 正文校验：缺 markdown / 空 / 超 20 万字 → 400", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "正文校验场景");
    const cases: { payload: { markdown?: string }; label: string }[] = [
      { payload: {}, label: "缺 markdown" },
      { payload: { markdown: "   " }, label: "空正文" },
      { payload: { markdown: "x".repeat(200_001) }, label: "超 20 万字" },
    ];
    for (const kind of ["solution", "construction"]) {
      for (const c of cases) {
        const res = await h.app.inject({
          method: "PUT",
          url: `/api/v1/projects/${scenarioId}/deliverables/${kind}`,
          payload: c.payload,
        });
        expect(res.statusCode, `${kind}:${c.label}`).toBe(400);
      }
    }
  });

  it("POST export-docx 目录非法或缺失 → 400", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "Word 场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-docx-dir-"));
    process.env.DELIVERABLE_DIR = dir;
    generateReports(h, scenarioId);
    const outside = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
      payload: { dir: "/etc" },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toContain("主目录");

    const missing = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
  });

  it("GET /deliverables：未生成时留空、不落盘；生成后取回正文（变更表 #174 / #246）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "取正文场景");
    const outDir = process.env.EXPORT_DIR!;
    const before = readdirSync(outDir).length;

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/deliverables`,
    });
    expect(res.statusCode).toBe(200);
    const { reports } = res.json() as {
      reports: Record<
        string,
        { markdown: string; chars: number; generated: boolean; generated_at: string | null }
      >;
    };
    // 变更表 #246：只有一份
    expect(Object.keys(reports)).toEqual(["solution"]);
    /**
     * 变更表 #174（用户定调）：交付物没开始就不填内容
     *
     * 以前这里返回即时推导的"要点版"（1.6 万/2.2 万字）当预览，用户会以为报告已经生成；
     * 现在未生成就是空的，界面只留「生成报告」入口。
     */
    const solution = reports["solution"]!;
    expect(solution.markdown).toBe("");
    expect(solution.chars).toBe(0);
    expect(solution.generated).toBe(false);
    expect(solution.generated_at).toBeNull();
    // 不落盘：目录文件数不变
    expect(readdirSync(outDir).length).toBe(before);

    // 生成后（= 有正式版文件）才有正文：见下一条用例的完整链路
  });

  it("生成过正式版后：GET 返回各自正式版内容，导出写盘的内容与 GET 一致（所见即所得）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "正式版场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      // 直接落一份"模型写的"正文，模拟生成完成（<id>.solution.md）
      const sampleSolution = "## 现状与问题\n\n解决方案正式版正文。\n\n## 下一步\n\n边界。";
      writeFileSync(join(dir, `${scenarioId}.solution.md`), sampleSolution, "utf8");

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables`,
      });
      const { reports } = res.json() as {
        reports: Record<string, { generated: boolean; markdown: string }>;
      };
      expect(reports["solution"]!.generated).toBe(true);
      expect(reports["solution"]!.markdown).toBe(sampleSolution);

      const exp = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      const { files } = exp.json() as { files: string[] };
      expect(files).toHaveLength(1);
      expect(files[0]!.endsWith("正式版场景解决方案.md")).toBe(true);
      expect(readFileSync(files[0]!, "utf8")).toBe(sampleSolution);
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("旧项目的定稿不会消失：#136 之前落的 <id>.external.md 仍被 solution 读到（只读兜底）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "旧文件场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-legacy-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      const legacy = "# 旧文件场景 对外汇报材料 2026-10-07\n\n## 现状\n\n改名之前的定稿。";
      writeFileSync(join(dir, `${scenarioId}.external.md`), legacy, "utf8");

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables`,
      });
      const { reports } = res.json() as {
        reports: Record<string, { generated: boolean; markdown: string }>;
      };
      expect(reports["solution"]!.generated).toBe(true);
      expect(reports["solution"]!.markdown).toBe(legacy);
      expect(existsSync(join(dir, `${scenarioId}.solution.md`))).toBe(false);
    } finally {
      delete process.env.DELIVERABLE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /deliverables：场景不存在 404", async () => {
    const h = makeHarness();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/projects/nope/deliverables",
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

  it("GET system/status：DB ok + 默认未配置模型（v1.6 口径，不再探 DSH）", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/system/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      db: "ok",
      model_configured: false,
      provider_count: 0,
      default_model: null,
    });
  });

  it("GET providers：默认空登记表", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/system/providers" });
    expect(res.json()).toEqual({ configured: false, providers: [], default_model: null });
  });

  it("POST providers：新建/更新 + 密钥脱敏不回显；非法链接 400", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-a", base_url: "https://a.example.com/v1/", api_key: "sk-secret-9999", models: ["m-1", "m-2"] },
    });
    expect(created.statusCode).toBe(200);
    const pub = created.json();
    expect(pub.base_url).toBe("https://a.example.com/v1");
    expect(pub.has_key).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret-9999");

    // 更新时省略 api_key → 保留原密钥
    const updated = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-a", base_url: "https://b.example.com/v1", models: [{ id: "m-1" }] },
    });
    expect(updated.json().has_key).toBe(true);

    const bad = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-b", base_url: "ftp://x", models: ["m"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("http");
  });

  it("PUT providers/default：设默认成功/模型不属于供应商 400；status 转已配置需有 Key", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-a", base_url: "https://a.example.com/v1", api_key: "sk-1", models: ["m-1"] },
    });
    const ok = await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/providers/default",
      payload: { provider: "p-a", model: "m-1" },
    });
    expect(ok.json()).toEqual({ provider: "p-a", model: "m-1" });

    const badModel = await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/providers/default",
      payload: { provider: "p-a", model: "ghost" },
    });
    expect(badModel.statusCode).toBe(400);

    const status = await h.app.inject({ method: "GET", url: "/api/v1/system/status" });
    expect(status.json().model_configured).toBe(true);
    expect(status.json().default_model).toEqual({ provider: "p-a", model: "m-1" });
  });

  it("DELETE providers/:name：删除成功；不存在 404；删默认所在供应商清空默认", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-del", base_url: "https://d.example.com/v1", api_key: "sk-1", models: ["m"] },
    });
    await h.app.inject({
      method: "PUT",
      url: "/api/v1/system/providers/default",
      payload: { provider: "p-del", model: "m" },
    });
    const gone = await h.app.inject({ method: "DELETE", url: "/api/v1/system/providers/p-del" });
    expect(gone.json()).toEqual({ deleted: true });
    const status = await h.app.inject({ method: "GET", url: "/api/v1/system/status" });
    expect(status.json().default_model).toBeNull();
    const again = await h.app.inject({ method: "DELETE", url: "/api/v1/system/providers/p-del" });
    expect(again.statusCode).toBe(404);
  });

  it("POST providers/test：草稿链接两段式检查（fetch mock，不出网）", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "p" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const draft = await h.app.inject({
        method: "POST",
        url: "/api/v1/system/providers/test",
        payload: { base_url: "https://t.example.com/v1", api_key: "sk-t", model: "m-1" },
      });
      expect(draft.statusCode).toBe(200);
      expect(draft.json().ok).toBe(true);
      expect(draft.json().stage).toBe("chat");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST providers/test：测已存供应商时密钥服务端侧取，未知供应商 404，缺参数 400", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-saved", base_url: "https://s.example.com/v1", api_key: "sk-saved", models: ["m-x"] },
    });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "m-x" }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "p" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/v1/system/providers/test",
        payload: { name: "p-saved" },
      });
      expect(r.json().ok).toBe(true);
      // 请求带上了存储侧密钥（不回前端）
      const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-saved");
    } finally {
      vi.unstubAllGlobals();
    }

    const nf = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers/test",
      payload: { name: "ghost" },
    });
    expect(nf.statusCode).toBe(404);
    const missing = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers/test",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
  });

  it("POST providers/models：草稿裸域名候选探测发现模型并回传修正后链接", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url) === "https://t.example.com/v1/models"
        ? new Response(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-0" }] }), { status: 200 })
        : new Response(JSON.stringify({ data: [] }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/v1/system/providers/models",
        payload: { base_url: "https://t.example.com", api_key: "sk-t" },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { ok: boolean; models: string[]; resolved_base_url?: string };
      expect(body.ok).toBe(true);
      expect(body.models).toEqual(["m-0", "m-1"]);
      expect(body.resolved_base_url).toBe("https://t.example.com/v1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST providers/models：按名测已存供应商（密钥服务端侧取），未知 404", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers",
      payload: { name: "p-list", base_url: "https://s.example.com/v1", api_key: "sk-saved", models: ["m-x"] },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "m-x" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/v1/system/providers/models",
        payload: { name: "p-list" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().models).toEqual(["m-x"]);
      const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-saved");
    } finally {
      vi.unstubAllGlobals();
    }

    const nf = await h.app.inject({
      method: "POST",
      url: "/api/v1/system/providers/models",
      payload: { name: "ghost" },
    });
    expect(nf.statusCode).toBe(404);
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
