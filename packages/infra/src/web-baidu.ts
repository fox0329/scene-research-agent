/**
 * web-baidu — 免注册检索：百度网页搜索
 *
 * 为什么在 Bing 之外再留一条：2026-10-21 实测本机网络下
 * `www.bing.com/search` 对多词中文 query **只按第一个词返回**（搜「城镇污水处理厂
 * 在线监测 资质」回来的是「城镇」百科词条），用它做调研来源等于给用户塞噪声。
 * 百度结果页对同一个 query 能返回相关结果（CCEP 认证、CEMS 监测要求等），
 * 因此把它作为国内网络的默认免注册通道，Bing 降为配置项。
 *
 * ## 必须如实说明的局限
 *
 * ① 解析的是搜索结果页 HTML，非官方接口，改版会失效——解析不出结果要**明确报错**；
 * ② 链接是百度跳转地址（`www.baidu.com/link?url=…`），点开由浏览器二次跳转，
 *    不还原真实域名（还原要逐条请求，慢且更容易被拦）；
 * ③ 结果里有推广位，靠标题/摘要做相关性过滤（见 `apps/server/src/step-research.ts`）。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 结果块：百度用 `<div class="result c-container …">` / `<div class="result-op …">` */
const BLOCK_SPLIT_RE = /class="result(?:-op)?[ "]/;

/** 标题链接：`<h3 …><a href="…" …>标题</a>` */
const H3_LINK_RE = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

/** 摘要（新版是 `c-abstract`，旧版 `c-span-last`） */
const ABSTRACT_RE = /<div[^>]+class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

/** 推广位标记 */
const AD_RE = /广告|data-tuiguang|ec_ad/;

function stripTags(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析百度搜索结果页
 *
 * @param html - 结果页 HTML
 * @returns 命中列表（去掉推广位、去重）
 */
export function parseBaiduHtml(html: string): SearchHit[] {
  const src = String(html ?? "");
  if (src.trim() === "") return [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of src.split(BLOCK_SPLIT_RE).slice(1)) {
    // 推广位只在块头部有标记，别扫整块（正文里出现"广告"字样的正常文章会被误杀）
    if (AD_RE.test(block.slice(0, 1200))) continue;
    const link = H3_LINK_RE.exec(block);
    if (!link?.[1]) continue;
    const url = stripTags(link[1]);
    if (!/^https?:\/\//iu.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const snippet = ABSTRACT_RE.exec(block)?.[1] ?? "";
    out.push({ url, title: stripTags(link[2] ?? ""), snippet: stripTags(snippet) });
  }
  return out;
}

/** 判断返回页是不是被拦（验证码/安全验证） */
export function looksBlockedByBaidu(html: string): boolean {
  const s = String(html ?? "");
  return /(安全验证|请输入验证码|网络不给力|百度安全验证)/u.test(s.slice(0, 4000));
}

/**
 * 免注册检索（百度网页搜索）
 *
 * @param query - 查询串
 * @param budget - 预算（只用超时字段）
 * @param limit - 期望条数
 */
export async function searchBaidu(
  query: string,
  budget: WebBudget,
  limit = 10,
): Promise<{ ok: boolean; hits: SearchHit[]; error?: string }> {
  const q = String(query ?? "").trim();
  if (q === "") return { ok: false, hits: [], error: "查询串为空" };
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${Math.min(Math.max(limit, 1), 20)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(budget.pageTimeoutMs),
    });
    if (!res.ok) return { ok: false, hits: [], error: `百度返回 HTTP ${res.status}` };
    const html = await res.text();
    if (looksBlockedByBaidu(html)) {
      return { ok: false, hits: [], error: "百度返回安全验证页（可能需要降低频率或稍后再试）" };
    }
    const hits = parseBaiduHtml(html).slice(0, limit);
    if (hits.length === 0) return { ok: false, hits: [], error: "百度结果页里解析不出结果（可能改版）" };
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, hits: [], error: `百度检索异常：${e instanceof Error ? e.message : String(e)}` };
  }
}
