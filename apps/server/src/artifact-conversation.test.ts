/**
 * @scene/server — 产物唯一会话测试
 *
 * 覆盖：产物身份校验（block 不拆会话）、打开不创建、首次 ensure 只建一条、
 * 上下文包含产物行、压缩摘要保留早先决策。
 */

import { describe, it, expect, vi } from "vitest";
import type { DshClient } from "@scene/contract";
import { createDb } from "@scene/infra";
import {
  buildArtifactContext,
  currentArtifactHash,
  ensureArtifactConversation,
  fillTableFromCommand,
  findArtifactConversation,
  normalizeArtifactRef,
  readArtifactThread,
  touchArtifactConversation,
} from "./artifact-conversation.js";
import { compactConversationHistory } from "./conversation-compaction.js";
import { isUserConversation } from "./conversation-kind.js";

function mockDsh(): DshClient {
  return {
    createSession: vi.fn(async ({ title }: { title: string }) => ({
      sessionId: `dsh-${title}`,
    })),
    prompt: vi.fn(),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

function seedScenario(db: ReturnType<typeof createDb>): string {
  const scenario = db.scenarioRepo.insert({
    name: "智慧会议室",
    description: "客户要做一间 50 人会议室",
    status: "进行中",
    current_stage: 1,
  });
  return scenario.id;
}

describe("normalizeArtifactRef", () => {
  it("表格产物必须属于对应流程步，并推导业务标题", () => {
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: "现状",
      title: "",
    });
    expect(ref).toMatchObject({ step: 2, stage: 1, type: "table", id: "表1-3", block: "现状" });
    expect(ref.title.length).toBeGreaterThan(0);
  });

  it("场景定义只接受表1-1，交付物只接受 solution", () => {
    expect(normalizeArtifactRef({ step: 1, stage: null, type: "anchor", id: "表1-1" }).title).toContain(
      "场景定义",
    );
    expect(() =>
      normalizeArtifactRef({ step: 1, stage: null, type: "anchor", id: "表2-1" }),
    ).toThrow(/表1-1/);
    expect(() =>
      normalizeArtifactRef({ step: 6, stage: null, type: "deliverable", id: "solution" }),
    ).not.toThrow();
    expect(() =>
      normalizeArtifactRef({ step: 6, stage: null, type: "deliverable", id: "other" }),
    ).toThrow(/solution/);
    // 作用域必须落在正确的流程步：第 2 步不能挂表1-1，第 5 步不能挂交付物
    expect(() =>
      normalizeArtifactRef({ step: 2, stage: 1, type: "anchor", id: "表1-1" }),
    ).toThrow(/第 1 步/);
    expect(() =>
      normalizeArtifactRef({ step: 5, stage: 4, type: "deliverable", id: "solution" }),
    ).toThrow(/第 6 步/);
    expect(() =>
      normalizeArtifactRef({ step: 99, stage: null, type: "table", id: "表1-3" }),
    ).toThrow(/超出范围/);
  });

  it("拒绝不属于该流程步的表", () => {
    expect(() =>
      normalizeArtifactRef({ step: 2, stage: 1, type: "table", id: "表4-1" }),
    ).toThrow(/不属于/);
  });
});

describe("compactConversationHistory", () => {
  it("无历史时返回空串，不产生空块", () => {
    expect(compactConversationHistory([]).block).toBe("");
    expect(compactConversationHistory([{ role: "用户", content: "  " }]).block).toBe("");
  });

  it("超出 12 条时保留最近 12 条，并把早先决策压成摘要", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "用户" : "系统",
      content: i === 0 ? "我们决定采用分层架构，边缘层不接第三方云" : `第 ${i} 条消息`,
    }));
    const result = compactConversationHistory(messages);
    expect(result.compacted).toBe(true);
    expect(result.total).toBe(20);
    expect(result.kept).toBe(12);
    expect(result.block).toContain("（更早的 8 条已省略）");
    expect(result.block).toContain("【更早对话摘要】");
    expect(result.summary).toContain("决策");
    expect(result.summary).toContain("分层架构");
    expect(result.block).toContain("第 19 条消息");
  });

  it("早先的寒暄不挤掉后出现的决策", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "用户" : "系统",
      content: i === 17 ? "决定采用边缘网关，不上云" : `闲聊第 ${i} 条`,
    }));
    const result = compactConversationHistory(messages);
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("决策：决定采用边缘网关");
  });

  it("未超预算时不压缩、不生成摘要", () => {
    const result = compactConversationHistory([
      { role: "用户", content: "你好" },
      { role: "系统", content: "你好，有什么可以帮你" },
    ]);
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("");
  });
});

describe("artifact conversation persistence", () => {
  it("打开不创建；首次 ensure 只建一条；block 变化不拆会话", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    const dsh = mockDsh();
    const base = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: "现状",
      title: "门槛与合规",
    });

    const before = readArtifactThread(db, scenarioId, base);
    expect(before.conversation_id).toBeNull();
    expect(before.messages).toEqual([]);
    expect(findArtifactConversation(db, scenarioId, base)).toBeUndefined();

    const created = await ensureArtifactConversation(db, dsh, scenarioId, base);
    expect(created.kind).toBe("产物会话");
    expect(created.scope_type).toBe("table");
    expect(created.scope_id).toBe("表1-3");
    expect(created.title).toContain("门槛");

    const withOtherBlock = { ...base, block: "另一块" };
    const again = await ensureArtifactConversation(db, dsh, scenarioId, withOtherBlock);
    expect(again.id).toBe(created.id);
    expect(again.block).toBe("另一块");
    expect(dsh.createSession).toHaveBeenCalledTimes(1);

    const list = db.conversationRepo.list({
      where: "scenario_id = ? AND kind = '产物会话'",
      params: [scenarioId],
    });
    expect(list).toHaveLength(1);
    expect(isUserConversation(list[0]!)).toBe(false);
  });

  it("并发首次发送只落一条会话（唯一索引兜底）", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    const dsh = mockDsh();
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    const [a, b] = await Promise.all([
      ensureArtifactConversation(db, dsh, scenarioId, ref),
      ensureArtifactConversation(db, dsh, scenarioId, ref),
    ]);
    expect(a.id).toBe(b.id);
    const list = db.conversationRepo.list({
      where: "scenario_id = ? AND kind = '产物会话'",
      params: [scenarioId],
    });
    expect(list).toHaveLength(1);
  });

  it("历史完整读取；超过 12 条时给出压缩摘要", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    const dsh = mockDsh();
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    const conversation = await ensureArtifactConversation(db, dsh, scenarioId, ref);
    for (let i = 0; i < 14; i++) {
      db.messageRepo.insert({
        conversation_id: conversation.id,
        role: i % 2 === 0 ? "用户" : "系统",
        content: i === 0 ? "确定采用分层架构" : `消息 ${i}`,
      });
    }
    db.conversationRepo.update(conversation.id, { summary: "决策：采用分层架构" });

    const state = readArtifactThread(db, scenarioId, ref);
    expect(state.conversation_id).toBe(conversation.id);
    expect(state.messages).toHaveLength(14);
    expect(state.compacted).toBe(true);
    expect(state.kept).toBe(12);
    expect(state.summary).toContain("分层架构");
  });

  it("产物内容变化后标记 stale，发送后清掉；历史消息不清空", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    const dsh = mockDsh();
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    const conversation = await ensureArtifactConversation(db, dsh, scenarioId, ref);
    db.messageRepo.insert({
      conversation_id: conversation.id,
      role: "用户",
      content: "这条历史不能被清掉",
    });
    touchArtifactConversation(db, conversation.id, scenarioId, ref);
    expect(readArtifactThread(db, scenarioId, ref).stale).toBe(false);

    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入", barrier_name: "涉密资质" },
      is_stale: false,
      source_type: "AI提取",
    });
    const changed = readArtifactThread(db, scenarioId, ref);
    expect(changed.stale).toBe(true);
    expect(changed.messages).toHaveLength(1);

    touchArtifactConversation(db, conversation.id, scenarioId, ref);
    expect(readArtifactThread(db, scenarioId, ref).stale).toBe(false);
    expect(currentArtifactHash(db, scenarioId, ref)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("写入表格命令：按第一列值定位行、支持列名，写入 __ai_cells 并标下游待重算（#298）", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入", barrier_name: "涉密资质" },
      is_stale: false,
      source_type: "AI提取",
    });
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    const note = await fillTableFromCommand(db, scenarioId, ref, {
      command: "写入表格",
      params: {
        fills: [
          { row: "行业准入", column: "门槛", value: "涉密集成资质（模型知识）" },
          { row: "行业准入", column: "判据", value: "需具备涉密集成资质" },
        ],
      },
    });
    expect(note).toContain("写入 2 处");
    const row = db.stageDataRepo.list({
      where: "scenario_id = ? AND table_code = ?",
      params: [scenarioId, "表1-3"],
    })[0]!;
    expect(row.row.barrier_name).toBe("涉密集成资质（模型知识）");
    expect(row.row.criteria).toBe("需具备涉密集成资质");
    expect(row.row.__ai_cells).toEqual(["barrier_name", "criteria"]);
  });

  it("新增行与删除行（#302）：按列名映射、插到表里、按第一列值删除", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入", barrier_name: "涉密资质" },
      is_stale: false,
      source_type: "AI提取",
    });
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });

    const note = await fillTableFromCommand(db, scenarioId, ref, {
      command: "write_table",
      params: {
        add_rows: [
          {
            values: {
              门槛类型: "数据壁垒",
              门槛: "历史运行数据不足三年",
              判据: "需提供三年以上运行记录",
            },
          },
        ],
        delete_rows: [{ row: "行业准入" }],
      },
    });
    expect(note).toContain("新增 1 行");
    expect(note).toContain("删除 1 行");
    const rows = db.stageDataRepo.list({
      where: "scenario_id = ? AND table_code = ?",
      params: [scenarioId, "表1-3"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row.barrier_type).toBe("数据壁垒");
    expect(rows[0]!.row.criteria).toBe("需提供三年以上运行记录");
    expect(rows[0]!.row.__ai_cells).toEqual(["barrier_type", "barrier_name", "criteria"]);
  });

  it("行操作守卫：空操作 / 未知列 / 删不存在的行都报错", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入" },
      is_stale: false,
      source_type: "AI提取",
    });
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    await expect(
      fillTableFromCommand(db, scenarioId, ref, { command: "write_table", params: {} }),
    ).rejects.toThrow(/没有任何操作/);
    await expect(
      fillTableFromCommand(db, scenarioId, ref, {
        command: "write_table",
        params: { add_rows: [{ values: { "没有这列": "x" } }] },
      }),
    ).rejects.toThrow(/没有/);
    await expect(
      fillTableFromCommand(db, scenarioId, ref, {
        command: "write_table",
        params: { delete_rows: [{ row: "不存在" }] },
      }),
    ).rejects.toThrow(/找不到/);
  });

  it("写入表格命令：未知行 / 未知列 / 超量 / 交付物都拒绝", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入" },
      is_stale: false,
      source_type: "AI提取",
    });
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    await expect(
      fillTableFromCommand(db, scenarioId, ref, {
        command: "写入表格",
        params: { fills: [{ row: "不存在", column: "门槛", value: "x" }] },
      }),
    ).rejects.toThrow(/找不到/);
    await expect(
      fillTableFromCommand(db, scenarioId, ref, {
        command: "写入表格",
        params: { fills: [{ row: "行业准入", column: "没有这列", value: "x" }] },
      }),
    ).rejects.toThrow(/没有/);
    await expect(
      fillTableFromCommand(db, scenarioId, ref, {
        command: "推进阶段",
        params: {},
      }),
    ).rejects.toThrow(/只支持/);
  });

  it("上下文包含当前产物的表行与场景定义", async () => {
    const db = createDb(":memory:");
    const scenarioId = seedScenario(db);
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: { barrier_type: "行业准入", barrier_name: "涉密资质", criteria: "需具备涉密集成资质" },
      is_stale: false,
      source_type: "AI提取",
    });
    const ref = normalizeArtifactRef({
      step: 2,
      stage: 1,
      type: "table",
      id: "表1-3",
      block: null,
      title: "门槛与合规",
    });
    const context = buildArtifactContext(db, scenarioId, ref);
    expect(context).toContain("【当前场景】");
    expect(context).toContain("智慧会议室");
    expect(context).toContain("【当前产物】");
    expect(context).toContain("涉密资质");
    expect(context).toContain("需具备涉密集成资质");
    expect(context).toContain("不要编造来源");
  });
});
