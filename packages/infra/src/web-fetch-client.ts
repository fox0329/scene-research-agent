/**
 * web-fetch-client — 联网检索与抓取（变更表 #216）
 *
 * 通道选型依据 `docs/技术调研-权威来源检索.md` §4.2：
 *   主检索：DeepSeek Search（`POST /v1/tools/search`）—— 用户已有 Key、$0.75/1k 按成功计费
 *   主抓取：DeepSeek Fetch（`POST /v1/tools/fetch`，直接给 Markdown）→ 失败退回 Node `fetch`
 *
 * 为什么不在这一层做权威性判定：判定是领域层的确定性规则（`gradeWebSource`），
 * 这里只负责"拿到东西"，拿不到就如实返回失败原因，不猜、不编。
 *
 * 硬要求（§7.5）：**联网是加分项，不是必需项**。任何失败都只能让
 * "来源权威性"这项变差，不能阻断主流程——所以本模块一律返回结果对象，
 * 不向上抛网络异常。
 */

import { createHash } from "node:crypto";

/** 检索结果（搜索 API 的一条） */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** 搜索 API 若直接带正文就放这里，省一次抓取 */
  content?: string;
}

/** 抓取结果 */
export interface FetchResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  publishedAt?: string;
  publisher?: string;
  httpStatus: number;
  contentType: string;
  etag?: string;
  lastModified?: string;
  /** 失败原因（ok=false 时有值），中文可读 */
  error?: string;
}

/** 引擎凭据 */
export interface EngineConfig {
  /** OpenAI 兼容的 base_url（如 https://api.deepseek.com/v1） */
  baseUrl: string;
  apiKey: string;
  /** 搜索接口路径，默认 /tools/search */
  searchPath?: string;
  /** 抓取接口路径，默认 /tools/fetch */
  fetchPath?: string;
}

/** 预算（§7.2 的硬上限，超了降级不报错） */
export interface WebBudget {
  maxSearches: number;
  maxFetches: number;
  /** 单页超时（ms） */
  pageTimeoutMs: number;
  /** 单页大小上限（字节） */
  pageMaxBytes: number;
}

export const DEFAULT_BUDGET: WebBudget = {
  maxSearches: 15,
  maxFetches: 20,
  pageTimeoutMs: 15_000,
  pageMaxBytes: 2 * 1024 * 1024,
};

/** 跳过抓取的域名（直接丢弃，连请求都不发） */
const BLOCKED_HOST_RE =
  /(^|\.)(facebook|instagram|tiktok|pinterest|linkedin)\.com$|(^|\.)(doubleclick|googlesyndication)\./i;

/** 简单限速：同一域名两次请求至少间隔（ms），防封 IP */
const PER_DOMAIN_INTERVAL_MS = 1000;

/** 全局并发上限 */
const MAX_CONCURRENCY = 4;

/** 计数器（一次检索会话内共享） */
interface Counters {
  searches: number;
  fetches: number;
  /** host → 上次请求时间 */
  lastHit: Map<string, number>;
}

function newCounters(): Counters {
  return { searches: 0, fetches: 0, lastHit: new Map() };
}

/** 归一化 base_url（容忍带不带 /v1、带不带尾斜杠） */
function joinUrl(base: string, path: string): string {
  const b = String(base ?? "").replace(/\/+$/, "");
  const p = String(path ?? "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

/** 抽 host */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 该 URL 是否直接丢弃（社交/广告域名） */
export function shouldSkipUrl(url: string): boolean {
  const h = hostOf(url);
  return h === "" || BLOCKED_HOST_RE.test(h);
}

/** 同域限速：不足间隔就等 */
async function throttle(counters: Counters, url: string): Promise<void> {
  const h = hostOf(url);
  if (h === "") return;
  const last = counters.lastHit.get(h) ?? 0;
  const wait = PER_DOMAIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  counters.lastHit.set(h, Date.now());
}

/** 带超时的 fetch */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 抽标题 */
function titleOfHtml(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m?.[1]) return decodeEntities(m[1]).trim();
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  return og?.[1] ? decodeEntities(og[1]).trim() : "";
}

/** 从 HTML 抽站点名（发布机构） */
function siteNameOfHtml(html: string): string {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html);
  return og?.[1] ? decodeEntities(og[1]).trim() : "";
}

/** 从 HTML 抽发布日期 */
function publishedAtOfHtml(html: string): string {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

/** 解码常见 HTML 实体（够用即可，不做完整实现） */
function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return String(s).replace(/&[a-z#0-9]+;/gi, (m) => map[m.toLowerCase()] ?? m);
}

/**
 * HTML → Markdown（够用的确定性转换）
 *
 * 不引第三方依赖（turndown/readability 会增加安装体积与双平台风险，G-0.2）。
 * 只做正文所需的最小集：标题、段落、列表、链接、粗体、换行。
 * 脚本与样式整段剔除——注入内容常藏在 `<script>` 里。
 */
export function htmlToMarkdown(html: string): string {
  let s = String(html ?? "");
  // 剔除不可见与危险块
  s = s.replace(/<(script|style|noscript|iframe|svg|canvas)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, body) => {
    return `\n\n${"#".repeat(Number(lvl))} ${stripTags(body).trim()}\n\n`;
  });
  // 列表
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${stripTags(body).trim()}`);
  // 段落与换行
  s = s.replace(/<(p|div|section|article|tr|br)[^>]*>/gi, "\n\n");
  s = s.replace(/<\/(p|div|section|article|tr)>/gi, "\n\n");
  // 粗体/斜体/链接（链接只留文字 + 括号里的地址）
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `**${stripTags(body).trim()}**`);
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `*${stripTags(body).trim()}*`);
  s = s.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => {
    const t = stripTags(body).trim();
    return t ? `${t}（${href}）` : href;
  });
  // 表格单元格用制表符分隔（保留行结构）
  s = s.replace(/<\/t[dh]>/gi, "\t");
  s = s.replace(/<\/tr>/gi, "\n");
  // 其余标签全去
  s = stripTags(s);
  s = decodeEntities(s);
  // 空白规范化：连续 3+ 换行压成 2 个
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, "");
}

/**
 * 检索
 *
 * @param cfg - 引擎凭据
 * @param query - 查询串（支持 `site:` 算子下推）
 * @param counters - 预算计数器
 * @param budget - 预算
 * @param limit - 期望条数
 * @returns 命中列表；失败返回空数组 + 原因（不抛错）
 */
export async function searchWeb(
  cfg: EngineConfig,
  query: string,
  counters: Counters = newCounters(),
  budget: WebBudget = DEFAULT_BUDGET,
  limit = 8,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  if (cfg.apiKey === "" || cfg.baseUrl === "") {
    return { ok: false, hits: [], error: "未配置检索引擎（缺 API Key）" };
  }
  if (counters.searches >= budget.maxSearches) {
    return { ok: false, hits: [], error: `已达检索次数上限（${budget.maxSearches}）` };
  }
  counters.searches += 1;

  const url = joinUrl(cfg.baseUrl, cfg.searchPath ?? "tools/search");
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ query, limit, need_content: false }),
      },
      budget.pageTimeoutMs,
    );
    if (!res.ok) {
      return { ok: false, hits: [], error: `检索接口返回 HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    return { ok: true, hits: parseSearchHits(json) };
  } catch (e) {
    return { ok: false, hits: [], error: `检索失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 解析检索响应
 *
 * 不同厂商字段名不一致（`results` / `data` / `web_pages`、`url` / `link`），
 * 这里统一归一化——**宁可多认几种字段，也不要因为字段名变了就静默零结果**。
 */
export function parseSearchHits(json: unknown): SearchHit[] {
  const root = json as Record<string, unknown> | null;
  if (!root) return [];
  const candidates: unknown[] = [];
  const pushArr = (v: unknown) => {
    if (Array.isArray(v)) candidates.push(...v);
  };
  pushArr(root["results"]);
  pushArr(root["data"]);
  pushArr(root["hits"]);
  const web = root["web_pages"] ?? root["webPages"];
  if (Array.isArray(web)) candidates.push(...web);
  else if (web && typeof web === "object") pushArr((web as Record<string, unknown>)["value"]);

  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const url = String(o["url"] ?? o["link"] ?? o["href"] ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: String(o["title"] ?? o["name"] ?? "").trim(),
      snippet: String(o["snippet"] ?? o["description"] ?? o["summary"] ?? "").trim(),
      content: typeof o["content"] === "string" && o["content"].trim() !== "" ? o["content"] : undefined,
    });
  }
  return out;
}

/**
 * 抓取一页（DeepSeek Fetch 优先，失败退回 Node fetch）
 *
 * @param cfg - 引擎凭据
 * @param url - 目标 URL
 * @param counters - 预算计数器
 * @param budget - 预算
 * @returns 抓取结果（ok=false 时 error 说明原因，不抛错）
 */
export async function fetchPage(
  cfg: EngineConfig,
  url: string,
  counters: Counters = newCounters(),
  budget: WebBudget = DEFAULT_BUDGET,
): Promise<FetchResult> {
  const empty: FetchResult = {
    ok: false,
    url,
    finalUrl: url,
    title: "",
    markdown: "",
    httpStatus: 0,
    contentType: "",
  };
  if (shouldSkipUrl(url)) {
    return { ...empty, error: "域名在跳过名单（社交/广告）" };
  }
  if (counters.fetches >= budget.maxFetches) {
    return { ...empty, error: `已达抓取页数上限（${budget.maxFetches}）` };
  }
  counters.fetches += 1;

  // ① 引擎抓取（直接给 Markdown）
  if (cfg.apiKey !== "" && cfg.baseUrl !== "") {
    const viaEngine = await fetchViaEngine(cfg, url, budget);
    if (viaEngine.ok) return viaEngine;
    // 引擎失败不立刻放弃：政府站/标准站常被引擎侧拒绝，直连往往能拿到
  }

  // ② 直连兜底
  return fetchDirect(url, counters, budget);
}

/** 引擎抓取 */
async function fetchViaEngine(cfg: EngineConfig, url: string, budget: WebBudget): Promise<FetchResult> {
  const base: FetchResult = {
    ok: false,
    url,
    finalUrl: url,
    title: "",
    markdown: "",
    httpStatus: 0,
    contentType: "",
  };
  try {
    const res = await fetchWithTimeout(
      joinUrl(cfg.baseUrl, cfg.fetchPath ?? "tools/fetch"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ url, format: "markdown" }),
      },
      budget.pageTimeoutMs,
    );
    if (!res.ok) return { ...base, httpStatus: res.status, error: `引擎抓取 HTTP ${res.status}` };
    const raw = await res.text();
    if (raw.length > budget.pageMaxBytes) {
      return { ...base, error: `页面超过大小上限（${raw.length} 字节）` };
    }
    const json = JSON.parse(raw) as Record<string, unknown>;
    const markdown = String(json["markdown"] ?? json["content"] ?? json["text"] ?? "");
    if (markdown.trim() === "") return { ...base, error: "引擎抓取返回空正文" };
    return {
      ok: true,
      url,
      finalUrl: String(json["final_url"] ?? json["url"] ?? url),
      title: String(json["title"] ?? ""),
      markdown,
      publishedAt: String(json["published_at"] ?? json["publishedAt"] ?? ""),
      publisher: String(json["publisher"] ?? json["site_name"] ?? ""),
      httpStatus: Number(json["status"] ?? 200),
      contentType: String(json["content_type"] ?? "text/markdown"),
      etag: typeof json["etag"] === "string" ? json["etag"] : undefined,
      lastModified: typeof json["last_modified"] === "string" ? json["last_modified"] : undefined,
    };
  } catch (e) {
    return { ...base, error: `引擎抓取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 直连抓取（Node 内置 fetch） */
async function fetchDirect(url: string, counters: Counters, budget: WebBudget): Promise<FetchResult> {
  const base: FetchResult = {
    ok: false,
    url,
    finalUrl: url,
    title: "",
    markdown: "",
    httpStatus: 0,
    contentType: "",
  };
  try {
    await throttle(counters, url);
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          // 政府站常拒绝无 UA 请求；用可识别的 UA 是礼貌也是必要
          "user-agent": "SceneMaster/0.2 (+research agent; contact: local user)",
          accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
        },
      },
      budget.pageTimeoutMs,
    );
    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > budget.pageMaxBytes) {
      return {
        ...base,
        finalUrl: res.url || url,
        httpStatus: res.status,
        contentType,
        error: `页面超过大小上限（${buf.byteLength} 字节）`,
      };
    }
    if (!res.ok) {
      return { ...base, finalUrl: res.url || url, httpStatus: res.status, contentType, error: `HTTP ${res.status}` };
    }

    const isPdf = /application\/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url);
    if (isPdf) {
      // PDF 交给上层用 parseDocument 处理（避免这里重复实现 PDF 解析）
      return {
        ...base,
        finalUrl: res.url || url,
        httpStatus: res.status,
        contentType,
        error: "PDF 需走材料解析路径（parseDocument）",
      };
    }

    const html = buf.toString("utf8");
    const title = titleOfHtml(html);
    const markdown = htmlToMarkdown(html);
    if (markdown.trim() === "") {
      return { ...base, finalUrl: res.url || url, httpStatus: res.status, contentType, error: "正文为空（可能是 JS 渲染页）" };
    }
    return {
      ok: true,
      url,
      finalUrl: res.url || url,
      title,
      markdown,
      publishedAt: publishedAtOfHtml(html),
      publisher: siteNameOfHtml(html),
      httpStatus: res.status,
      contentType,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    };
  } catch (e) {
    return { ...base, error: `抓取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 批量抓取（受全局并发上限约束）
 *
 * @param cfg - 引擎凭据
 * @param urls - 目标 URL
 * @param budget - 预算
 * @returns 抓取结果（顺序与输入一致；失败的也在结果里，带 error）
 */
export async function fetchPages(
  cfg: EngineConfig,
  urls: string[],
  budget: WebBudget = DEFAULT_BUDGET,
): Promise<FetchResult[]> {
  const counters = newCounters();
  const results: FetchResult[] = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= urls.length) return;
      results[i] = await fetchPage(cfg, urls[i]!, counters, budget);
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, worker));
  return results;
}

/** 从凭据推导引擎配置（provider 的 base_url + api_key） */
export function engineConfigOf(provider: { base_url: string; api_key: string }): EngineConfig {
  return {
    baseUrl: String(provider.base_url ?? "").trim(),
    apiKey: String(provider.api_key ?? "").trim(),
  };
}

/** 内容指纹（变更检测用） */
export function contentFingerprint(s: string): string {
  return createHash("sha256").update(String(s ?? ""), "utf8").digest("hex");
}
