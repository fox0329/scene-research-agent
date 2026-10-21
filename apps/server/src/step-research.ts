/**
 * @scene/server — 每一步的联网调研（先调研、再分析）
 *
 * 背景（用户定调 2026-10-21）：「不管是模型知识还是怎么，都需要先深度搜索调研，
 * 确保来源的真实、客观、最新」；「调研信息来源为什么一个链接都没有？这不正常，
 * 就算是行业常识，调研也是第一步。」
 *
 * 所以调研不能只存一条 search hit（标题 + URL + 摘要）：那只是"搜到了"，
 * 不等于"这条来源能当依据"。本模块做三件事：
 *   ① **实体化 query**：场景名 + 本步表名 + 调用方传入的关键实体（子场景/门槛/对手/型号），
 *      4–6 条、去重、每条 ≤40 字；
 *   ② **抓正文验真**：每条 query 取前 5 条命中，全局最多抓 12 页（单页 8 秒、整体 60 秒），
 *      抓成功的正文落 `web_source`（复用 `saveWebCapture` 的权威性判定），
 *      再把该行的 authority/publisher/published_at/domain 回写 `research_source`，`verified=1`；
 *   ③ **新鲜度**：发布时间早于「当前 − 3 年」标 `stale=1`；没有日期不判过期（但排序靠后）。
 *
 * 三条铁律：
 *  ① **先查再分析**：不靠模型回忆行业常识；模型只允许引用本步调研列表里的 URL 或材料页码。
 *  ② **查不到就写未知**：引擎不可用/抓取失败时**绝不假装有结果**，只留检索命中（`verified=0`）
 *     或一条失败记录；分析照常推进，但提示词会强制「来源只能写未知」。
 *  ③ **不编链接**：只落检索接口真实返回的 http(s) URL；标题/摘要/发布方原样保留。
 *
 * 失败不能拖垮分析：`runStepResearch` **本身不抛**，异常一律收进 `errors`。
 */

import { createHash } from "node:crypto";
import type { Scenario } from "@scene/contract";
import { flowStep, tableDef } from "@scene/contract";
import {
  DEFAULT_BUDGET,
  fetchByEngine,
  loadRegistry,
  loadWebSearchConfig,
  resolveEngine,
  saveWebCapture,
  searchByEngine,
  type FetchResult,
  type ResolvedEngine,
  type ResearchSource,
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
  /** 真正尝试抓正文的页数（≤12；抓取在预算内提前收手） */
  fetched: number;
  /** 正文抓取成功且落 web_source 的来源数（verified=1） */
  verified: number;
  /** 已验真来源的权威分布（给实测报告用） */
  authorityCounts: Record<"T1" | "T2" | "T3" | "T4", number>;
  /** 本步落库的调研来源（已排序：权威 T1→T4、verified 优先、发布时间倒序） */
  sources: ResearchSource[];
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

/** 抓取结果（比 `FetchResult` 宽松：测试只关心 ok/url/正文/元数据） */
export type FetchOutcome = Pick<FetchResult, "ok" | "url"> &
  Partial<Omit<FetchResult, "ok" | "url">> & { error?: string };

/** 可注入的抓取函数（默认走 `fetchByEngine`；测试注入假页面） */
export type FetchFn = (url: string) => Promise<FetchOutcome>;

/** 可注入依赖（测试用；生产不传） */
export interface StepResearchDeps {
  search?: SearchFn;
  fetch?: FetchFn;
  cfg?: WebSearchConfig;
  /** 上游关键实体（子场景 / 门槛名 / 对手名 / 型号），最多取 3 个拼具体 query */
  keywords?: string[];
}

/** 每条 query 取几条结果（预算内够用，不贪多） */
export const RESULT_LIMIT = 5;
/** 单条 query 最大字符数（用户要求 ≤40 字） */
export const QUERY_MAX = 40;
/** 一次调研最多几条 query（4–6 条） */
const QUERY_MAX_COUNT = 6;
/** 至少凑够几条 query（不足时补通用 query） */
const QUERY_MIN_COUNT = 4;
/** snippet 落库截断（右栏不展示全文，避免库膨胀） */
const SNIPPET_MAX = 500;
/** 检索失败记录的归一化 URL 键：同一场景同一步只留一条失败记录 */
const FAILED_KEY = "";
/** 全局最多抓几页正文（再多也读不完，且容易触发站点拦截） */
export const MAX_FETCH_PAGES = 12;
/** 每步至少尝试凑够几条"已验真"来源（凑不够就有多少存多少） */
export const TARGET_VERIFIED = 5;
/** 单页抓取超时（用户要求 8 秒） */
export const FETCH_TIMEOUT_MS = 8_000;
/** 一次调研的整体预算（60 秒；超时即收手，按「调研未完成」处理） */
export const RESEARCH_BUDGET_MS = 60_000;
/** 发布时间超过 3 年算过期（无日期不算 stale） */
const STALE_AFTER_MS = 3 * 365 * 24 * 60 * 60 * 1000;
/** 权威性排序（未知排最后） */
const AUTHORITY_RANK: Record<string, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

/** 按字符数截断（中文按字算，不按 UTF-16 码元） */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function charLen(text: string): number {
  return Array.from(text).length;
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

/** 关键词清洗：去空白/标点、去重、长度 2–20 字，最多 3 个 */
function cleanKeywords(keywords: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keywords ?? []) {
    const k = String(raw ?? "")
      .replace(/[\s，,。；;：:、/|]+/gu, " ")
      .trim();
    if (charLen(k) < 2 || charLen(k) > 20) continue;
    if (/^(未知|未提供|其他|无|暂无)$/u.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 构造本步的检索 query（4–6 条、去重、每条 ≤40 字）
 *
 * 结构 = 实体 query（关键词 ≤3 条）+ 本步表名（最多 3 条）+ 按步挑的通用 query，
 * 最后去重截到 6 条。**实体 query 排最前**：它们最具体（门槛名/对手名/型号），
 * 被后面的通用 query 挤掉就没有"深度调研"可言了。
 */
export function buildStepQueries(
  scenarioName: string,
  step: number,
  keywords?: readonly string[],
): string[] {
  const name = String(scenarioName ?? "").trim() || "行业";
  const raw: string[] = [];

  // ① 实体 query：`<场景> <关键词> 标准/资质`
  cleanKeywords(keywords).forEach((k, i) => {
    raw.push(withName(name, `${k} ${i % 2 === 0 ? "标准" : "资质"}`));
  });

  // ② 本步表名（最多 3 条，避免把预算吃光）
  for (const tableName of tableNamesOf(step).slice(0, 3)) {
    raw.push(withName(name, tableName));
  }

  // ③ 通用 query：按步挑 2–3 条
  const generic =
    step <= 2
      ? ["招标 资质", "标准"]
      : step === 3
        ? ["招标 资质", "标准", "设备 报价"]
        : ["标准", "设备 报价"];
  for (const tail of generic) raw.push(withName(name, tail));

  // ④ 不足 4 条时补通用项（交付类步骤没有表名，只有 2–3 条通用 query 不够用）
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
  // 去重后可能掉到 4 条以下（关键词与表名撞车）：补通用 query，保证 4–6 条
  for (const tail of ["行业 现状", "市场 规模", "政策 文件", "招标 公告"]) {
    if (out.length >= QUERY_MIN_COUNT) break;
    const q = clip(withName(name, tail), QUERY_MAX);
    if (q === "" || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
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
function engineSearchFn(
  engine: ResolvedEngine,
  cfg: WebSearchConfig,
  counters: { searches: number; fetches: number; lastHit: Map<string, number> },
): SearchFn {
  return (query, limit) => searchByEngine(engine, cfg, query, counters, DEFAULT_BUDGET, limit);
}

/** 把引擎包成 `FetchFn`（单页 8 秒、全局最多 12 页；预算与检索共享） */
function engineFetchFn(
  engine: ResolvedEngine,
  cfg: WebSearchConfig,
  counters: { searches: number; fetches: number; lastHit: Map<string, number> },
): FetchFn {
  return (url) =>
    fetchByEngine(engine, cfg, url, counters, {
      ...DEFAULT_BUDGET,
      maxFetches: MAX_FETCH_PAGES,
      pageTimeoutMs: FETCH_TIMEOUT_MS,
    });
}

/** 带超时的检索：单条 query 卡住时不能把整次调研拖过 60 秒预算 */
async function searchWithDeadline(
  search: SearchFn,
  query: string,
  limit: number,
  ms: number,
): Promise<{ ok: boolean; hits: ResearchHit[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      search(query, limit),
      new Promise<{ ok: boolean; hits: ResearchHit[]; error?: string }>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, hits: [], error: `检索超时（${Math.round(ms / 1000)} 秒）` }),
          ms,
        );
      }),
    ]);
  } catch (err: unknown) {
    return { ok: false, hits: [], error: `检索异常：${errorText(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 带超时的抓取：即便注入的 fetch 忽略 abort，也不能把整次调研挂住 */
async function fetchWithDeadline(fetch: FetchFn, url: string, ms: number): Promise<FetchOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(url),
      new Promise<FetchOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, url, markdown: "", error: `抓取超时（${Math.round(ms / 1000)} 秒）` }),
          ms,
        );
      }),
    ]);
  } catch (err: unknown) {
    return { ok: false, url, markdown: "", error: `抓取异常：${errorText(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/** 取 host（去 www，统一小写） */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/**
 * 抓取前的优先级：先抓更像"权威原文"的页
 *
 * 此时还没有正文，判不了 T1/T2（那要领域层按页面内容判），但 host 本身就是强信号。
 * 把政府/标准站排前面，能在 12 页预算里尽量凑出 T1/T2，而不是把预算花在自媒体上。
 */
function preRank(url: string): number {
  const host = hostOfUrl(url);
  if (host === "") return 9;
  if (
    /(^|\.)gov\.(cn|mil)$/u.test(host) ||
    host.endsWith(".gov.cn") ||
    /(^|\.)(flk\.npc\.gov\.cn|openstd\.samr\.gov\.cn|std\.samr\.gov\.cn|sac\.gov\.cn)$/u.test(host) ||
    /(^|\.)(iso\.org|iec\.ch|itu\.int)$/u.test(host)
  ) {
    return 0;
  }
  if (/(^|\.)(edu\.cn|edu)$/u.test(host) || /(^|\.)(arxiv\.org|nature\.com|cnki\.net)$/u.test(host)) return 1;
  if (/^(docs|doc|developer|support|help|api|wiki)\./u.test(host) || /\/docs?\//iu.test(url)) return 2;
  if (/(^|\.)(mp\.weixin\.qq\.com|zhihu\.com|csdn\.net|baijiahao\.baidu\.com|toutiao\.com)$/u.test(host)) return 8;
  return 4;
}

/** 发布时间是否超过 3 年（无日期/不可解析 = 不过期，但排序靠后） */
export function isStalePublished(publishedAt: string | undefined, nowMs = Date.now()): boolean {
  const raw = String(publishedAt ?? "").trim();
  if (raw === "") return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t < nowMs - STALE_AFTER_MS;
}

/** 发布时间 → `YYYY-MM`（右栏标签与提示词摘要用；解析不了返回空串） */
export function publishedMonth(publishedAt: string | undefined): string {
  const raw = String(publishedAt ?? "").trim();
  if (raw === "") return "";
  const m = /^(\d{4})-(\d{1,2})/u.exec(raw);
  if (m?.[1] !== undefined && m[2] !== undefined) return `${m[1]}-${m[2].padStart(2, "0")}`;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 权威性排序值（T1 最小；未知排最后） */
export function researchAuthorityRank(authority: string | undefined): number {
  return AUTHORITY_RANK[String(authority ?? "").trim()] ?? 5;
}

function publishedMs(publishedAt: string | undefined): number {
  const t = Date.parse(String(publishedAt ?? "").trim());
  return Number.isFinite(t) ? t : 0;
}

/**
 * 调研来源排序：权威 T1→T4、verified=1 优先、发布时间倒序
 *
 * 右栏与提示词摘要共用同一份顺序——两处排序不一致会让用户看到"右栏第一条"
 * 和"模型引用的第一条"不是一个东西。
 */
export function sortResearchSources<
  T extends { authority?: string; verified?: number; published_at?: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const rank = researchAuthorityRank(a.authority) - researchAuthorityRank(b.authority);
    if (rank !== 0) return rank;
    const verified = Number(b.verified ?? 0) - Number(a.verified ?? 0);
    if (verified !== 0) return verified;
    return publishedMs(b.published_at) - publishedMs(a.published_at);
  });
}

/** 本步可点开的调研来源（只认 `status=有效` 且 http(s) 的） */
export function validResearchSources(rows: readonly ResearchSource[]): ResearchSource[] {
  return rows.filter(
    (r) => r.status === "有效" && /^https?:\/\//iu.test(String(r.url ?? "").trim()),
  );
}

/**
 * 提示词里的调研摘要：`标题｜发布方｜YYYY-MM｜T?｜URL`（最多 12 条）
 *
 * 只给**真实可打开**的链接；未验真的也列（标 T?）——模型能引用它，但门禁会核对
 * host 是否真在本步调研结果里。
 */
export function researchBriefLines(rows: readonly ResearchSource[], limit = 12): string[] {
  const clean = (s: string): string => String(s ?? "").replace(/[｜|\r\n]+/gu, " ").trim();
  const seen = new Set<string>();
  const unique = sortResearchSources(validResearchSources(rows)).filter((r) => {
    const url = String(r.url ?? "").trim();
    if (url === "" || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return unique
    .slice(0, limit)
    .map((r) => {
      const title = clean(r.title) || r.url;
      const publisher = clean(r.publisher ?? "") || "未知发布方";
      const month = publishedMonth(r.published_at) || "日期未知";
      const authority = String(r.authority ?? "").trim() || "T?";
      return `${title}｜${publisher}｜${month}｜${authority}｜${r.url}`;
    });
}

/** 本步调研来源的 host 集合（门禁做 host 级核对用，去 www） */
export function researchHostsOf(rows: readonly ResearchSource[]): string[] {
  const out = new Set<string>();
  for (const r of validResearchSources(rows)) {
    const host = hostOfUrl(r.url);
    if (host !== "") out.add(host);
  }
  return [...out];
}

/** 抓取后从 web_source 回读的一行 */
interface CaptureMeta {
  authority: string;
  publisher: string;
  domain: string;
  publishedAt: string;
  /** 重定向落地的真实页地址（搜索跳转链接会过期） */
  finalUrl: string;
}

/** 回读抓取落库结果（authority 由 `saveWebCapture` 的领域层规则判定） */
function readCaptureMeta(db: DbInstance, webSourceId: string): CaptureMeta | undefined {
  try {
    const row = db.db
      .prepare("SELECT authority, publisher, published_at AS publishedAt, domain FROM web_source WHERE id = ?")
      .get(webSourceId) as CaptureMeta | undefined;
    return row;
  } catch {
    return undefined;
  }
}

/** 一条候选命中（检索已返回、尚未落库） */
interface Candidate {
  url: string;
  key: string;
  title: string;
  snippet: string;
  query: string;
}

/**
 * 跑一次某步的联网调研
 *
 * 顺序：构造 query → 选引擎 → 逐条检索（前 5 条命中）→ 按权威优先级抓正文（≤12 页）
 * → 抓成功的落 `web_source` 并回写权威/发布方/日期 → 全部命中落 `research_source`。
 *
 * @param db - 数据库（写 `research_source` / `web_source`）
 * @param scenario - 场景（取名称拼 query，取 id 落库）
 * @param step - 流程步号（1 起）
 * @param deps - 测试注入（检索/抓取函数、引擎配置、关键词）；生产不传
 */
export async function runStepResearch(
  db: DbInstance,
  scenario: Scenario,
  step: number,
  deps: StepResearchDeps = {},
): Promise<StepResearchResult> {
  const queries = buildStepQueries(scenario.name, step, deps.keywords);
  const errors: string[] = [];
  const authorityCounts: StepResearchResult["authorityCounts"] = { T1: 0, T2: 0, T3: 0, T4: 0 };
  const emptyResult = (engine: string): StepResearchResult => ({
    saved: 0,
    queries: queries.length,
    skipped: 0,
    engine,
    errors,
    fetched: 0,
    verified: 0,
    authorityCounts,
    sources: [],
  });
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
      errors.push(reason);
      return emptyResult(engineKind);
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

    const counters = { searches: 0, fetches: 0, lastHit: new Map<string, number>() };
    const search = deps.search ?? engineSearchFn(engine, searchCfg, counters);
    const fetch = deps.fetch ?? engineFetchFn(engine, searchCfg, counters);
    /** 整次调研的预算起点（检索 + 抓取共享 60 秒） */
    const startedAt = Date.now();

    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    let skipped = 0;

    for (const query of queries) {
      try {
        const left = RESEARCH_BUDGET_MS - (Date.now() - startedAt);
        if (left <= 0) {
          errors.push(`调研总预算 ${Math.round(RESEARCH_BUDGET_MS / 1000)} 秒已用完，剩余 query 未执行`);
          break;
        }
        const res = await searchWithDeadline(search, query, RESULT_LIMIT, Math.min(DEFAULT_BUDGET.pageTimeoutMs, left));
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
          candidates.push({
            url,
            key,
            title: cleanTitle(String(hit.title ?? ""), url),
            snippet: clip(String(hit.snippet ?? ""), SNIPPET_MAX),
            query,
          });
        }
      } catch (err: unknown) {
        errors.push(`「${query}」检索异常：${errorText(err)}`);
      }
    }

    /**
     * 抓正文验真：按 host 权威优先级排序后抓，最多 12 页、每页 8 秒、整体 60 秒
     *
     * 为什么先排序再抓：12 页预算装不下 30 条命中，先抓政府/标准站能把
     * T1/T2 的比例最大化；凑够 5 条已验真就停（剩余命中保留为未验真）。
     */
    const captures = new Map<string, CaptureMeta>();
    const dead = new Map<string, string>();
    let fetched = 0;
    let verified = 0;

    const ranked = [...candidates].sort((a, b) => preRank(a.url) - preRank(b.url));
    /* 并发抓取：串行 12 页 × 8 秒最坏 96 秒，实测会把 60 秒预算拖爆（第 3 步就超时，
       整步被迫写成「未知」）。四路并发后典型 20 秒内完成，且仍受总预算约束。 */
    const FETCH_CONCURRENCY = 4;
    for (let i = 0; i < ranked.length; i += FETCH_CONCURRENCY) {
      if (fetched >= MAX_FETCH_PAGES || verified >= TARGET_VERIFIED) break;
      const remaining = RESEARCH_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        errors.push(
          `调研总预算 ${Math.round(RESEARCH_BUDGET_MS / 1000)} 秒已用完，未抓完的命中只保留标题与链接（verified=0）`,
        );
        break;
      }
      const chunk = ranked.slice(i, i + FETCH_CONCURRENCY).slice(0, MAX_FETCH_PAGES - fetched);
      fetched += chunk.length;
      await Promise.all(
        chunk.map(async (cand) => {
          if (verified >= TARGET_VERIFIED) return;
          const page = await fetchWithDeadline(fetch, cand.url, Math.min(FETCH_TIMEOUT_MS, remaining));
          if (!page.ok || String(page.markdown ?? "").trim() === "") {
            dead.set(cand.key, String(page.error ?? "正文为空，未能验真"));
            return;
          }
          try {
            const stored = saveWebCapture(db.db, {
              url: cand.url,
              finalUrl: String(page.finalUrl ?? cand.url),
              title: String(page.title ?? "") || cand.title,
              markdown: String(page.markdown ?? ""),
              ...(page.publishedAt ? { publishedAt: String(page.publishedAt) } : {}),
              ...(page.publisher ? { publisher: String(page.publisher) } : {}),
              httpStatus: Number(page.httpStatus ?? 200),
              contentType: String(page.contentType ?? ""),
              ...(page.etag ? { etag: String(page.etag) } : {}),
              ...(page.lastModified ? { lastModified: String(page.lastModified) } : {}),
              query: cand.query,
            });
            const meta = readCaptureMeta(db, stored.id);
            captures.set(cand.key, {
              authority: meta?.authority ?? stored.authority,
              publisher: meta?.publisher ?? "",
              domain: meta?.domain ?? "",
              publishedAt: meta?.publishedAt ?? "",
              finalUrl: String(page.finalUrl ?? cand.url),
            });
            verified++;
          } catch (err: unknown) {
            dead.set(cand.key, `正文入库失败：${errorText(err)}`);
          }
        }),
      );
    }

    // 全部命中落 research_source：抓成功的带权威/发布方/日期（verified=1），其余只留命中
    const nowIso = new Date().toISOString();
    let saved = 0;
    const savedRows: ResearchSource[] = [];
    for (const cand of candidates) {
      const cap = captures.get(cand.key);
      const authority = cap?.authority ?? "";
      if (authority === "T1" || authority === "T2" || authority === "T3" || authority === "T4") {
        authorityCounts[authority] += 1;
      }
      /* 抓成功后用重定向落地的真实页地址：百度/必应的跳转链接会过期，
         而且 host 级来源核对要核"原页面"的域名，不是搜索引擎的域名。 */
      const landed = String(captures.get(cand.key)?.finalUrl ?? "").trim();
      const finalUrl = /^https?:\/\//iu.test(landed) ? landed : cand.url;
      const row: ResearchSource = {
        id: sourceId(scenario.id, step, cand.key),
        scenario_id: scenario.id,
        step,
        query: cand.query,
        title: cand.title,
        url: finalUrl,
        url_key: cand.key,
        snippet: cand.snippet,
        engine: engineKind,
        fetched_at: nowIso,
        status: "有效",
        error: cap ? "" : (dead.get(cand.key) ?? ""),
        publisher: cap?.publisher ?? "",
        domain: cap?.domain ?? "",
        published_at: cap?.publishedAt ?? "",
        authority,
        verified: cap ? 1 : 0,
        stale: isStalePublished(cap?.publishedAt) ? 1 : 0,
      };
      try {
        savedRows.push(db.researchRepo.upsert(row));
        saved++;
      } catch (err: unknown) {
        errors.push(`「${cand.query}」结果落库失败：${errorText(err)}`);
      }
    }

    // 一条都没搜到（query 用尽 / 全失败 / 全被过滤）：留一条失败记录
    if (saved === 0) {
      if (skipped > 0) errors.push(`检索返回了 ${skipped} 条，但与本步无关，已全部丢弃`);
      recordFailure(db, scenario, step, errors[0] ?? "未检索到可用链接", engineKind);
    }
    return {
      saved,
      queries: queries.length,
      skipped,
      engine: engineKind,
      errors,
      fetched,
      verified,
      authorityCounts,
      sources: sortResearchSources(savedRows),
    };
  } catch (err: unknown) {
    // 兜底：参数、配置异常都吞进 errors，函数本身绝不抛
    errors.push(errorText(err));
    recordFailure(db, scenario, step, errors[0] ?? "联网调研失败", engineKind);
    return emptyResult(engineKind);
  }
}
