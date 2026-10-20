/**
 * @scene/server — 阶段总结文档服务与路由测试（P3-c1）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, FollowEvent } from "@scene/contract";
import { createDb } from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { createApp } from "./app.js";
import { createSseHub } from "./sse-hub.js";
import {
  normalizeStage,
  readStageRowsByTable,
  generateStageSummary,
  getOrGenerateStageSummary,
  stageCompletenessOf,
} from "./stage-summary-service.js";
import { writeAnchorRows } from "./scenario-anchor.js";

function mockDsh(events: FollowEvent[] = []): DshClient {
  return {
    createSession: vi.fn(async ({ title }: { title: string }) => ({ sessionId: `dsh-${title}` })),
    prompt: vi.fn(() => (async function* () {
      for (const e of events) yield e;
    })()),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

function seed(): { db: DbInstance; scenarioId: string; lineId: string } {
  const db = createDb(":memory:");
  const line = db.productLineRepo.insert({ name: "感知与控制" });
  const sc = db.scenarioRepo.insert({
    name: "智慧水务",
    description: null,
    status: "进行中",
    current_stage: 1,
  });
  // 表1-3 一行 + 表1-1 锚一行（表1-2、表2-7 已移到阶段 3）
  db.stageDataRepo.insert({
    scenario_id: sc.id,
    stage: 1,
    table_code: "表1-3",
    row: { barrier_type: "技术", barrier_name: "水质达标率", criteria: "≥ 99%", judgment: "过得了" },
    is_stale: false,
    source: "《招标》p.2",
  });
  db.stageDataRepo.insert({
    scenario_id: sc.id,
    stage: 1,
    table_code: "表1-1",
    row: { item: "场景边界", content: "制水厂到管网末端", source_type: "用户确认" },
    is_stale: false,
    source: "用户输入",
  });
  db.scenarioBriefRepo.upsert(sc.id, {
    scene_name: "智慧水务",
    intent: "值不值得进",
    customer_hint: null,
    region_hint: null,
    scope_hint: null,
    audience: null,
    deadline: null,
    raw_text: "场景名称：智慧水务\n想搞清楚什么：值不值得进",
  });
  return { db, scenarioId: sc.id, lineId: line.id };
}

describe("stage-summary-service — 阶段归一", () => {
  it("旧编号 8（交付物）归一为 7", () => {
    expect(normalizeStage(8 as never)).toBe(7);
    expect(normalizeStage(1)).toBe(1);
  });
});

describe("stage-summary-service — 读行", () => {
  it("按注册表表号取行，并始终带上场景锚（表1-1）", () => {
    const { db, scenarioId } = seed();
    const rows = readStageRowsByTable(db, scenarioId, 1);
    expect(Object.keys(rows)).toContain("表1-1");
    expect(Object.keys(rows)).toContain("表1-3");
    expect(rows["表1-3"]).toHaveLength(1);
    expect(rows["表1-1"]).toHaveLength(1);
  });

  it("只带注册表里的锚行：存量旧 12 项残项不进总结（用户投诉过的无效信息）", () => {
    const { db, scenarioId } = seed();
    writeAnchorRows(db, scenarioId, [
      { item: "场景名称", content: "智慧水务", source_type: "用户补充" },
      { item: "场景边界", content: "制水厂到管网末端", source_type: "AI推断" },
      // 旧 12 项制残项（迁移脚本执行前会躺在库里）
      { item: "价值主张", content: "用漏损率下降换运维成本", source_type: "AI推断" },
      { item: "核心业务流程", content: "取水-制水-输配", source_type: "AI推断" },
    ]);
    const items = readStageRowsByTable(db, scenarioId, 1)["表1-1"]!.map((r) => String(r["item"]));
    expect(items).toContain("场景边界");
    expect(items).not.toContain("价值主张");
    expect(items).not.toContain("核心业务流程");
  });
});

describe("stage-summary-service — 生成与落库", () => {
  it("生成六段骨架并写入 stage_summary", () => {
    const { db, scenarioId } = seed();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = generateStageSummary(db, sc, 1);
    expect(r.stage).toBe(1);
    expect(r.markdown).toContain("# 阶段 1 · 认识场景（含门槛与合规） — 总结");
    expect(r.markdown).toContain("## 五、待补齐信息");
    expect(r.markdown).toContain("用户诉求（第一输入，唯一基准）");
    expect(r.completeness.expectedTables).toBe(5);
    const stored = db.stageSummaryRepo.get(scenarioId, 1);
    expect(stored?.content).toBe(r.markdown);
  });

  it("getOrGenerate 命中缓存；refresh 重新生成", () => {
    const { db, scenarioId } = seed();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const first = getOrGenerateStageSummary(db, sc, 1);
    expect(first.cached).toBe(false);
    const second = getOrGenerateStageSummary(db, sc, 1);
    expect(second.cached).toBe(true);
    expect(second.markdown).toBe(first.markdown);
    const refreshed = generateStageSummary(db, sc, 1);
    expect(refreshed.markdown).toContain("阶段 1");
  });

  it("stageCompletenessOf 给出缺口清单（不含判定措辞）", () => {
    const { db, scenarioId } = seed();
    const c = stageCompletenessOf(db, scenarioId, 1);
    expect(c.expectedTables).toBe(5);
    expect(c.tablesWithData).toBe(2);
    const text = c.gaps.map((g) => g.detail).join(" ");
    expect(text).toContain("尚无数据");
    for (const bad of ["建议进", "不通过", "红线"]) expect(text).not.toContain(bad);
  });

  it("交付物阶段（6，老编号 7/8）也能生成说明性总结", () => {
    const { db, scenarioId } = seed();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = generateStageSummary(db, sc, 6);
    expect(r.stage).toBe(6);
    expect(r.markdown).toContain("阶段 6 · 最终交付物");
    expect(r.markdown).toContain("不给决策建议");
    expect(r.markdown).toContain("核实结论");
  });
});

describe("stage-summary-service — 路由", () => {
  let db: DbInstance;
  let app: ReturnType<typeof createApp>;
  let scenarioId: string;

  beforeEach(() => {
    const s = seed();
    db = s.db;
    scenarioId = s.scenarioId;
    process.env.EXPORT_DIR = mkdtempSync(join(tmpdir(), "scene-export-"));
    process.env.SCENE_PROVIDERS_FILE = join(
      mkdtempSync(join(tmpdir(), "scene-providers-")),
      "providers.local.json",
    );
    app = createApp({ db, dshClient: mockDsh(), hub: createSseHub() });
  });

  it("GET /stages/:n/completeness 返回缺口清单", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1/completeness`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { expectedTables: number; gaps: unknown[]; percent: number };
    expect(body.expectedTables).toBe(5);
    expect(body.gaps.length).toBeGreaterThan(0);
    expect(body.percent).toBe(40);
  });

  it("GET /stages/:n/summary 返回 markdown + 完整度", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1/summary`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { stage: number; markdown: string; completeness: { percent: number } };
    expect(body.stage).toBe(1);
    expect(body.markdown).toContain("## 六、上下游衔接");
    expect(body.completeness.percent).toBe(40);
  });

  it("GET /stages/:n/summary?format=md 直接下载 Markdown", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/1/summary?format=md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("stage-1-summary.md");
    expect(res.body).toContain("阶段 1");
  });

  it("阶段号非法 / 场景不存在分别返回 400 / 404", async () => {
    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/x/summary`,
    });
    expect(bad.statusCode).toBe(400);
    const nf = await app.inject({ method: "GET", url: "/api/v1/projects/nope/stages/1/summary" });
    expect(nf.statusCode).toBe(404);
  });
});
