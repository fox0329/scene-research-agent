/**
 * @scene/infra — DSH 客户端适配器（直连 API 方案）
 *
 * 首版实现：③直连 OpenAI 兼容 API。
 * 后续 M2/M3 可升级到 ②vendor workspace 挂载。
 *
 * DSH 未启动时返回有意义的错误信息（不静默失败）。
 */

import { randomUUID } from "node:crypto";
import type { DshClient, SessionHandle, FollowEvent, SseEventType } from "@scene/contract";
import {
  getProviderConfig,
  getApiKey,
  getBaseURL,
  getDshPort,
  getDshToken,
  getDefaultModelConfig,
} from "./dsh-config.js";

// ─── 会话状态（内存 Map，首版实现） ─────────────────────

interface SessionState {
  id: string;
  title: string;
  providerName: string;
  modelId: string;
  abortController: AbortController | null;
}

const sessions = new Map<string, SessionState>();

// ─── 创建客户端工厂 ──────────────────────────────────────

export interface DshClientOptions {
  /** 供应商名称，不传则使用 agent-default-model 配置 */
  provider?: string;
  /** 模型 ID，不传则使用供应商第一个模型 */
  model?: string;
  /** DSH 端口，默认从 DSH_PORT 环境变量或 3081 */
  dshPort?: number;
}

/**
 * 创建 DSH 客户端实例。
 *
 * 直连 OpenAI 兼容 API：从 .dsh/settings.yaml 读取 provider 配置，
 * 用 apiKeyEnv 对应的环境变量作鉴权，流式调用 chat/completions。
 */
export function createDshClient(opts: DshClientOptions = {}): DshClient {
  return new DshClientImpl(opts);
}

// ─── 内部实现 ─────────────────────────────────────────────

const DEFAULT_PROVIDER = "talkweb";
const DEFAULT_MODEL = "deepseek-v4-pro";

class DshClientImpl implements DshClient {
  private readonly providerName: string;
  private readonly modelId: string;
  private readonly dshPort: number;

  constructor(opts: DshClientOptions) {
    this.dshPort = opts.dshPort ?? getDshPort();

    // 确定供应商
    if (opts.provider) {
      this.providerName = opts.provider;
    } else {
      try {
        const def = getDefaultModelConfig();
        this.providerName = def.provider;
      } catch {
        this.providerName = DEFAULT_PROVIDER;
      }
    }

    // 确定模型
    if (opts.model) {
      this.modelId = opts.model;
    } else {
      try {
        const def = getDefaultModelConfig();
        if (def.provider === this.providerName) {
          this.modelId = def.model;
        } else {
          const cfg = getProviderConfig(this.providerName);
          const firstModel = cfg.models[0];
          if (!firstModel) {
            throw new Error(`供应商 "${this.providerName}" 未配置任何模型`);
          }
          this.modelId = firstModel.id;
        }
      } catch {
        this.modelId = DEFAULT_MODEL;
      }
    }
  }

  // ── createSession ──────────────────────────────────────

  async createSession(opts: { title: string; preset?: string }): Promise<SessionHandle> {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      id: sessionId,
      title: opts.title,
      providerName: this.providerName,
      modelId: this.modelId,
      abortController: null,
    });
    return { sessionId };
  }

  // ── prompt ─────────────────────────────────────────────

  async *prompt(
    h: SessionHandle,
    input: {
      system: string;
      user: string;
      outputContract: Record<string, unknown>;
    },
  ): AsyncIterable<FollowEvent> {
    const session = sessions.get(h.sessionId);
    if (!session) {
      yield makeErrorEvent(`会话 ${h.sessionId} 不存在，请先调用 createSession`);
      return;
    }

    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const apiKey = getApiKey(session.providerName);
      const baseURL = getBaseURL(session.providerName, this.dshPort);

      const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
      const body = buildRequestBody(
        session.modelId,
        input.system,
        input.user,
        input.outputContract,
      );

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      // DSH Token 鉴权（可选）
      const dshToken = getDshToken();
      if (dshToken) {
        headers["X-DSH-Token"] = dshToken;
      }

      const response = await fetchWithDshCheck(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      // 流式读取 SSE
      yield* this.consumeStream(response, abortController);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        yield { type: "done" };
        return;
      }
      yield makeErrorEvent(formatError(err));
    } finally {
      session.abortController = null;
    }
  }

  // ── cancel ─────────────────────────────────────────────

  async cancel(h: SessionHandle): Promise<void> {
    const session = sessions.get(h.sessionId);
    if (!session) return;
    session.abortController?.abort();
    session.abortController = null;
  }

  // ── SSE 流消费 ─────────────────────────────────────────

  private async *consumeStream(
    response: Response,
    _abortController: AbortController,
  ): AsyncIterable<FollowEvent> {
    const body = response.body;
    if (!body) {
      yield makeErrorEvent("响应体为空");
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed === "data: [DONE]") {
            yield { type: "done" };
            return;
          }

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr) as OpenAIChunk;
              const content = extractContent(chunk);
              if (content) {
                yield { type: "text", text: content };
              }
              if (chunk.choices?.[0]?.finish_reason) {
                yield { type: "done" };
                return;
              }
            } catch {
              // 跳过解析失败的 chunk，不中断流
            }
          }
        }
      }

      // 流结束但没收到 [DONE]
      yield { type: "done" };
    } catch (err: unknown) {
      if (isAbortError(err)) {
        yield { type: "done" };
        return;
      }
      yield makeErrorEvent(formatError(err));
    } finally {
      reader.releaseLock();
    }
  }
}

// ─── 请求体构建 ──────────────────────────────────────────

function buildRequestBody(
  model: string,
  system: string,
  user: string,
  outputContract: Record<string, unknown>,
): Record<string, unknown> {
  // 使用 tool_choice + tools 强制 JSON Schema 输出
  // 这比 response_format 更通用，各 provider 兼容性更好
  const hasSchema = outputContract && Object.keys(outputContract).length > 0;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.3,
  };

  if (hasSchema) {
    body.tools = [
      {
        type: "function",
        function: {
          name: "submit_result",
          description: "提交结构化分析结果",
          parameters: outputContract,
        },
      },
    ];
    body.tool_choice = {
      type: "function",
      function: { name: "submit_result" },
    };
  }

  return body;
}

// ─── 流式响应解析 ────────────────────────────────────────

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

function extractContent(chunk: OpenAIChunk): string | null {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return null;

  // 普通文本内容
  if (delta.content) return delta.content;

  // tool_calls 流式参数拼接
  if (delta.tool_calls?.[0]?.function?.arguments) {
    return delta.tool_calls[0].function.arguments;
  }

  return null;
}

// ─── HTTP 工具 ───────────────────────────────────────────

async function fetchWithDshCheck(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const resp = await fetch(url, init);

    if (!resp.ok) {
      const statusText = resp.statusText || `HTTP ${resp.status}`;
      let detail = "";
      try {
        detail = await resp.text();
      } catch {
        // 忽略读取错误
      }

      // 502/503 通常是 DSH 未启动
      if (resp.status === 502 || resp.status === 503) {
        throw new Error(
          `DSH 服务未就绪（${statusText}）。` +
          "请确认 DSH 已启动：npm run dsh:start",
        );
      }

      // 401/403 鉴权失败
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `API 鉴权失败（${statusText}）。` +
          "请检查对应环境变量中的 API Key 是否正确。",
        );
      }

      throw new Error(
        `API 请求失败：${statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      );
    }

    return resp;
  } catch (err: unknown) {
    if (isFetchConnectionError(err)) {
      throw new Error(
        "无法连接到 LLM API。可能原因：\n" +
        "1. DSH 未启动（运行 npm run dsh:start）\n" +
        "2. 网络不可达\n" +
        "3. 供应商 baseURL 配置错误",
      );
    }
    throw err;
  }
}

// ─── 错误处理工具 ────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

function isFetchConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("networkerror") ||
    msg.includes("failed to fetch")
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function makeErrorEvent(message: string): FollowEvent {
  return { type: "error" as SseEventType, message };
}