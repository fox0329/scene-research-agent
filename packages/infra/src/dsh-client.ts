/**
 * @scene/infra — LLM 客户端适配器（直连 OpenAI 兼容 API）
 *
 * 模型配置来源 = 应用自持供应商登记表（provider-store，变更表 #16）：
 * 不再读取 .dsh/settings.yaml，也不假设 DSH 代理存在——用户未配置时
 * 本客户端产出明确的"未配置"错误事件。baseURL 允许指向任意
 * OpenAI 兼容端点（含自建 DSH 代理 /v1，由用户在设置页自行填链接）。
 */

import { randomUUID } from "node:crypto";
import type { DshClient, SessionHandle, FollowEvent, SseEventType } from "@scene/contract";
import { resolveActiveModel, type ResolvedModel } from "./provider-store.js";

// ─── 会话状态（内存 Map，首版实现） ─────────────────────

interface SessionState {
  id: string;
  title: string;
  providerName: string;
  modelId: string;
  abortController: AbortController | null;
}

const sessions = new Map<string, SessionState>();

/**
 * 模型流超时（毫秒）——治的是"页面一直显示分析中"：
 * 供应商卡住不回字节时，fetch/read 会**永远**等下去，进度条就永远转。
 * 空闲超时：这么久没有新字节 → 中止本次生成并报错（可重试）。
 * 连接超时：这么久还没拿到响应头 → 同上。
 * 环境变量可覆盖（自建慢模型可调大）。
 */
const llmIdleTimeoutMs = (): number => Number(process.env["LLM_IDLE_TIMEOUT_MS"] ?? 120_000);
const llmConnectTimeoutMs = (): number => Number(process.env["LLM_CONNECT_TIMEOUT_MS"] ?? 60_000);

/**
 * 单次生成的最大输出预算
 *
 * 不显式给就等于交给供应商默认值：一次生成整步的表格（第 3 步 8 张表 ~50 行）实测
 * 要 1.6–2 万字符，默认上限小的时候会中途截断，截断的 JSON 解析必然失败
 * （实机事故：30 行被清成 0 行）。这里给足预算，并留环境变量给不同供应商/模型调。
 */
const llmMaxTokens = (): number => Number(process.env["LLM_MAX_TOKENS"] ?? 32_768);

/** 模型流空闲超时（区别于用户主动取消：这条要报错，不能静默当成功） */
class LlmTimeoutError extends Error {
  constructor(ms: number, what: string) {
    super(`${what}超时（${Math.round(ms / 1000)} 秒无响应），已中止本步分析，可直接重试`);
    this.name = "LlmTimeoutError";
  }
}

/** 读一块，超时即抛（首字节也走这条，覆盖"连上但不吐字"） */
type StreamChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<StreamChunk> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LlmTimeoutError(idleMs, "模型响应")), idleMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 创建客户端工厂 ──────────────────────────────────────

export interface DshClientOptions {
  /** 供应商名称，不传则使用登记表默认模型 */
  provider?: string;
  /** 模型 ID，不传则使用登记表默认模型 */
  model?: string;
  /** 兼容旧签名：已废弃，不再使用 DSH 代理端口 */
  dshPort?: number;
}

/**
 * 创建 LLM 客户端实例。
 *
 * 直连 OpenAI 兼容 API：每次调用实时解析登记表（改配置即时生效），
 * 用供应商自带的 api_key 鉴权，流式调用 chat/completions。
 */
export function createDshClient(opts: DshClientOptions = {}): DshClient {
  return new DshClientImpl(opts);
}

// ─── 内部实现 ─────────────────────────────────────────────

class DshClientImpl implements DshClient {
  private readonly providerOverride?: string;
  private readonly modelOverride?: string;

  constructor(opts: DshClientOptions = {}) {
    this.providerOverride = opts.provider;
    this.modelOverride = opts.model;
  }

  // ── createSession ──────────────────────────────────────

  async createSession(opts: { title: string; preset?: string }): Promise<SessionHandle> {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      id: sessionId,
      title: opts.title,
      providerName: this.providerOverride ?? "",
      modelId: this.modelOverride ?? "",
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
    /** 连接超时（区别于用户主动取消） */
    let timedOut = false;
    const connectTimeoutMs = llmConnectTimeoutMs();

    try {
      // 实时解析登记表：设置页改动无需重启即生效
      let resolved: ResolvedModel;
      try {
        resolved = resolveActiveModel(
          session.providerName || undefined,
          session.modelId || undefined,
        );
      } catch (err: unknown) {
        yield makeErrorEvent(err instanceof Error ? err.message : String(err));
        return;
      }
      session.providerName = resolved.provider.name;
      session.modelId = resolved.modelId;

      const url = `${resolved.provider.base_url.replace(/\/+$/, "")}/chat/completions`;
      const body = buildRequestBody(
        resolved.modelId,
        input.system,
        input.user,
        input.outputContract,
      );

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.provider.api_key}`,
      };

      /**
       * 连接超时只盖「等到响应头」，**不能盖整个流**
       *
       * 曾经写成 `AbortSignal.timeout()` 直接挂在 fetch 上：那个信号一旦到点会连
       * **响应体读取**一起中止——本步分析一次要跑 1–3 分钟，结果任何超过 60 秒的
       * 分析都在第 60 秒被自己掐死，报「The operation was aborted due to timeout」
       * （用户实机复现：重算第 3 步跑到 62 秒整条断掉）。所以这里用手动定时器，
       * 响应头一到就 clearTimeout 摘掉它；流中卡死由 idle 超时（readWithIdleTimeout）管。
       */
      const connectAbort = new AbortController();
      const connectTimer = setTimeout(() => {
        timedOut = true;
        connectAbort.abort();
      }, connectTimeoutMs);
      let response: Response;
      try {
        response = await fetchWithLlmCheck(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any([abortController.signal, connectAbort.signal]),
        });
      } catch (err: unknown) {
        if (!isToolChoiceRejection(err)) throw err;
        /* 思考型模型：去掉 tool_choice 重试一次。工具仍在，模型通常照样直接调用；
           就算它改成正文输出 JSON，下游解析器本来就同时吃 tool_calls 与正文 JSON。
           真实故障：用户选 deepseek-flash，定义整理 400 → 静默不写表（故障清单 #63）。 */
        const retryBody = buildRequestBody(
          resolved.modelId,
          input.system,
          input.user,
          input.outputContract,
          { withoutToolChoice: true },
        );
        response = await fetchWithLlmCheck(url, {
          method: "POST",
          headers,
          body: JSON.stringify(retryBody),
          signal: AbortSignal.any([abortController.signal, connectAbort.signal]),
        });
      } finally {
        clearTimeout(connectTimer);
      }

      // 流式读取 SSE
      yield* this.consumeStream(response, abortController);
    } catch (err: unknown) {
      // 用户主动取消（cancel）静默收尾；超时中止要报错，否则会被当成"分析完成但没结果"
      if (isAbortError(err)) {
        if (timedOut) {
          yield makeErrorEvent(
            `模型连接超时（${Math.round(connectTimeoutMs / 1000)} 秒无响应），已中止本步分析，可直接重试`,
          );
          return;
        }
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
        const { done, value } = await readWithIdleTimeout(reader, llmIdleTimeoutMs());
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
                // finish_reason 要透出去：`length` = 被输出上限截断，调用方必须按失败处理
                yield { type: "done", finishReason: chunk.choices[0].finish_reason };
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
      if (err instanceof LlmTimeoutError) {
        // 中止底层请求，别让连接挂着；错误事件让 UI 退出"分析中"
        _abortController.abort();
        await reader.cancel().catch(() => undefined);
        yield makeErrorEvent(err.message);
        return;
      }
      if (isAbortError(err)) {
        yield { type: "done" };
        return;
      }
      yield makeErrorEvent(formatError(err));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 超时路径已 cancel，挂起的 read 收尾中——release 失败可忽略 */
      }
    }
  }
}

// ─── 请求体构建 ──────────────────────────────────────────

/**
 * 思考型模型（deepseek-flash / deepseek-reasoner / o1/o3…）不接受强制 `tool_choice`：
 * 报 `Thinking mode does not support this tool_choice`。命中时去掉 tool_choice 重试一次。
 */
function isToolChoiceRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /tool_choice/i.test(msg) && /thinking|does not support/i.test(msg);
}

/**
 * 去掉 tools/tool_choice 的那次重试，模型**看不到 JSON Schema** 了，
 * 会自己发明字段名（实测 deepseek-flash 把正文放进 `value`，导致整表判空）。
 * 所以把结构用文字写进提示词，让它照着输出。
 */
function describeOutputContract(user: string, outputContract: Record<string, unknown>): string {
  return [
    user,
    "",
    "【输出格式（必须遵守）】",
    "不要调用任何工具，直接输出**一个 JSON 对象**（不要代码围栏、不要解释文字）。字段与类型如下：",
    JSON.stringify(outputContract),
  ].join("\n");
}

function buildRequestBody(
  model: string,
  system: string,
  user: string,
  outputContract: Record<string, unknown>,
  opts?: { withoutToolChoice?: boolean },
): Record<string, unknown> {
  // 使用 tool_choice + tools 强制 JSON Schema 输出
  // 这比 response_format 更通用，各 provider 兼容性更好
  const hasSchema = outputContract && Object.keys(outputContract).length > 0;

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: opts?.withoutToolChoice ? describeOutputContract(user, outputContract) : user,
    },
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.3,
    // 本步一次生成整步表格，输出很长：给足上限，避免中途截断
    max_tokens: llmMaxTokens(),
  };

  if (hasSchema && !opts?.withoutToolChoice) {
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
  if (delta.content) return delta.content;
  if (delta.tool_calls?.[0]?.function?.arguments) {
    return delta.tool_calls[0].function.arguments;
  }
  return null;
}

// ─── HTTP 工具 ───────────────────────────────────────────

async function fetchWithLlmCheck(
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

      // 401/403 鉴权失败
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `API 鉴权失败（${statusText}）。请在设置页检查该供应商的 API Key，或用「测试连接」复核`,
        );
      }
      // 404 常为 baseURL 拼接或模型 ID 问题
      if (resp.status === 404) {
        throw new Error(
          `接口或模型不存在（404）：${url}。请检查设置页的链接与模型 ID`,
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
        "无法连接到模型服务。可能原因：\n" +
        "1. 链接填错或服务未启动\n" +
        "2. 网络不可达\n" +
        "3. 可在设置页用「测试连接」定位问题",
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
