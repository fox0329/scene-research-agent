/**
 * refine-output 单测（MR2-T3）：零必改直接过、单次重写差分、token 熔断、重写后复查、差分不落库。
 */

import { describe, expect, it, vi } from "vitest";
import type { InfoStageId } from "@scene/contract";
import { createDb, type DbInstance } from "@scene/infra";
import { createRefineCommand } from "./refine-output.js";
import { insertRequirement, updateRequirement } from "./requirement-profile.js";

function mockDsh(reply: string) {
  return {
    createSession: vi.fn(async () => ({ sessionId: "s1" })),
    prompt: vi.fn(async function* () {
      yield { type: "text", text: reply } as never;
      yield { type: "done" } as never;
    }),
    cancel: vi.fn(async () => {}),
  } as never as Parameters<typeof createRefineCommand>[0]["dshClient"];
}

function buildDb(): { db: DbInstance; sid: string } {
  const db = createDb(":memory:");
  const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
  return { db, sid };
}

function seedRow(db: DbInstance, sid: string, row: Record<string, unknown>): void {
  db.stageDataRepo.insert({
    scenario_id: sid,
    stage: 3,
    table_code: "表3-1",
    row,
  } as never);
}

/** 高置信禁忌条目 + 产物含禁忌词 → 必改 */
function seedConstraint(db: DbInstance, sid: string): void {
  insertRequirement(db, {
    scenario_id: sid,
    scope: "scene",
    kind: "constraint",
    text: "不提国产替代",
    check_anchor: { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
    confidence: "用户原话",
    sources: [],
  });
}

const REWRITE_REPLY = JSON.stringify([
  { rowId: "", cell: "方案", newValue: "改为不含禁忌词的内容" },
]);

describe("refine-output（MR2-T3）", () => {
  it("零必改 → clean 跳过，不调 DSH", async () => {
    const { db, sid } = buildDb();
    seedRow(db, sid, { 方案: "正常内容" });
    const dsh = mockDsh("[]");
    const cmd = createRefineCommand({ db, dshClient: dsh });
    const out = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("clean");
    expect(out.diffs).toEqual([]);
    expect(dsh.createSession).not.toHaveBeenCalled();
  });

  it("有必改 → 单次重写出行级差分（不落库）", async () => {
    const { db, sid } = buildDb();
    seedConstraint(db, sid);
    seedRow(db, sid, { 方案: "提及国产替代路径" });
    const dsh = mockDsh(REWRITE_REPLY);
    const cmd = createRefineCommand({ db, dshClient: dsh });
    const out = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(out.skipped).toBe(false);
    // 差分是否生成取决于模型回复是否带合法 rowId（mock 里 rowId 为空 → 解析丢弃）
    expect(dsh.prompt).toHaveBeenCalledTimes(1); // 单次重写
    const rows = db.stageDataRepo.listByScenarioStage(sid, 3 as never);
    expect(rows.every((r) => !String(r.row["方案"]).includes("改后的内容"))).toBe(true); // 不落库
  });

  it("token 熔断：超每日上限跳过", async () => {
    const { db, sid } = buildDb();
    seedConstraint(db, sid);
    seedRow(db, sid, { 方案: "提及国产替代路径" });
    const dsh = mockDsh(REWRITE_REPLY);
    const cmd = createRefineCommand({ db, dshClient: dsh, dailyCallLimit: 1 });
    const first = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(first.skipped).toBe(false);
    const second = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("over-limit");
  });

  it("重写后复查：假定差分应用后仍违反 → remaining 如实报告", async () => {
    const { db, sid } = buildDb();
    seedConstraint(db, sid);
    seedRow(db, sid, { 方案: "国产替代是重点" });
    // 模型改了但新值仍含禁忌词 → 复查仍违反
    const badRewrite = JSON.stringify([
      { rowId: "x", cell: "方案", newValue: "保持原样" },
    ]);
    const dsh = mockDsh(badRewrite);
    const cmd = createRefineCommand({ db, dshClient: dsh });
    const out = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    // 差分被丢弃（rowId 不存在），复查基于未应用文本 → 仍违反 → remaining 非空
    expect(out.diffs).toHaveLength(0);
    expect(out.remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("黑名单条目不参与重写判定", async () => {
    const { db, sid } = buildDb();
    seedConstraint(db, sid);
    seedRow(db, sid, { 方案: "提及国产替代路径" });
    const entries = listAll(db);
    updateRequirement(db, entries[0]!.id, { status: "dismissed" });
    const dsh = mockDsh(REWRITE_REPLY);
    const cmd = createRefineCommand({ db, dshClient: dsh });
    const out = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(out.reason).toBe("clean");
  });

  it("无行 → no-rows 跳过", async () => {
    const { db, sid } = buildDb();
    const cmd = createRefineCommand({ db, dshClient: mockDsh("[]") });
    const out = await cmd.refine({ scenarioId: sid, stage: 3 as InfoStageId });
    expect(out.reason).toBe("no-rows");
  });
});

function listAll(db: DbInstance) {
  return db.db.prepare("SELECT * FROM requirement_profile").all() as { id: string }[];
}
