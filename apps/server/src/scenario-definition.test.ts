/**
 * @scene/server — 场景定义（对话式）测试
 *
 * 覆盖用户拍板的三条规则：
 *  1. 只在「整理成定义」时才写表（不自动增量）
 *  2. 整理时保留用户已确认的行
 *  3. 模型只能标 用户补充 / AI推断——**用户确认 永远只能由用户动作产生**
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";
import {
  DEFINITION_CELL_MAX_CHARS,
  DEFINITION_SYSTEM,
  compressCell,
  stripMetaNotes,
  buildDefinitionContext,
  consolidateDefinition,
  ensureDefinitionConversation,
  normalizeConsolidatedItems,
  hasDefinition,
} from "./scenario-definition.js";
import { readAnchorRows, ensureAnchorRows, writeAnchorRows, readBrief } from "./scenario-anchor.js";

/** 造一个按需返回指定文本的 mock DSH */
function mockDsh(text: string): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s-def" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      yield { type: "text", text };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

function setup(): { db: DbInstance; scenarioId: string } {
  const db = createDb(":memory:");
  db.productLineRepo.insert({ name: "感知与控制" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    status: "进行中",
    current_stage: 0,
  });
  return { db, scenarioId: sc.id };
}

/**
 * 模型整理输出夹具（新口径）
 *
 * 三条规则同时被验证：
 *  - **智能体侧的 5 项业务画像收 `AI推断`**（这是本职工作，不再当噪音丢掉）
 *  - **用户侧的项（场景名称）不许替用户编** → 模型猜的一律丢弃
 *  - 空内容不落行；对不上的项名显式记为 dropped
 */
const consolidation = JSON.stringify({
  items: [
    { item: "场景名称", content: "模型编的名字", source_type: "AI推断" },
    { item: "场景边界", content: "制水厂到管网末端", source_type: "AI推断" },
    { item: "生产对象", content: "加药、过滤、加压输送", source_type: "AI推断" },
    { item: "不存在的项", content: "应被丢弃", source_type: "AI推断" },
    { item: "买方类型", content: "", source_type: "AI推断" },
  ],
  intent: "这个场景值不值得进",
  open_questions: ["含不含二次供水？", "第二问", "第三问", "第四问应被截断"],
});

describe("scenario-definition — 系统提示词与上下文", () => {
  it("提示词约束：先替用户写画像、只问只有用户才知道的取舍、不给判断", () => {
    // 用户定调："用户只负责输入场景名称，智能体只负责从业务角度说清楚场景的范围"
    //          "用户什么都知道还要我们干什么？"
    expect(DEFINITION_SYSTEM).toContain("最多 2 个");
    expect(DEFINITION_SYSTEM).toContain("允许抽象、允许说不准");
    expect(DEFINITION_SYSTEM).toContain("不要追问边界");
    expect(DEFINITION_SYSTEM).toContain("把画像直接写出来");
    expect(DEFINITION_SYSTEM).toContain("禁止");
    expect(DEFINITION_SYSTEM).toContain("只谈行业与场景本体");
    expect(DEFINITION_SYSTEM).toContain("不要给判断");
    expect(DEFINITION_SYSTEM).toContain("输出任何 JSON");
    // 参考写法要点名"燃气场站"，这是验收标准
    expect(DEFINITION_SYSTEM).toContain("燃气场站");
    // 用户实测：亲口给的楼栋/人数/访客量/预算被模型改写成"行业口径"，这是编造的反面
    expect(DEFINITION_SYSTEM).toContain("用户亲口给出的数字与范围不是编造");
  });

  it("整理提示词：用户给出的事实优先，不许改写成行业口径", async () => {
    const { db, scenarioId } = setup();
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    const calls = vi.mocked(dsh.prompt).mock.calls;
    const last = calls[calls.length - 1]?.[1] as { user?: string } | undefined;
    expect(last?.user).toContain("用户说过的事实优先级最高");
    expect(last?.user).toContain("行业口径/量级待确认");
  });

  it("上下文列出表1-1 全部固定项与属主/状态标记（不再有「待确认」）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "场景边界", content: "制水厂到管网末端", source_type: "用户确认" },
      { item: "生产对象", content: "加药、过滤、加压输送", source_type: "AI推断" },
    ]);
    const ctx = buildDefinitionContext(db, db.scenarioRepo.getById(scenarioId)!);
    expect(ctx).toContain("场景名称（用户输入）：智慧水务");
    expect(ctx).toContain("场景边界（你负责写）：制水厂到管网末端 【用户已确认】");
    // 智能体自己写的画像标明"是推断"，但不是"待确认"（那个概念已取消）
    expect(ctx).toContain("生产对象（你负责写）：加药、过滤、加压输送 【智能体推断】");
    expect(ctx).not.toContain("待确认");
    // 未提及的项标「还空着」，提示模型只补空缺
    expect(ctx).toContain("采购特征（你负责写）：（空） 【还空着】");
  });
});

describe("scenario-definition — 正文去噪（用户投诉「大量无效信息」）", () => {
  it("剥离元说明注解（谁说的由来源字段表达，不该写进正文）", () => {
    expect(stripMetaNotes("水厂中控室值班人员（用户未明说，按行业通行情况推断）")).toBe(
      "水厂中控室值班人员",
    );
    expect(
      stripMetaNotes("不含管网输配、二次供水（对话中由助手按行业通行情况推断范围外，用户未明确否定）"),
    ).toBe("不含管网输配、二次供水");
    expect(stripMetaNotes("正常内容（括号里是补充说明）")).toBe("正常内容（括号里是补充说明）");
  });

  it("超长格按句界压到上限（定义要一句话，不要 88–115 字的段落）", () => {
    // 对齐用户真实数据里最长的那格（核心业务流程 115 字）
    const long =
      "原水取入→加药混凝沉淀→过滤→消毒→出厂水送管网；过程中由现场仪表/PLC采集流量、压力、浊度、余氯、pH等水质与工艺参数，汇总到中控室监控系统，值班人员看数、加减药量、调泵启停与转速、处理报警、记运行台账，并向上级/监管上报数据";
    const out = compressCell(long);
    expect(out.length).toBeLessThanOrEqual(DEFINITION_CELL_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
    // 短内容原样保留
    expect(compressCell("市政水务集团")).toBe("市政水务集团");
  });

  it("重新整理：业务画像留着（不再「这次没提就抹掉」），旧 12 项制的残项被清空", async () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      // 上次整理写出的画像（带元说明注解 → 要剥掉，但内容要留）
      { item: "买方类型", content: "园区开发主体（用户未明说，按行业通行情况推断）", source_type: "AI推断" },
      // 旧 12 项制残项：已不在表定义里 → 清空
      { item: "价值主张", content: "用漏损率下降换运维成本", source_type: "AI推断" },
    ]);
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);

    const rows = readAnchorRows(db, scenarioId);
    // 画像本体是交付物，不能因为"这次没再产出"就洗掉；元说明注解要剥掉
    expect(rows.find((r) => r.item === "买方类型")?.content).toBe("园区开发主体");
    // 历史残项（表1-1 已经没有「价值主张」这一项）清空
    expect(rows.find((r) => r.item === "价值主张")?.content ?? "").toBe("");
    // 本次整理新写出的内容也在
    expect(rows.find((r) => r.item === "场景边界")?.content).toBe("制水厂到管网末端");
  });
});

describe("scenario-definition — 整理结果收敛", () => {
  it("优先 item_key 匹配；空内容不落行；丢弃项被显式记录（不静默）", () => {
    const { rows, dropped } = normalizeConsolidatedItems({
      items: [
        { item_key: "scene_boundary", content: "制水到管网", source_type: "用户确认" },
        { item: "采购特征", content: "集采 + 项目制", source_type: "AI推断" },
        { item: "乱写的项", content: "z", source_type: "用户补充" },
        { item: "生产对象", content: "  ", source_type: "AI推断" },
        { item: "买方类型", content: "未提供", source_type: "AI推断" },
      ],
    });
    expect(rows.map((r) => r.item)).toEqual(["场景边界", "采购特征"]);
    // 模型自称「用户确认」→ 降级为推断（保留内容，但绝不落成用户确认）
    expect(rows[0]?.source_type).toBe("AI推断");
    // 匹配不到的项名被列出来（真机上曾因标签对不上而静默丢失）
    expect(dropped).toEqual(["乱写的项"]);
  });

  it("中文标签与注册表不完全一致时仍能对上（真机暴露的问题）", () => {
    // 真机现象：模型输出「客户类型」「不含什么」这类近似标签，
    // 早期精确匹配把它们全丢掉，导致"整理后 L1 全空"而 used_llm=true
    const { rows, dropped } = normalizeConsolidatedItems({
      items: [
        { item: "边界", content: "制水厂到管网末端", source_type: "AI推断" },
        { item: "覆盖范围", content: "出厂到管网（近义改写，与上一项同项 → 先到先得）", source_type: "AI推断" },
        { item: "采购方式", content: "集团集采 + 项目制招标", source_type: "AI推断" },
      ],
    });
    expect(dropped).toEqual([]);
    expect(rows.map((r) => r.item)).toEqual(["场景边界", "采购特征"]);
  });

  it("同项重复输出时先到先得（不产生重复行）", () => {
    const { rows } = normalizeConsolidatedItems({
      items: [
        { item_key: "scene_boundary", content: "第一版", source_type: "AI推断" },
        { item: "边界", content: "第二版", source_type: "AI推断" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("第一版");
  });
});

describe("scenario-definition — 整理成定义", () => {
  it("把对话整理成表1-1，并写入「想搞清楚什么」", async () => {
    const { db, scenarioId } = setup();
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    db.messageRepo.insert({ conversation_id: convId, role: "用户", content: "看看市政水务的漏损场景" });

    const out = await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    expect(out.usedLlm).toBe(true);
    expect(out.openQuestions).toHaveLength(2); // 最多 2 个
    const rows = readAnchorRows(db, scenarioId);
    // 智能体写的业务画像照收（这就是交付物）
    expect(rows.find((r) => r.item === "场景边界")?.content).toBe("制水厂到管网末端");
    expect(rows.find((r) => r.item === "场景边界")?.source_type).toBe("AI推断");
    // 用户侧的项不许替用户编：模型给「场景名称」猜的名字被丢弃，保留用户给的
    expect(rows.find((r) => r.item === "场景名称")?.content).toBe("智慧水务");
    expect(out.inferredDropped).toBe(1);
    expect(rows.some((r) => r.item === "不存在的项")).toBe(false);
    expect(readBrief(db, scenarioId)?.intent).toBe("这个场景值不值得进");
    expect(hasDefinition(db, scenarioId)).toBe(true);
  });

  it("保留用户已确认的行（用户的决定优先，整理不覆盖）", async () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "场景边界", content: "只做排水，不含供水", source_type: "用户确认" },
    ]);
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    const row = readAnchorRows(db, scenarioId).find((r) => r.item === "场景边界");
    expect(row?.content).toBe("只做排水，不含供水");
    expect(row?.source_type).toBe("用户确认");
  });

  it("不覆盖用户已填的「想搞清楚什么」", async () => {
    const { db, scenarioId } = setup();
    const { upsertBrief } = await import("./scenario-anchor.js");
    upsertBrief(db, scenarioId, { scene_name: "智慧水务", intent: "用户自己写的诉求" });
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    expect(readBrief(db, scenarioId)?.intent).toBe("用户自己写的诉求");
  });

  it("模型不可用时降级：不写任何内容，也不抛错", async () => {
    const { db, scenarioId } = setup();
    const dsh: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s" })),
      prompt: vi.fn(() => {
        throw new Error("no key");
      }),
      cancel: vi.fn(async () => {}),
    };
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    const out = await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    expect(out.usedLlm).toBe(false);
    expect(hasDefinition(db, scenarioId)).toBe(false);
  });

  it("有界等待：模型长时间无输出时降级（不挂起、不写内容）", async () => {
    const { db, scenarioId } = setup();
    const slow: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s" })),
      // 每 20ms 吐一次，永远不结束 → 应被超时截断
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: "text", text: "…" };
        }
      }),
      cancel: vi.fn(async () => {}),
    };
    const convId = await ensureDefinitionConversation(db, slow, db.scenarioRepo.getById(scenarioId)!);
    const t0 = Date.now();
    const out = await consolidateDefinition(db, slow, db.scenarioRepo.getById(scenarioId)!, convId, {
      timeoutMs: 120,
    });
    expect(Date.now() - t0).toBeLessThan(2000); // 有界：不会跑满 100×20ms
    expect(out.usedLlm).toBe(false);
    expect(hasDefinition(db, scenarioId)).toBe(false);
  });

  it("幂等：重复整理复用同一个「场景定义」会话", async () => {
    const { db, scenarioId } = setup();
    const dsh = mockDsh(consolidation);
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const a = await ensureDefinitionConversation(db, dsh, sc);
    const b = await ensureDefinitionConversation(db, dsh, sc);
    expect(b).toBe(a);
  });
});

describe("scenario-definition — 路由", () => {
  let db: DbInstance;
  let app: ReturnType<typeof createApp>;
  let scenarioId: string;

  beforeEach(() => {
    const s = setup();
    db = s.db;
    scenarioId = s.scenarioId;
    process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
    process.env.SCENE_PROVIDERS_FILE = join(
      mkdtempSync(join(tmpdir(), "scene-providers-")),
      "providers.local.json",
    );
    app = createApp({ db, dshClient: mockDsh(consolidation), hub: createSseHub() });
  });

  it("GET /definition 只读：不创建会话（没有则为 null），但幂等预建锚骨架", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/definition`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conversation_id: string | null;
      messages: unknown[];
      anchor: unknown[];
    };
    // 读操作不产生副作用：看一眼第 1 步不该在左栏凭空多出一个会话
    expect(body.conversation_id).toBeNull();
    expect(body.messages).toEqual([]);
    expect(body.anchor).toHaveLength(6);

    // 真正发第一条消息时才建会话，此后 GET 能读到它
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/messages`,
      payload: { content: "客户是市政水务集团" },
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/definition`,
    });
    const b2 = after.json() as { conversation_id: string | null; messages: unknown[] };
    expect(b2.conversation_id).toBeTruthy();
    expect(b2.messages.length).toBeGreaterThan(0);

    // 幂等：再读还是同一个会话
    const again = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/definition`,
    });
    expect((again.json() as { conversation_id: string }).conversation_id).toBe(b2.conversation_id);
  });

  it("POST /definition/messages 走 SSE 流", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/messages`,
      payload: { content: "我想梳理市政水务的漏损场景" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload).toContain("event: follow");
  });

  it("POST /definition/consolidate 把对话整理成表1-1 并返回对照", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/messages`,
      payload: { content: "客户是市政水务集团，范围是制水到管网" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/consolidate`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: { item: string; content: string }[];
      alignment: { rowKey: string; alignment: string }[];
      updated: number;
      used_llm: boolean;
    };
    expect(body.used_llm).toBe(true);
    expect(body.rows.some((r) => r.content === "制水厂到管网末端")).toBe(true);
    // 对照表 = 用户侧的项（永远列出）∪ 模型写出来的项（不再要求 6 项齐全）
    const keys = body.alignment.map((a) => a.rowKey);
    expect(keys).toContain("scene_boundary");
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(body.updated).toBeGreaterThan(0);
  });

  it("空消息 400；场景不存在 404", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/messages`,
      payload: { content: "   " },
    });
    expect(bad.statusCode).toBe(400);
    const nf = await app.inject({ method: "GET", url: "/api/v1/projects/nope/definition" });
    expect(nf.statusCode).toBe(404);
  });

  it("回归：经路由新建场景后第 1 步**仍未就绪**（锚骨架只填了「场景名称」，不算画像已写出）", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "只输名称的新场景" },
    });
    const id = (created.json() as { id: string }).id;

    // 锚骨架确实已建，且「场景名称」被填上（这正是让旧判据误判的原因）
    const anchor = (
      await app.inject({ method: "GET", url: `/api/v1/projects/${id}/definition` })
    ).json() as { anchor: { item: string; content: string }[] };
    expect(anchor.anchor.find((r) => r.item === "场景名称")?.content).toBe("只输名称的新场景");

    const flow = (
      await app.inject({ method: "GET", url: `/api/v1/projects/${id}/flow` })
    ).json() as { steps: { id: number; ready: boolean; readyHint: string }[] };
    expect(flow.steps[0]!.ready).toBe(false);
    expect(flow.steps[0]!.readyHint).toContain("场景业务画像");
  });

  it("整理后第 1 步即可推进（就绪=业务画像已写出，不要求用户逐项确认）", async () => {
    const before = await app.inject({ method: "GET", url: `/api/v1/projects/${scenarioId}/flow` });
    expect(
      (before.json() as { steps: { id: number; ready: boolean }[] }).steps[0]!.ready,
    ).toBe(false);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/messages`,
      payload: { content: "客户是市政水务集团" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${scenarioId}/definition/consolidate`,
    });

    const after = await app.inject({ method: "GET", url: `/api/v1/projects/${scenarioId}/flow` });
    const first = (after.json() as { steps: { id: number; ready: boolean; readyHint: string }[] })
      .steps[0]!;
    // 画像写出 → 即可推进；提示只是"看一眼，能改"，不再点名"待确认/已确认"
    expect(first.ready).toBe(true);
    expect(first.readyHint).toContain("场景业务画像已写出");
    expect(first.readyHint).toContain("没问题就继续");
    expect(first.readyHint).not.toContain("待确认");
  });
});

/**
 * 故障清单 #63：装了桌面版、聊完点「整理成定义」，表1-1 六项里五项全空、界面无任何提示。
 *
 * 三层原因各有回归：
 *  ① 项名：提示词同时给了 item_key（scene_name）与中文名，模型把**键填进 item 字段**时
 *     旧解析器只按中文名找 → 六项全判"匹配不到"丢弃；
 *  ② 正文：思考型模型不接受强制 tool_choice（400），去掉后模型看不到 JSON Schema，
 *     会把正文放进 `value` 而不是 `content`；
 *  ③ 失败可见：`prompt` 出错是 **yield error 事件**不是抛异常，旧代码只收 text → 静默空白。
 */
describe("scenario-definition — 模型输出兼容与失败可见（故障清单 #63）", () => {
  it("英文 item_key 填在 item 字段里也能匹配到固定项", () => {
    const out = normalizeConsolidatedItems({
      items: [{ item: "scene_boundary", content: "只含企业园区会议室" }],
    });
    expect(out.dropped).toEqual([]);
    expect(out.rows.map((r) => r.item)).toEqual(["场景边界"]);
  });

  it("正文放在 value 字段也能收（模型没拿到 JSON Schema 时会自起字段名）", () => {
    const out = normalizeConsolidatedItems({
      items: [
        { item_key: "scene_boundary", item: "场景边界", value: "只含企业园区会议室" },
        { item: "production_object", value: "会议预约、音视频、环控" },
      ],
    });
    expect(out.dropped).toEqual([]);
    expect(out.rows.map((r) => r.content)).toEqual([
      "只含企业园区会议室",
      "会议预约、音视频、环控",
    ]);
  });

  it("模型只回 error 事件时：不写表，但原因必须带出来（不许静默空白）", async () => {
    const s = setup();
    const failing: DshClient = {
      createSession: vi.fn(async () => ({ sessionId: "s-err" })),
      prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
        yield {
          type: "error",
          message: "API 请求失败：Bad Request — Thinking mode does not support this tool_choice",
        };
      }),
      cancel: vi.fn(async () => {}),
    } as DshClient;
    const convId = await ensureDefinitionConversation(
      s.db,
      mockDsh(consolidation),
      s.db.scenarioRepo.getById(s.scenarioId)!,
    );
    process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
    const out = await consolidateDefinition(
      s.db,
      failing,
      s.db.scenarioRepo.getById(s.scenarioId)!,
      convId,
    );
    expect(out.usedLlm).toBe(false);
    expect(out.error).toContain("tool_choice");
    // 除"场景名称"（用户输入，建锚骨架时就落好）外，一项都不该被写
    const filled = readAnchorRows(s.db, s.scenarioId).filter(
      (r) => r.content && r.item !== "场景名称",
    );
    expect(filled).toHaveLength(0);
  });

  it("路由把失败原因回给界面（error 字段），不再是 200 空白", async () => {
    const s = setup();
    process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
    process.env.SCENE_PROVIDERS_FILE = join(
      mkdtempSync(join(tmpdir(), "scene-providers-")),
      "providers.local.json",
    );
    await ensureDefinitionConversation(
      s.db,
      mockDsh(consolidation),
      s.db.scenarioRepo.getById(s.scenarioId)!,
    );
    const failingApp = createApp({
      db: s.db,
      hub: createSseHub(),
      dshClient: {
        createSession: vi.fn(async () => ({ sessionId: "s-err" })),
        prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
          yield { type: "error", message: "模型没有返回任何内容" };
        }),
        cancel: vi.fn(async () => {}),
      } as DshClient,
    });
    const res = await failingApp.inject({
      method: "POST",
      url: `/api/v1/projects/${s.scenarioId}/definition/consolidate`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error?: string }).error).toContain("模型没有返回任何内容");
  });
});

