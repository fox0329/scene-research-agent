/**
 * MR1-T2 埋点接入单测
 *
 * 验证四处端点 + 对话撤销工具各产生一条 interaction_event（event-recorder 唯一写入口）。
 * 用真内存库（createDb(":memory:")），埋点走原生 SQL，mock repo 测不到。
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { listInteractionEvents } from "./requirement-profile.js";
import { recordOperation } from "./operation-log.js";
import { undoLast } from "./conversation-tools.js";

const mockDsh = {
  createSession: vi.fn(async () => ({ sessionId: "dsh-mock" })),
  prompt: vi.fn(async function* () {
    yield { type: "text", text: "ok" };
    yield { type: "done" };
  }),
  cancel: vi.fn(async () => {}),
} as unknown as Parameters<typeof createApp>[0]["dshClient"];

function buildApp(): { app: FastifyInstance; db: DbInstance } {
  const db = createDb(":memory:");
  const app = createApp({ db, dshClient: mockDsh });
  return { app, db };
}

function seedScenario(db: DbInstance): string {
  // 通用 repo 强制生成 id（传入被忽略），必须用返回值里的真实 id
  const scenario = db.scenarioRepo.insert({
    name: "埋点测试场景",
    status: "进行中",
    current_stage: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return scenario.id;
}

function allEvents(db: DbInstance): ReturnType<typeof listInteractionEvents> {
  return db.db.prepare("SELECT * FROM interaction_event ORDER BY created_at").all() as ReturnType<
    typeof listInteractionEvents
  >;
}

describe("MR1-T2 埋点接入", () => {
  it("编辑单元格 → edit_cell 事件（target 含表码/行/列）", async () => {
    const { app, db } = buildApp();
    const sid = seedScenario(db);
    const row = db.stageDataRepo.insert({
      scenario_id: sid,
      stage: 1,
      table_code: "表1-1",
      row: { 关键要素: "潜污泵" },
      source_type: "AI提取",
      evidence_level: "C",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${sid}/stage-data/${row.id}`,
      payload: { cell: "关键要素", value: "潜污泵控制箱" },
    });
    expect(res.statusCode).toBe(200);
    const events = allEvents(db);
    expect(events.filter((e) => e.action === "edit_cell")).toHaveLength(1);
    expect(events[0]!.target).toBe(`表1-1:${row.id}:关键要素`);
  });

  it("质量关决策：重算 → rewrite；继续 → confirm", async () => {
    const { app, db } = buildApp();
    const sid = seedScenario(db);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/stages/1/decide`,
      payload: { action: "重算" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sid}/stages/1/decide`,
      payload: { action: "继续" },
    });
    const actions = allEvents(db).map((e) => e.action);
    expect(actions).toContain("rewrite");
    expect(actions).toContain("confirm");
  });

  it("UI 撤销端点 → undo 事件（无场景上下文，scenario_id 为空）", async () => {
    const { app, db } = buildApp();
    const rec = recordOperation(db, {
      surface: "ui",
      tool: "fill_table",
      summary: "写入表1-1 一行",
      undo: [{ kind: "delete", table: "stage_data", id: "no-row" }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/operations/${rec.id}/undo`,
    });
    expect(res.statusCode).toBe(200);
    const undoEvents = allEvents(db).filter((e) => e.action === "undo");
    expect(undoEvents).toHaveLength(1);
    expect(undoEvents[0]!.scenario_id).toBeNull();
  });

  it("对话撤销工具 → conversation surface 的 undo 事件", () => {
    const db = createDb(":memory:");
    const rec = recordOperation(db, {
      conversationId: "c-1",
      surface: "conversation",
      tool: "fill_table",
      summary: "写入表1-1 一行",
      undo: [{ kind: "delete", table: "stage_data", id: "no-row" }],
    });
    const ctx = {
      db,
      app: {} as FastifyInstance,
      conversationId: "c-1",
      surface: "conversation",
    };
    undoLast(ctx);
    const undoEvents = allEvents(db).filter((e) => e.action === "undo");
    expect(undoEvents).toHaveLength(1);
    expect(undoEvents[0]!.surface).toBe("conversation");
    expect(rec.id).toBeTruthy();
  });
});
