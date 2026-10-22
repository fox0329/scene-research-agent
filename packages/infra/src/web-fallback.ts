/**
 * 免费检索兜底链
 *
 * 单一搜索引擎在真实网络下会被反爬、改版或按地区拦截；一次 query 失败时
 * 换另一家继续查，而不是把「查不到」直接写进右栏。顺序按实测召回质量排：
 * 百度（桌面→移动）→ 搜狗 → 360；显式选 Bing 时 Bing 优先，再走同一条链。
 */

import type { SearchHit, WebBudget } from "./web-fetch-client.js";
import { searchBaidu } from "./web-baidu.js";
import { searchBing } from "./web-bing.js";
import { searchSogou } from "./web-sogou.js";
import { searchSo360 } from "./web-so360.js";
import { searchToutiao } from "./web-toutiao.js";

export type SearchResult = { ok: boolean; hits: SearchHit[]; error?: string };
export type SearchEngineFn = (
  query: string,
  budget: WebBudget,
  limit: number,
) => Promise<SearchResult>;

export interface FallbackDeps {
  baidu?: SearchEngineFn;
  bing?: SearchEngineFn;
  sogou?: SearchEngineFn;
  so360?: SearchEngineFn;
  toutiao?: SearchEngineFn;
}

const LABELS: Record<keyof FallbackDeps, string> = {
  baidu: "百度",
  bing: "Bing",
  sogou: "搜狗",
  so360: "360",
  toutiao: "头条",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按主引擎顺序尝试，直到一条真实命中
 *
 * 只返回 `ok=true` 且 hits 非空的结果；全部失败时把每一家的失败原因拼起来，
 * 右栏能说清「不是没查，是这几家都没返回」。
 */
export async function searchWithFallback(
  primary: "baidu" | "bing",
  query: string,
  budget: WebBudget,
  limit: number,
  deps: FallbackDeps = {},
  accept: (hit: SearchHit) => boolean = () => true,
): Promise<SearchResult & { via?: string }> {
  const order: Array<keyof FallbackDeps> =
    primary === "baidu"
      ? ["baidu", "sogou", "so360", "toutiao"]
      : ["bing", "sogou", "baidu", "so360", "toutiao"];
  const impl: Required<FallbackDeps> = {
    baidu: deps.baidu ?? searchBaidu,
    bing: deps.bing ?? searchBing,
    sogou: deps.sogou ?? searchSogou,
    so360: deps.so360 ?? searchSo360,
    toutiao: deps.toutiao ?? searchToutiao,
  };
  const errors: string[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const key = order[i]!;
    if (i > 0) await sleep(350);
    let r: SearchResult;
    try {
      r = await impl[key](query, budget, limit);
    } catch (e) {
      r = { ok: false, hits: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok && r.hits.some(accept)) return { ...r, via: LABELS[key] };
    errors.push(`${LABELS[key]}：${r.ok ? "结果均不相关" : (r.error ?? "无结果")}`);
  }
  return { ok: false, hits: [], error: errors.join("；") };
}
