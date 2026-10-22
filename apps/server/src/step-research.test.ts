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
import {
  buildStepQueries,
  keywordsFromDefinition,
  isHitRelevant,
  runStepResearch,
  type FetchFn,
  type FetchOutcome,
  type SearchFn,
} from "./step-research.js";

/** 长到不触发「正文过短」降级的正文，且标题词出现在前 500 字（避免被判标题不符） */
const LONG_BODY =
  "智慧水务行业标准与建设规范。为规范城镇供水管网漏损控制，明确水质达标率、压力合格率与漏损率指标。" +
  "本标准适用于城镇公共供水系统的规划、设计、施工与运行维护，给出了评价方法与验收要求。".repeat(6);

/** 假抓取：默认返回可验真的政府页；over 覆盖发布方/日期等 */
function page(over: Partial<FetchOutcome> = {}): FetchFn {
  return async (url) => ({
    ok: true,
    url,
    finalUrl: url,
    title: "智慧水务行业标准",
    markdown: LONG_BODY,
    publisher: "住房和城乡建设部",
    publishedAt: "2025-03-01",
    httpStatus: 200,
    contentType: "text/html",
    ...over,
  });
}

/** 假抓取：一律失败（不联网、不抛） */
function failingPage(): FetchFn {
  return async (url) => ({ ok: false, url, markdown: "", error: "站点拒绝抓取（403）" });
}

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

  it("keywords 参与 query 构造：最多 3 个实体，拼成具体标准/资质 query", () => {
    const queries = buildStepQueries("智慧水务", 2, ["等保三级", "漏损率", "CT15", "第四个会被丢掉"]);
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.length).toBeLessThanOrEqual(6);
    const joined = queries.join("\n");
    expect(joined).toContain("等保三级");
    expect(joined).toContain("漏损率");
    expect(joined).toContain("CT15");
    expect(joined).not.toContain("第四个会被丢掉");
    expect(queries.some((q) => q.includes("等保三级 标准") || q.includes("等保三级 资质"))).toBe(true);
    for (const q of queries) expect(Array.from(q).length).toBeLessThanOrEqual(40);
  });

  it("从定义里抽领域词：不把整句当关键词，也不只靠场景名", () => {
    const keywords = keywordsFromDefinition(
      [
        "长输/城际管道的线路截断阀室、分输阀室、清管站阀室、阴极保护间、放空立管及附属井室",
        "长输管网/管道公司、省级天然气管网公司",
      ],
      "管网阀室",
    );
    expect(keywords).toEqual(["城际管道", "线路截断阀室", "分输阀室"]);
    const queries = buildStepQueries("管网阀室", 2, keywords);
    expect(queries[0]).toContain("城际管道");
    expect(queries.some((q) => q.includes("线路截断阀室"))).toBe(true);
  });

  it("相关性要求场景核心：只有「管网」的供热标准不能当阀室来源", () => {
    const keywords = ["城际管道", "线路截断阀室", "分输阀室"];
    expect(
      isHitRelevant(
        "管网阀室 城际管道 标准",
        "城镇供热管网设计标准",
        "供热管网设计压力与温度要求",
        "管网阀室",
        keywords,
      ),
    ).toBe(false);
    expect(
      isHitRelevant(
        "管网阀室 城际管道 标准",
        "天然气管网管线进入场站阀室安全管理规定",
        "站场、阀室防静电工作服要求",
        "管网阀室",
        keywords,
      ),
    ).toBe(true);
    expect(
      isHitRelevant(
        "管网阀室 线路截断阀室 资质",
        "长输管道阀室设计规范",
        "线路截断阀室、分输阀室的设计要求",
        "管网阀室",
        keywords,
      ),
    ).toBe(true);
    // 标题是广告、只有摘要提到阀室：不能收
    expect(
      isHitRelevant(
        "管网阀室 门槛与合规",
        "大型钢企 PE 燃气管带压封堵合规公司推荐",
        "涉及阀室、管道抢修与合规要求",
        "管网阀室",
        keywords,
      ),
    ).toBe(false);
    // 标题只有泛泛的“燃气管网/管道”，没有阀室：不能收
    expect(
      isHitRelevant(
        "管网阀室 分层架构",
        "城市生命线安全专项应用系统 - 燃气管网安全监测系统",
        "城镇燃气管道阀井在线监测",
        "管网阀室",
        keywords,
      ),
    ).toBe(false);
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
      fetch: page(),
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
      fetch: page(),
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

  it("某条 query 被反爬拦住时，会用领域词补搜，不让整步断粮", async () => {
    const calls: string[] = [];
    const search: SearchFn = async (q) => {
      calls.push(q);
      if (calls.length === 1) return { ok: false, hits: [], error: "安全验证页" };
      return {
        ok: true,
        hits: [
          {
            url: `https://www.gov.cn/zhengce/water-${calls.length}`,
            title: "智慧水务技术规范",
            snippet: "智慧水务供水管网标准要求。",
          },
        ],
      };
    };
    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
      fetch: page(),
    });
    expect(result.saved).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(4);
    expect(calls.some((q) => /技术规范|安全 规范/u.test(q))).toBe(true);
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

  it("抓正文成功 → authority/published_at/verified=1 回写，且 publishedAt 来自抓取页", async () => {
    const search: SearchFn = async () => ({
      ok: true,
      hits: [
        {
          url: "https://www.gov.cn/zhengce/water-standard",
          title: "智慧水务行业标准",
          snippet: "明确了智慧水务的漏损率与水质指标。",
        },
      ],
    });
    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
      fetch: page({ publisher: "住房和城乡建设部", publishedAt: "2025-03-01" }),
    });

    expect(result.saved).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.authorityCounts.T1).toBe(1);
    const row = db.researchRepo.listByStep(scenario.id, 2)[0]!;
    expect(row.status).toBe("有效");
    expect(row.verified).toBe(1);
    expect(row.authority).toBe("T1");
    expect(row.publisher).toBe("住房和城乡建设部");
    expect(row.published_at).toBe("2025-03-01");
    expect(row.domain).toBe("gov.cn");
    expect(row.stale).toBe(0);
    // 正文已落 web_source（不是只存了一个 search hit）
    const web = db.db.prepare("SELECT authority, publisher, published_at FROM web_source").all() as Array<{
      authority: string;
      publisher: string;
      published_at: string;
    }>;
    expect(web).toHaveLength(1);
    expect(web[0]!.published_at).toBe("2025-03-01");
  });

  it("抓取失败 → 保留命中但 verified=0、authority 为空，不崩", async () => {
    const search: SearchFn = async () => ({
      ok: true,
      hits: [
        {
          url: "https://www.gov.cn/zhengce/water-standard",
          title: "智慧水务行业标准",
          snippet: "明确了智慧水务的漏损率与水质指标。",
        },
      ],
    });
    const result = await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search,
      fetch: failingPage(),
    });

    expect(result.saved).toBe(1);
    expect(result.verified).toBe(0);
    const row = db.researchRepo.listByStep(scenario.id, 2)[0]!;
    expect(row.verified).toBe(0);
    expect(row.authority).toBe("");
    expect(row.error).toContain("403");
    expect(row.url).toContain("gov.cn");
  });

  it("发布时间早于 3 年前 → stale=1；没有日期不判过期", async () => {
    const search = (url: string, title: string): SearchFn => async () => ({
      ok: true,
      hits: [{ url, title, snippet: "智慧水务标准要求。" }],
    });
    await runStepResearch(db, scenario, 2, {
      cfg: { engine: "bing-html" },
      search: search("https://www.gov.cn/old", "智慧水务旧标准"),
      fetch: page({ publishedAt: "2015-01-01" }),
    });
    const old = db.researchRepo.listByStep(scenario.id, 2)[0]!;
    expect(old.stale).toBe(1);
    expect(old.verified).toBe(1);

    db.researchRepo.clearStep(scenario.id, 3);
    await runStepResearch(db, scenario, 3, {
      cfg: { engine: "bing-html" },
      search: search("https://www.gov.cn/new", "智慧水务新标准"),
      fetch: page({ publishedAt: "" }),
    });
    const noDate = db.researchRepo.listByStep(scenario.id, 3)[0]!;
    expect(noDate.verified).toBe(1);
    expect(noDate.stale).toBe(0);
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
