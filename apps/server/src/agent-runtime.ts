/**
 * @scene/server — 智能体运行时（变更表 #319，参照 DSH agent-loop）
 *
 * DSH 的运行时是「消息日志 + 步进循环」：每步调用模型，模型可以返回多个
 * tool_calls；执行结果以 tool 消息写回日志，再进入下一步，直到模型不再调用工具。
 * 这里保留同一语义（消息角色、tool_call_id、步数上限、重复调用去重），
 * 但不复制 DSH 的插件/投影体系——场景通只需要会话内工具循环。
 *
 * 与旧实现的关键差别：工具结果不再伪装成 user 文本，而是标准 tool 消息，
 * 模型能准确看到「这个调用返回了什么」，从而自己决定重试、改用别的工具或收口。
 */

import type { AgentMessage, DshClient, SessionHandle } from "@scene/contract";

export interface AgentToolOutcome {
  note: string;
  operation?: { id: string; summary: string };
  /** 缺省 true：工具结果原文直接显示给用户。检索类工具给 false——素材只回给模型，由模型梳理后回答（#346） */
  display?: boolean;
}

/* ─── 正文泄漏过滤（#346）───────────────────────────────────
 * 实测（0.9.5）：模型发起 web_search 时会在正文里复述调用参数
 * （`{"query": "…"}`，可连排多条，或 `` 整段）。提示词压不住
 * （模型行为），且 text 是分片流式下发的、JSON 会被切碎——必须下沉到
 * 确定性层：跨片缓冲 + 模式剥离，匹配到完整泄漏才剥，剥不到照常输出。
 * 兼容层的 guessTextCall（无 tool_calls 时整段即调用）不受影响：它读的
 * 是未过滤的全量累积文本。 */

/** 缓冲尾部保留量：一条 {"query":"…"} 最长约 130 字符（query 已限 80 字），留 200 足够 */
const LEAK_PENDING_CHARS = 200;

export interface ToolLeakFilter {
  /** 返回本片可安全输出的部分（尾部余量留作缓冲） */
  push(piece: string): string;
  /** 流结束：冲刷剩余（未完成的半截 JSON 已不可能补全，按普通文本输出） */
  flush(): string;
}

/** 从 start 起扫描平衡的 JSON 对象（字符串感知），返回结束下标（不含），不完整返回 -1 */
function jsonEndIndex(buf: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i += 1) {
    const ch = buf[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function createToolLeakFilter(): ToolLeakFilter {
  let buf = "";
  const OPEN_TAG = "<tool_call>";
  const CLOSE_TAG = "</tool_call>";
  /** 泄漏正文的开头：web_search 参数 JSON（query 键 / name+arguments 整体）与工具调用标签 */
  const LEAD_RE = /<tool_call>|\{"query"|\{"name"/;

  function strip(from: number): { out: string; keepFrom: number; pending: boolean } {
    let out = "";
    let i = from;
    while (i < buf.length) {
      const rest = buf.slice(i);
      const m = rest.match(LEAD_RE);
      if (!m || m.index === undefined) return { out: out + rest, keepFrom: buf.length, pending: false };
      const start = i + m.index;
      out += rest.slice(0, m.index);
      if (buf.startsWith(OPEN_TAG, start)) {
        const end = buf.indexOf(CLOSE_TAG, start);
        if (end < 0) return { out, keepFrom: start, pending: true };
        i = end + CLOSE_TAG.length;
      } else {
        const end = jsonEndIndex(buf, start);
        if (end < 0) return { out, keepFrom: start, pending: true };
        i = end;
      }
      while (i < buf.length && /\s/.test(buf[i]!)) i += 1;
    }
    return { out, keepFrom: buf.length, pending: false };
  }

  return {
    push(piece: string): string {
      buf += piece;
      const { out, keepFrom, pending } = strip(0);
      if (pending) {
        /* 未完成的泄漏模式：只输出它之前已确认安全的部分，未决部分留缓冲等补全 */
        buf = buf.slice(keepFrom);
        return out;
      }
      /* 无未决模式：out 是全量剥离结果；尾部 200 字符仍可能是被切碎的
         泄漏开头（孤立 `{`、`{"qu`），留在缓冲等下一片拼装判定 */
      const tailStart = Math.max(0, out.length - LEAK_PENDING_CHARS);
      buf = out.slice(tailStart);
      return out.slice(0, tailStart);
    },
    flush(): string {
      const { out, keepFrom, pending } = strip(0);
      const rest = pending ? buf.slice(keepFrom) : "";
      buf = "";
      return out + rest;
    },
  };
}

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      note: string;
      operation?: { id: string; summary: string };
      /** 透传 callTool 的 display 标记（#346）：false = 结果素材不直接显示 */
      display?: boolean;
    }
  | { type: "error"; message: string }
  | { type: "done" };

export interface RunAgentOptions {
  client: DshClient;
  session: SessionHandle;
  system: string;
  user: string;
  tools?: Array<Record<string, unknown>>;
  /** 工具执行器：由各对话入口注入（写表/资料库/交付物优化等） */
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string | AgentToolOutcome>;
  /** 最大步数：防止模型无限调工具（DSH 也有 step 上限） */
  maxSteps?: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 从一条 assistant 文本里识别"模型把工具调用写成了 JSON"（兼容层） */
function guessTextCall(
  text: string,
  tools: Array<Record<string, unknown>>,
): { name: string; args: Record<string, unknown>; raw: string } | null {
  const specs = tools
    .map((def) => {
      const fn = (def as { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }).function;
      if (!fn?.name) return null;
      return { name: fn.name, keys: Object.keys(fn.parameters?.properties ?? {}) };
    })
    .filter((x): x is { name: string; keys: string[] } => x !== null);
  if (specs.length === 0) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
          const hit = specs.find(
            (spec) => spec.keys.length > 0 && spec.keys.some((k) => parsed[k] !== undefined),
          );
          if (hit) return { name: hit.name, args: parsed, raw: text.slice(start, i + 1) };
        } catch {
          /* 不是合法 JSON */
        }
        break;
      }
    }
  }
  return null;
}

/**
 * 跑一轮智能体：模型 ↔ 工具，直到模型不再调用工具或到达步数上限。
 * 工具失败不终止会话：以 tool 消息回写错误，让模型自己决定下一步。
 */
export async function* runAgent(
  opts: RunAgentOptions,
): AsyncGenerator<AgentRuntimeEvent> {
  const hasTools = Boolean(opts.tools?.length);
  const messages: AgentMessage[] = [
    ...(hasTools ? [{ role: "system" as const, content: opts.system }] : []),
    { role: "user", content: opts.user },
  ];
  const seen = new Set<string>();
  const maxSteps = opts.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step += 1) {
    let text = "";
    const calls: ToolCall[] = [];
    /* 每步一个过滤器：正文泄漏只出现在单步流内（#346） */
    const leak = createToolLeakFilter();
    let streamDone = false;
    let streamError: string | null = null;

    for await (const event of opts.client.prompt(
      opts.session,
      hasTools
        ? { system: opts.system, user: "", outputContract: {}, tools: opts.tools, messages }
        : { system: opts.system, user: opts.user, outputContract: {} },
    )) {
      if (event.type === "text") {
        const piece = String((event as { text?: unknown }).text ?? "");
        if (piece) {
          text += piece;
          const safe = leak.push(piece);
          if (safe) yield { type: "text", text: safe };
        }
      } else if (event.type === "tool_call") {
        const raw = (event as { calls?: Array<{ id?: string; name: string; arguments: string }> }).calls ?? [];
        for (const call of raw) {
          calls.push({
            id: String(call.id ?? `call_${step}_${calls.length}`),
            name: call.name,
            arguments: call.arguments,
          });
        }
      } else if (event.type === "error") {
        streamError = String(event["message"] ?? "模型调用失败");
        break;
      } else if (event.type === "done") {
        streamDone = true;
      }
    }

    /* 步流结束（含出错）：先冲刷过滤器缓冲再补发 done/error，已收正文不丢 */
    const flushed = leak.flush();
    if (flushed) yield { type: "text", text: flushed };
    if (streamError !== null) {
      yield { type: "error", message: streamError };
      return;
    }
    if (streamDone) yield { type: "done" };

    /* 兼容：模型把工具调用写成 JSON 文本（没有原生 tool_calls） */
    if (calls.length === 0 && opts.tools?.length) {
      const guessed = guessTextCall(text, opts.tools);
      if (guessed) {
        calls.push({
          id: `call_text_${step}_0`,
          name: guessed.name,
          arguments: JSON.stringify(guessed.args),
        });
        text = text.replace(guessed.raw, "").trim();
      }
    }

    if (calls.length === 0) return;

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    let executed = 0;
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `参数不是合法 JSON：${call.arguments}`,
        });
        yield { type: "tool", name: call.name, note: "参数不是合法 JSON，已跳过" };
        continue;
      }
      const signature = `${call.name}:${JSON.stringify(args)}`;
      if (seen.has(signature)) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "重复调用已跳过：同一工具与参数在本轮已执行过。",
        });
        continue;
      }
      seen.add(signature);
      executed += 1;

      try {
        const result = await opts.callTool(call.name, args);
        const note = typeof result === "string" ? result : result.note;
        const operation = typeof result === "string" ? undefined : result.operation;
        const display = typeof result === "string" ? undefined : result.display;
        messages.push({ role: "tool", tool_call_id: call.id, content: note });
        yield {
          type: "tool",
          name: call.name,
          note,
          ...(operation ? { operation } : {}),
          ...(display === undefined ? {} : { display }),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `工具执行失败：${message}`,
        });
        yield { type: "tool", name: call.name, note: `执行失败：${message}` };
      }
    }
    if (executed === 0) return;
  }
}
