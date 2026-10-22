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
  getStageBrief,
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
    expect(r.completeness.expectedTables).toBe(6);
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
    expect(c.expectedTables).toBe(6);
    expect(c.tablesWithData).toBe(2);
    const text = c.gaps.map((g) => g.detail).join(" ");
    expect(text).toContain("尚无数据");
    for (const bad of ["建议进", "不通过", "红线"]) expect(text).not.toContain(bad);
  });

  it("交付物阶段（5，老编号 6/7/8）也能生成说明性总结", () => {
    const { db, scenarioId } = seed();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = generateStageSummary(db, sc, 5);
    expect(r.stage).toBe(5);
    expect(r.markdown).toContain("阶段 5 · 最终交付物");
    expect(r.markdown).toContain("不给决策建议");
    expect(r.markdown).toContain("核实结论");
  });
});

describe("stage-summary-service — 右栏要点（brief）", () => {
  it("从真实行推导来源地址与结论提醒，不产 Markdown、不写库", () => {
    const { db, scenarioId } = seed();
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: {
        barrier_type: "行业准入",
        barrier_name: "等保三级",
        criteria: "GB/T 22239",
        cert_gap: "等保三级认证",
        source: "https://example.com/standard",
      },
      is_stale: false,
      source: "https://example.com/standard",
    });
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 1, 2);
    expect(r.stage).toBe(1);
    expect(r.scope).toBe("step");
    expect(r.brief.sources).toEqual([
      { label: "等保三级", url: "https://example.com/standard" },
    ]);
    expect(r.brief.advice).toContain(
      "门槛「等保三级」：拿不出 等保三级认证——不建议贸然进入",
    );
    expect(db.stageSummaryRepo.get(scenarioId, 1)).toBeUndefined();
  });

  it("没有判据时给兜底，不凑数", () => {
    const { db, scenarioId } = seed();
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 3, 4);
    expect(r.brief.advice).toEqual([
      "本步还没有可下结论的判据：门槛、赢面与能力匹配表尚未产出，风险提醒随这些表出现",
    ]);
    expect(r.brief.sources).toEqual([]);
  });

  it("第 3 步仍带出第 2 步未消解的门槛提醒（不再说「门槛尚未产出」）", () => {
    const { db, scenarioId } = seed();
    // 第 2 步的门槛：认证类缺口，规则应给出「不建议贸然进入」
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: {
        barrier_type: "认证",
        barrier_name: "等保三级",
        criteria: "GB/T 22239",
        cert_gap: "等保三级认证",
      },
      is_stale: false,
      source: "《招标》p.2",
    });
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 1, 3);
    expect(r.brief.advice.join("；")).toContain("门槛");
    expect(r.brief.advice.join("；")).not.toContain("本步还没有可下结论的判据");
    expect(r.brief.note).toContain("前序");
  });

  it("本步有联网调研结果时前置在来源最前，并与行内 URL 去重", () => {
    const { db, scenarioId } = seed();
    // 行内来源：表1-3 引用了其中一条链接（同 URL 不能出现两次）
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: {
        barrier_type: "行业准入",
        barrier_name: "等保三级",
        criteria: "GB/T 22239",
        cert_gap: "等保三级认证",
        source: "https://example.com/standard",
      },
      is_stale: false,
      source: "https://example.com/standard",
    });
    const researchRow = (
      n: number,
      over: Partial<Parameters<DbInstance["researchRepo"]["upsert"]>[0]> = {},
    ): Parameters<DbInstance["researchRepo"]["upsert"]>[0] => ({
      id: `rs_test_${n}`,
      scenario_id: scenarioId,
      step: 2,
      query: "智慧水务 进入门槛",
      title: `调研标题${n}`,
      url: `https://example.com/research-${n}`,
      url_key: `key${n}`,
      snippet: "",
      engine: "bing-html",
      fetched_at: "2026-10-21T00:00:00.000Z",
      status: "有效",
      error: "",
      ...over,
    });
    // 长标题按 24 字截断
    const longTitle = "城镇供水行业标准与智慧水务建设规范（2025 年版）";
    const expectLabel = Array.from(longTitle).slice(0, 24).join("");
    db.researchRepo.upsert(researchRow(1, { title: longTitle }));
    // 与行内来源同 URL：合并后只留调研这一条
    db.researchRepo.upsert(
      researchRow(2, { title: "等保三级认证要求", url: "https://example.com/standard", url_key: "k-std" }),
    );
    // 检索失败记录不是来源，不能进右栏链接列表
    db.researchRepo.upsert(
      researchRow(3, { title: "检索失败", url: "", url_key: "", status: "检索失败", error: "网络被拦" }),
    );

    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 1, 2);

    expect(r.brief.sources[0]).toEqual({
      label: expectLabel,
      url: "https://example.com/research-1",
    });
    expect(r.brief.sources.map((s) => s.url)).toEqual([
      "https://example.com/research-1",
      "https://example.com/standard",
    ]);
  });

  it("本步没有来源但调研失败时，把失败原因带进 brief", () => {
    const { db, scenarioId } = seed();
    db.researchRepo.upsert({
      id: "rs_failed_1",
      scenario_id: scenarioId,
      step: 2,
      query: "管网阀室 门槛与合规",
      title: "检索失败",
      url: "",
      url_key: "",
      snippet: "",
      engine: "baidu-html",
      fetched_at: "2026-10-22T00:00:00.000Z",
      status: "检索失败",
      error: "「管网阀室 门槛与合规」百度返回安全验证页（可能需要降低频率或稍后再试）",
    });
    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 1, 2);
    expect(r.brief.sources).toEqual([]);
    expect(r.brief.researchFailure).toContain("百度返回安全验证页");
  });

  it("交付物步没有自己的表：右栏汇总前面所有判据与调研来源（不报「本步没有判据」）", () => {
    const { db, scenarioId } = seed();
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 1,
      table_code: "表1-3",
      row: {
        barrier_type: "行业准入",
        barrier_name: "等保三级",
        criteria: "GB/T 22239",
        cert_gap: "等保三级认证",
        source: "https://example.com/standard",
      },
      is_stale: false,
      source: "https://example.com/standard",
    });
    db.researchRepo.upsert({
      id: "rs_delivery_1",
      scenario_id: scenarioId,
      step: 2,
      query: "智慧水务 进入门槛",
      title: "城镇供水行业标准（2025 年版）",
      url: "https://example.com/research-delivery",
      url_key: "k-delivery",
      snippet: "",
      engine: "bing-html",
      fetched_at: "2026-10-21T00:00:00.000Z",
      status: "有效",
      error: "",
    });

    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 5, 6);

    expect(r.brief.advice).toContain(
      "门槛「等保三级」：拿不出 等保三级认证——不建议贸然进入",
    );
    expect(r.brief.advice.join("")).not.toContain("本步还没有可下结论的判据");
    expect(r.brief.sources.map((s) => s.url)).toEqual([
      "https://example.com/research-delivery",
      "https://example.com/standard",
    ]);
  });
});

describe("stage-summary-service — 右栏来源排序与标签（2026-10-21）", () => {
  const mk = (
    scenarioId: string,
    n: number,
    over: Partial<Parameters<DbInstance["researchRepo"]["upsert"]>[0]> = {},
  ): Parameters<DbInstance["researchRepo"]["upsert"]>[0] => ({
    id: `rs_sort_${n}`,
    scenario_id: scenarioId,
    step: 2,
    query: "智慧水务 标准",
    title: `来源${n}`,
    url: `https://example.com/s${n}`,
    url_key: `sort${n}`,
    snippet: "",
    engine: "baidu-html",
    fetched_at: "2026-10-21T00:00:00.000Z",
    status: "有效",
    error: "",
    ...over,
  });

  it("T1 排最前、同权威下 verified=1 优先、stale 标注、label 带发布方与日期", () => {
    const { db, scenarioId } = seed();
    db.researchRepo.upsert(
      mk(scenarioId, 1, { title: "媒体解读", url: "https://example.com/media", authority: "T3", verified: 1, published_at: "2025-01-01" }),
    );
    db.researchRepo.upsert(
      mk(scenarioId, 2, {
        title: "国家标准全文",
        url: "https://www.gov.cn/standard",
        authority: "T1",
        verified: 1,
        publisher: "住建部",
        published_at: "2024-06-01",
      }),
    );
    db.researchRepo.upsert(
      mk(scenarioId, 3, { title: "未验真政府页", url: "https://www.gov.cn/raw", authority: "T1", verified: 0 }),
    );
    db.researchRepo.upsert(
      mk(scenarioId, 4, {
        title: "旧规范",
        url: "https://example.com/old",
        authority: "T2",
        verified: 1,
        publisher: "某协会",
        published_at: "2015-03-01",
        stale: 1,
      }),
    );

    const sc = db.scenarioRepo.getById(scenarioId)!;
    const r = getStageBrief(db, sc, 1, 2);
    const research = r.brief.sources.filter((x) => x.url.includes("example.com") || x.url.includes("gov.cn"));
    expect(research.map((x) => x.url)).toEqual([
      "https://www.gov.cn/standard", // T1 + verified
      "https://www.gov.cn/raw", // T1 未验真
      "https://example.com/old", // T2
      "https://example.com/media", // T3
    ]);
    expect(research[0]!.label).toBe("国家标准全文 · 住建部 · 2024-06");
    expect(research[2]!.label).toContain("（较早）");
    expect(research[2]!.label).toContain("2015-03");
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
    expect(body.expectedTables).toBe(6);
    expect(body.gaps.length).toBeGreaterThan(0);
    expect(body.percent).toBe(33);
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
    expect(body.completeness.percent).toBe(33);
  });

  it("GET /stages/:n/summary?view=brief 返回来源 + 提醒（不含 markdown）", async () => {
    db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: 3,
      table_code: "表4-3",
      row: {
        gap_ref: "边缘 AI 推理",
        match: "不能做",
        our_product: "AI Box",
        action: "转分包给算法厂商",
        source: "https://example.com/ai",
      },
      is_stale: false,
      source: "https://example.com/ai",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${scenarioId}/stages/3/summary?view=brief&step=4`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stage: number;
      action: string;
      brief: { sources: { label: string; url: string }[]; advice: string[] };
      completeness: { expectedTables: number };
    };
    expect(body.stage).toBe(3);
    expect(body.action).toBe("brief");
    expect(body.brief.sources).toEqual([
      { label: "边缘 AI 推理", url: "https://example.com/ai" },
    ]);
    expect(body.brief.advice).toContain(
      "「边缘 AI 推理」做不了，转分包给算法厂商——建议分包或放弃这一段",
    );
    expect(body.completeness.expectedTables).toBeGreaterThan(0);
    expect((body as unknown as { markdown?: string }).markdown).toBeUndefined();
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
