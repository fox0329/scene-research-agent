/**
 * refine 路由 + 差分面板单测（MR2-T4）
 *
 * 路由：refine 触发（mock DSH 差分回复）→ apply 写回 + edit_cell 埋点。
 * 面板：呈现层纯函数断言（沿用 MR1-T5 惯例：renderToStaticMarkup 不跑 useEffect）。
 */

import { describe, expect, it, vi } from "vitest";
import { createDb } from "@scene/infra";
import { createApp } from "./app.js";
import { insertRequirement } from "./requirement-profile.js";
import { listInteractionEvents } from "./requirement-profile.js";

const mockDsh = {
  createSession: vi.fn(async () => ({ sessionId: "s1" })),
  prompt: vi.fn(async function* () {
    yield {
      type: "text",
      text: JSON.stringify([{ rowId: "", cell: "方案", newValue: "占位" }]),
    } as never;
    yield { type: "done" } as never;
  }),
  cancel: vi.fn(async () => {}),
} as never as Parameters<typeof createApp>[0]["dshClient"];

function buildApp() {
  const db = createDb(":memory:");
  const app = createApp({ db, dshClient: mockDsh });
  return { app, db };
}

describe("refine 路由（MR2-T4）", () => {
  it("POST refine：有必改返回差分；apply 写回并记 edit_cell 埋点", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "constraint",
      text: "不提国产替代",
      check_anchor: { type: "keyword", terms: ["国产", "替代"], mode: "命中即违反" },
      confidence: "用户原话",
      sources: [],
    });
    db.stageDataRepo.insert({
      scenario_id: sid,
      stage: 3,
      table_code: "表3-1",
      row: { 方案: "提及国产替代路径" },
    } as never);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/refine`,
      payload: { stage: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skipped: boolean; findings: unknown[] };
    expect(body.skipped).toBe(false);
    expect(body.findings.length).toBeGreaterThan(0);

    // apply：用户确认写回（mock 差分 rowId 为空不落库——用真实差分验证写回链路）
    const row = db.stageDataRepo.listByScenarioStage(sid, 3 as never)[0]!;
    const applyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/refine/apply`,
      payload: {
        diffs: [
          {
            tableCode: "表3-1",
            rowId: row.id,
            cell: "方案",
            oldValue: "提及国产替代路径",
            newValue: "改为合规表述",
          },
        ],
      },
    });
    expect(applyRes.statusCode).toBe(200);
    expect((applyRes.json() as { applied: number }).applied).toBe(1);
    const updated = db.stageDataRepo.getById(row.id)!;
    expect((updated.row as Record<string, unknown>)["方案"]).toBe("改为合规表述");
    const events = listInteractionEvents(db, sid);
    expect(events.some((e) => e.action === "edit_cell" && e.target.startsWith("refine:"))).toBe(true);
  });

  it("apply 空差分 → 400", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/refine/apply`,
      payload: { diffs: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refine stage 非法 → 400", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 3 }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/refine`,
      payload: { stage: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("refine 阶段归一（MR2-T4 修正）", () => {
  it("stage 6+（交付物阶段）归一到 5 查表数据", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 6 as never }).id;
    db.stageDataRepo.insert({
      scenario_id: sid,
      stage: 5,
      table_code: "表6-1",
      row: { 方案: "示例内容" },
    } as never);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/refine`,
      payload: { stage: 6 },
    });
    expect(res.statusCode).toBe(200);
    // 无画像条目 → clean 而非 no-rows（说明表数据查到了）
    expect((res.json() as { reason?: string }).reason).toBe("clean");
  });
});
