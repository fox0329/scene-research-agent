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
  DEFINITION_SYSTEM,
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
  const line = db.productLineRepo.insert({ name: "感知与控制" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    product_line_id: line.id,
    status: "进行中",
    current_stage: 0,
  });
  return { db, scenarioId: sc.id };
}

const consolidation = JSON.stringify({
  items: [
    { item: "客户类型/行业", content: "市政水务集团", source_type: "用户补充" },
    { item: "覆盖什么", content: "制水到管网", source_type: "用户补充" },
    { item: "核心用途", content: "漏损监测", source_type: "AI推断" },
    { item: "不存在的项", content: "应被丢弃", source_type: "用户补充" },
    { item: "明确不含什么", content: "", source_type: "AI推断" },
  ],
  intent: "这个场景值不值得进",
  open_questions: ["含不含二次供水？", "第二问", "第三问", "第四问应被截断"],
});

describe("scenario-definition — 系统提示词与上下文", () => {
  it("提示词约束：只谈场景本体、每轮 ≤3 问、不给判断、不主动输出定义块", () => {
    expect(DEFINITION_SYSTEM).toContain("最多 3 个");
    expect(DEFINITION_SYSTEM).toContain("只谈场景本体");
    expect(DEFINITION_SYSTEM).toContain("不要给判断");
    expect(DEFINITION_SYSTEM).toContain("输出任何 JSON");
  });

  it("上下文列出表1-1 全部固定项与状态标记（含必确认标记）", () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" },
      { item: "核心用途", content: "漏损监测", source_type: "AI推断" },
    ]);
    const ctx = buildDefinitionContext(db, db.scenarioRepo.getById(scenarioId)!);
    expect(ctx).toContain("场景名称：智慧水务");
    expect(ctx).toContain("客户类型/行业（必确认）：市政水务集团 【用户已确认】");
    expect(ctx).toContain("核心用途（必确认）：漏损监测 【系统推断·待确认】");
    // 未提及的项标「还空着」，提示模型只补空缺
    expect(ctx).toContain("【还空着】");
    expect(ctx).toContain("明确不含什么（必确认）：（空） 【还空着】");
  });
});

describe("scenario-definition — 整理结果收敛", () => {
  it("丢弃非固定项与空内容；source_type 只接受 用户补充 / AI推断", () => {
    const rows = normalizeConsolidatedItems({
      items: [
        { item: "客户类型/行业", content: "x", source_type: "用户确认" },
        { item: "覆盖什么", content: "y", source_type: "用户补充" },
        { item: "乱写的项", content: "z", source_type: "用户补充" },
        { item: "核心用途", content: "  ", source_type: "AI推断" },
        { item: "明确不含什么", content: "未提供", source_type: "AI推断" },
      ],
    });
    // 非固定项与空内容被丢弃；保留的是「客户类型/行业」（自称用户确认 → 降级）与「覆盖什么」
    expect(rows.map((r) => r.item)).toEqual(["客户类型/行业", "覆盖什么"]);
    // 模型自称「用户确认」→ 降级为推断（保留内容，但绝不落成用户确认）
    expect(rows[0]?.source_type).toBe("AI推断");
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
    expect(out.openQuestions).toHaveLength(3);
    const rows = readAnchorRows(db, scenarioId);
    expect(rows.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团");
    expect(rows.find((r) => r.item === "客户类型/行业")?.source_type).toBe("用户补充");
    expect(rows.find((r) => r.item === "核心用途")?.source_type).toBe("AI推断");
    expect(rows.some((r) => r.item === "不存在的项")).toBe(false);
    expect(readBrief(db, scenarioId)?.intent).toBe("这个场景值不值得进");
    expect(hasDefinition(db, scenarioId)).toBe(true);
  });

  it("保留用户已确认的行（用户的决定优先，整理不覆盖）", async () => {
    const { db, scenarioId } = setup();
    ensureAnchorRows(db, scenarioId, "智慧水务");
    writeAnchorRows(db, scenarioId, [
      { item: "客户类型/行业", content: "市政水务集团（含排水）", source_type: "用户确认" },
    ]);
    const dsh = mockDsh(consolidation);
    const convId = await ensureDefinitionConversation(db, dsh, db.scenarioRepo.getById(scenarioId)!);
    await consolidateDefinition(db, dsh, db.scenarioRepo.getById(scenarioId)!, convId);
    const row = readAnchorRows(db, scenarioId).find((r) => r.item === "客户类型/行业");
    expect(row?.content).toBe("市政水务集团（含排水）");
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

  it("GET /definition 幂等创建「场景定义」会话并返回消息与锚行", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/definition`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversation_id: string; messages: unknown[]; anchor: unknown[] };
    expect(body.conversation_id).toBeTruthy();
    expect(body.messages).toEqual([]);
    expect(body.anchor).toHaveLength(12);
    // 幂等
    const again = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/definition`,
    });
    expect((again.json() as { conversation_id: string }).conversation_id).toBe(body.conversation_id);
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
    expect(body.rows.some((r) => r.content === "市政水务集团")).toBe(true);
    expect(body.alignment).toHaveLength(6); // 只对 L1 六项做对照
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

  it("整理后流程第 1 步变为就绪（就绪看定义是否已整理）", async () => {
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
    expect(first.ready).toBe(true);
    expect(first.readyHint).toContain("定义已整理");
  });
});
