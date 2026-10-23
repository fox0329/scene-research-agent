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
}

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      note: string;
      operation?: { id: string; summary: string };
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
          yield { type: "text", text: piece };
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
        yield { type: "error", message: String(event["message"] ?? "模型调用失败") };
        return;
      } else if (event.type === "done") {
        yield { type: "done" };
      }
    }

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
        messages.push({ role: "tool", tool_call_id: call.id, content: note });
        yield { type: "tool", name: call.name, note, ...(operation ? { operation } : {}) };
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
