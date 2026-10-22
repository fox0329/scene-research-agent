/**
 * web-sogou — 免注册检索：搜狗网页搜索
 *
 * 为什么还要留一条：2026-10-22 实测本机网络下，百度桌面版被重定向到安全验证页，
 * 移动版对部分 query 也会拦截；搜狗对同一组「管网阀室」query 仍返回
 * 天然气管网阀室安全管理规定、输气管道阀室技术规定等有效结果。
 *
 * 局限与百度相同：解析结果页 HTML，非官方接口；链接可能是 `/link?url=` 跳转，
 * 优先使用结果块里的 `data-url` 真实地址。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCK_RE = /<div[^>]+class="[^"]*vrwrap[^"]*"[^>]*>/gu;
const TITLE_RE = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu;
const SUGGEST_RE = /<p[^>]+class="[^"]*(?:star-wiki|text-lightgray|str_info|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/p>/giu;
const AD_RE = /广告|data-tuiguang|data-ad|ec_ad/iu;

function stripTags(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/\s+/gu, " ")
    .trim();
}

function absoluteUrl(raw: string): string {
  const u = stripTags(raw);
  if (/^https?:\/\//iu.test(u)) return u;
  if (u.startsWith("/")) return `https://www.sogou.com${u}`;
  return "";
}

/** 解析搜狗结果页 */
export function parseSogouHtml(html: string): SearchHit[] {
  const src = String(html ?? "");
  if (src.trim() === "") return [];
  const starts = [...src.matchAll(BLOCK_RE)].map((m) => m.index ?? 0);
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i += 1) {
    const block = src.slice(starts[i], starts[i + 1] ?? src.length);
    if (AD_RE.test(block.slice(0, 1200))) continue;
    const link = TITLE_RE.exec(block);
    if (!link?.[1]) continue;
    // 优先取结果块自己的真实地址；`/link?url=` 只在没有真实地址时兜底
    const dataUrl = /data-url="([^"]+)"/iu.exec(block)?.[1] ?? "";
    const url = absoluteUrl(dataUrl) || absoluteUrl(link[1]);
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    const snippets = [...block.matchAll(SUGGEST_RE)]
      .map((m) => stripTags(m[1] ?? ""))
      .filter((s) => s.length >= 8);
    const snippet = snippets.sort((a, b) => b.length - a.length)[0] ?? "";
    const title = stripTags(link[2] ?? "");
    if (title === "") continue;
    out.push({ url, title, snippet });
  }
  return out;
}

export function looksBlockedBySogou(html: string, finalUrl = ""): boolean {
  const s = String(html ?? "");
  return (
    /antispider|请输入验证码|访问过于频繁|异常访问|安全验证/iu.test(s.slice(0, 6000)) ||
    /\/antispider/iu.test(finalUrl)
  );
}

export async function searchSogou(
  query: string,
  budget: WebBudget,
  limit = 10,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  const q = String(query ?? "").trim();
  if (q === "") return { ok: false, hits: [], error: "查询串为空" };
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) return { ok: false, hits: [], error: `搜狗返回 HTTP ${res.status}` };
    const html = await res.text();
    if (looksBlockedBySogou(html, res.url)) {
      return { ok: false, hits: [], error: "搜狗返回反爬验证页" };
    }
    const hits = parseSogouHtml(html).slice(0, limit);
    if (hits.length === 0) return { ok: false, hits: [], error: "搜狗结果页里解析不出结果（可能改版）" };
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: `搜狗检索异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
