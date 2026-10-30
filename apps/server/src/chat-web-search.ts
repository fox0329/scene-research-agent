/**
 * @scene/server — 对话联网检索工具（变更表 #344）
 *
 * 用户定调（2026-10-30）：「所有对话入口都要联网」。四个对话入口
 * （主对话 / 场景定义 / 产物 / 资料助手）共用这一把 web_search 工具。
 *
 * 边界（与既有规则对齐）：
 * - 检索走 web-engine 现成基建（#216），不新增供应商与 Key；
 * - 结果只回给模型（display: false，#346），不落库也不原文显示——
 *   用户看到的是模型消化后的梳理，入库仍走阶段调研（step-research）与写表门禁；
 * - 引擎不可用/检索失败时返回引导话术（改按行业通识并如实说明），绝不假装检索过。
 */

import {
  loadWebSearchConfig,
  resolveEngine,
  searchByEngine,
  type ResolvedEngine,
  type WebSearchConfig,
} from "@scene/infra";
import { currentModelProvider } from "./step-research.js";

/** 对话检索给的预算：小而快（阶段分析是 60 秒长跑，对话里用户在等） */
const CHAT_SEARCH_BUDGET = {
  maxSearches: 2,
  maxFetches: 0,
  pageTimeoutMs: 10_000,
  pageMaxBytes: 512 * 1024,
} as const;

/** 单次检索总上限（毫秒）：超过按失败处理，不让用户干等 */
const CHAT_SEARCH_TIMEOUT_MS = 25_000;

/** 每次最多返回的命中数 */
const CHAT_SEARCH_LIMIT = 5;

/** 摘要截断长度：够了就够，别把上下文撑爆 */
const SNIPPET_MAX_CHARS = 160;

/** web_search 工具定义（OpenAI tools 格式，与 WRITE_TABLE_TOOL 等一致，由 dsh-client 透传） */
export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网检索最新公开信息。当用户的问题在当前资料/产物里没有、又需要最新或外部事实时调用。" +
      "每次传一个中文关键词短语（不要整句、不要多个问题），需要多角度时分多次调用。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索关键词，如「高德地图 服务区 数据 采集」「全国 充电桩 数量 2025」",
        },
      },
      required: ["query"],
    },
  },
} as const;

/** 提取查询词：去空白、截断；空返回 null（模型偶尔传空参，别把空串当查询） */
export function extractChatSearchQuery(args: Record<string, unknown>): string | null {
  const raw = String(args.query ?? "").trim();
  if (!raw) return null;
  return raw.length > 80 ? raw.slice(0, 80) : raw;
}

/** 命中行的统一格式：标题｜URL｜发布时间（有才写）；摘要单独一行，供引用时标注来源 */
export function formatChatSearchHits(
  query: string,
  hits: ReadonlyArray<{ title?: unknown; url?: unknown; snippet?: unknown; publishedAt?: unknown }>,
  via?: string,
): string {
  const head =
    `联网检索结果（查询「${query}」，共 ${hits.length} 条` + (via ? `，来源通道：${via}` : "") + `）：`;
  const lines = hits.map((hit, i) => {
    const title = String(hit.title ?? "").trim() || "（无标题）";
    const url = String(hit.url ?? "").trim();
    const published = String(hit.publishedAt ?? "").trim();
    const snippet = String(hit.snippet ?? "").trim();
    const meta = [title, url, published].filter((part) => part !== "").join("｜");
    const body =
      snippet.length > SNIPPET_MAX_CHARS ? `${snippet.slice(0, SNIPPET_MAX_CHARS)}…` : snippet;
    return `${i + 1}. ${meta}${body ? `\n   ${body}` : ""}`;
  });
  return (
    [head, ...lines].join("\n") +
    "\n使用要求：把以上结果消化后组织回答——先给结论与梳理，需要引用时在句末标「标题｜URL」；" +
    "不要把来源清单原样罗列给用户，不要在正文里输出工具调用的 JSON；" +
    "与材料结论分开，不写进表格；没有覆盖的部分如实说明。"
  );
}

/** 组装当前引擎（与 step-research 同口径：官方 DeepSeek 时补 modelProvider，不覆盖用户配置） */
function resolveChatEngine(): { cfg: WebSearchConfig; engine: ResolvedEngine } {
  const provider = currentModelProvider();
  const cfg = loadWebSearchConfig();
  const engine = resolveEngine(cfg, provider);
  const searchCfg: WebSearchConfig =
    engine.kind === "deepseek-native" && cfg.modelProvider === undefined && provider
      ? { ...cfg, modelProvider: provider }
      : cfg;
  return { cfg: searchCfg, engine };
}

/**
 * 执行一次对话检索：成功给格式化结果；失败给「如实说明 + 引导按行业通识回答」的话术。
 *
 * 返回值直接作为工具回复进对话，所以文案写给模型看：先讲事实，再讲要求。
 * display: false——检索素材只回给模型，由模型消化后回答，不原文显示给用户（#346）。
 */
export async function runChatWebSearch(
  args: Record<string, unknown>,
): Promise<{ note: string; display: false }> {
  const query = extractChatSearchQuery(args);
  if (!query) {
    return {
      note: "web_search 缺少 query 参数：请传一个中文关键词短语再调，或直接说明无法检索。",
      display: false,
    };
  }

  let resolved: ReturnType<typeof resolveChatEngine>;
  try {
    resolved = resolveChatEngine();
  } catch (err) {
    return {
      note: `联网检索初始化失败：${err instanceof Error ? err.message : String(err)}。请如实告知用户当前无法联网，改按行业通识回答并注明无在线来源。`,
      display: false,
    };
  }
  if (!resolved.engine.canSearch) {
    return {
      note: `联网检索当前不可用：${resolved.engine.detail}。请如实告知用户，改按行业通识回答并注明无在线来源。`,
      display: false,
    };
  }

  const run = searchByEngine(
    resolved.engine,
    resolved.cfg,
    query,
    { searches: 0, fetches: 0, lastHit: new Map<string, number>() },
    { ...CHAT_SEARCH_BUDGET },
    CHAT_SEARCH_LIMIT,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CHAT_SEARCH_TIMEOUT_MS);
  });
  const outcome = await Promise.race([run, timeout]);
  if (timer) clearTimeout(timer);

  if (outcome === null) {
    return {
      note: `联网检索超时（${Math.round(CHAT_SEARCH_TIMEOUT_MS / 1000)} 秒）。请如实告知用户，改按行业通识回答并注明无在线来源。`,
      display: false,
    };
  }
  if (!outcome.ok || outcome.hits.length === 0) {
    const reason = outcome.error ?? "没有可用结果";
    return {
      note: `联网检索未取得结果：${reason}。请如实告知用户，改按行业通识回答并注明无在线来源。`,
      display: false,
    };
  }
  return { note: formatChatSearchHits(query, outcome.hits, outcome.via), display: false };
}

/** 对话入口共用的工具挂载：defs 给模型，onCall 做分发（未知名一律拒绝，不猜） */
export function chatWebSearchTools(): {
  defs: Array<Record<string, unknown>>;
  onCall: (name: string, args: Record<string, unknown>) => Promise<string | { note: string }>;
} {
  return {
    defs: [WEB_SEARCH_TOOL],
    onCall: (name, args) =>
      name === "web_search" ? runChatWebSearch(args) : Promise.resolve({ note: `未知工具：${name}` }),
  };
}
