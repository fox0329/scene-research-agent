/**
 * @scene/server — 步骤联网调研测试
 *
 * 覆盖（不联网，注入假检索函数）：
 *  - 有结果：落库、按归一化 URL 去重、saved 计数
 *  - 检索抛错：函数本身不抛、errors 有值、落一条「检索失败」
 *  - 引擎不可用（canSearch = false）：saved = 0 + errors，且不伪造结果
 *  - query 构造：4–6 条、去重、每条 ≤40 字
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Scenario } from "@scene/contract";
import { FLOW_LAST_STEP } from "@scene/contract";
import { createDb, type DbInstance } from "@scene/infra";
import { buildStepQueries, runStepResearch, type SearchFn } from "./step-research.js";

describe("step-research — query 构造", () => {
  it("每步 4–6 条、去重、每条 ≤40 字，且带上场景名", () => {
    for (let step = 1; step <= FLOW_LAST_STEP; step++) {
      const queries = buildStepQueries("智慧水务", step);
      expect(queries.length).toBeGreaterThanOrEqual(4);
      expect(queries.length).toBeLessThanOrEqual(6);
      expect(new Set(queries).size).toBe(queries.length);
      for (const q of queries) {
        expect(Array.from(q).length).toBeLessThanOrEqual(40);
        expect(q.startsWith("智慧水务")).toBe(true);
      }
    }
  });

  it("超长场景名按 40 字截断，不产生重复 query", () => {
    const queries = buildStepQueries("某" + "超长场景名称".repeat(10), 3);
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(new Set(queries).size).toBe(queries.length);
    for (const q of queries) expect(Array.from(q).length).toBeLessThanOrEqual(40);
  });
});

describe("runStepResearch", () => {
  let db: DbInstance;
  let scenario: Scenario;

  beforeEach(() => {
    db = createDb(":memory:");
    scenario = db.scenarioRepo.insert({ name: "智慧水务", status: "进行中", current_stage: 1 });
  });

  afterEach(() => {
    db.db.close();
  });

  it("命中结果落库：同一 URL（不同追踪参数）去重后 saved=2", async () => {
    const search: SearchFn = async () => ({
      ok: true,
      hits: [
        {
          url: "https://www.gov.cn/zhengce/water?utm_source=bing",
          title: "智慧水务行业标准",
          snippet: "到 2025 年，城市公共供水管网漏损率控制在 9% 以内。",
        },
        {
          url: "https://example.com/bidding",
          title: "智慧水务项目招标资质要求",
          snippet: "投标人须具备电子与智能化工程专业承包二级及以上资质。",
        },
      ],
    });

    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
    });

    expect(result.saved).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.queries).toBeGreaterThanOrEqual(4);
    expect(result.engine).toBe("bing-html");

    const rows = db.researchRepo.listByStep(scenario.id, 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "有效")).toBe(true);
    expect(rows.every((r) => r.url_key !== "")).toBe(true);
    // 追踪参数被归一化掉：库里存的是原始 URL，但两条不同的 utm 只会有一条
    expect(new Set(rows.map((r) => r.url_key)).size).toBe(2);
    expect(rows.some((r) => r.title === "智慧水务行业标准")).toBe(true);

    // 同一步重跑：按 (scenario_id, step, url_key) 幂等更新，不累积重复链接
    const again = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
    });
    expect(again.saved).toBe(2);
    expect(db.researchRepo.listByStep(scenario.id, 2)).toHaveLength(2);
  });

  it("检索结果与本步无关时一条都不落库（宁可空着，不给噪声）", async () => {
    const search: SearchFn = async () => ({
      ok: true,
      hits: [
        { url: "https://baike.baidu.com/item/城镇", title: "城镇（行政区划）_百度百科", snippet: "城镇的定义" },
        { url: "https://example.com/tuanjian", title: "网上共青团·智慧团建", snippet: "团员管理" },
      ],
    });
    const result = await runStepResearch(db, scenario, 2, { cfg: { engine: "baidu-html" }, search });
    expect(result.saved).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);
    const rows = db.researchRepo.listByStep(scenario.id, 2);
    expect(rows.filter((r) => r.status === "有效")).toHaveLength(0);
  });

  it("检索函数抛错：不抛、errors 有值、落一条「检索失败」", async () => {
    const search: SearchFn = async () => {
      throw new Error("网络被拦");
    };

    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
    });

    expect(result.saved).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join("；")).toContain("网络被拦");

    const rows = db.researchRepo.listByStep(scenario.id, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("检索失败");
    expect(rows[0]!.error).toContain("网络被拦");
    expect(rows[0]!.query).toContain("检索失败");
    expect(rows[0]!.url).toBe("");
  });

  it("引擎不可用（canSearch = false）：saved=0、errors 说明原因，不假装有结果", async () => {
    const result = await runStepResearch(db, scenario, 2, { cfg: { engine: "none" } });

    expect(result.saved).toBe(0);
    expect(result.engine).toBe("none");
    expect(result.errors).toHaveLength(1);

    const rows = db.researchRepo.listByStep(scenario.id, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("检索失败");
    expect(rows[0]!.query).toContain("检索失败");
  });

  it("命中结果全部不是 http(s)：过滤掉，仍如实记为检索失败", async () => {
    const search: SearchFn = async () => ({
      ok: true,
      hits: [{ url: "ftp://example.com/file", title: "非法协议" }],
    });

    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
    });

    expect(result.saved).toBe(0);
    const rows = db.researchRepo.listByStep(scenario.id, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("检索失败");
  });
});
