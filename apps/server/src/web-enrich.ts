/**
 * web-enrich — 联网补证的服务端编排（变更表 #216）
 *
 * 依据 `docs/技术调研-权威来源检索.md` §6.5 的链路：
 *   触发判据 → 生成 query → 检索 → 域名预筛 → 抓取 →
 *   抽元数据/判权威 → 切块落库 → （此后才允许被引用）
 *
 * 两条不可动摇的约束：
 *   ① **第 ⑦ 步之前，检索结果一律不得进入生成上下文**——
 *      模型看到的永远只有"已入库的材料"
 *   ② 任何失败只让"来源权威性"变差，**不阻断主流程**（§7.5）
 */

import type { DbInstance } from "@scene/infra";
import {
  fetchByEngine,
  loadWebSearchConfig,
  resolveEngine,
  saveWebCapture,
  searchByEngine,
  shouldSkipUrl,
  listWebSources,
  webBlocksBySnapshot,
  type ResolvedEngine,
  type WebBudget,
  type WebSearchConfig,
  DEFAULT_BUDGET,
} from "@scene/infra";
import { resolveActiveModel } from "@scene/infra";
import { isHttpUrl, isBareUrlCitation, normalizeUrl } from "@scene/domain";

/** 一次补证的输入 */
export interface EnrichInput {
  /** 缺口主题（决定 query），如「网络安全等级保护 定级要求」 */
  topics: string[];
  /** 优先限定在这些站点内检索（`site:` 下推） */
  preferSites?: string[];
  /** 显式给 URL 时直接抓（用户粘贴链接的场景） */
  explicitUrls?: string[];
  /** 每个主题检索条数 */
  perTopic?: number;
  /** 预算覆盖 */
  budget?: Partial<WebBudget>;
  /** 是否包含自媒体（默认 false，§7.5：宁可缺不可脏） */
  includeSocial?: boolean;
  /** 谁触发的（落审计） */
  trigger?: string;
}

/** 单条结果摘要 */
export interface EnrichItem {
  url: string;
  ok: boolean;
  /** 快照名（成功时） */
  snapshotName?: string;
  blockCount?: number;
  authority?: string;
  category?: string;
  /** 引用串示例（`快照名:1`） */
  citation?: string;
  /** 是否禁止引用 */
  blocked?: boolean;
  reasons?: string[];
  error?: string;
}

/** 一次补证的结果 */
export interface EnrichReport {
  /** 是否真的联网了（没 Key / 无网络时为 false） */
  performed: boolean;
  /** 未联网的原因（performed=false 时有值） */
  skipReason?: string;
  /** 用掉的检索次数 / 抓取次数 */
  searches: number;
  fetches: number;
  items: EnrichItem[];
  /** 成功入库且可引用的份数 */
  usable: number;
  /** 被过滤掉的数量（社交/黑名单/判不出来） */
  filtered: number;
  /** 实际用的引擎 */
  engine?: string;
  /** 引擎说明（为什么能用/不能用） */
  engineDetail?: string;
}

/**
 * 解析当前可用的检索引擎
 *
 * 不抛错：未配供应商、代理无检索接口、Key 无效都是**正常情况**，
 * 按 §7.5「联网是加分项」处理——如实返回"不可用"，主流程继续。
 */
function resolveEngineNow(): { engine: ResolvedEngine; cfg: WebSearchConfig } {
  const cfg = loadWebSearchConfig();
  let modelProvider: { baseUrl: string; apiKey: string } | undefined;
  try {
    const { provider } = resolveActiveModel();
    modelProvider = { baseUrl: provider.base_url, apiKey: provider.api_key };
  } catch {
    modelProvider = undefined;
  }
  const merged: WebSearchConfig = { ...cfg, modelProvider: cfg.modelProvider ?? modelProvider };
  return { engine: resolveEngine(cfg, merged.modelProvider), cfg: merged };
}

/**
 * 生成检索 query（确定性模板）
 *
 * 把站点限定拼成 `site:` 算子——调研文档 §4.2 选 DeepSeek 的核心理由之一
 * 就是它支持算子下推，能直接把"只在 .gov.cn 里搜"交给引擎。
 */
export function buildQueries(topic: string, preferSites: string[] | undefined): string[] {
  const t = String(topic ?? "").trim();
  if (t === "") return [];
  const sites = (preferSites ?? []).map((s) => s.trim()).filter(Boolean);
  if (sites.length === 0) return [t];
  // 一次一个站点，避免 `site:a OR site:b` 这类引擎兼容性差异
  return sites.map((s) => `${t} site:${s}`);
}

/**
 * 联网补证
 *
 * @param db - 数据库
 * @param input - 输入
 * @returns 报告（永不抛错，失败信息写在 skipReason / items[].error）
 */
export async function enrichWeb(db: DbInstance, input: EnrichInput): Promise<EnrichReport> {
  const budget: WebBudget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const report: EnrichReport = {
    performed: false,
    searches: 0,
    fetches: 0,
    items: [],
    usable: 0,
    filtered: 0,
  };

  const { engine, cfg: engineCfg } = resolveEngineNow();
  report.engine = engine.kind;
  report.engineDetail = engine.detail;

  // 用户显式给 URL 时，即使没有检索能力也能直连抓（直连不需要 Key）
  const hasExplicit = (input.explicitUrls ?? []).length > 0;
  if (!engine.canSearch && !hasExplicit) {
    report.skipReason = engine.detail;
    return report;
  }

  const perTopic = Math.min(Math.max(input.perTopic ?? 6, 1), 10);

  // ── ① 收集候选 URL ──
  const candidates: Array<{ url: string; query: string; title?: string; content?: string; publishedAt?: string }> = [];
  const seen = new Set<string>();

  for (const u of input.explicitUrls ?? []) {
    const url = String(u ?? "").trim();
    if (!isHttpUrl(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ url, query: "（用户指定）" });
  }

  // 计数在会话内共享（同域限速依赖它）
  const searchCounters = { searches: 0, fetches: 0, lastHit: new Map<string, number>() };

  if (engine.canSearch) {
    for (const topic of input.topics) {
      for (const q of buildQueries(topic, input.preferSites)) {
        const r = await searchByEngine(engine, engineCfg, q, searchCounters, budget, perTopic);
        report.searches += 1;
        if (!r.ok) continue;
        for (const hit of r.hits) {
          if (shouldSkipUrl(hit.url)) {
            report.filtered += 1;
            continue;
          }
          const key = normalizeUrl(hit.url);
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            url: hit.url,
            query: q,
            title: hit.title,
            content: hit.content,
            publishedAt: hit.publishedAt,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    report.skipReason = "检索没有返回可用候选（可能无网络或关键词过窄）";
    return report;
  }

  // ── ② 抓取（受预算与并发约束）──
  //
  // Tavily 检索时已经带回 Markdown 全文，直接用，省一次抓取（§4.2）。
  const urls = candidates.slice(0, budget.maxFetches).map((c) => c.url);
  const queryByUrl = new Map(candidates.map((c) => [c.url, c.query]));
  const contentByUrl = new Map(
    candidates.filter((c) => c.content).map((c) => [c.url, c.content!] as const),
  );
  const fetched = await Promise.all(
    urls.map(async (u) => {
      const pre = contentByUrl.get(u);
      if (pre && pre.trim() !== "") {
        // 检索结果自带正文：仍要过一遍抓取逻辑之外的元数据抽取，故直接构造结果
        return {
          ok: true,
          url: u,
          finalUrl: u,
          title: candidates.find((c) => c.url === u)?.title ?? "",
          markdown: pre,
          publishedAt: candidates.find((c) => c.url === u)?.publishedAt,
          httpStatus: 200,
          contentType: "text/markdown",
        };
      }
      return fetchByEngine(engine, engineCfg, u, searchCounters, budget);
    }),
  );
  report.fetches = fetched.length;

  // ── ③ 落库（入库后才算"材料"）──
  for (const f of fetched) {
    if (!f.ok || f.markdown.trim() === "") {
      report.items.push({
        url: f.url,
        ok: false,
        error: f.error ?? "抓取失败",
      });
      continue;
    }
    try {
      const saved = saveWebCapture(db.db, {
        url: f.url,
        finalUrl: f.finalUrl,
        title: f.title,
        markdown: f.markdown,
        publishedAt: f.publishedAt,
        publisher: f.publisher,
        httpStatus: f.httpStatus,
        contentType: f.contentType,
        etag: f.etag,
        lastModified: f.lastModified,
        query: queryByUrl.get(f.url) ?? "",
      });
      // 自媒体在默认模式下不入库引用（宁可缺不可脏）
      const social = saved.category === "自媒体";
      const blocked = saved.blocked || (social && !input.includeSocial);
      report.items.push({
        url: f.url,
        ok: !blocked,
        snapshotName: saved.snapshotName,
        blockCount: saved.blockCount,
        authority: saved.authority,
        category: saved.category,
        citation: `${saved.snapshotName}:1`,
        blocked,
        reasons: saved.reasons,
        error: blocked ? (social ? "自媒体来源，默认不采用" : "判定为不可引用来源") : undefined,
      });
      if (!blocked) report.usable += 1;
      else report.filtered += 1;
    } catch (e) {
      report.items.push({ url: f.url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  report.performed = true;
  return report;
}

/**
 * 触发判据（§7.1，确定性）
 *
 * 只在阶段 1/2 有价值：阶段 3 之后是"我方能力匹配"，答案在公司自己的材料里。
 *
 * @param args - 阶段、必填空缺率、T4 占比、质量关结论
 * @returns 是否触发 + 原因
 */
export function shouldEnrich(args: {
  stage: number;
  requiredGapRate?: number;
  t4Rate?: number;
  qualityGateFailed?: boolean;
  rowCount?: number;
}): { fire: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (args.stage > 2) {
    return { fire: false, reasons: ["阶段 3 之后是我方能力匹配，联网价值低、噪声高"] };
  }
  if (args.qualityGateFailed) reasons.push("质量关「来源权威性达标」未通过（T-3）");
  if ((args.requiredGapRate ?? 0) > 0.3 && (args.rowCount ?? 0) >= 5) {
    reasons.push(`必填列空缺率 ${Math.round((args.requiredGapRate ?? 0) * 100)}% > 30%（T-1）`);
  }
  if ((args.t4Rate ?? 0) > 0.25) {
    reasons.push(`T4/无来源占比 ${Math.round((args.t4Rate ?? 0) * 100)}% > 25%（T-2）`);
  }
  return { fire: reasons.length > 0, reasons };
}

/**
 * 列出可引用的网页来源（右栏/管理页用）
 *
 * 只返回"有效"且未被禁引的，避免用户误引用。
 */
export function listUsableWebSources(db: DbInstance, limit = 50) {
  return listWebSources(db.db, { status: "有效", limit }).filter(
    (s) => s.authority !== "T4",
  );
}

/** 按引用串取网页原文（右栏「看原文」） */
export function webPassagesOf(db: DbInstance, citation: string, limit = 3) {
  const s = String(citation ?? "").trim();
  if (s === "" || isBareUrlCitation(s)) return [];
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return [];
  const snapshot = s.slice(0, idx).trim();
  const blocks = webBlocksBySnapshot(db.db, snapshot);
  const from = Number(s.slice(idx + 1)) || 1;
  return blocks
    .filter((b) => b.blockNo >= from)
    .slice(0, limit)
    .map((b) => ({ blockNo: b.blockNo, heading: b.heading, text: b.text }));
}

/**
 * 联网能力状态（给设置页/浏览器用）
 *
 * 存在的意义：**如实告诉用户能不能联网**。用户配了代理却以为能联网，
 * 比"明确说不能"更糟——那会让人以为来源已经补强过了。
 */
export function webEngineStatus(): {
  engine: string;
  canSearch: boolean;
  detail: string;
  /** 有没有配 Tavily Key（不回显 Key 本体） */
  hasTavilyKey: boolean;
  /** 已入库可用网页来源数 */
  sourceCount: number;
} {
  const { engine, cfg } = resolveEngineNow();
  return {
    engine: engine.kind,
    canSearch: engine.canSearch,
    detail: engine.detail,
    hasTavilyKey: Boolean(cfg.tavilyKey),
    sourceCount: 0,
  };
}
