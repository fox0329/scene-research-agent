/**
 * web-authority — 网页来源的权威性判定（变更表 #216）
 *
 * 依据 `docs/技术调研-权威来源检索.md` §5.1/§5.2/§5.3：
 * **P1–P9 优先级阶梯**（先命中者胜）+ **降级因子** + **升级因子**。
 *
 * 为什么不交给模型判：G-R1/§三.5 要求"来源权威性分级"落确定性层。
 * 模型判权威的问题是不可复现、不可审计、可被页面内容带偏
 * （页面里写一句"本文转载自新华社"模型就可能信）。
 *
 * 与 `evidence.ts` 的关系：类目与 T1–T4 映射**完全复用**，本模块只负责
 * "网页 → 类目"这一段的规则，以及降级/升级因子的串接。
 */

import { gradeByCategory, type SourceCategory } from "./evidence.js";

/** 命中的规则编号（可审计，落库给用户看） */
export type WebRuleId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9";

/** 判定结果 */
export interface WebAuthorityVerdict {
  /** 类目（复用现有枚举） */
  category: SourceCategory;
  /** 权威性 T1–T4 */
  authority: "T1" | "T2" | "T3" | "T4";
  /** 命中的 P 规则 */
  rule: WebRuleId;
  /** 是否**禁止引用**（P9：黑名单或判不出来） */
  blocked: boolean;
  /** 命中的降级因子 */
  downgrades: DowngradeFactor[];
  /** 命中的升级因子 */
  upgrades: UpgradeFactor[];
  /** 人可读的理由，落 `web_source.authority_reason` */
  reasons: string[];
}

/** 降级因子（每命中一项降一级；T1 最低降到 T3） */
export type DowngradeFactor =
  | "转载"
  | "无发布日期"
  | "正文过短"
  | "列表或搜索页"
  | "内容与标题不符"
  | "命中注入特征"
  | "快照已变更";

/** 升级因子（最多 +1，且不越过 P1/P2 的 T1 上限） */
export type UpgradeFactor = "含文号" | "PDF原文" | "一手发布";

/** 页面元数据（抓取后抽出来的，判类目的输入） */
export interface WebPageMeta {
  url: string;
  title?: string;
  /** 正文纯文本（用于降级因子判定） */
  text?: string;
  /** 页面声明的发布日期（ISO 8601 或可解析字符串） */
  publishedAt?: string;
  /** 发布机构（og:site_name / 页脚） */
  publisher?: string;
  /** Content-Type */
  contentType?: string;
  /** 是否命中注入特征（由 web-injection 判定后传入，避免重复实现） */
  injectionHit?: boolean;
  /** 快照是否已变更（实时校验时传入） */
  changed?: boolean;
}

// ─── P1 法规标准原文站点 ─────────────────────────────────────

/** 法规标准原文站点（host 精确或后缀匹配） */
const P1_HOSTS = [
  "flk.npc.gov.cn",
  "openstd.samr.gov.cn",
  "std.samr.gov.cn",
  "sac.gov.cn",
  "iso.org",
  "iec.ch",
  "itu.int",
  "ietf.org",
  "3gpp.org",
  "etsi.org",
  "ieee.org",
];

// ─── P3 交易所与公告原文 ─────────────────────────────────────

const P3_HOSTS = ["cninfo.com.cn", "sse.com.cn", "szse.cn", "hkexnews.hk", "sec.gov"];

// ─── P5 学术与行业组织 ───────────────────────────────────────

const P5_HOSTS = ["arxiv.org", "acm.org", "nature.com", "sciencedirect.com", "springer.com", "wiley.com"];

// ─── P8 自媒体与 UGC ─────────────────────────────────────────

const P8_HOSTS = [
  "mp.weixin.qq.com",
  "zhihu.com",
  "csdn.net",
  "jianshu.com",
  "baijiahao.baidu.com",
  "toutiao.com",
  "weibo.com",
  "bilibili.com",
  "xiaohongshu.com",
  "douban.com",
  "x.com",
  "twitter.com",
  "reddit.com",
  "quora.com",
  "facebook.com",
  "youtube.com",
];

/** P4 厂商官方：主域上的文档类子域标签 */
const DOC_SUBDOMAIN_LABELS = new Set([
  "docs",
  "doc",
  "developer",
  "developers",
  "dev",
  "support",
  "help",
  "api",
  "reference",
  "wiki",
  "download",
  "downloads",
]);

/** P4 厂商官方：路径特征 */
const DOC_PATH_RE = /\/(docs?|support|datasheet|data-?sheet|whitepaper|white-?paper|manual|manuals|download)\b/i;

// ─── 转载 / 列表页 / 文号 等特征 ─────────────────────────────

/**
 * 转载声明（要拿"来源机构"做对比）
 *
 * 两段式：「来源」必须带冒号（否则「数据来源不同」这类正文会被误判为转载）；
 * 「转自」类可以不带冒号（「本文转自 人民日报」是常见写法）。
 */
const REPRINT_RES = [
  /(?:来源|文章来源|稿源)\s*[:：]\s*([^\n，。；]{2,30})/u,
  /(?:转载自|本文转自|转自)\s*[:：]?\s*([^\n，。；]{2,30})/u,
];

/** 列表页/搜索页特征 */
const LIST_TITLE_RE = /(搜索结果|检索结果|列表|栏目|索引|全部文章)/u;
const LIST_URL_RE = /[?&](q|query|keyword|keywords|search|wd)=/i;

/** 正文过短阈值（去空白后的字数） */
const MIN_BODY_CHARS = 300;

/** 文号 / 标准号 / 公告编号 / SEC Accession Number */
const DOC_NO_RES = [
  /国办发〔\d{4}〕\d+号/u,
  /[\u4e00-\u9fa5]{1,6}发〔\d{4}〕\d+号/u,
  /GB(?:\/T)?\s?\d+(?:\.\d+)?-\d{4}/u,
  /ISO\s?\d+(?:-\d+)?:\d{4}/u,
  /IEC\s?\d+(?:-\d+)?:\d{4}/u,
  /公告编号\s*[:：]\s*\d+/u,
  /Accession\s+Number\s+\d{10}-\d{2}-\d{6}/iu,
];

/** 权威性等级序（用于降级） */
const RANK: Record<"T1" | "T2" | "T3" | "T4", number> = { T1: 1, T2: 2, T3: 3, T4: 4 };
const BY_RANK = ["T1", "T2", "T3", "T4"] as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** host 是否等于或属于某站（`docs.aws.amazon.com` 属于 `amazon.com` 时才算） */
function hostIsOrSub(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/** P2：政府域名，但排除转载/评论/问答页 */
function isGovHost(host: string): boolean {
  // 注意 `gov.cn` 裸域：`host.endsWith(".gov.cn")` 对 `gov.cn` 本身是 false。
  // 实测 `www.gov.cn`（去掉 www 后就是 `gov.cn`）因此被判成「媒体 T4」✗
  return (
    /(^|\.)gov$/.test(host) ||
    host === "gov.cn" ||
    host.endsWith(".gov.cn") ||
    /(^|\.)mil$/.test(host) ||
    host === "mil" ||
    host === "int" ||
    host.endsWith(".int")
  );
}

/** 政府站上的非原文页（评论、问答、留言、转载栏目） */
function isGovNonPrimaryPath(url: string): boolean {
  return /(comment|liuyan|bbs|ask|wenda|interview|zhuanzai|fazhi|blog)/i.test(url);
}

/** 抽文号 */
export function extractDocNo(text: string): string | null {
  for (const re of DOC_NO_RES) {
    const m = re.exec(String(text ?? ""));
    if (m) return m[0];
  }
  return null;
}

/** 抽「来源：X」/「本文转自 X」里的 X（转载判定用） */
export function extractReprintSource(text: string): string | null {
  const s = String(text ?? "");
  for (const re of REPRINT_RES) {
    const m = re.exec(s);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * 判网页来源的类目与权威性（确定性，先命中者胜）
 *
 * @param meta - 页面元数据
 * @returns 结论 + 可审计的理由
 */
export function gradeWebSource(meta: WebPageMeta): WebAuthorityVerdict {
  const url = String(meta.url ?? "").trim();
  const host = hostOf(url);
  const title = String(meta.title ?? "");
  const reasons: string[] = [];

  if (host === "") {
    return {
      category: "未知",
      authority: "T4",
      rule: "P9",
      blocked: true,
      downgrades: [],
      upgrades: [],
      reasons: ["URL 无法解析，判不出来源"],
    };
  }

  // ── P1 法规标准原文 ──
  if (P1_HOSTS.some((h) => hostIsOrSub(host, h))) {
    reasons.push(`P1 法规标准原文站点（${host}）`);
    return finalize("法规标准", "T1", "P1", meta, reasons);
  }

  // ── P8 自媒体与 UGC（**必须排在 P4 之前**，否则 `www.zhihu.com` 会被文档子域规则吃掉）──
  if (P8_HOSTS.some((h) => hostIsOrSub(host, h))) {
    reasons.push(`P8 自媒体/UGC 平台（${host}）`);
    return finalize("自媒体", "T4", "P8", meta, reasons);
  }

  // ── P2 政府域名（先于 P3/P4，政府站优先按官方文件算）──
  if (isGovHost(host)) {
    if (isGovNonPrimaryPath(url)) {
      reasons.push(`P2 政府域名但落在评论/问答/转载栏目（${host}）`);
      return finalize("媒体", "T3", "P7", meta, reasons);
    }
    reasons.push(`P2 政府域名（${host}）`);
    return finalize("政府文件", "T1", "P2", meta, reasons);
  }

  // ── P3 交易所与公告原文 ──
  if (P3_HOSTS.some((h) => hostIsOrSub(host, h))) {
    reasons.push(`P3 交易所/公告原文站点（${host}）`);
    return finalize("年报公告", "T2", "P3", meta, reasons);
  }

  // ── P5 学术与行业组织 ──
  if (P5_HOSTS.some((h) => hostIsOrSub(host, h))) {
    reasons.push(`P5 学术/行业组织站点（${host}）`);
    return finalize("行业报告", "T2", "P5", meta, reasons);
  }
  if (/(^|\.)edu$/.test(host) || host.endsWith(".edu.cn")) {
    reasons.push(`P5 教育机构域名（${host}）`);
    return finalize("行业报告", "T2", "P5", meta, reasons);
  }

  // ── P4 厂商官方（两段式：文档类子域 或 文档类路径）──
  const labels = host.split(".");
  const hasDocSub = labels.length >= 3 && DOC_SUBDOMAIN_LABELS.has(labels[0]!);
  if (hasDocSub || DOC_PATH_RE.test(url)) {
    reasons.push(`P4 厂商官方文档（${hasDocSub ? "文档子域" : "文档路径"}：${host}）`);
    return finalize("厂商官方", "T2", "P4", meta, reasons);
  }

  // ── P7 其他媒体 / 聚合站（判不出更细的，按媒体处理）──
  if (LIST_TITLE_RE.test(title) || LIST_URL_RE.test(url)) {
    reasons.push("P7 列表页/搜索页，不是内容页");
    return finalize("媒体", "T3", "P7", meta, reasons);
  }
  reasons.push(`P7 一般网站（${host}），无权威性信号`);
  return finalize("媒体", "T3", "P7", meta, reasons);
}

/**
 * 套降级/升级因子并给出最终等级
 *
 * 降级：每命中一项降一级，**T1 最低降到 T3**（不直接降到 T4——
 * "政府站转载了一篇媒体文章"仍是"政府站上能查到的公开信息"，
 * 降到 T4 会让用户以为它和公众号同级）。
 * 升级：最多 +1，且**不越过 P1/P2 的 T1 上限**。
 */
function finalize(
  category: SourceCategory,
  baseAuthority: "T1" | "T2" | "T3" | "T4",
  rule: WebRuleId,
  meta: WebPageMeta,
  reasons: string[],
): WebAuthorityVerdict {
  const downgrades: DowngradeFactor[] = [];
  const upgrades: UpgradeFactor[] = [];
  const text = String(meta.text ?? "");
  const title = String(meta.title ?? "");
  const compact = text.replace(/\s+/g, "");

  // ── 降级因子 ──
  const reprintFrom = extractReprintSource(text);
  if (reprintFrom && !hostOf(meta.url).includes(reprintFrom.replace(/[^\p{L}\p{N}]/gu, ""))) {
    downgrades.push("转载");
    reasons.push(`正文声明「来源：${reprintFrom}」，属转载`);
  }
  if (!hasDate(meta.publishedAt)) {
    downgrades.push("无发布日期");
    reasons.push("抽不到发布日期，时效无法判断");
  }
  if (compact !== "" && compact.length < MIN_BODY_CHARS) {
    downgrades.push("正文过短");
    reasons.push(`正文仅 ${compact.length} 字（阈值 ${MIN_BODY_CHARS}），可能是摘要页或列表页`);
  }
  if (LIST_TITLE_RE.test(title)) {
    downgrades.push("列表或搜索页");
    reasons.push("标题是列表/搜索页特征");
  }
  if (titleMismatch(title, text)) {
    downgrades.push("内容与标题不符");
    reasons.push("标题关键词在正文前 500 字命中不足，疑似标题党或跳转错页");
  }
  if (meta.injectionHit) {
    downgrades.push("命中注入特征");
    reasons.push("正文命中提示注入特征，内容不可信");
  }
  if (meta.changed) {
    downgrades.push("快照已变更");
    reasons.push("页面内容与入库快照不一致，引用可能已失效");
  }

  // ── 升级因子 ──
  const docNo = extractDocNo(`${title}\n${text.slice(0, 2000)}`);
  if (docNo) {
    upgrades.push("含文号");
    reasons.push(`正文含文号/标准号：${docNo}`);
  }
  if (/\.pdf($|\?)/i.test(meta.url) || /application\/pdf/i.test(String(meta.contentType ?? ""))) {
    upgrades.push("PDF原文");
    reasons.push("PDF 原件");
  }

  // ── 合成 ──
  let rank = RANK[baseAuthority];
  if (downgrades.length > 0) {
    const floor = baseAuthority === "T1" ? 3 : 4; // T1 最低 T3；其余最低 T4
    rank = Math.min(rank + downgrades.length, floor);
  }
  if (upgrades.length > 0 && rank > 1) {
    // +1 但不越过 T1（rank 1）
    rank = Math.max(1, rank - 1);
  }

  const authority = BY_RANK[rank - 1]!;
  // 判不出来 / 无信号 → 禁止引用（P9 语义）
  const blocked = authority === "T4" && downgrades.length >= 2;
  if (blocked) reasons.push("降级过多，判为不可靠来源，禁止引用");

  return { category, authority, rule, blocked, downgrades, upgrades, reasons };
}

/** 日期能不能用（有值且能解析） */
function hasDate(s: string | undefined): boolean {
  const v = String(s ?? "").trim();
  if (v === "") return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

/**
 * 标题与正文是否明显不符
 *
 * 取标题里长度 ≥2 的词（中文按 2 字滑窗，英文按单词），看前 500 字命中率。
 * 命中率 < 30% 视为不符——抓错页、跳到登录页、标题党都会命中这条。
 */
function titleMismatch(title: string, text: string): boolean {
  const t = String(title ?? "").trim();
  if (t === "" || String(text ?? "").trim() === "") return false;
  const head = text.slice(0, 500);
  const tokens = new Set<string>();
  for (const w of t.match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []) tokens.add(w.toLowerCase());
  const han = t.replace(/[^\p{Script=Han}]/gu, "");
  for (let i = 0; i + 2 <= han.length; i++) tokens.add(han.slice(i, i + 2));
  if (tokens.size === 0) return false;
  let hit = 0;
  for (const tok of tokens) if (head.toLowerCase().includes(tok)) hit += 1;
  return hit / tokens.size < 0.3;
}

/** 便捷：只要最终等级（多数调用方只需要这个） */
export function gradeWebSourceAuthority(meta: WebPageMeta): "T1" | "T2" | "T3" | "T4" {
  return gradeWebSource(meta).authority;
}

/** 类目 → 权威性（复用现有映射，供外部对齐用） */
export function authorityOfCategory(category: SourceCategory): "T1" | "T2" | "T3" | "T4" {
  return gradeByCategory(category);
}
