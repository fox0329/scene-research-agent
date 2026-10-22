/**
 * 资料库「表内新增行」路由：M3 的 dependency 是历史 NOT NULL 列，新增行必须给缺省值
 * （用户从空表直接填能力名/描述时不能再撞 500）。
 */

import { describe, expect, it, vi } from "vitest";
import type { DshClient } from "@scene/contract";
import { createDb } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";

function mockDsh(): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-x" })),
    prompt: vi.fn(() => (async function* () {})()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

function setup() {
  const db = createDb(":memory:");
  const app = createApp({ db, dshClient: mockDsh(), hub: createSseHub() });
  const line = db.productLineRepo.insert({ name: "新增行测试库" });
  return { app, db, lineId: line.id };
}

describe("POST /api/v1/library/rows/:code", () => {
  it("能力清单只填名称+描述即可新增：历史 dependency 列补空串，不报 500", async () => {
    const { app, db, lineId } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/library/rows/M3",
      payload: {
        product_line_id: lineId,
        values: { name: "边缘推理", description: "支持 6TOPS NPU 推理" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      product_line_id: lineId,
      name: "边缘推理",
      description: "支持 6TOPS NPU 推理",
      dependency: "",
    });

    const rows = db.capabilityRepo.list({
      where: "product_line_id = ?",
      params: [lineId],
    });
    expect(rows).toHaveLength(1);
  });
});
