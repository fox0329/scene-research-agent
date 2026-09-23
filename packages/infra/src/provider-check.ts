/**
 * @scene/infra — 供应商链接质量检查与模型列表发现（变更表 #16）
 *
 * 模型列表发现（参考 CC Switch 做法）：按候选端点序列尝试 GET /models，
 * 用户不必懂 /v1 约定——裸域名自动试 /v1/models，已带版本段拼 /models。
 * 命中后返回 discovered 模型 ID 与实际可用的 baseURL（表单可回填修正）。
 *
 * 连接检查两段式：
 * 1. GET 候选 /models —— 链路可达性 + Key 鉴权 + 往返延迟 + 发现模型 ID；
 * 2. 已选模型时 POST {resolved_base}/chat/completions（max_tokens=1，非流式）
 *    —— 验证该模型对这个 Key 真能出字，报生成首包延迟。
 * 只做只读探测，不产生有效输出、不写入业务数据。
 */

import type { ProviderProfile } from "./provider-store.js";

export interface ConnectionCheckResult {
  ok: boolean;
  /** 通过的阶段：models = 仅链路探测；chat = 含模型最小生成 */
  stage: "models" | "chat";
  /** /models 往返延迟（ms） */
  models_latency_ms?: number;
  /** chat 往返延迟（ms） */
  chat_latency_ms?: number;
  /** /models 返回的模型 ID（最多 50 个） */
  models_seen?: string[];
  /** 失败原因（中文，可直接展示） */
  error?: string;
}

/** 模型列表发现结果（设置页「获取模型列表」用） */
export interface ModelsFetchResult {
  ok: boolean;
  /** 发现的模型 ID（排序去重，最多 200 个） */
  models: string[];
  /** 实际命中的 baseURL（候选探测成功的那个，供表单回填修正） */
  resolved_base_url?: string;
  /** /models 往返延迟（ms） */
  latency_ms?: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
/** 发现列表上限：聚合网关可能返回上千条，截断保护 UI */
const MAX_DISCOVERED_MODELS = 200;

/** 校验并规范化用户录入的链接（仅允许 http/https） */
export function normalizeBaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`链接不是合法 URL：${raw || "（空）"}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`链接协议仅支持 http/https：${parsed.protocol}`);
  }
  return url;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return `连接超时（>${PROBE_TIMEOUT_MS / 1000}s）`;
  if (/econnrefused|fetch failed|enotfound|network/i.test(msg.toLowerCase())) {
    return "网络不可达：请检查链接拼写与网络环境";
  }
  return msg;
}

// ─── 模型列表发现（参考 CC Switch 候选端点探测） ───────────

/**
 * 生成 /models 候选 URL 列表。用户不必懂 /v1 约定：
 * 已带版本段（/v1、/v4…）按 OpenAI 惯例拼 /models；
 * 裸域名/无版本段先试 /v1/models，再兜底 /models。
 * 404/405/非 JSON 时按序换下一个候选（见 fetchProviderModels）。
 */
export function modelsUrlCandidates(base: string): string[] {
  const trimmed = base.trim().replace(/\/+$/, "");
  const candidates: string[] = [];
  if (/\/v\d+$/.test(trimmed)) {
    candidates.push(`${trimmed}/models`);
    // 非 /v1 版本段（如智谱 /api/coding/paas/v4）保留 /v1/models 作兜底
    if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
    candidates.push(`${trimmed}/models`);
  }
  return [...new Set(candidates)];
}

/** 解析模型列表响应：OpenAI/Anthropic `{data:[{id}]}` 或智谱 `{models:[{slug}]}`；非 JSON 返回 null */
function parseModelsResponse(raw: string): string[] | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const b = body as { data?: unknown; models?: unknown };
  const ids: string[] = [];
  if (Array.isArray(b.data)) {
    for (const m of b.data) {
      const id = (m as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  if (ids.length === 0 && Array.isArray(b.models)) {
    for (const m of b.models) {
      const e = (m ?? {}) as { slug?: unknown; id?: unknown };
      const id =
        typeof e.slug === "string" && e.slug
          ? e.slug
          : typeof e.id === "string" && e.id
            ? e.id
            : "";
      if (id) ids.push(id);
    }
  }
  return ids.length > 0 ? [...new Set(ids)].slice(0, MAX_DISCOVERED_MODELS) : null;
}

/**
 * 拉取供应商模型列表：按候选端点序列探测，命中即返回模型 ID 与实际
 * 可用的 baseURL。设置页「获取模型列表」按钮的后端。
 */
export async function fetchProviderModels(
  input: { base_url: string; api_key: string },
): Promise<ModelsFetchResult> {
  let base: string;
  try {
    base = normalizeBaseUrl(input.base_url);
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (!input.api_key) {
    return { ok: false, models: [], error: "未填 API Key，无法鉴权" };
  }
  const headers = { authorization: `Bearer ${input.api_key}` };
  let lastError = "";
  for (const url of modelsUrlCandidates(base)) {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(url, { method: "GET", headers });
      const latency = Date.now() - t0;
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          models: [],
          latency_ms: latency,
          error: `鉴权失败（HTTP ${res.status}）：API Key 无效或无权限`,
        };
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}（${url}）`;
        continue;
      }
      const parsed = parseModelsResponse(await res.text());
      if (!parsed) {
        // 200 但不是模型列表 JSON：多为网关回退 HTML 首页，试下一个候选
        lastError = `返回的不是模型列表 JSON（${url}）`;
        continue;
      }
      return {
        ok: true,
        models: parsed.sort(),
        resolved_base_url: url.replace(/\/models$/, ""),
        latency_ms: latency,
      };
    } catch (err) {
      lastError = describeFetchError(err);
    }
  }
  return {
    ok: false,
    models: [],
    error: `所有候选端点均失败（${lastError}）。请检查链接与 Key；若网关未开放模型列表接口，可手填模型 ID`,
  };
}

/** 对单个供应商做连接质量检查 */
export async function checkProviderConnection(
  input: { base_url: string; api_key: string; model?: string },
): Promise<ConnectionCheckResult> {
  let base: string;
  try {
    base = normalizeBaseUrl(input.base_url);
  } catch (err) {
    return { ok: false, stage: "models", error: err instanceof Error ? err.message : String(err) };
  }
  if (!input.api_key) {
    return { ok: false, stage: "models", error: "未填 API Key，无法鉴权检查" };
  }
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${input.api_key}`,
  };

  // 第一段：/models 候选端点探活 + 鉴权 + 延迟（裸域名自动命中 /v1/models）
  let modelsSeen: string[] = [];
  const t0 = Date.now();
  let modelsLatency: number | undefined;
  let lastCandidateError = "";
  try {
    for (const url of modelsUrlCandidates(base)) {
      const res = await fetchWithTimeout(url, { method: "GET", headers });
      modelsLatency = Date.now() - t0;
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          stage: "models",
          models_latency_ms: modelsLatency,
          error: `鉴权失败（HTTP ${res.status}）：API Key 无效或无权限`,
        };
      }
      if (res.status === 404 || res.status === 405) {
        lastCandidateError = `HTTP ${res.status}（${url}）`;
        continue;
      }
      if (!res.ok) {
        return {
          ok: false,
          stage: "models",
          models_latency_ms: modelsLatency,
          error: `链路探测失败（HTTP ${res.status}）：${url}`,
        };
      }
      const parsed = parseModelsResponse(await res.text());
      if (!parsed) {
        lastCandidateError = `返回的不是模型列表 JSON（${url}）`;
        continue;
      }
      modelsSeen = parsed.slice(0, 50);
      // chat 段用实际命中的 base（用户填裸域名时 base 已被补上 /v1）
      base = url.replace(/\/models$/, "");
      break;
    }
    if (modelsSeen.length === 0) {
      // 所有候选均未提供模型列表（404/405/非 JSON）：链路可能仍通，有模型则进第二段
      if (!input.model) {
        return {
          ok: false,
          stage: "models",
          models_latency_ms: modelsLatency,
          error: `链接可达但未提供模型列表（${lastCandidateError}）：请检查链接是否以 /v1 结尾，或手填模型 ID 后重测`,
        };
      }
    } else if (!input.model) {
      return { ok: true, stage: "models", models_latency_ms: modelsLatency, models_seen: modelsSeen };
    }
  } catch (err) {
    return { ok: false, stage: "models", error: describeFetchError(err) };
  }

  // 第二段：对指定模型做一次最小生成（max_tokens=1）
  const t1 = Date.now();
  try {
    const res = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    const chatLatency = Date.now() - t1;
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 160);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        stage: "chat",
        models_latency_ms: modelsLatency,
        chat_latency_ms: chatLatency,
        models_seen: modelsSeen.length ? modelsSeen : undefined,
        error: `模型调用失败（HTTP ${res.status}）：${detail || input.model}`,
      };
    }
    // 验证响应是有效的 JSON（不是 HTML 页面）
    let isValidJson = false;
    try {
      const data = (await res.json()) as Record<string, unknown>;
      // OpenAI 兼容响应应有 choices 数组
      isValidJson = Array.isArray(data.choices);
    } catch {
      // 解析失败：可能是 HTML
    }
    if (!isValidJson) {
      return {
        ok: false,
        stage: "chat",
        chat_latency_ms: chatLatency,
        models_seen: modelsSeen.length ? modelsSeen : undefined,
        error: "模型接口返回的不是 API 响应（可能是网页）。请检查链接是否以 /v1 结尾，例：https://api.example.com/v1",
      };
    }
    return { ok: true, stage: "chat", chat_latency_ms: chatLatency, models_seen: modelsSeen.length ? modelsSeen : undefined };
  } catch (err) {
    return { ok: false, stage: "chat", error: describeFetchError(err) };
  }
}

/** 已存档案的便捷入口（密钥从登记表取，不经前端回传） */
export async function checkSavedProvider(
  provider: ProviderProfile,
  model?: string,
): Promise<ConnectionCheckResult> {
  return checkProviderConnection({
    base_url: provider.base_url,
    api_key: provider.api_key,
    model: model || provider.models[0]?.id,
  });
}
