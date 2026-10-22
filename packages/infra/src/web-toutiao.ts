/**
 * web-toutiao — 免注册检索：头条搜索
 *
 * 为什么还需要它：2026-10-22 连续实测后，百度桌面/移动、搜狗、360 会同时进入
 * 反爬冷却（百度安全验证、搜狗 403、360 反爬页），但 `so.toutiao.com` 仍返回
 * 带结果的 SSR 页面。它作为最后一条兜底通道，不保证长期稳定，因此解析失败要
 * 明确报错，且只接收能还原到真实落地页的结果。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CARD_RE = /<div[^>]+class="result-content[^"]*"[^>]*>/gu;
const PARAMS_RE = /cr-params="([^"]*)"/iu;
const HREF_RE = /<a[^>]+href="([^"]+)"/iu;

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&#x3D;": "=",
  };
  return String(s ?? "")
    .replace(/&[a-z]+;|&#x[0-9a-f]+;|&#\d+;/giu, (m) => {
      const key = m.toLowerCase();
      if (named[key]) return named[key];
      const hex = /^&#x([0-9a-f]+);$/iu.exec(m)?.[1];
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      const dec = /^&#(\d+);$/u.exec(m)?.[1];
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return m;
    });
}

function stripTags(s: string): string {
  let text = decodeEntities(String(s ?? "").replace(/<[^>]*>/gu, ""))
    .replace(/\s+/gu, " ")
    .trim();
  // 头条用 <em> 高亮关键词，去掉标签后会留下「截断 阀室」这种空格
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/gu, "$1");
  }
  return text;
}

/**
 * 还原头条的多层跳转：
 * `/search/jump?...&url=` → `article.zlink.toutiao.com/...&h5_url=` → 真实页面
 */
export function unwrapToutiaoUrl(raw: string): string {
  let s = decodeEntities(raw).trim();
  if (!/^https?:\/\//iu.test(s)) s = `https://so.toutiao.com${s.startsWith("/") ? "" : "/"}${s}`;
  for (let i = 0; i < 3; i += 1) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return "";
    }
    const h5 = u.searchParams.get("h5_url");
    if (h5) {
      s = h5;
      continue;
    }
    const nested = u.searchParams.get("url");
    if (nested) {
      s = nested;
      continue;
    }
    break;
  }
  return /^https?:\/\//iu.test(s) ? s : "";
}

/** 解析头条搜索结果页（SSR 卡片） */
export function parseToutiaoHtml(html: string): SearchHit[] {
  const src = String(html ?? "");
  if (src.trim() === "") return [];
  const starts = [...src.matchAll(CARD_RE)].map((m) => m.index ?? 0);
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i += 1) {
    const block = src.slice(starts[i], starts[i + 1] ?? src.length);
    if (/广告|data-ad|data-tuiguang/iu.test(block.slice(0, 1200))) continue;
    const paramsText = PARAMS_RE.exec(block)?.[1];
    if (!paramsText) continue;
    let title = "";
    let paramsUrl = "";
    try {
      const params = JSON.parse(decodeEntities(paramsText)) as { title?: unknown; url?: unknown };
      title = stripTags(String(params.title ?? ""));
      paramsUrl = String(params.url ?? "");
    } catch {
      continue;
    }
    const href = HREF_RE.exec(block)?.[1] ?? "";
    const url = unwrapToutiaoUrl(paramsUrl || href);
    if (title === "" || url === "" || seen.has(url)) continue;
    if (/^https?:\/\/(?:so|www)\.toutiao\.com\/search/iu.test(url)) continue;
    seen.add(url);
    const snippet = stripTags(block).slice(0, 300);
    out.push({ url, title, snippet });
  }
  return out;
}

export function looksBlockedByToutiao(html: string, finalUrl = ""): boolean {
  const s = String(html ?? "");
  return (
    /请输入验证码|安全验证|访问异常|异常访问/iu.test(s.slice(0, 6000)) ||
    /\/captcha/iu.test(finalUrl)
  );
}

export async function searchToutiao(
  query: string,
  budget: WebBudget,
  limit = 10,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  const q = String(query ?? "").trim();
  if (q === "") return { ok: false, hits: [], error: "查询串为空" };
  const url = `https://so.toutiao.com/search?keyword=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) return { ok: false, hits: [], error: `头条搜索返回 HTTP ${res.status}` };
    const html = await res.text();
    if (looksBlockedByToutiao(html, res.url)) return { ok: false, hits: [], error: "头条搜索返回反爬验证页" };
    const hits = parseToutiaoHtml(html).slice(0, limit);
    return hits.length > 0
      ? { ok: true, hits }
      : { ok: false, hits: [], error: "头条搜索没有解析到结果" };
  } catch (err: unknown) {
    return { ok: false, hits: [], error: `头条搜索请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
