/**
 * 联网核验路由：POST 改库（升级证据）、GET 只读统计（fastify.inject）
 *
 * 检索/抓取用注入的假函数，不联网。
 */

import { describe, expect, it, vi } from "vitest";
import type { DshClient } from "@scene/contract";
import { createDb } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";
import type { LibraryVerifyDeps } from "./library-verify.js";

function mockDsh(): DshClient {
  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-x" })),
    prompt: vi.fn(() => (async function* () {})()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

const BODY = (() => {
  const seed =
    "本页为产品规格说明，面向工业现场部署。设备支持多种工业协议接入、本地数据处理与远程运维。" +
    "并提供完整的接口定义、环境适应性说明与安装指引。";
  return `# CT21B 工业计算机 产品规格说明\n\n${(seed + "\n\n").repeat(8)}\nCT21B`;
})();

const verifyDeps: LibraryVerifyDeps = {
  search: async () => ({
    ok: true,
    hits: [
      {
        url: "https://docs.example.com/ct21b",
        title: "CT21B 工业计算机",
        snippet: "CT21B",
      },
    ],
  }),
  fetch: async (url: string) => ({
    ok: true,
    url,
    finalUrl: url,
    title: "CT21B 工业计算机 产品规格说明",
    markdown: BODY,
    publishedAt: "2025-06-01",
    publisher: "示例科技",
    httpStatus: 200,
    contentType: "text/html",
  }),
};

function setup() {
  const db = createDb(":memory:");
  const app = createApp({
    db,
    dshClient: mockDsh(),
    hub: createSseHub(),
    libraryVerifyDeps: verifyDeps,
  });
  const line = db.productLineRepo.insert({ name: "核验路由库" });
  const product = db.productRepo.insert({
    product_line_id: line.id,
    model: "CT21B",
    name: "在鸿工控机CT21B",
    status: "在售",
    launch_date: "2025-01-01",
    position_desc: "主力型号",
    source: "产品彩页.docx",
    source_type: "AI提取",
    source_authority: "T3",
    evidence_level: "B",
  } as never);
  return { app, db, lineId: line.id, productId: product.id };
}

describe("POST /api/v1/library/verify", () => {
  it("执行核验：T2 命中 → 已核实并把证据级升 A", async () => {
    const { app, db, lineId, productId } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/library/verify",
      payload: { product_line_id: lineId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      checked: number;
      verified: number;
      upgraded: number;
      remaining: number;
      details: { table: string; row_id: string; status: string; sources: { url: string }[] }[];
    };
    expect(body.checked).toBe(1);
    expect(body.verified).toBe(1);
    expect(body.upgraded).toBe(1);
    expect(body.remaining).toBe(0);
    expect(body.details[0]!.table).toBe("M1");
    expect(body.details[0]!.row_id).toBe(productId);
    expect(body.details[0]!.sources[0]!.url).toBe("https://docs.example.com/ct21b");
    expect(db.productRepo.getById(productId)!.evidence_level).toBe("A");
  });

  it("limit 非法 → 400；产品线不存在 → 404", async () => {
    const { app, lineId } = setup();
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/library/verify",
      payload: { limit: 0 },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/library/verify",
      payload: { product_line_id: "nope" },
    });
    expect(missing.statusCode).toBe(404);
    expect(lineId).toBeTruthy();
  });
});

describe("GET /api/v1/library/verification", () => {
  it("只读统计与分组明细；读取不改变证据级", async () => {
    const { app, db, lineId, productId } = setup();
    await app.inject({
      method: "POST",
      url: "/api/v1/library/verify",
      payload: { product_line_id: lineId },
    });

    const before = db.productRepo.getById(productId)!.evidence_level;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/library/verification?product_line_id=${lineId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      by_status: Record<string, number>;
      upgraded: number;
      details: { table: string; row_id: string; status: string; sources: { url: string }[] }[];
      groups: Record<string, { row_id: string }[]>;
    };
    expect(body.total).toBe(1);
    expect(body.by_status["已核实"]).toBe(1);
    expect(body.upgraded).toBe(1);
    expect(body.groups["已核实"]![0]!.row_id).toBe(productId);
    expect(body.details[0]!.sources[0]!.url).toBe("https://docs.example.com/ct21b");
    // GET 只读：不改证据级、不新增记录
    expect(db.productRepo.getById(productId)!.evidence_level).toBe(before);
    expect(db.verificationRepo.listAll()).toHaveLength(1);
  });

  it("产品线不存在 → 404；不传产品线 → 全库", async () => {
    const { app, lineId } = setup();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/library/verification?product_line_id=nope",
    });
    expect(missing.statusCode).toBe(404);

    const all = await app.inject({ method: "GET", url: "/api/v1/library/verification" });
    expect(all.statusCode).toBe(200);
    expect(lineId).toBeTruthy();
  });
});
