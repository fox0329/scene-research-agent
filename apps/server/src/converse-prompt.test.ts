/**
 * @scene/server — 对话助手「操作手册」的口径守卫
 *
 * 为什么单独守：这份 prompt 决定**应用内助手怎么给用户讲业务流程**。
 * 它曾经漂移过——信息模型重构（8 阶段 / 无质量关）之后，prompt 里还写着
 * 「9 阶段业务流…每阶段产出质量关建议」，用户问"有几个阶段"就会得到 9 阶段的答案。
 * 这类漂移不会让任何测试失败，只会让产品说错话，所以在这里钉死。
 */

import { describe, it, expect, vi } from "vitest";
import type { Conversation, DshClient, FollowEvent, Scenario } from "@scene/contract";
import type { Repo, MessageRepo } from "@scene/infra";
import {
  CONVERSE_SYSTEM_PROMPT,
  createConverseCommand,
  type ConverseDb,
} from "./converse.js";

describe("对话助手操作手册口径", () => {
  it("描述现行 6 阶段（0-5）与 6 流程步", () => {
    expect(CONVERSE_SYSTEM_PROMPT).toContain("6 个阶段（0-5）");
    expect(CONVERSE_SYSTEM_PROMPT).toContain("共 6 步");
    expect(CONVERSE_SYSTEM_PROMPT).toContain("材料解析与入库");
  });

  it("不再出现已废止的 9 阶段 / 质量关 / 建议档位表述", () => {
    expect(CONVERSE_SYSTEM_PROMPT).not.toContain("9 阶段");
    expect(CONVERSE_SYSTEM_PROMPT).not.toMatch(/每阶段产出质量关/);
    // 「质量关」只允许出现在"没有质量关"这类否定句里
    const pos = CONVERSE_SYSTEM_PROMPT.indexOf("质量关");
    expect(CONVERSE_SYSTEM_PROMPT.slice(Math.max(0, pos - 8), pos)).toContain("没有");
  });

  it("说明「场景定义」对话不占步，且定义只以表1-1 为准", () => {
    expect(CONVERSE_SYSTEM_PROMPT).toContain("不计入 8 步");
    expect(CONVERSE_SYSTEM_PROMPT).toContain("表1-1");
    expect(CONVERSE_SYSTEM_PROMPT).toContain("不要直接改它");
  });
});

// ─── 回归：定义块不得再直接改写 scenario.description ──────────

function makeDeps(reply: string) {
  const scenario: Scenario = {
    id: "s1",
    name: "智慧水务",
    description: "派生缓存（来自表1-1）",
    product_line_id: null,
    status: "进行中",
    current_stage: 0,
  } as unknown as Scenario;

  const update = vi.fn();
  const conversations = new Map<string, Conversation>();
  const messages: { id: string; conversation_id: string; role: string; content: string }[] = [];

  const conversationRepo = {
    insert: (row: Partial<Conversation>) => {
      const conv = { id: "c1", status: "活跃", ...row } as Conversation;
      conversations.set(conv.id, conv);
      return conv;
    },
    getById: (id: string) => conversations.get(id),
    list: () => [...conversations.values()],
    update: vi.fn(),
    deleteById: vi.fn(),
  } as unknown as Repo<Conversation>;

  const messageRepo = {
    insert: (row: { conversation_id: string; role: string; content: string }) => {
      const m = { id: `m${messages.length + 1}`, ...row };
      messages.push(m);
      return m;
    },
    listByConversation: (id: string) => messages.filter((m) => m.conversation_id === id),
  } as unknown as MessageRepo;

  const scenarioRepo = {
    getById: () => scenario,
    update,
  } as unknown as ConverseDb["scenarioRepo"];

  const dshClient = {
    createSession: vi.fn(async () => ({ sessionId: "sess" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      yield { type: "text", text: reply };
      yield { type: "done" };
    }),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;

  return {
    db: { conversationRepo, messageRepo, scenarioRepo } as unknown as ConverseDb,
    dshClient,
    update,
  };
}

describe("场景定义只以表1-1 为准（不再由对话改写 description）", () => {
  it("回复里的【场景定义 v2】块不会被回写，也不加「已更新」话术", async () => {
    const reply = "好的，我记下了。\n\n【场景定义 v2】\n场景是市政水务的漏损监测，范围出厂到管网。";
    const { db, dshClient, update } = makeDeps(reply);
    const cmd = createConverseCommand({ db, dshClient });

    const conv = await cmd.create({ scenario_id: "s1", title: "测试" });
    for await (const _ of cmd.sendMessage(conv.id, "范围只看出厂到管网")) {
      /* 消费流 */
    }

    // 关键：不再有第二个定义来源
    expect(update).not.toHaveBeenCalled();
    const sys = db.messageRepo.listByConversation(conv.id).filter((m) => m.role === "系统");
    expect(sys[0]!.content).not.toContain("场景定义已更新");
    // 原文保留（不再剥离"更新块"）
    expect(sys[0]!.content).toContain("【场景定义 v2】");
  });
});
