/**
 * profile-extract 抽取管道单测（MR1-T4）
 *
 * 不调真 DSH：注入 mock dshClient 返回固定 JSON；
 * 覆盖：攒批触发、空闲触发、判定落库四分支、黑名单、token 熔断、undo 待复核。
 */

import { describe, expect, it, vi } from "vitest";
import { createDb, type DbInstance } from "@scene/infra";
import { createProfileExtractor } from "./profile-extract.js";
import { insertRequirement } from "./requirement-profile.js";

/** mock DSH：prompt 按 script 依次回复 */
function mockDsh(replies: string[]): Parameters<typeof createProfileExtractor>[0]["dshClient"] {
  let call = 0;
  return {
    createSession: vi.fn(async () => ({ sessionId: `s-${call}` })),
    prompt: vi.fn(async function* () {
      const reply = replies[Math.min(call, replies.length - 1)] ?? "[]";
      call++;
      yield { type: "text", text: reply } as never;
      yield { type: "done" } as never;
    }),
    cancel: vi.fn(async () => {}),
  } as never;
}

const JSON_REPLY = JSON.stringify([
  {
    text: "篇幅控制在两页纸以内",
    kind: "explicit",
    confidence: "用户原话",
    anchor: null,
    sourceRef: "m1",
    sourceSnippet: "给我两页纸的",
  },
]);

function buildDb(): DbInstance {
  const db = createDb(":memory:");
  db.scenarioRepo.insert({ name: "抽取测试", status: "进行中", current_stage: 1 });
  return db;
}

function firstScenarioId(db: DbInstance): string {
  return db.scenarioRepo.list()[0]!.id;
}

/** 建会话并塞两条用户消息（抽取管道有消息才启动，空会话直接跳过） */
function seedConversation(db: DbInstance, sid: string): string {
  const cid = db.conversationRepo.insert({
    scenario_id: sid,
    title: "t",
    status: "活跃",
    dsh_session_id: "dsh-x",
  } as never).id;
  db.messageRepo.insert({ conversation_id: cid, role: "用户", content: "给我两页纸的方案" });
  db.messageRepo.insert({ conversation_id: cid, role: "用户", content: "不提国产替代" });
  return cid;
}

describe("抽取管道", () => {
  it("攒批：3 条消息触发一次抽取并落库", async () => {
    const db = buildDb();
    const extractor = createProfileExtractor({ db, dshClient: mockDsh([JSON_REPLY]) });
    const sid = firstScenarioId(db);
    const cid = seedConversation(db, sid);
    await extractor.noteMessage(sid, cid);
    await extractor.noteMessage(sid, cid);
    expect(db.db.prepare("SELECT COUNT(*) n FROM requirement_profile").get()).toEqual({ n: 0 });
    await extractor.noteMessage(sid, cid); // 第 3 条触发
    const rows = db.db.prepare("SELECT * FROM requirement_profile").all() as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(["篇幅控制在两页纸以内"]);
  });

  it("判定落库：rejected 不落库、superseded 新旧两行", async () => {
    const db = buildDb();
    const sid = firstScenarioId(db);
    // 已有高置信同主题条目：新 AI推断冲突 → 低置信拒
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "explicit",
      text: "篇幅两页纸",
      confidence: "用户原话",
      sources: [],
    });
    const aiConflict = JSON.stringify([
      { text: "篇幅不要两页纸", kind: "explicit", confidence: "AI推断", anchor: null, sourceRef: "m2", sourceSnippet: "x" },
    ]);
    const extractor = createProfileExtractor({ db, dshClient: mockDsh([aiConflict]) });
    const cid = seedConversation(db, sid);
    const result = await extractor.flush(sid, cid);
    expect(result.rejected).toBe(1);
    expect(db.db.prepare("SELECT COUNT(*) n FROM requirement_profile").get()).toEqual({ n: 1 });
  });

  it("superseded：同级用户改口 → 新 active 旧 superseded", async () => {
    const db = buildDb();
    const sid = firstScenarioId(db);
    const old = insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "explicit",
      text: "预算控制在 50 万以内",
      confidence: "用户原话",
      sources: [],
    });
    const change = JSON.stringify([
      { text: "预算控制在 80 万以内", kind: "explicit", confidence: "用户原话", anchor: null, sourceRef: "m3", sourceSnippet: "改 80 万" },
    ]);
    const extractor = createProfileExtractor({ db, dshClient: mockDsh([change]) });
    const cid = seedConversation(db, sid);
    const result = await extractor.flush(sid, cid);
    expect(result.superseded).toBe(1);
    const statuses = db.db
      .prepare("SELECT text, status FROM requirement_profile ORDER BY created_at")
      .all() as { text: string; status: string }[];
    expect(statuses).toEqual([
      { text: "预算控制在 50 万以内", status: "superseded" },
      { text: "预算控制在 80 万以内", status: "active" },
    ]);
    expect(old.id).toBeTruthy();
  });

  it("黑名单：dismissed 同文不再抽回", async () => {
    const db = buildDb();
    const sid = firstScenarioId(db);
    const banned = insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "preference",
      text: "用户不要的条目",
      confidence: "AI推断",
      sources: [],
    });
    await import("./requirement-profile.js").then((m) =>
      m.updateRequirement(db, banned.id, { status: "dismissed" }),
    );
    const extractor = createProfileExtractor({
      db,
      dshClient: mockDsh([
        JSON.stringify([
          { text: "用户不要的条目", kind: "preference", confidence: "用户原话", anchor: null, sourceRef: "m4", sourceSnippet: "x" },
        ]),
      ]),
    });
    const cid = seedConversation(db, sid);
    const result = await extractor.flush(sid, cid);
    expect(result.rejected).toBe(1);
  });

  it("token 熔断：超每日上限跳过", async () => {
    const db = buildDb();
    const dsh = mockDsh([JSON_REPLY]);
    const extractor = createProfileExtractor({ db, dshClient: dsh, dailyCallLimit: 1 });
    const sid = firstScenarioId(db);
    const cid = seedConversation(db, sid);
    const first = await extractor.flush(sid, cid);
    expect(first.skipped).toBe(false);
    const second = await extractor.flush(sid, cid);
    expect(second.skipped).toBe(true); // 上限 1 次已用
  });

  it("无消息 flush 直接跳过（不烧 token）", async () => {
    const db = buildDb();
    const dsh = mockDsh([JSON_REPLY]);
    const extractor = createProfileExtractor({ db, dshClient: dsh });
    const sid = firstScenarioId(db);
    const result = await extractor.flush(sid, null);
    expect(result.skipped).toBe(true);
    expect(dsh.createSession).not.toHaveBeenCalled();
  });

  it("undo 待复核：undo 事件命中条目出处 → 复核引用", async () => {
    const db = buildDb();
    const sid = firstScenarioId(db);
    const { recordInteractionEvent } = await import("./requirement-profile.js");
    recordInteractionEvent(db, { scenario_id: sid, surface: "ui", action: "undo", target: "row-9" });
    const extractor = createProfileExtractor({ db, dshClient: mockDsh([]) });
    const hints = extractor.pendingReviewHints(sid);
    // 没有条目引用 row-9 → 无复核提示（不误报）
    expect(hints).toEqual([]);
  });
});
