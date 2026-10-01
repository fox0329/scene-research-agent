/**
 * @scene/server — 场景诉求与场景锚路由测试（P3-a）
 *
 * 覆盖：POST /projects 带诉求建场景、GET/PUT /projects/:id/brief、
 * PUT /projects/:id/anchor（逐格写入 + 派生缓存）、POST /projects/:id/brief/draft、
 *
 * v2.2 起 legacy `POST /projects/:id/draft-definition` 已移除——它会**自动**起草锚行，
 * 与「只在用户点『整理成定义』时才写表」冲突（定义只走 /definition/* 三端点）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";

function mockDshClient(events: FollowEvent[] = []): DshClient {
  return {
    createSession: vi.fn(async ({ title }: { title: string }) => ({ sessionId: `dsh-${title}` })),
    prompt: vi.fn(() => (async function* () {
      for (const e of events) yield e;
    })()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

let db: DbInstance;
let app: ReturnType<typeof createApp>;

function makeApp(events?: FollowEvent[]): void {
  db = createDb(":memory:");
  process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
  process.env.SCENE_PROVIDERS_FILE = join(
    mkdtempSync(join(tmpdir(), "scene-providers-")),
    "providers.local.json",
  );
  app = createApp({ db, dshClient: mockDshClient(events), hub: createSseHub() });
}

async function createProject(body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/projects", payload: body });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

beforeEach(() => makeApp());

describe("POST /projects — 场景诉求随建场景写入", () => {
  it("带 intent 时写入诉求并预建表1-1 锚骨架", async () => {
    const id = await createProject({
      name: "智慧水务",
      intent: "想搞清楚这个场景值不值得进",
      customer_hint: "市政水务集团",
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${id}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { brief: { intent: string } | null; anchor: unknown[] };
    expect(body.brief?.intent).toBe("想搞清楚这个场景值不值得进");
    expect(body.anchor).toHaveLength(12);
  });

  it("不带 intent 时不建诉求（保持旧调用兼容），但仍预建锚骨架", async () => {
    const id = await createProject({ name: "只有名字" });
    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${id}/brief` });
    const body = res.json() as { brief: unknown; anchor: unknown[] };
    expect(body.brief).toBeNull();
    expect(body.anchor).toHaveLength(12);
  });
});

describe("PUT /projects/:id/brief", () => {
  it("写入诉求；缺 intent 返回 400（它是第一输入）", async () => {
    const id = await createProject({ name: "智慧水务" });
    const bad = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${id}/brief`,
      payload: { intent: "  " },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toContain("第一输入");

    const ok = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${id}/brief`,
      payload: { intent: "想看怎么做方案", audience: "给客户看" },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { brief: { intent: string; raw_text: string } };
    expect(body.brief.intent).toBe("想看怎么做方案");
    expect(body.brief.raw_text).toContain("想搞清楚什么：想看怎么做方案");
  });

  it("场景不存在返回 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/nope/brief",
      payload: { intent: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /projects/:id/anchor — 逐格写入与派生缓存", () => {
  it("写入若干行后 description 由锚行派生", async () => {
    const id = await createProject({ name: "智慧水务", intent: "看值不值得进" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${id}/anchor`,
      payload: {
        rows: [
          { item: "客户类型/行业", content: "市政水务集团", source_type: "用户确认" },
          { item: "核心用途", content: "漏损监测", source_type: "AI提取" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; description: string };
    expect(body.rows).toHaveLength(12);
    expect(body.description).toContain("客户类型/行业：市政水务集团");
    expect(db.scenarioRepo.getById(id)?.description).toContain("核心用途：漏损监测");
  });

  it("rows 非数组返回 400", async () => {
    const id = await createProject({ name: "x" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${id}/anchor`,
      payload: { rows: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /projects/:id/brief/draft", () => {
  it("无诉求时返回 400（起草必须有基准）", async () => {
    const id = await createProject({ name: "只有名字" });
    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${id}/brief/draft` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("场景诉求");
  });

  it("有诉求时起草写锚（LLM 失败走降级，不阻断）", async () => {
    const id = await createProject({
      name: "智慧水务",
      intent: "看值不值得进",
      customer_hint: "市政水务集团",
    });
    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${id}/brief/draft` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: { item: string; content: string }[]; used_llm: boolean };
    expect(body.rows).toHaveLength(12);
    expect(body.used_llm).toBe(false); // mock 无 JSON 输出 → 降级
    expect(body.rows.find((r) => r.item === "客户类型/行业")?.content).toBe("市政水务集团");
  });
});
