/**
 * web-engine — 检索引擎适配器（变更表 #216）
 *
 * 为什么需要适配器：调研文档 §4.2 推荐 DeepSeek Search/Fetch 作为主通道，
 * 但那是**官方 API** 的能力。实测（2026-10-19）发现一个必须正视的现实：
 * 用户配的供应商是 OpenAI 兼容代理（`https://llm.talkweb.com.cn/v1`），
 * 这类代理只透传 `/chat/completions`，**没有 `/tools/search`、`/tools/fetch`**：
 *
 *   POST {base}/tools/search → HTTP 504（网关超时，路径不存在）
 *   POST {base}/search       → 404 Invalid URL
 *   POST {base}/tools/fetch  → 404 Invalid URL
 *
 * 所以「联网检索」不能写死一个供应商。本模块把「检索 + 抓正文」抽象成引擎，
 * 按能力自动选择，选不到就如实返回"没有可用引擎"，**绝不假装联网了**。
 *
 * 支持的引擎：
 *   deepseek-native：官方 DeepSeek（`/tools/search` + `/tools/fetch`）
 *   tavily         ：Tavily（`/search` + `/extract`），`include_raw_content: markdown`
 *                    一次调用同时给 URL 与正文，省掉抓取步骤（免费 1000 credits/月）
 *   none           ：只能抓用户显式给的 URL（Node fetch 直连，零 Key）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { searchWithFallback } from "./web-fallback.js";
import {
  fetchPage,
  searchWeb,
  type EngineConfig,
  type FetchResult,
  type SearchHit,
  type WebBudget,
  DEFAULT_BUDGET,
} from "./web-fetch-client.js";

/** 引擎种类 */
export type EngineKind = "deepseek-native" | "tavily" | "baidu-html" | "bing-html" | "none";

/** 引擎配置（落 `data/web-search.local.json`，不入版本控制） */
export interface WebSearchConfig {
  /** 强制指定引擎；缺省按能力自动选 */
  engine?: EngineKind;
  /** Tavily Key（用户自备，默认关闭） */
  tavilyKey?: string;
  /** 覆盖模型供应商（缺省用当前默认供应商） */
  modelProvider?: { baseUrl: string; apiKey: string };
}

/** 解析后的引擎 */
export interface ResolvedEngine {
  kind: EngineKind;
  /** 能不能检索（false 时只能抓显式 URL） */
  canSearch: boolean;
  /** 人可读的说明（展示给用户，说明为什么不能用某个引擎） */
  detail: string;
}

/** 配置文件路径（与 providers.local.json 同目录） */
function configPath(): string {
  const env = process.env.SCENE_WEB_SEARCH_FILE;
  if (env) return resolve(env);
  return resolve(process.cwd(), "data", "web-search.local.json");
}

/** 读配置；缺失/损坏按"未配置"处理，不抛错 */
export function loadWebSearchConfig(): WebSearchConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    return raw as WebSearchConfig;
  } catch {
    return {};
  }
}

/**
 * 保存配置
 *
 * 只写用户给的字段；空值不写，避免把已有 Key 覆盖成空。
 */
export function saveWebSearchConfig(patch: WebSearchConfig): WebSearchConfig {
  const cur = loadWebSearchConfig();
  const next: WebSearchConfig = {
    engine: patch.engine ?? cur.engine,
    tavilyKey: patch.tavilyKey ?? cur.tavilyKey,
    modelProvider: patch.modelProvider ?? cur.modelProvider,
  };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  return next;
}

/** 模型供应商的口径：base_url 是不是 DeepSeek 官方 */
export function isOfficialDeepSeek(baseUrl: string): boolean {
  // 不能直接用正则在整串上匹配：`https://api.deepseek.com/v1` 里 `api` 前面是 `/`，
  // `(^|\.)api` 匹配不到（实测漏判，官方接口被当成"无检索能力"）
  const raw = String(baseUrl ?? "").trim();
  if (raw === "") return false;
  try {
    return new URL(raw).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

/**
 * 选引擎
 *
 * @param cfg - 显式配置
 * @param modelProvider - 当前模型供应商（可为空）
 * @returns 引擎 + 能否检索 + 说明
 */
export function resolveEngine(
  cfg: WebSearchConfig,
  modelProvider?: { baseUrl: string; apiKey: string },
): ResolvedEngine {
  // 显式指定优先
  if (cfg.engine === "tavily") {
    return cfg.tavilyKey
      ? { kind: "tavily", canSearch: true, detail: "已按配置使用 Tavily 检索" }
      : { kind: "none", canSearch: false, detail: "配置指定 Tavily，但没有填 Key" };
  }
  if (cfg.engine === "deepseek-native") {
    const ok = modelProvider !== undefined && isOfficialDeepSeek(modelProvider.baseUrl) && modelProvider.apiKey !== "";
    return ok
      ? { kind: "deepseek-native", canSearch: true, detail: "已按配置使用 DeepSeek 官方检索" }
      : {
          kind: "none",
          canSearch: false,
          detail: "配置指定 DeepSeek 官方检索，但当前供应商不是 api.deepseek.com 或缺少 Key",
        };
  }
  if (cfg.engine === "baidu-html") {
    return {
      kind: "baidu-html",
      canSearch: true,
      detail: "已按配置使用百度网页搜索（免注册，非官方接口）",
    };
  }
  if (cfg.engine === "bing-html") {
    return {
      kind: "bing-html",
      canSearch: true,
      detail: "已按配置使用 Bing 网页搜索（免注册，非官方接口）",
    };
  }
  if (cfg.engine === "none") {
    return { kind: "none", canSearch: false, detail: "已关闭联网检索（只能抓你显式给的链接）" };
  }

  // 自动：官方 DeepSeek 优先，其次 Tavily
  if (modelProvider && isOfficialDeepSeek(modelProvider.baseUrl) && modelProvider.apiKey !== "") {
    return { kind: "deepseek-native", canSearch: true, detail: "自动识别：当前供应商是 DeepSeek 官方，用其检索接口" };
  }
  if (cfg.tavilyKey) {
    return { kind: "tavily", canSearch: true, detail: "自动识别：当前供应商无检索接口，改用 Tavily" };
  }
  // 免注册兜底：百度网页搜索。
  // 2026-10-21 实测：Bing 对多词中文 query 只按第一个词返回（全是噪声），
  // 百度同一 query 能返回相关结果，所以国内网络默认走百度，Bing 只在显式配置时使用。
  return {
    kind: "baidu-html",
    canSearch: true,
    detail:
      "免注册模式：用百度网页搜索（非官方接口，可能随改版失效）。" +
      "配上 Tavily 或官方 DeepSeek 会更稳。",
  };
}

/** Tavily search 响应 */
interface TavilySearchResponse {
  results?: Array<{
    url?: string;
    title?: string;
    content?: string;
    raw_content?: string;
    published_date?: string;
  }>;
}

/**
 * Tavily 检索（一次调用同时拿 URL 与正文）
 *
 * `include_raw_content: "markdown"` 是关键——它直接给清洗后的全文，
 * 省掉「再抓一次」的步骤，也让"原文"来源可靠（Tavily 侧的抽取结果）。
 */
async function tavilySearch(
  apiKey: string,
  query: string,
  budget: WebBudget,
  limit: number,
): Promise<{ ok: boolean; hits: Array<SearchHit & { publishedAt?: string }>; error?: string }> {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_raw_content: "markdown",
      }),
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, hits: [], error: `Tavily 返回 HTTP ${res.status}：${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as TavilySearchResponse;
    const hits = (json.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
      .map((r) => ({
        url: r.url!,
        title: String(r.title ?? ""),
        snippet: String(r.content ?? ""),
        // raw_content 是 Tavily 抽好的 Markdown 全文
        content: typeof r.raw_content === "string" && r.raw_content.trim() !== "" ? r.raw_content : undefined,
        publishedAt: typeof r.published_date === "string" ? r.published_date : undefined,
      }));
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: `Tavily 检索异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 按引擎检索
 *
 * @param engine - 已解析的引擎
 * @param cfg - 引擎配置
 * @param query - 查询串
 * @param counters - 预算计数器
 * @param budget - 预算
 * @param limit - 条数
 */
export async function searchByEngine(
  engine: ResolvedEngine,
  cfg: WebSearchConfig,
  query: string,
  counters: { searches: number; fetches: number; lastHit: Map<string, number> },
  budget: WebBudget = DEFAULT_BUDGET,
  limit = 8,
  accept?: (query: string, hit: SearchHit) => boolean,
): Promise<{ ok: boolean; hits: Array<SearchHit & { publishedAt?: string }>; error?: string }> {
  if (!engine.canSearch) return { ok: false, hits: [], error: engine.detail };
  if (engine.kind === "baidu-html") {
    if (counters.searches >= budget.maxSearches) {
      return { ok: false, hits: [], error: `已达检索次数上限（${budget.maxSearches}）` };
    }
    counters.searches += 1;
    return searchWithFallback("baidu", query, budget, limit, {}, (hit) => accept?.(query, hit) ?? true);
  }
  if (engine.kind === "bing-html") {
    if (counters.searches >= budget.maxSearches) {
      return { ok: false, hits: [], error: `已达检索次数上限（${budget.maxSearches}）` };
    }
    counters.searches += 1;
    return searchWithFallback("bing", query, budget, limit, {}, (hit) => accept?.(query, hit) ?? true);
  }
  if (engine.kind === "tavily") {
    if (!cfg.tavilyKey) return { ok: false, hits: [], error: "Tavily Key 未配置" };
    if (counters.searches >= budget.maxSearches) {
      return { ok: false, hits: [], error: `已达检索次数上限（${budget.maxSearches}）` };
    }
    counters.searches += 1;
    return tavilySearch(cfg.tavilyKey, query, budget, limit);
  }
  // deepseek-native
  const mp = cfg.modelProvider;
  if (!mp) return { ok: false, hits: [], error: "缺少 DeepSeek 供应商配置" };
  const engineCfg: EngineConfig = { baseUrl: mp.baseUrl, apiKey: mp.apiKey };
  return searchWeb(engineCfg, query, counters, budget, limit);
}

/**
 * 按引擎抓取一页
 *
 * 有引擎时先试引擎（政府站常被引擎侧拒绝，所以失败要退直连）。
 */
export async function fetchByEngine(
  engine: ResolvedEngine,
  cfg: WebSearchConfig,
  url: string,
  counters: { searches: number; fetches: number; lastHit: Map<string, number> },
  budget: WebBudget = DEFAULT_BUDGET,
): Promise<FetchResult> {
  // 直连一定能试（不需要 Key），引擎抓取只是"更省事"的路径
  const engineCfg: EngineConfig =
    engine.kind === "deepseek-native" && cfg.modelProvider
      ? { baseUrl: cfg.modelProvider.baseUrl, apiKey: cfg.modelProvider.apiKey }
      : { baseUrl: "", apiKey: "" };
  return fetchPage(engineCfg, url, counters, budget);
}
