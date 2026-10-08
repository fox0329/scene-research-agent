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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent, StageId } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";

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
  // 每个 harness 用独立临时登记表：默认"未配置"态，不碰项目 data/
  process.env.SCENE_PROVIDERS_FILE = join(
    mkdtempSync(join(tmpdir(), "scene-providers-")),
    "providers.local.json",
  );
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
      table_code: "表1-2",
      row: { link: "视频监控", can_touch: "可以碰", our_role: "替代", description: "接入" },
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
    expect(body.rows[0]!.table_code).toBe("表1-2");
    // 阶段 1 共 8 张表；完整度只给缺口，不给判定
    expect(body.completeness.expectedTables).toBe(8);
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

  it("?step=2 的完整度只算本步 7 张表（表1-1 归第 1 步）", async () => {
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
    expect(stepC.expectedTables).toBe(7);
  });

  it("阶段面板 ?step=2 也按本步表集给完整度", async () => {
    const { scenarioId } = seedScenario(h.db, "面板范围场景");
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1?step=2`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { completeness: { expectedTables: number } }).completeness.expectedTables).toBe(7);
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
      product_line_id: plId,
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
      product_line_id: plId,
      status: "进行中",
      current_stage: 4,
    });
    const b = h.db.scenarioRepo.insert({
      name: "场景B（显式排除通用库）",
      product_line_id: plId,
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
      product_line_id: plId,
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
      product_line_id: plId,
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
  it("POST export 写出两份 md：<场景>解决方案.md + <场景>建设工作方案.md（变更表 #137）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "导出场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-export-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      expect(res.statusCode).toBe(200);
      const { files } = res.json() as { files: string[] };
      // 两份都是客户端可读的正式交付物，各按自己的章节骨架装配
      expect(files).toHaveLength(2);
      for (const f of files) expect(existsSync(f), f).toBe(true);
      expect(files[0]!.endsWith("导出场景解决方案.md")).toBe(true);
      expect(files[1]!.endsWith("导出场景建设工作方案.md")).toBe(true);
      expect(readFileSync(files[0]!, "utf-8")).toContain("## 现状");
      expect(readFileSync(files[1]!, "utf-8")).toContain("## 建设背景与必要性");
      expect(readFileSync(files[1]!, "utf-8")).not.toContain("## 现状");

      // 再导一次：两份都还在，文件名不变（导出幂等）
      const again = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      expect(again.statusCode).toBe(200);
      const second = again.json() as { files: string[] };
      expect(second.files).toHaveLength(2);
      expect(second.files[0]!.endsWith("导出场景解决方案.md")).toBe(true);
      expect(second.files[1]!.endsWith("导出场景建设工作方案.md")).toBe(true);
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

  it("POST export-docx 把两份交付物按同一版式写成 Word（变更表 #133 / #137）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "Word 场景");
    const dir = mkdtempSync(join(homedir(), ".scene-docx-test-"));
    try {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export-docx`,
        payload: { dir },
      });
      expect(res.statusCode).toBe(200);
      const { files } = res.json() as { files: string[] };
      // 两份：解决方案 + 建设工作方案（同一个渲染器、同一套 Word 模板）
      expect(files).toHaveLength(2);
      for (const f of files) {
        expect(f.startsWith(dir)).toBe(true);
        expect(f.endsWith(".docx")).toBe(true);
        const head = readFileSync(f).subarray(0, 2).toString("utf8");
        expect(head, f).toBe("PK"); // zip 魔数
      }
      expect(files[0]!.endsWith("Word 场景解决方案.docx")).toBe(true);
      expect(files[1]!.endsWith("Word 场景建设工作方案.docx")).toBe(true);
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
      expect(second.unchanged.length).toBe(2);
      expect(second.unchanged[0]!.endsWith("Word 场景解决方案.docx")).toBe(true);
      expect(second.unchanged[1]!.endsWith("Word 场景建设工作方案.docx")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("PUT deliverables/construction 保存成功，且两份互不串（变更表 #137 新增）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "互不串场景");
    const dir = mkdtempSync(join(homedir(), ".scene-save-kind-test-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      const saved = await h.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${scenarioId}/deliverables/construction`,
        payload: { markdown: "# 互不串场景建设工作方案\n\n## 建设路径\n\n手改的建设路径正文\n" },
      });
      expect(saved.statusCode).toBe(200);
      const body = saved.json() as { path: string; written: boolean; overwritten: boolean };
      expect(body.written).toBe(true);
      expect(body.overwritten).toBe(false);
      // 落盘是 <id>.construction.md，不碰 <id>.solution.md
      expect(body.path).toBe(join(dir, `${scenarioId}.construction.md`));
      expect(readFileSync(body.path, "utf8")).toContain("手改的建设路径正文");
      expect(existsSync(join(dir, `${scenarioId}.solution.md`))).toBe(false);

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
      // 建设工作方案：读到刚保存的正文
      expect(reports["construction"]!.markdown).toContain("手改的建设路径正文");
      expect(reports["construction"]!.generated).toBe(true);
      expect(reports["construction"]!.generated_at).toBeTruthy();
      expect(reports["construction"]!.chars).toBeGreaterThan(0);
      // 解决方案不受影响：还是要点版，且不含建设工作方案的正文
      expect(reports["solution"]!.generated).toBe(false);
      expect(reports["solution"]!.markdown).toContain("## 现状");
      expect(reports["solution"]!.markdown).not.toContain("手改的建设路径正文");
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
      expect(res.json().error).toContain("solution、construction");
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

  it("GET /deliverables：中栏取两份正文（装配但不落盘）", async () => {
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
    // 变更表 #137：两份——解决方案 + 建设工作方案
    expect(Object.keys(reports).sort()).toEqual(["construction", "solution"]);
    expect(reports["solution"]!.markdown).toContain("解决方案");
    expect(reports["solution"]!.markdown).toContain("取正文场景");
    // 章标题不带手写序号（五章：现状 / 场景与问题 / 方案 / 价值 / 下一步）
    expect(reports["solution"]!.markdown).toContain("## 现状");
    expect(reports["solution"]!.markdown).not.toContain("## 一、现状");
    // 建设工作方案按自己的章节骨架装配（不是解决方案的复制）
    expect(reports["construction"]!.markdown).toContain("建设工作方案");
    expect(reports["construction"]!.markdown).toContain("## 建设背景与必要性");
    expect(reports["construction"]!.markdown).not.toContain("## 一、");
    for (const kind of ["solution", "construction"]) {
      // 要点版没有"生成时间"（正式版才有）——见下一条用例
      expect(reports[kind]!.generated, kind).toBe(false);
      expect(reports[kind]!.generated_at, kind).toBeNull();
      expect(reports[kind]!.chars, kind).toBeGreaterThan(0);
    }
    // 只装配不写盘：目录文件数不变
    expect(readdirSync(outDir).length).toBe(before);
  });

  it("生成过正式版后：GET 返回各自正式版内容，导出写盘的内容与 GET 一致（所见即所得）", async () => {
    const h = makeHarness();
    const { scenarioId } = seedScenario(h.db, "正式版场景");
    const dir = mkdtempSync(join(tmpdir(), "scene-deliverable-"));
    process.env.DELIVERABLE_DIR = dir;
    try {
      // 直接落两份"模型写的"正文，模拟生成完成（<id>.solution.md / <id>.construction.md）
      const sampleSolution = "## 现状\n\n解决方案正式版正文。\n\n## 下一步\n\n边界。";
      const sampleConstruction = "## 建设内容\n\n建设工作方案正式版正文。";
      writeFileSync(join(dir, `${scenarioId}.solution.md`), sampleSolution, "utf8");
      writeFileSync(join(dir, `${scenarioId}.construction.md`), sampleConstruction, "utf8");

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${scenarioId}/deliverables`,
      });
      const { reports } = res.json() as {
        reports: Record<string, { generated: boolean; markdown: string }>;
      };
      expect(reports["solution"]!.generated).toBe(true);
      expect(reports["solution"]!.markdown).toBe(sampleSolution);
      expect(reports["construction"]!.generated).toBe(true);
      expect(reports["construction"]!.markdown).toBe(sampleConstruction);

      const exp = await h.app.inject({
        method: "POST",
        url: `/api/v1/projects/${scenarioId}/deliverables/export`,
      });
      const { files } = exp.json() as { files: string[] };
      expect(files).toHaveLength(2);
      expect(files[0]!.endsWith("正式版场景解决方案.md")).toBe(true);
      expect(files[1]!.endsWith("正式版场景建设工作方案.md")).toBe(true);
      expect(readFileSync(files[0]!, "utf8")).toBe(sampleSolution);
      expect(readFileSync(files[1]!, "utf8")).toBe(sampleConstruction);
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
      // 兜底只对 solution 生效：建设工作方案不受旧文件影响（各写各的新路径）
      expect(reports["construction"]!.generated).toBe(false);
      expect(reports["construction"]!.markdown).not.toBe(legacy);
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
