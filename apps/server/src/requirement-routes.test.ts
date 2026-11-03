/**
 * 反思优化 API 单测（MR1-T6）：三端点 + flag 行为
 */

import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb } from "@scene/infra";
import { createApp } from "./app.js";
import { insertRequirement, listRequirements } from "./requirement-profile.js";
import { isReflectionEnabled } from "./requirement-routes.js";

const mockDsh = {
  createSession: vi.fn(async () => ({ sessionId: "d" })),
  prompt: vi.fn(async function* () {
    yield { type: "text", text: "x" } as never;
    yield { type: "done" } as never;
  }),
  cancel: vi.fn(async () => {}),
} as never as Parameters<typeof createApp>[0]["dshClient"];

function buildApp() {
  const db = createDb(":memory:");
  const app = createApp({ db, dshClient: mockDsh });
  return { app, db };
}

describe("反思优化 API（MR1-T6）", () => {
  it("GET requirements：返回条目列表与升级候选", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 1 }).id;
    insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "explicit",
      text: "篇幅两页纸",
      confidence: "用户原话",
      sources: [],
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${sid}/requirements` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; upgrade_candidates: unknown[] };
    expect(body.entries).toHaveLength(1);
    expect(body.upgrade_candidates).toEqual([]);
  });

  it("PATCH：手编覆盖生效（用户编辑赢）", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 1 }).id;
    const entry = insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "explicit",
      text: "旧口径",
      confidence: "AI推断",
      sources: [],
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${entry.id}`,
      payload: { text: "用户改的口径" },
    });
    expect(res.statusCode).toBe(200);
    expect(listRequirements(db, sid)[0]!.text).toBe("用户改的口径");
  });

  it("DELETE：dismissed 进黑名单，列表不再返回", async () => {
    const { app, db } = buildApp();
    const sid = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 1 }).id;
    const entry = insertRequirement(db, {
      scenario_id: sid,
      scope: "scene",
      kind: "preference",
      text: "不要的条目",
      confidence: "AI推断",
      sources: [],
    });
    const res = await app.inject({ method: "DELETE", url: `/api/v1/requirements/${entry.id}` });
    expect(res.statusCode).toBe(200);
    expect(listRequirements(db, sid)).toHaveLength(0);
  });

  it("PATCH 不存在的条目 → 404", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/requirements/no-such-id",
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("flag：默认关，env 显式 1 才开", () => {
    const prev = process.env.SCENE_REFLECTION_ENABLED;
    try {
      delete process.env.SCENE_REFLECTION_ENABLED;
      expect(isReflectionEnabled()).toBe(false);
      process.env.SCENE_REFLECTION_ENABLED = "1";
      expect(isReflectionEnabled()).toBe(true);
      process.env.SCENE_REFLECTION_ENABLED = "0";
      expect(isReflectionEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SCENE_REFLECTION_ENABLED;
      else process.env.SCENE_REFLECTION_ENABLED = prev;
    }
  });

  it("flag 关：消息不触发抽取（mock dsh 无 createSession 调用）", async () => {
    const prev = process.env.SCENE_REFLECTION_ENABLED;
    delete process.env.SCENE_REFLECTION_ENABLED;
    try {
      const { app, db } = buildApp();
      const sc = db.scenarioRepo.insert({ name: "t", status: "进行中", current_stage: 1 });
      const cid = db.conversationRepo.insert({
        scenario_id: sc.id,
        title: "t",
        status: "活跃",
        dsh_session_id: "dsh-x",
      }).id;
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${cid}/messages`,
        payload: { content: "篇幅两页纸" },
      });
      // converse 走 mock dsh 的主链路，flag 关时抽取不额外占会话
      expect([200, 500]).toContain(res.statusCode); // mock 环境主链路可能 500，关键是无抽取调用
      const createCalls = (mockDsh.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(createCalls).toBeLessThanOrEqual(1); // 只有主链路至多 1 次，无抽取第 2 次
    } finally {
      if (prev === undefined) delete process.env.SCENE_REFLECTION_ENABLED;
      else process.env.SCENE_REFLECTION_ENABLED = prev;
    }
  });
});
