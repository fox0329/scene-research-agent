/**
 * maybe-clarify 单测（MR3-T2）：阈值裁决接线、答案存在性丢弃、注入会话、静音。
 */

import { describe, expect, it, vi } from "vitest";
import { createDb, type DbInstance } from "@scene/infra";
import { createClarifyCommand } from "./clarify-command.js";
import { insertRequirement, recordInteractionEvent } from "./requirement-profile.js";

function mockDsh(question: string) {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s1" })),
    prompt: vi.fn(async function* () {
      yield { type: "text", text: JSON.stringify({ question }) } as never;
      yield { type: "done" } as never;
    }),
    cancel: vi.fn(async () => {}),
  } as never as Parameters<typeof createClarifyCommand>[0]["dshClient"];
}

function buildDb(): { db: DbInstance; sid: string; convId: string } {
  const db = createDb(":memory:");
  const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
  const conv = db.conversationRepo.insert({
    scenario_id: sid,
    title: "会话",
    status: "活跃",
    dsh_session_id: "dsh1",
  } as never);
  return { db, sid, convId: conv.id };
}

describe("maybe-clarify（MR3-T2）", () => {
  it("纠偏 ≥2 → 问；问题注入会话为系统消息 + 记 clarify 事件", async () => {
    const { db, sid, convId } = buildDb();
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "rewrite", target: "t1" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t2" });
    const cmd = createClarifyCommand({ db, dshClient: mockDsh("预算和性能你更看重哪个？") });
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(true);
    expect(out.reasons).toEqual(["correction"]);
    const messages = db.messageRepo.listByConversation(convId);
    expect(messages.some((m) => m.role === "系统" && m.content.includes("预算和性能"))).toBe(true);
    const events = db.db
      .prepare("SELECT COUNT(*) AS n FROM interaction_event WHERE scenario_id = ? AND action = 'clarify'")
      .get(sid) as { n: number };
    expect(events.n).toBe(1);
  });

  it("答案已在画像 → 丢弃不问（answer-exists）", async () => {
    const { db, sid, convId } = buildDb();
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t1" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t2" });
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "preference",
      text: "预算控制在五十万以内",
      check_anchor: null,
      confidence: "用户原话",
      sources: [],
    });
    const dsh = mockDsh("项目预算大概多少？");
    const cmd = createClarifyCommand({ db, dshClient: dsh });
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(false);
    expect(out.reason).toBe("answer-exists");
    expect(db.messageRepo.listByConversation(convId)).toHaveLength(0);
  });

  it("无触发源 → 不问不调模型", async () => {
    const { db, sid, convId } = buildDb();
    const dsh = mockDsh("问什么？");
    const cmd = createClarifyCommand({ db, dshClient: dsh });
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(false);
    expect(out.reason).toBe("threshold");
    expect(dsh.createSession).not.toHaveBeenCalled();
  });

  it("会话已问 2 次 → 不再问", async () => {
    const { db, sid, convId } = buildDb();
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t1" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t2" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "conversation", action: "clarify", target: "c1" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "conversation", action: "clarify", target: "c2" });
    const cmd = createClarifyCommand({ db, dshClient: mockDsh("再问一个？") });
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(false);
    expect(out.reason).toBe("threshold");
  });

  it("「别再问」后静音：即使有触发源也不问", async () => {
    const { db, sid, convId } = buildDb();
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t1" });
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "t2" });
    const cmd = createClarifyCommand({ db, dshClient: mockDsh("问？") });
    cmd.mute(sid);
    expect(cmd.isMuted(sid)).toBe(true);
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(false);
    expect(out.reason).toBe("muted");
  });

  it("维度缺失 ≥2 触发（dimension_gap 条目）", async () => {
    const { db, sid, convId } = buildDb();
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "dimension_gap",
      text: "缺少运维维度",
      check_anchor: null,
      confidence: "AI推断",
      sources: [],
    });
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "dimension_gap",
      text: "缺少验收维度",
      check_anchor: null,
      confidence: "AI推断",
      sources: [],
    });
    const cmd = createClarifyCommand({ db, dshClient: mockDsh("运维和验收怎么安排？") });
    const out = await cmd.maybeClarify({ scenarioId: sid, conversationId: convId });
    expect(out.asked).toBe(true);
    expect(out.reasons).toEqual(["dimension-gap"]);
  });
});
