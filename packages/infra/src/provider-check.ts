/**
 * @scene/infra — 供应商链接质量检查（变更表 #16）
 *
 * 两段式：
 * 1. GET {base_url}/models —— 链路可达性 + Key 鉴权 + 往返延迟；
 *    并顺带发现该 Key 实际可用的模型 ID 列表（部分网关比登记表宽松/严格）。
 * 2. 已选模型时 POST {base_url}/chat/completions（max_tokens=1，非流式）
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

const PROBE_TIMEOUT_MS = 10_000;

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

  // 第一段：/models 探活 + 鉴权 + 延迟
  let modelsSeen: string[] = [];
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(`${base}/models`, { method: "GET", headers });
    const latency = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, stage: "models", models_latency_ms: latency, error: `鉴权失败（HTTP ${res.status}）：API Key 无效或无权限` };
    }
    // 部分兼容网关不提供 /models（404）：链路本身是通的，有模型就继续第二段
    const listUnsupported = res.status === 404;
    if (!res.ok && !listUnsupported) {
      return { ok: false, stage: "models", models_latency_ms: latency, error: `链路探测失败（HTTP ${res.status}）：${base}/models` };
    }
    if (listUnsupported) {
      if (!input.model) {
        return {
          ok: false,
          stage: "models",
          models_latency_ms: latency,
          error: "链接可达（/models 未提供），但该网关无模型列表：请选择模型后重测",
        };
      }
      // 链路通但无列表，进入第二段验证
    } else {
      try {
        const data = (await res.json()) as { data?: { id?: string }[] };
        modelsSeen = (data.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 50);
      } catch {
        // 个别网关 /models 返回非 JSON；能 200 即算链路+鉴权通过
      }
      if (!input.model) {
        return { ok: true, stage: "models", models_latency_ms: latency, models_seen: modelsSeen };
      }
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
        models_latency_ms: undefined,
        chat_latency_ms: chatLatency,
        models_seen: modelsSeen.length ? modelsSeen : undefined,
        error: `模型调用失败（HTTP ${res.status}）：${detail || input.model}`,
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
