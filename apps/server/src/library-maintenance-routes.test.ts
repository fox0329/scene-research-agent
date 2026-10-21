/**
 * 能力重复合并路由：POST 才改库、GET 只读预览（fastify.inject）
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
  const line = db.productLineRepo.insert({ name: "合并路由库" });
  const short = db.capabilityRepo.insert({
    product_line_id: line.id,
    domain: "工业",
    name: "设备监测",
    description: "支持设备监测",
    maturity: "已交付",
    dependency: "",
    source: "材料A.docx",
    source_type: "AI提取",
    source_authority: "T3",
    evidence_level: "B",
  } as never);
  const long = db.capabilityRepo.insert({
    product_line_id: line.id,
    domain: "工业",
    name: "设备监测",
    description: "支持设备状态实时监测，并可导出历史曲线与告警记录",
    maturity: "已交付",
    dependency: "",
    source: "材料B.docx",
    source_type: "AI提取",
    source_authority: "T3",
    evidence_level: "B",
  } as never);
  return { app, db, lineId: line.id, shortId: short.id, longId: long.id };
}

describe("GET/POST /api/v1/library/dedupe", () => {
  it("GET 只读预览：列出将合并的组，不删行", async () => {
    const { app, db, lineId, shortId, longId } = setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/library/dedupe?product_line_id=${lineId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      merged: { keptId: string; removedIds: string[]; keptDescription: string }[];
    };
    expect(body.merged).toHaveLength(1);
    expect(body.merged[0]!.keptId).toBe(longId);
    expect(body.merged[0]!.removedIds).toEqual([shortId]);
    expect(db.capabilityRepo.getById(shortId)).toBeTruthy();
    expect(db.capabilityRepo.getById(longId)).toBeTruthy();
  });

  it("POST 执行合并并返回报告；再 POST 幂等（merged 0）", async () => {
    const { app, db, lineId, shortId, longId } = setup();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/library/dedupe",
      payload: { product_line_id: lineId },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { merged: { keptId: string; removedIds: string[] }[] };
    expect(body.merged).toHaveLength(1);
    expect(body.merged[0]!.keptId).toBe(longId);
    expect(db.capabilityRepo.getById(shortId)).toBeUndefined();
    expect(db.capabilityRepo.getById(longId)).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/library/dedupe",
      payload: { product_line_id: lineId },
    });
    expect((second.json() as { merged: unknown[] }).merged).toHaveLength(0);
  });

  it("产品线不存在 → 404；不传产品线 → 全库", async () => {
    const { app, lineId } = setup();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/library/dedupe?product_line_id=nope",
    });
    expect(missing.statusCode).toBe(404);

    const postMissing = await app.inject({
      method: "POST",
      url: "/api/v1/library/dedupe",
      payload: { product_line_id: "nope" },
    });
    expect(postMissing.statusCode).toBe(404);

    const all = await app.inject({ method: "GET", url: "/api/v1/library/dedupe" });
    expect(all.statusCode).toBe(200);
    expect((all.json() as { merged: unknown[] }).merged).toHaveLength(1);
    expect(lineId).toBeTruthy();
  });
});
