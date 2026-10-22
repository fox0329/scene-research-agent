/**
 * web-so360 — 免注册检索：360 网页搜索
 *
 * 作为百度/搜狗都被反爬拦截时的最后一条免注册通道；链接优先取 `data-mdurl`
 *（真实落地页），没有时才用 360 跳转链接。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCK_RE = /<li[^>]+class="[^"]*res-list[^"]*"[^>]*>/gu;
const TITLE_RE = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu;
const DESC_RE = /<p[^>]+class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/iu;
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

/** 解析 360 结果页 */
export function parseSo360Html(html: string): SearchHit[] {
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
    const mdUrl = /data-mdurl="([^"]+)"/iu.exec(block)?.[1] ?? "";
    const url = stripTags(mdUrl) || stripTags(link[1]);
    if (!/^https?:\/\//iu.test(url)) continue;
    // 360 的 AI 问答卡不是原始来源，跳过；真实页面优先用 data-mdurl
    if (/^https?:\/\/(?:ai|wenda)\.so\.com/iu.test(url) && mdUrl === "") continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = stripTags(link[2] ?? "");
    if (title === "") continue;
    out.push({ url, title, snippet: stripTags(DESC_RE.exec(block)?.[1] ?? "") });
  }
  return out;
}

export function looksBlockedBySo360(html: string, finalUrl = ""): boolean {
  const s = String(html ?? "");
  return (
    /antispider|请输入验证码|访问异常|异常访问|安全验证/iu.test(s.slice(0, 6000)) ||
    /\/antispider/iu.test(finalUrl)
  );
}

export async function searchSo360(
  query: string,
  budget: WebBudget,
  limit = 10,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  const q = String(query ?? "").trim();
  if (q === "") return { ok: false, hits: [], error: "查询串为空" };
  const url = `https://www.so.com/s?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) return { ok: false, hits: [], error: `360 返回 HTTP ${res.status}` };
    const html = await res.text();
    if (looksBlockedBySo360(html, res.url)) {
      return { ok: false, hits: [], error: "360 返回反爬验证页" };
    }
    const hits = parseSo360Html(html).slice(0, limit);
    if (hits.length === 0) return { ok: false, hits: [], error: "360 结果页里解析不出结果（可能改版）" };
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: `360 检索异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
