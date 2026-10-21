/**
 * @scene/server — 每一步的联网调研（调研先于分析）
 *
 * 背景（用户质问 2026-10-21）：「调研信息来源为什么一个链接都没有？这不正常，
 * 就算是行业常识，调研也是第一步。」根因不是展示层——阶段分析的来源一直只写
 * 「行业通例（模型知识）」，**产品从来没有真正做过一步联网调研**。
 *
 * 本模块补上这一步：在某一步分析开始前，按「场景名 + 本步表名 / 场景名 + 资质/标准/报价」
 * 构造 4–6 条 query，走 `web-engine` 现有的检索通道，把命中的 URL 与标题落进
 * `research_source`，右栏「调研信息来源」直接把库里的链接列出来（可点开）。
 *
 * 三条铁律：
 *  ① **检索先于分析**：不靠模型回忆行业常识；模型拿到的上下文可以引用这些链接。
 *  ② **查不到就留空**：引擎不可用时**绝不假装有结果**，只写一条「检索失败」记录，
 *     右栏据此如实说明「本步还没有联网调研结果（可能检索不可用）」。
 *  ③ **不编链接**：只落检索接口真实返回的 http(s) URL；标题/摘要原样保留。
 *
 * 失败不能拖垮分析：`runStepResearch` **本身不抛**，异常一律收进 `errors`。
 */

import { createHash } from "node:crypto";
import type { Scenario } from "@scene/contract";
import { flowStep, tableDef } from "@scene/contract";
import {
  DEFAULT_BUDGET,
  loadRegistry,
  loadWebSearchConfig,
  resolveEngine,
  searchByEngine,
  type ResolvedEngine,
  type WebSearchConfig,
} from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { urlKey } from "@scene/domain";

/** 一次步骤调研的结果（路由原样返回，供手动补跑与验证） */
export interface StepResearchResult {
  /** 新落库/更新的有效链接数（按归一化 URL 去重） */
  saved: number;
  /** 实际构造并尝试的 query 条数 */
  queries: number;
  /** 被相关性过滤掉的结果数（检索服务返回了、但与本步 query 无关） */
  skipped: number;
  /** 引擎种类：deepseek-native / tavily / baidu-html / bing-html / none */
  engine: string;
  /** 检索失败原因（有链接时也可能非空——部分 query 失败不隐藏） */
  errors: string[];
}

/** 检索命中（只保留本模块用到的字段） */
export interface ResearchHit {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/**
 * 可注入的检索函数
 *
 * 默认实现走 `web-engine`；测试注入假函数，**不允许伪造"真实联网结果"**——
 * 假函数只用于验证落库/去重/失败处理，生产调用的是真引擎。
 */
export type SearchFn = (
  query: string,
  limit: number,
) => Promise<{ ok: boolean; hits: ResearchHit[]; error?: string }>;

/** 可注入依赖（测试用；生产不传） */
export interface StepResearchDeps {
  search?: SearchFn;
  cfg?: WebSearchConfig;
}

/** 每条 query 取几条结果（预算内够用，不贪多） */
const RESULT_LIMIT = 5;
/** 单条 query 最大字符数（用户要求 ≤40 字） */
const QUERY_MAX = 40;
/** 一次调研最多几条 query（4–6 条） */
const QUERY_MAX_COUNT = 6;
/** 至少凑够几条 query（不足时补通用 query） */
const QUERY_MIN_COUNT = 4;
/** snippet 落库截断（右栏不展示全文，避免库膨胀） */
const SNIPPET_MAX = 500;
/** 检索失败记录的归一化 URL 键：同一场景同一步只留一条失败记录 */
const FAILED_KEY = "";

/** 按字符数截断（中文按字算，不按 UTF-16 码元） */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** 本步的表名（拿不到步骤定义时返回空数组，不抛） */
function tableNamesOf(step: number): string[] {
  try {
    return flowStep(step)
      .tables.map((code) => tableDef(code)?.name ?? "")
      .filter((name) => name !== "");
  } catch {
    return [];
  }
}

/**
 * 拼一条 query：场景名按剩余预算截断，保证整条 ≤40 字
 *
 * 为什么不能统一截整条：场景名一长（>35 字）会把后面的关键词全截掉，
 * 几条 query 退化成同一个串（去重后只剩 1 条），检索就失效了。
 */
function withName(name: string, tail: string): string {
  const budget = QUERY_MAX - Array.from(tail).length - 1; // 留一个空格
  const head = clip(name, Math.max(4, budget));
  return `${head} ${tail}`.trim();
}

/**
 * 构造本步的检索 query（4–6 条、去重、每条 ≤40 字）
 *
 * 结构 = `<场景名> <本步表名>` × 最多 3 条 + 按步挑 2–3 条通用 query
 * （招标资质 / 标准 / 设备报价），不足 4 条时补「行业现状」。
 *
 * 为什么先放表名：本步要填什么表，就决定了"这一步该查什么"；用表名当关键词比
 * 让模型自由发挥更贴分析对象（如「智慧水务 进入门槛」）。
 */
export function buildStepQueries(scenarioName: string, step: number): string[] {
  const name = String(scenarioName ?? "").trim() || "行业";
  const raw: string[] = [];

  // ① 本步表名（最多 3 条，避免把预算吃光）
  for (const tableName of tableNamesOf(step).slice(0, 3)) {
    raw.push(withName(name, tableName));
  }

  // ② 通用 query：按步挑 2–3 条
  const generic =
    step <= 2
      ? ["招标 资质", "标准"]
      : step === 3
        ? ["招标 资质", "标准", "设备 报价"]
        : ["标准", "设备 报价"];
  for (const tail of generic) raw.push(withName(name, tail));

  // ③ 不足 4 条时补通用项（交付类步骤没有表名，只有 2–3 条通用 query 不够用）
  for (const tail of ["行业 现状", "市场 规模"]) {
    if (raw.length >= QUERY_MIN_COUNT) break;
    raw.push(withName(name, tail));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of raw) {
    const clipped = clip(q.replace(/\s+/gu, " ").trim(), QUERY_MAX);
    if (clipped === "" || seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= QUERY_MAX_COUNT) break;
  }
  return out;
}

/** 当前默认模型供应商（拿不到就返回 undefined——引擎自动选会退回免注册通道） */
function currentModelProvider(): { baseUrl: string; apiKey: string } | undefined {
  try {
    const registry = loadRegistry();
    const ref = registry.default_model;
    const provider =
      (ref ? registry.providers.find((p) => p.name === ref.provider) : undefined) ??
      registry.providers[0];
    if (!provider) return undefined;
    const baseUrl = String(provider.base_url ?? "").trim();
    const apiKey = String(provider.api_key ?? "").trim();
    if (baseUrl === "" || apiKey === "") return undefined;
    return { baseUrl, apiKey };
  } catch {
    return undefined;
  }
}

/** 把引擎包成 `SearchFn`（计数器与预算按一次调研共享） */
function engineSearchFn(engine: ResolvedEngine, cfg: WebSearchConfig): SearchFn {
  const counters = { searches: 0, fetches: 0, lastHit: new Map<string, number>() };
  return (query, limit) => searchByEngine(engine, cfg, query, counters, DEFAULT_BUDGET, limit);
}

/** 稳定的行 id：同一场景/步/URL 反复检索不换主键 */
function sourceId(scenarioId: string, step: number, key: string): string {
  const hash = createHash("sha256").update(`${scenarioId}|${step}|${key}`, "utf8").digest("hex");
  return `rs_${hash.slice(0, 16)}`;
}

/**
 * 写一条「检索失败」记录
 *
 * 用途：右栏要能如实说明"为什么没有链接"，而不是空白。`query` 写明原因。
 * 自身不抛——落库失败也不能让调研函数崩。
 */
function recordFailure(
  db: DbInstance,
  scenario: Scenario,
  step: number,
  reason: string,
  engine: string,
): void {
  try {
    const text = clip(reason, 200) || "联网检索不可用";
    db.researchRepo.upsert({
      id: sourceId(scenario.id, step, "__failed__"),
      scenario_id: scenario.id,
      step,
      query: `检索失败：${text}`,
      title: "检索失败",
      url: "",
      url_key: FAILED_KEY,
      snippet: "",
      engine,
      fetched_at: new Date().toISOString(),
      status: "检索失败",
      error: text,
    });
  } catch {
    // 失败记录本身写不进去时只能放弃：调研不是主流程，绝不能反过来中断分析
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 跑一次某步的联网调研
 *
 * 顺序：构造 query → 选引擎 → 逐条检索 → 命中落 `research_source`。
 * 引擎 `canSearch === false` 时不检索、不编结果，只写一条失败记录并返回原因。
 *
 * @param db - 数据库（写 `research_source`）
 * @param scenario - 场景（取名称拼 query，取 id 落库）
 * @param step - 流程步号（1 起）
 * @param deps - 测试注入（检索函数 / 引擎配置）；生产不传
 */
/** 广告/登录页式标题：标题本身就是噪声，直接不要（不是相关性判断，是清洗） */
const AD_TITLE_RE = /(开通.{0,4}会员|登录|注册|下载\s*APP|广告|商机信息|立即咨询)/iu;

/** 标题清洗：去标签、压空白；标题是 HTML 残渣或广告语时退回 URL */
function cleanTitle(raw: string, url: string): string {
  const text = raw
    .replace(/<[^>]*>/gu, " ")
    .replace(/&[a-z]+;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "" || /^[<\s]/u.test(text) || AD_TITLE_RE.test(text)) return url;
  return clip(text, 200);
}

/** 通用词：这些词出现在几乎每条 query 里，拿它们判相关性等于不判 */
const GENERIC_TERMS = new Set([
  "智慧", "系统", "平台", "行业", "场景", "方案", "管理", "服务", "数据", "现状",
  "规模", "招标", "资质", "标准", "要求", "报价", "设备", "市场", "分析", "调研",
  "门槛", "合规", "要素", "架构", "能力", "公司", "产品", "客户", "项目",
]);

/** 取「具体词」的二字组：搜索引擎对多词 query 的召回不可控，用字样重合度做确定性相关性过滤 */
function specificBigrams(text: string): Set<string> {
  const out = new Set<string>();
  // 通用词可能只是长词的前缀（「智慧水务」含「智慧」），要先剥掉再取二字组，
  // 否则「智慧团建」这种页面会因为共享「智慧」被误判成相关（实测踩过）
  let cleaned = String(text ?? "");
  for (const g of GENERIC_TERMS) cleaned = cleaned.split(g).join(" ");
  for (const token of cleaned.split(/\s+/u)) {
    const t = token.trim();
    if (t.length < 2) continue;
    const chars = Array.from(t);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const a = chars[i];
      const b = chars[i + 1];
      if (a !== undefined && b !== undefined) out.add(a + b);
    }
  }
  return out;
}

/** 标题/摘要与本条 query 是否有实质重合（≥1 个具体二字组） */
function isRelevant(query: string, title: string, snippet: string): boolean {
  const wanted = specificBigrams(query);
  if (wanted.size === 0) return true; // query 全是通用词：没有判据就不拦
  const hay = `${title} ${snippet}`;
  for (const bg of wanted) if (hay.includes(bg)) return true;
  return false;
}

export async function runStepResearch(
  db: DbInstance,
  scenario: Scenario,
  step: number,
  deps: StepResearchDeps = {},
): Promise<StepResearchResult> {
  const queries = buildStepQueries(scenario.name, step);
  const errors: string[] = [];
  let engineKind = "none";

  try {
    const provider = currentModelProvider();
    const cfg = deps.cfg ?? loadWebSearchConfig();
    const engine = resolveEngine(cfg, provider);
    engineKind = engine.kind;

    if (!engine.canSearch) {
      // 查不到就留空：写一条失败记录让右栏能如实说明，绝不假装有结果
      const reason = engine.detail || "没有可用的联网检索引擎";
      recordFailure(db, scenario, step, reason, engineKind);
      return { saved: 0, queries: queries.length, skipped: 0, engine: engineKind, errors: [reason] };
    }

    /**
     * 官方 DeepSeek 检索要带供应商 Key
     *
     * `resolveEngine` 用的是「当前供应商」参数，而 `searchByEngine` 只读
     * `cfg.modelProvider`——不把这两处接上，官方 DeepSeek 用户会得到
     * 「缺少 DeepSeek 供应商配置」。只在没显式配置时补，不覆盖用户配置。
     */
    const searchCfg: WebSearchConfig =
      engine.kind === "deepseek-native" && cfg.modelProvider === undefined && provider
        ? { ...cfg, modelProvider: provider }
        : cfg;

    const search = deps.search ?? engineSearchFn(engine, searchCfg);
    const seen = new Set<string>();
    let saved = 0;
    let skipped = 0;

    for (const query of queries) {
      try {
        const res = await search(query, RESULT_LIMIT);
        if (!res.ok) {
          errors.push(res.error ? `「${query}」${res.error}` : `「${query}」检索失败`);
          continue;
        }
        for (const hit of res.hits) {
          const url = String(hit.url ?? "").trim();
          if (!/^https?:\/\//iu.test(url)) continue;
          // 检索服务对多词 query 会退化成首词结果（实测 Bing 全是「城镇」「污水」百科），
          // 不相关的一条都不落库——宁可右栏空着，也不能把噪声当调研来源给用户
          if (!isRelevant(query, String(hit.title ?? ""), String(hit.snippet ?? ""))) {
            skipped += 1;
            continue;
          }
          const key = urlKey(url);
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            db.researchRepo.upsert({
              id: sourceId(scenario.id, step, key),
              scenario_id: scenario.id,
              step,
              query,
              title: cleanTitle(String(hit.title ?? ""), url),
              url,
              url_key: key,
              snippet: clip(String(hit.snippet ?? ""), SNIPPET_MAX),
              engine: engineKind,
              fetched_at: new Date().toISOString(),
              status: "有效",
              error: "",
            });
            saved++;
          } catch (err: unknown) {
            errors.push(`「${query}」结果落库失败：${errorText(err)}`);
          }
        }
      } catch (err: unknown) {
        errors.push(`「${query}」检索异常：${errorText(err)}`);
      }
    }

    // 一条都没搜到（query 用尽 / 全失败 / 全被过滤）：留一条失败记录
    if (saved === 0) {
      if (skipped > 0) errors.push(`检索返回了 ${skipped} 条，但与本步无关，已全部丢弃`);
      recordFailure(db, scenario, step, errors[0] ?? "未检索到可用链接", engineKind);
    }
    return { saved, queries: queries.length, skipped, engine: engineKind, errors };
  } catch (err: unknown) {
    // 兜底：参数、配置异常都吞进 errors，函数本身绝不抛
    errors.push(errorText(err));
    recordFailure(db, scenario, step, errors[0] ?? "联网调研失败", engineKind);
    return { saved: 0, queries: queries.length, skipped: 0, engine: engineKind, errors };
  }
}
