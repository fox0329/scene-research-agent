/**
 * library-verify — 已导入资料的联网核验与证据提级
 *
 * 用户定调 2026-10-21：「导入的资料可以通过检索的方式进行核实或者提高等级」。
 * 做法（全部确定性判定，模型不参与）：
 *   ① 只核**公开检索能核的表**：M1 产品（型号+名称）、M3 能力（领域+能力名+描述关键词）、
 *      M6 报价（型号+单价）、O1 认证（型号+证书类型+证书号）；M2/M4/M5 是内部规格/边界/短板，
 *      公开引擎核不了，**不核、不伪造**。
 *   ② 每行 1–2 条 query，`searchByEngine` 取前 3 条；抓正文后落 `web_source`
 *      （复用 `saveWebCapture` 的权威性判定，T1–T4 不在这里重写）。
 *   ③ 命中判定：标题或正文必须同时含该行的**关键标识**，且不是同一份自有材料
 *      （来源是 URL 时 host 相同即视为同源；来源是文件名时视为独立）。
 *   ④ 提级：命中 ≥1 个 T1/T2 独立来源 → `已核实` + `evidence_level="A"`；
 *      只有 T3/T4 → `未核实`（记录来源，不降级）；命中但单价矛盾 → `有冲突`（保持原级）。
 *
 * 每条记录的落库走 `library_verification`（`UNIQUE(table_code,row_id)`），不覆盖原始证据。
 * 每次最多核 20 行（`limit`），只核未核验或超过 7 天的行；单页 8 秒、整批 90 秒硬上限。
 */

import type {
  Capability,
  LibraryVerification,
  OptionalMaterial,
  PriceQuote,
  Product,
  VerificationStatus,
} from "@scene/contract";
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
  type WebSearchConfig,
} from "@scene/infra";
import type { DbInstance } from "@scene/infra";
import { gradeWebSource, urlKey, type WebPageMeta } from "@scene/domain";
import type { FetchFn, SearchFn, ResearchHit } from "./step-research.js";

// ─── 常量 ──────────────────────────────────────────────────

/** 可核验的表号（M2/M4/M5 不核） */
export const VERIFY_TABLES = ["M1", "M3", "M6", "O1"] as const;
export type VerifyTable = (typeof VERIFY_TABLES)[number];

/** 每次调用最多核几行（用户要求：最多 20 行） */
export const VERIFY_LIMIT = 20;
/** 已核验行的重核间隔（7 天） */
export const VERIFY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** 整批核验的总预算（90 秒） */
export const VERIFY_TOTAL_MS = 90_000;
/** 单页抓取超时（8 秒） */
export const VERIFY_PAGE_TIMEOUT_MS = 8_000;
/** 每行取前几条检索结果 */
const RESULT_LIMIT = 3;
/** sources_json 最多存几条 */
const MAX_SOURCES = 3;
/** 每行最多几条 query */
const MAX_QUERIES = 2;
/** note 截断长度 */
const NOTE_MAX = 500;

const AUTHORITY_RANK: Record<string, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

// ─── 公开类型 ──────────────────────────────────────────────

/** 核验来源（落 sources_json 的一条） */
export interface VerificationSource {
  title: string;
  url: string;
  publisher: string;
  published_at: string;
}

/** 一条核验明细（POST 返回、GET 分组都用同一结构） */
export interface VerifyDetail {
  table: VerifyTable;
  row_id: string;
  /** 行摘要（型号 / 能力名 / 证书号，便于人回查） */
  summary: string;
  status: VerificationStatus;
  /** 命中的最高权威级；无来源为空串 */
  authority: string;
  sources: VerificationSource[];
  key_text: string;
  note: string;
  checked_at: string;
  /** 本次是否把 evidence_level 升为 A */
  upgraded: boolean;
}

/** 一批核验的统计（路由原样返回） */
export interface VerifyReport {
  checked: number;
  verified: number;
  conflict: number;
  unverified: number;
  upgraded: number;
  /** 本批之后仍未核验（或已过 7 天）的行数 */
  remaining: number;
  details: VerifyDetail[];
  /** 检索/抓取失败原因（不阻断其余行） */
  errors: string[];
}

export interface VerifyOptions {
  productLineId?: string;
  limit?: number;
}

/** 可注入依赖（测试用；生产缺省走 web-engine） */
export interface LibraryVerifyDeps {
  search?: SearchFn;
  fetch?: FetchFn;
  cfg?: WebSearchConfig;
  /** 当前模型供应商（DeepSeek 官方检索需要 Key） */
  provider?: { baseUrl: string; apiKey: string };
  /** 注入当前时间（测试 7 天时效用） */
  now?: () => Date;
}

/** GET /library/verification 的汇总 */
export interface VerificationSummary {
  generated_at: string;
  total: number;
  by_status: Record<VerificationStatus, number>;
  /** 已核实且当前证据级为 A 的行数（界面显示"升 A y"） */
  upgraded: number;
  details: VerifyDetail[];
  groups: Record<VerificationStatus, VerifyDetail[]>;
}

// ─── 内部类型 ──────────────────────────────────────────────

/** 一条待核验的目标行（把四张表压成同一口径） */
interface VerifyTarget {
  table: VerifyTable;
  rowId: string;
  productLineId: string;
  summary: string;
  keyText: string;
  /** 原始来源（判断"是否同一份自有材料"） */
  source: string;
  queries: string[];
  model: string;
  name: string;
  certType: string;
  certNo: string;
  unitPrice: string;
  createdAt: string;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string;
}

interface Matched {
  text: string;
  source: VerificationSource;
  authority: string;
  captured: boolean;
}

// ─── 工具函数 ──────────────────────────────────────────────

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** 去掉会导致 query 语义漂移的引号，再包一层双引号 */
function quoted(term: string): string {
  const clean = text(term).replace(/["“”]/g, "").slice(0, 40);
  return clean === "" ? "" : `"${clean}"`;
}

function clipQuery(parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ").slice(0, 60).trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** 型号键：去掉全部空白后大写（与领域层 normalizeModel 同口径） */
function normalizeModelText(value: string): string {
  return String(value ?? "")
    .replace(/[\u3000\s]+/g, "")
    .toUpperCase();
}

function textHasModel(haystack: string, model: string): boolean {
  const wanted = normalizeModelText(model);
  if (wanted.length < 2) return false;
  return normalizeModelText(haystack).includes(wanted);
}

/**
 * 能力名分词（无第三方分词器，确定性两字切片）
 *
 * 中文按 2 字滑窗切片、拉丁词整体保留；"AI质检"会得到 `ai` + `质检` 两个实词。
 * 只用于命中判定，不追求语言学正确——判定口径可复现比"分得准"更重要。
 */
export function capabilityTokens(name: string): string[] {
  const parts = text(name)
    .replace(/[（）()【】\[\]「」《》<>·,，、;；:：/|+&\s]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const out = new Set<string>();
  for (const part of parts) {
    for (const word of part.match(/[A-Za-z][A-Za-z0-9+.-]*/g) ?? []) {
      if (word.length >= 2) out.add(word.toLowerCase());
    }
    for (const run of part.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      if (run.length <= 4) {
        out.add(run);
        continue;
      }
      for (let i = 0; i + 2 <= run.length; i += 2) out.add(run.slice(i, i + 2));
    }
  }
  return [...out];
}

/** 来源是不是同一份自有材料（来源是文件名 → 视为独立） */
export function isIndependentSource(source: string, hitUrl: string): boolean {
  const raw = text(source);
  if (!/^https?:\/\//iu.test(raw)) return true;
  const a = hostOf(raw);
  const b = hostOf(hitUrl);
  if (a === "" || b === "") return true;
  return a !== b;
}

/** 抓取前按 host 预排序：政府/标准/官方文档优先（与 step-research 同思路） */
function preRank(url: string): number {
  const host = hostOf(url);
  if (host === "") return 9;
  if (/(^|\.)gov\.(cn|mil)$/u.test(host) || /(^|\.)(iso\.org|iec\.ch|itu\.int)$/u.test(host)) return 0;
  if (/(^|\.)(edu\.cn|edu)$/u.test(host)) return 1;
  if (/^(docs|doc|developer|support|help|api|wiki)\./u.test(host) || /\/docs?\//iu.test(url)) return 2;
  if (/(^|\.)(mp\.weixin\.qq\.com|zhihu\.com|csdn\.net|toutiao\.com)$/u.test(host)) return 8;
  return 4;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** 带超时的检索：单条 query 卡住不能拖垮整批 */
function searchWithDeadline(
  search: SearchFn,
  query: string,
  ms: number,
): Promise<{ ok: boolean; hits: ResearchHit[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    search(query, RESULT_LIMIT).catch((err: unknown) => ({
      ok: false,
      hits: [] as ResearchHit[],
      error: `检索异常：${err instanceof Error ? err.message : String(err)}`,
    })),
    new Promise<{ ok: boolean; hits: ResearchHit[]; error?: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, hits: [], error: `检索超时（${Math.round(ms / 1000)} 秒）` }),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 带超时的抓取 */
function fetchWithDeadline(fetchFn: FetchFn, url: string, ms: number): Promise<Partial<FetchResult>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fetchFn(url).catch((err: unknown) => ({
      ok: false,
      url,
      markdown: "",
      error: `抓取异常：${err instanceof Error ? err.message : String(err)}`,
    })),
    new Promise<Partial<FetchResult>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, url, markdown: "", error: `抓取超时（${Math.round(ms / 1000)} 秒）` }),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function rankOf(authority: string): number {
  return AUTHORITY_RANK[authority] ?? 99;
}

/** 取最高权威级（空串表示没有可用来源） */
function bestAuthority(authorities: readonly string[]): string {
  const valid = authorities.filter((a) => a in AUTHORITY_RANK);
  if (valid.length === 0) return "";
  return valid.sort((a, b) => rankOf(a) - rankOf(b))[0]!;
}

function isAuthority(value: string): value is "T1" | "T2" | "T3" | "T4" {
  return value === "T1" || value === "T2" || value === "T3" || value === "T4";
}

// ─── 目标行构造 ────────────────────────────────────────────

/** 能力行 → 核验目标 */
function capabilityTarget(row: Capability): VerifyTarget {
  const name = text(row.name);
  const domain = text(row.domain);
  // 描述关键词：能力名之外的实词（≤2 个），让第二条 query 更具体
  const nameTokens = new Set(capabilityTokens(name));
  const keyword = capabilityTokens(row.description)
    .filter((token) => !nameTokens.has(token))
    .slice(0, 2)
    .join(" ");
  return {
    table: "M3",
    rowId: row.id,
    productLineId: row.product_line_id,
    summary: [domain, name].filter(Boolean).join("｜"),
    keyText: [name, domain].filter(Boolean).join(" "),
    source: text(row.source),
    queries: [
      clipQuery([quoted(name), domain]),
      clipQuery([quoted(name), keyword]),
    ].filter(Boolean),
    model: "",
    name,
    certType: "",
    certNo: "",
    unitPrice: "",
    createdAt: String(row.created_at ?? ""),
  };
}

/** 产品行 → 核验目标（型号完全匹配） */
function productTarget(row: Product): VerifyTarget {
  const model = text(row.model);
  const name = text(row.name);
  return {
    table: "M1",
    rowId: row.id,
    productLineId: row.product_line_id,
    summary: [model, name].filter(Boolean).join(" "),
    keyText: [model, name].filter(Boolean).join(" "),
    source: text(row.source),
    queries: [clipQuery([quoted(model), quoted(name)]), clipQuery([quoted(model)])].filter(Boolean),
    model,
    name,
    certType: "",
    certNo: "",
    unitPrice: "",
    createdAt: String(row.created_at ?? ""),
  };
}

/** 报价行 → 核验目标（型号 + 单价） */
function quoteTarget(row: PriceQuote, productLineId: string): VerifyTarget {
  const model = text(row.model);
  const price = text(row.unit_price);
  return {
    table: "M6",
    rowId: row.id,
    productLineId,
    summary: [model, text(row.config), price].filter(Boolean).join("｜"),
    keyText: [model, price].filter(Boolean).join(" "),
    source: text(row.source),
    queries: [
      clipQuery([quoted(model), price === "" || price === "面议" ? "报价" : quoted(price)]),
      clipQuery([quoted(model), "报价"]),
    ].filter(Boolean),
    model,
    name: "",
    certType: "",
    certNo: "",
    unitPrice: price,
    createdAt: String(row.created_at ?? ""),
  };
}

/** O1 认证行 → 核验目标（证书号，或证书类型+型号） */
function certTarget(row: OptionalMaterial, payload: Record<string, unknown>): VerifyTarget {
  const model = text(payload["model"]);
  const certType = text(payload["cert_type"]);
  const certNo = text(payload["cert_no"]);
  const queries = [
    certNo ? clipped([quoted(certNo)]) : "",
    model ? clipped([quoted(model), quoted(certType)]) : "",
    model ? clipped([quoted(model), "认证"]) : "",
  ].filter(Boolean).slice(0, MAX_QUERIES);
  return {
    table: "O1",
    rowId: row.id,
    productLineId: row.product_line_id,
    summary: [model, certType, certNo].filter(Boolean).join(" "),
    keyText: [certNo, certType, model].filter(Boolean).join(" "),
    source: text(row.source),
    queries,
    model,
    name: "",
    certType,
    certNo,
    unitPrice: "",
    createdAt: String(row.created_at ?? ""),
  };
}

/** 小工具：过滤空串 */
function clipped(parts: string[]): string {
  return clipQuery(parts.filter(Boolean));
}

/** 汇总待核目标（可按产品线过滤，按创建时间稳定排序） */
function buildTargets(db: DbInstance, productLineId?: string): VerifyTarget[] {
  const line = text(productLineId);
  const keep = (id: string): boolean => line === "" || id === line;
  const out: VerifyTarget[] = [];

  for (const p of db.productRepo.list({ orderBy: "created_at ASC" }) as Product[]) {
    if (keep(p.product_line_id)) out.push(productTarget(p));
  }
  for (const c of db.capabilityRepo.list({ orderBy: "created_at ASC" }) as Capability[]) {
    if (keep(c.product_line_id)) out.push(capabilityTarget(c));
  }
  const lineOfProduct = new Map(
    (db.productRepo.list() as Product[]).map((p) => [p.id, p.product_line_id]),
  );
  for (const q of db.quoteRepo.list({ orderBy: "created_at ASC" }) as PriceQuote[]) {
    const pid = lineOfProduct.get(q.product_id) ?? "";
    if (keep(pid)) out.push(quoteTarget(q, pid));
  }
  const certs = db.optionalMaterialRepo.list({
    where: "category = ?",
    params: ["O1认证"],
    orderBy: "created_at ASC",
  }) as OptionalMaterial[];
  for (const row of certs) {
    if (keep(row.product_line_id)) out.push(certTarget(row, row.payload ?? {}));
  }
  return out.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.table + a.rowId < b.table + b.rowId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/** 已核验且在 7 天内的行（`table|rowId` 集合） */
function freshKeys(db: DbInstance, nowMs: number): Set<string> {
  const out = new Set<string>();
  for (const row of db.verificationRepo.listAll()) {
    const at = Date.parse(row.checked_at);
    if (Number.isFinite(at) && nowMs - at < VERIFY_FRESH_MS) {
      out.add(`${row.table_code}|${row.row_id}`);
    }
  }
  return out;
}

// ─── 命中 / 冲突判定 ───────────────────────────────────────

/** 标题或正文是否含该行的关键标识（按表分口径） */
export function matchesKey(target: {
  table: VerifyTable;
  model?: string;
  name?: string;
  certType?: string;
  certNo?: string;
}, haystack: string): boolean {
  const textValue = String(haystack ?? "");
  switch (target.table) {
    case "M1":
    case "M6":
      return textHasModel(textValue, String(target.model ?? ""));
    case "M3": {
      const tokens = capabilityTokens(String(target.name ?? ""));
      if (tokens.length === 0) return false;
      const hay = textValue.toLowerCase();
      const need = Math.min(2, tokens.length);
      return tokens.filter((token) => hay.includes(token)).length >= need;
    }
    case "O1": {
      const certNo = normalizeModelText(String(target.certNo ?? ""));
      if (certNo.length >= 3 && normalizeModelText(textValue).includes(certNo)) return true;
      const certType = String(target.certType ?? "").toLowerCase();
      return (
        certType !== "" &&
        textHasModel(textValue, String(target.model ?? "")) &&
        textValue.toLowerCase().includes(certType)
      );
    }
    default:
      return false;
  }
}

/** 页面里的价格数字（只认带价格语境的数，避免把规格数字当价格） */
function priceNumbersIn(textValue: string): number[] {
  const out: number[] = [];
  const patterns = [
    /(?:单价|售价|报价|价格|含税价|人民币|RMB|¥|￥)\s*[:：]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/giu,
    /([0-9][0-9,]*(?:\.[0-9]+)?)\s*元/gu,
  ];
  for (const re of patterns) {
    for (const m of textValue.matchAll(re)) {
      const n = Number(String(m[1] ?? "").replace(/,/g, ""));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** 库内单价里的数字（"12000–15000" 取第一个） */
function rowPrice(unitPrice: string): number | undefined {
  const m = /[0-9][0-9,]*(?:\.[0-9]+)?/u.exec(text(unitPrice));
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 报价冲突：命中型号的页面上出现"同一价位段"的价格，但都不等于库内单价
 *
 * 只看 0.5×–2× 区间：配件价、年费、其他型号价格通常不在这个区间，避免把噪声当矛盾。
 */
export function findPriceConflict(
  unitPrice: string,
  matchedTexts: readonly string[],
): { conflict: boolean; pagePrice?: number } {
  const own = rowPrice(unitPrice);
  if (own === undefined) return { conflict: false };
  const pagePrices = matchedTexts.flatMap((t) => priceNumbersIn(t)).filter((n) => n >= own * 0.5 && n <= own * 2);
  if (pagePrices.length === 0) return { conflict: false };
  const consistent = pagePrices.some((n) => Math.abs(n - own) <= Math.max(1, own * 0.01));
  return consistent ? { conflict: false } : { conflict: true, pagePrice: pagePrices[0] };
}

// ─── 单行核验 ──────────────────────────────────────────────

function makeDetail(
  target: VerifyTarget,
  status: VerificationStatus,
  fields: Partial<Pick<VerifyDetail, "authority" | "sources" | "note" | "upgraded">>,
  checkedAt: string,
): VerifyDetail {
  return {
    table: target.table,
    row_id: target.rowId,
    summary: target.summary,
    status,
    authority: fields.authority ?? "",
    sources: fields.sources ?? [],
    key_text: target.keyText,
    note: (fields.note ?? "").slice(0, NOTE_MAX),
    checked_at: checkedAt,
    upgraded: fields.upgraded ?? false,
  };
}

/** 逐条检索并过滤候选（同源自有材料、非 http、重复 URL 都不要） */
async function collectCandidates(
  target: VerifyTarget,
  search: SearchFn,
  deadline: number,
): Promise<{ candidates: Candidate[]; errors: string[]; ownSkipped: number }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let ownSkipped = 0;

  for (const query of target.queries.slice(0, MAX_QUERIES)) {
    if (remainingMs(deadline) <= 0) {
      errors.push("整批核验 90 秒预算已用完，剩余 query 未执行");
      break;
    }
    const res = await searchWithDeadline(
      search,
      query,
      Math.min(VERIFY_PAGE_TIMEOUT_MS, remainingMs(deadline)),
    );
    if (!res.ok) {
      errors.push(res.error ? `「${query}」${res.error}` : `「${query}」检索失败`);
      continue;
    }
    for (const hit of res.hits) {
      const url = text(hit.url);
      if (!/^https?:\/\//iu.test(url)) continue;
      const key = urlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isIndependentSource(target.source, url)) {
        ownSkipped += 1;
        continue;
      }
      candidates.push({
        url,
        title: text(hit.title),
        snippet: text(hit.snippet),
        publishedAt: text(hit.publishedAt),
      });
      if (candidates.length >= RESULT_LIMIT) break;
    }
    if (candidates.length >= RESULT_LIMIT) break;
  }
  candidates.sort((a, b) => preRank(a.url) - preRank(b.url));
  return { candidates, errors, ownSkipped };
}

/** 抓正文并落 web_source；失败时退回标题+摘要（不伪造正文） */
async function captureCandidate(
  db: DbInstance,
  cand: Candidate,
  fetchFn: FetchFn,
  deadline: number,
): Promise<{ text: string; source: VerificationSource; authority: string; captured: boolean }> {
  let pageTitle = cand.title;
  let body = "";
  let publisher = "";
  let publishedAt = cand.publishedAt;
  let authority = "";
  let captured = false;

  const left = remainingMs(deadline);
  if (left > 0) {
    const page = await fetchWithDeadline(fetchFn, cand.url, Math.min(VERIFY_PAGE_TIMEOUT_MS, left));
    if (page.ok && text(page.markdown) !== "") {
      try {
        const stored = saveWebCapture(db.db, {
          url: cand.url,
          finalUrl: text(page.finalUrl) || cand.url,
          title: text(page.title) || cand.title,
          markdown: String(page.markdown ?? ""),
          ...(page.publishedAt ? { publishedAt: String(page.publishedAt) } : {}),
          ...(page.publisher ? { publisher: String(page.publisher) } : {}),
          httpStatus: Number(page.httpStatus ?? 200),
          contentType: String(page.contentType ?? ""),
          ...(page.etag ? { etag: String(page.etag) } : {}),
          ...(page.lastModified ? { lastModified: String(page.lastModified) } : {}),
        });
        if (!stored.blocked) {
          pageTitle = text(page.title) || cand.title;
          body = String(page.markdown ?? "");
          publisher = text(page.publisher);
          publishedAt = text(page.publishedAt) || cand.publishedAt;
          authority = isAuthority(stored.authority) ? stored.authority : "";
          captured = true;
        }
      } catch {
        // 落库失败（正文为空/清洗不出块）按"未抓到正文"处理
      }
    }
  }

  return {
    // 标题也算命中依据（用户口径："正文或标题必须同时含关键标识"）
    text: `${pageTitle} ${body} ${body === "" ? cand.snippet : ""}`,
    source: { title: pageTitle || cand.url, url: cand.url, publisher, published_at: publishedAt },
    authority,
    captured,
  };
}

/** 未抓正文时的权威级：只按 URL/标题判（不给提级，最高按 T4 记账） */
function uncapturedAuthority(cand: Candidate, pageText: string): string {
  const meta: WebPageMeta = { url: cand.url, title: cand.title, text: pageText };
  const graded = gradeWebSource(meta).authority;
  // 没抓到正文的页面不能作为提级依据：只保留"站点级别"信息，按 T4 记账
  return graded === "T1" || graded === "T2" ? "T4" : graded;
}

function dedupeSources(sources: VerificationSource[]): VerificationSource[] {
  const seen = new Set<string>();
  const out: VerificationSource[] = [];
  for (const s of sources) {
    if (s.url === "" || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** 把命中结果落成记录，并按结论决定是否升证据级 */
function persistDetail(db: DbInstance, detail: VerifyDetail): VerifyDetail {
  db.verificationRepo.upsert({
    table_code: detail.table,
    row_id: detail.row_id,
    status: detail.status,
    authority: (detail.authority || "") as LibraryVerification["authority"],
    sources_json: JSON.stringify(detail.sources),
    key_text: detail.key_text,
    note: detail.note,
    checked_at: detail.checked_at,
  });
  return detail;
}

/** 核验通过才升级：只改 evidence_level，不动 source / 内容 */
export function applyEvidenceUpgrade(db: DbInstance, table: VerifyTable, rowId: string): boolean {
  const repos = {
    M1: db.productRepo,
    M3: db.capabilityRepo,
    M6: db.quoteRepo,
    O1: db.optionalMaterialRepo,
  } as const;
  const repo = repos[table];
  const current = repo.getById(rowId);
  if (!current) return false;
  if (current.evidence_level === "A") return false;
  repo.update(rowId, { evidence_level: "A" } as never);
  return true;
}

/** 核验单行（返回明细；任何异常都收敛成"未核实"，不抛） */
async function verifyTarget(
  db: DbInstance,
  target: VerifyTarget,
  io: { search: SearchFn; fetch: FetchFn },
  deadline: number,
  checkedAt: string,
): Promise<VerifyDetail> {
  if (target.queries.length === 0 || target.keyText.trim() === "") {
    return persistDetail(
      db,
      makeDetail(target, "未核实", { note: "缺少可核验的关键标识（型号/能力名/证书号），未发起检索" }, checkedAt),
    );
  }

  const { candidates, errors, ownSkipped } = await collectCandidates(target, io.search, deadline);
  const matched: Matched[] = [];

  for (const cand of candidates) {
    if (remainingMs(deadline) <= 0) {
      errors.push("整批核验 90 秒预算已用完，部分候选页未抓取");
      break;
    }
    const captured = await captureCandidate(db, cand, io.fetch, deadline);
    if (!matchesKey(target, captured.text)) continue;
    const authority = captured.captured ? captured.authority : uncapturedAuthority(cand, captured.text);
    matched.push({ ...captured, authority });
  }

  if (matched.length === 0) {
    const note =
      errors.length > 0
        ? errors.join("；")
        : ownSkipped > 0
          ? `检索到的 ${ownSkipped} 条来源与自有材料同 host，不算独立来源`
          : candidates.length === 0
            ? "未检索到可用链接（可能被反爬拦截或没有公开来源）"
            : "标题与正文均未同时含该行关键标识";
    return persistDetail(db, makeDetail(target, "未核实", { note }, checkedAt));
  }

  const sources = dedupeSources(matched.map((m) => m.source));
  const best = bestAuthority(matched.map((m) => m.authority));
  const uncapturedCount = matched.filter((m) => !m.captured).length;

  if (target.table === "M6") {
    const conflict = findPriceConflict(target.unitPrice, matched.map((m) => m.text));
    if (conflict.conflict) {
      const note =
        `检索到的报价（${conflict.pagePrice ?? "?"} 元）与库内单价（${target.unitPrice}）不一致` +
        "，保持原证据级，请人工核对报价口径";
      return persistDetail(db, makeDetail(target, "有冲突", { authority: best, sources, note }, checkedAt));
    }
  }

  if (best === "T1" || best === "T2") {
    const upgraded = applyEvidenceUpgrade(db, target.table, target.rowId);
    const note =
      `命中 ${best} 独立来源${sources[0] ? `：${sources[0].title || sources[0].url}` : ""}` +
      (uncapturedCount > 0 ? `（另有 ${uncapturedCount} 条未抓到正文，不计提级）` : "");
    return persistDetail(db, makeDetail(target, "已核实", { authority: best, sources, note, upgraded }, checkedAt));
  }

  const note =
    best === ""
      ? "命中来源但均未抓到正文，权威级无法判定，不升级"
      : `只检索到 ${best} 来源，未达 T1/T2 独立来源门槛，不升级证据等级`;
  return persistDetail(db, makeDetail(target, "未核实", { authority: best, sources, note }, checkedAt));
}

/** 默认检索/抓取（web-engine）；引擎不可用时返回 undefined 让调用方写"未核实" */
function defaultIo(
  deps: LibraryVerifyDeps,
): { search: SearchFn; fetch: FetchFn; engine: ResolvedEngine } | undefined {
  if (deps.search && deps.fetch) {
    return {
      search: deps.search,
      fetch: deps.fetch,
      engine: { kind: "none", canSearch: true, detail: "注入的检索函数" },
    };
  }
  const cfg = deps.cfg ?? loadWebSearchConfig();
  const provider = deps.provider ?? currentProvider();
  const engine = resolveEngine(cfg, provider);
  if (!engine.canSearch) return undefined;
  const searchCfg: WebSearchConfig =
    engine.kind === "deepseek-native" && cfg.modelProvider === undefined && provider
      ? { ...cfg, modelProvider: provider }
      : cfg;
  const counters = { searches: 0, fetches: 0, lastHit: new Map<string, number>() };
  const budget = { ...DEFAULT_BUDGET, maxSearches: 60, maxFetches: 60, pageTimeoutMs: VERIFY_PAGE_TIMEOUT_MS };
  return {
    engine,
    search: (query, limit) => searchByEngine(engine, searchCfg, query, counters, budget, limit),
    fetch: (url) => fetchByEngine(engine, searchCfg, url, counters, budget),
  };
}

/** 当前默认供应商（DeepSeek 官方检索要带 Key；与 step-research 同口径） */
function currentProvider(): { baseUrl: string; apiKey: string } | undefined {
  try {
    const registry = loadRegistry();
    const ref = registry.default_model;
    const provider =
      (ref ? registry.providers.find((p) => p.name === ref.provider) : undefined) ??
      registry.providers[0];
    if (!provider) return undefined;
    const baseUrl = text(provider.base_url);
    const apiKey = text(provider.api_key);
    if (baseUrl === "" || apiKey === "") return undefined;
    return { baseUrl, apiKey };
  } catch {
    return undefined;
  }
}

// ─── 对外入口 ──────────────────────────────────────────────

/**
 * 核验一批行（默认最多 20 行），同步执行
 *
 * @returns 统计 + 明细；`remaining` 是本批之后仍需核验的行数（已核验 7 天内不重复核）
 */
export async function verifyLibrary(
  db: DbInstance,
  options: VerifyOptions = {},
  deps: LibraryVerifyDeps = {},
): Promise<VerifyReport> {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const checkedAt = new Date(nowMs).toISOString();
  const rawLimit = Number(options.limit ?? VERIFY_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), VERIFY_LIMIT) : VERIFY_LIMIT;

  const fresh = freshKeys(db, nowMs);
  const eligible = buildTargets(db, options.productLineId).filter(
    (t) => !fresh.has(`${t.table}|${t.rowId}`),
  );
  const batch = eligible.slice(0, limit);

  const report: VerifyReport = {
    checked: 0,
    verified: 0,
    conflict: 0,
    unverified: 0,
    upgraded: 0,
    remaining: Math.max(0, eligible.length - batch.length),
    details: [],
    errors: [],
  };
  if (batch.length === 0) return report;

  const deadline = Date.now() + VERIFY_TOTAL_MS;
  const io = defaultIo(deps);
  if (!io) {
    for (const target of batch) {
      const detail = persistDetail(
        db,
        makeDetail(
          target,
          "未核实",
          { note: "没有可用的联网检索引擎（未配置 DeepSeek 官方 Key / Tavily，或已关闭检索）" },
          checkedAt,
        ),
      );
      report.details.push(detail);
      report.unverified += 1;
    }
    report.checked = report.details.length;
    return report;
  }

  for (const target of batch) {
    if (remainingMs(deadline) <= 0) {
      report.errors.push("整批核验 90 秒预算已用完，剩余行留待下次");
      // 没来得及核的行不写记录：下次调用仍是待核状态
      break;
    }
    try {
      const detail = await verifyTarget(db, target, io, deadline, checkedAt);
      report.details.push(detail);
      if (detail.status === "已核实") report.verified += 1;
      else if (detail.status === "有冲突") report.conflict += 1;
      else report.unverified += 1;
      if (detail.upgraded) report.upgraded += 1;
    } catch (err: unknown) {
      report.errors.push(
        `${target.table} ${target.summary || target.rowId} 核验异常：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  report.checked = report.details.length;
  // 已写记录的行 7 天内不会再进 eligible：剩余 = 本批原有 + 未处理
  report.remaining = Math.max(0, eligible.length - report.checked);
  return report;
}

// ─── 已核验结果查询（GET） ─────────────────────────────────

/** 核验记录对应的当前行信息（行已删则返回 undefined） */
export function resolveVerificationRow(
  db: DbInstance,
  tableCode: string,
  rowId: string,
): { productLineId: string; summary: string; evidence: string } | undefined {
  if (tableCode === "M1") {
    const row = db.productRepo.getById(rowId);
    if (!row) return undefined;
    return {
      productLineId: row.product_line_id,
      summary: [text(row.model), text(row.name)].filter(Boolean).join(" "),
      evidence: text(row.evidence_level),
    };
  }
  if (tableCode === "M3") {
    const row = db.capabilityRepo.getById(rowId);
    if (!row) return undefined;
    return {
      productLineId: row.product_line_id,
      summary: [text(row.domain), text(row.name)].filter(Boolean).join("｜"),
      evidence: text(row.evidence_level),
    };
  }
  if (tableCode === "M6") {
    const row = db.quoteRepo.getById(rowId);
    if (!row) return undefined;
    const product = db.productRepo.getById(row.product_id);
    return {
      productLineId: product?.product_line_id ?? "",
      summary: [text(row.model), text(row.config), text(row.unit_price)].filter(Boolean).join("｜"),
      evidence: text(row.evidence_level),
    };
  }
  if (tableCode === "O1") {
    const row = db.optionalMaterialRepo.getById(rowId);
    if (!row) return undefined;
    const payload = row.payload ?? {};
    return {
      productLineId: row.product_line_id,
      summary: [text(payload["model"]), text(payload["cert_type"]), text(payload["cert_no"])]
        .filter(Boolean)
        .join(" "),
      evidence: text(row.evidence_level),
    };
  }
  return undefined;
}

function parseSources(raw: string): VerificationSource[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        title: text(item["title"]),
        url: text(item["url"]),
        publisher: text(item["publisher"]),
        published_at: text(item["published_at"]),
      }))
      .filter((item) => item.url !== "")
      .slice(0, MAX_SOURCES);
  } catch {
    return [];
  }
}

const STATUS_ORDER: VerificationStatus[] = ["已核实", "有冲突", "未核实"];

/** 读取已核验统计与明细（按状态分组；只读，不改库） */
export function listVerifications(db: DbInstance, productLineId?: string): VerificationSummary {
  const line = text(productLineId);
  const details: VerifyDetail[] = [];
  for (const row of db.verificationRepo.listAll()) {
    const resolved = resolveVerificationRow(db, row.table_code, row.row_id);
    if (!resolved) continue; // 行已删：记录留着但不出现在统计里
    if (line !== "" && resolved.productLineId !== line) continue;
    if (!VERIFY_TABLES.includes(row.table_code as VerifyTable)) continue;
    details.push({
      table: row.table_code as VerifyTable,
      row_id: row.row_id,
      summary: resolved.summary,
      status: row.status,
      authority: row.authority,
      sources: parseSources(row.sources_json),
      key_text: row.key_text,
      note: row.note,
      checked_at: row.checked_at,
      upgraded: row.status === "已核实" && resolved.evidence === "A",
    });
  }

  details.sort((a, b) => {
    const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (byStatus !== 0) return byStatus;
    return a.checked_at < b.checked_at ? 1 : a.checked_at > b.checked_at ? -1 : 0;
  });

  const byStatus: Record<VerificationStatus, number> = { 已核实: 0, 未核实: 0, 有冲突: 0 };
  const groups: Record<VerificationStatus, VerifyDetail[]> = { 已核实: [], 未核实: [], 有冲突: [] };
  for (const detail of details) {
    byStatus[detail.status] += 1;
    groups[detail.status].push(detail);
  }

  return {
    generated_at: new Date().toISOString(),
    total: details.length,
    by_status: byStatus,
    upgraded: details.filter((d) => d.upgraded).length,
    details,
    groups,
  };
}
