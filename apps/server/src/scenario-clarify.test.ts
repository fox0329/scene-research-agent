/**
 * @scene/server — 澄清问题落点（变更表 #174）
 *
 * 真故障回归：阶段分析内部会话已从左侧栏隐藏，但仍是「活跃」状态。若"取最近活跃会话"
 * 不过滤 kind，澄清问题会被写进一条用户看不见的会话——看不到问题，也就没法回答。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type DbInstance } from "@scene/infra";
import { pickClarifyConversation } from "./scenario-clarify.js";

describe("澄清问题落点：跳过隐藏的阶段分析会话", () => {
  let db: DbInstance;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("最近一条是阶段分析会话时，仍写进用户可见的「场景定义」会话", () => {
    const sc = db.scenarioRepo.insert({ name: "智慧病房", description: "住院病区", status: "进行中", current_stage: 1 });
    const def = db.conversationRepo.insert({
      scenario_id: sc.id,
      title: "场景定义",
      status: "活跃",
      dsh_session_id: "sess-def",
      kind: "用户",
    });
    // 历史遗留：后建的阶段分析会话更新，且仍是活跃
    db.conversationRepo.insert({
      scenario_id: sc.id,
      title: "阶段 5 · 分析",
      status: "活跃",
      dsh_session_id: "sess-stage",
      kind: "阶段分析",
    });

    expect(pickClarifyConversation(db, sc.id)?.id).toBe(def.id);
  });

  it("没有用户可见会话时返回空（由调用方新建「场景澄清」）", () => {
    const sc = db.scenarioRepo.insert({ name: "智慧病房", description: "住院病区", status: "进行中", current_stage: 1 });
    db.conversationRepo.insert({
      scenario_id: sc.id,
      title: "阶段 1 · 分析",
      status: "活跃",
      dsh_session_id: "sess-stage",
      kind: "阶段分析",
    });

    expect(pickClarifyConversation(db, sc.id)).toBeUndefined();
  });

  it("老库没有 kind 列（默认值兜底）时照样算用户会话", () => {
    const sc = db.scenarioRepo.insert({ name: "智慧病房", description: "住院病区", status: "进行中", current_stage: 1 });
    const conv = db.conversationRepo.insert({
      scenario_id: sc.id,
      title: "场景定义",
      status: "活跃",
      dsh_session_id: "sess-def",
    });

    expect(pickClarifyConversation(db, sc.id)?.id).toBe(conv.id);
  });
});
