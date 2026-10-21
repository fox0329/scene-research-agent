/**
 * 存量资料体检路由：GET 只读、POST 才改数据（fastify.inject）
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
  const line = db.productLineRepo.insert({ name: "体检测试库" });
  const product = db.productRepo.insert({
    product_line_id: line.id,
    model: "CT21B",
    name: "在鸿工控机CT21B",
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "主力型号",
    source: "https://mp.weixin.qq.com/s/abc",
    source_type: "AI提取",
    source_authority: "T4",
    evidence_level: "B",
  } as never);
  return { app, db, lineId: line.id, productId: product.id };
}

describe("POST/GET /api/v1/library/reaudit", () => {
  it("GET 只读预览：返回报告 applied:false，不改库", async () => {
    const { app, db, lineId, productId } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/library/reaudit?product_line_id=${lineId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scanned: number;
      downgraded: number;
      applied: boolean;
      evidence: { C: number };
      byTable: Record<string, number>;
    };
    expect(body.applied).toBe(false);
    expect(body.scanned).toBe(1);
    expect(body.downgraded).toBe(1);
    expect(body.evidence.C).toBe(1);
    expect(body.byTable.M1).toBe(1);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("B");
  });

  it("POST 才改数据并返回计数；再次 POST 幂等（downgraded 0）", async () => {
    const { app, db, lineId, productId } = setup();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/library/reaudit",
      payload: { product_line_id: lineId },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { applied: boolean; downgraded: number };
    expect(body.applied).toBe(true);
    expect(body.downgraded).toBe(1);
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("C");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/library/reaudit",
      payload: { product_line_id: lineId },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { downgraded: number }).downgraded).toBe(0);
  });

  it("产品线不存在 → 404；不传 product_line_id → 全库", async () => {
    const { app, lineId } = setup();
    const missing = await app.inject({ method: "GET", url: "/api/v1/library/reaudit?product_line_id=nope" });
    expect(missing.statusCode).toBe(404);

    const all = await app.inject({ method: "GET", url: "/api/v1/library/reaudit" });
    expect(all.statusCode).toBe(200);
    expect((all.json() as { scanned: number }).scanned).toBeGreaterThanOrEqual(1);

    const postMissing = await app.inject({
      method: "POST",
      url: "/api/v1/library/reaudit",
      payload: { product_line_id: "nope" },
    });
    expect(postMissing.statusCode).toBe(404);
    expect(lineId).toBeTruthy();
  });
});
