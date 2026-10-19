/**
 * web-bing — 免注册检索：Bing 网页搜索（变更表 #219）
 *
 * 为什么需要它：Tavily / DeepSeek Search / Brave 都要求注册拿 Key。
 * 实测（2026-10-19，上海网络）：
 *   api.tavily.com      → 200，2.05s（可用，但要注册）
 *   app.tavily.com      → 307（注册页可达）
 *   api.search.brave.com→ 超时（不可用）
 *   html.duckduckgo.com → 超时（不可用）
 *   lite.duckduckgo.com → 超时（不可用）
 *   searx.be            → 超时（不可用）
 *   www.bing.com/search → **200，0.61s，10 条结果**（跟随跳转后可用）
 *
 * 所以"完全免注册"且在本网络可用的通用检索，现实里只剩 Bing。
 *
 * ## 必须如实说明的局限（不许包装）
 *
 * 这是**非官方接口**：Bing 没有公开的免费搜索 API，这里解析的是搜索结果页 HTML。
 * 因此：
 *   ① 标记可能随 Bing 改版失效——所以解析失败要**明确报错**，不能静默返回零结果
 *   ② 没有稳定性承诺，也不适合高并发（要限速）
 *   ③ 属于 ToS 灰色地带；正式商用前应换成有 Key 的官方通道
 *
 * 定位：**可用的兜底**，优先级低于官方通道。用户配了 Key 就用 Key，没配才走这条。
 *
 * 顺带一个好处：Bing 原生支持 `site:` 算子，而我们的 query 模板本来就会拼
 * `主题 site:gov.cn`，能直接享受"只在权威站里搜"的能力。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";

/** 浏览器 UA（Bing 对无 UA 请求会给空页或验证页） */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 结果块的正则（Bing 用 `<li class="b_algo">`） */
const BLOCK_SPLIT_RE = /<li class="b_algo"/;

/** 标题链接：`<h2 ...><a href="…" ...>标题</a>` */
const H2_LINK_RE = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

/** 摘要 */
const SNIPPET_RE = /<p[^>]*>([\s\S]*?)<\/p>/i;

/** 显示用的来源域名 */
const CITE_RE = /<cite[^>]*>([\s\S]*?)<\/cite>/i;

/** 解码 HTML 实体（够用即可，不引依赖） */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&ensp;": " ",
    "&emsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
    "&hellip;": "…",
  };
  return String(s ?? "")
    .replace(/&[a-z]+;/gi, (m) => named[m.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeChar(parseInt(d, 10)));
}

/** 码点转字符，非法值原样丢弃 */
function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 去标签 */
function stripTags(s: string): string {
  return decodeEntities(String(s ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * 解开 Bing 的跳转包装
 *
 * Bing 常把结果 URL 包成 `https://www.bing.com/ck/a?...&u=a1aHR0cHM6…`，
 * 其中 `u` 参数是「`a1` 前缀 + base64url」。不还原就会把 bing.com 当成来源域名，
 * 权威性判定直接错到离谱（所有结果都变成 bing.com）。
 */
export function unwrapBingUrl(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(s)) return s;
  const m = /[?&]u=([^&]+)/i.exec(s);
  if (!m?.[1]) return s;
  let b64 = decodeURIComponent(m[1]);
  if (b64.startsWith("a1")) b64 = b64.slice(2);
  // base64url → base64
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : s;
  } catch {
    return s;
  }
}

/**
 * 解析 Bing 搜索结果页
 *
 * 纯函数，可在没有网络的情况下单测（用真实页面片段做 fixture）。
 *
 * @param html - 搜索结果页 HTML
 * @returns 命中列表（无结果时返回空数组，由调用方判断是"真没有"还是"被拦"）
 */
export function parseBingHtml(html: string): SearchHit[] {
  const src = String(html ?? "");
  if (src.trim() === "") return [];
  const blocks = src.split(BLOCK_SPLIT_RE).slice(1);
  const out: SearchHit[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    const link = H2_LINK_RE.exec(b);
    if (!link?.[1]) continue;
    const url = unwrapBingUrl(decodeEntities(link[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripTags(link[2] ?? "");
    const snip = SNIPPET_RE.exec(b);
    // 摘要里去掉纯域名那行（Bing 会塞 `<cite>`，已单独抽掉）
    const cite = CITE_RE.exec(b);
    const citeText = cite?.[1] ? stripTags(cite[1]) : "";
    const snippet = snip?.[1] ? stripTags(snip[1]) : "";
    out.push({
      url,
      title,
      snippet: snippet === citeText ? "" : snippet,
    });
  }
  return out;
}

/** 判断返回页是不是"被拦/要验证"（Bing 偶尔给验证页或空壳） */
export function looksBlocked(html: string): boolean {
  const s = String(html ?? "");
  if (s.includes('class="b_algo"')) return false;
  return /(captcha|unusual traffic|验证码|请输入验证码|请稍后再试)/i.test(s);
}

/**
 * 免注册检索（Bing 网页搜索）
 *
 * @param query - 查询串（支持 `site:` 算子）
 * @param budget - 预算（只用超时字段）
 * @param limit - 期望条数（Bing 首页约 10 条，取够即可）
 * @returns 命中列表；失败给 error（不抛错）
 */
export async function searchBing(
  query: string,
  budget: WebBudget,
  limit = 10,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  const q = String(query ?? "").trim();
  if (q === "") return { ok: false, hits: [], error: "查询串为空" };

  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(Math.max(limit, 1), 20)}&setlang=zh-Hans`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) return { ok: false, hits: [], error: `Bing 返回 HTTP ${res.status}` };
    const html = await res.text();
    if (looksBlocked(html)) {
      return { ok: false, hits: [], error: "Bing 返回验证/拦截页（可能需要降低频率或稍后再试）" };
    }
    const hits = parseBingHtml(html).slice(0, limit);
    if (hits.length === 0) {
      // 明确区分"没有结果"与"解析失效"：后者是我们要修的问题，不能当成没搜到
      return { ok: false, hits: [], error: "Bing 返回页面里解析不出结果（可能是改版或空结果）" };
    }
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: `Bing 检索异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
