/**
 * @scene/infra — LLM 客户端测试（provider-store 口径，变更表 #16）
 *
 * 只测本地逻辑，不实际调用 LLM API（需要网络）。
 * 登记表解析路径由 SCENE_PROVIDERS_FILE 指到不存在的文件 = "未配置"态。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshClient, SessionHandle, FollowEvent } from "@scene/contract";
import { createDshClient } from "./dsh-client.js";

let root: string;
const origProvidersFile = process.env.SCENE_PROVIDERS_FILE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scene-providers-"));
  process.env.SCENE_PROVIDERS_FILE = join(root, "providers.local.json"); // 不存在 → 未配置
});

afterEach(() => {
  if (origProvidersFile !== undefined) {
    process.env.SCENE_PROVIDERS_FILE = origProvidersFile;
  } else {
    delete process.env.SCENE_PROVIDERS_FILE;
  }
  rmSync(root, { recursive: true, force: true });
});

function seedRegistry() {
  writeFileSync(
    process.env.SCENE_PROVIDERS_FILE!,
    JSON.stringify({
      providers: [
        {
          name: "testp",
          base_url: "http://127.0.0.1:59999/v1",
          api_key: "sk-test",
          models: [{ id: "m-1" }],
          updated_at: new Date().toISOString(),
        },
      ],
      default_model: { provider: "testp", model: "m-1" },
    }),
  );
}

describe("createDshClient", () => {
  it("应返回实现 DshClient 接口的对象", () => {
    const client = createDshClient();
    expect(typeof client.createSession).toBe("function");
    expect(typeof client.prompt).toBe("function");
    expect(typeof client.cancel).toBe("function");
  });

  it("createSession 应生成唯一 UUID sessionId", async () => {
    const client = createDshClient();
    const h1 = await client.createSession({ title: "测试会话1" });
    const h2 = await client.createSession({ title: "测试会话2" });
    expect(h1.sessionId).not.toBe(h2.sessionId);
    expect(h1.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("prompt 对不存在的会话应返回 error 事件", async () => {
    const client = createDshClient();
    const events: FollowEvent[] = [];
    for await (const e of client.prompt(
      { sessionId: "nonexistent-id" } as SessionHandle,
      { system: "test", user: "test", outputContract: {} },
    )) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0]! as Record<string, unknown>).message).toContain("nonexistent-id");
  });

  it("未配置登记表时 prompt 产出「尚未配置」错误事件（不静默失败）", async () => {
    const client = createDshClient();
    const h = await client.createSession({ title: "无配置" });
    const events: FollowEvent[] = [];
    for await (const e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(String((events[0]! as Record<string, unknown>).message)).toContain("尚未配置");
  });

  it("有登记表但链接不可达：prompt 产出含排查指引的错误事件", async () => {
    seedRegistry();
    const client = createDshClient();
    const h = await client.createSession({ title: "不可达" });
    const events: FollowEvent[] = [];
    for await (const e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
      events.push(e);
    }
    expect(events.at(-1)!.type).toBe("error");
    expect(String((events.at(-1)! as Record<string, unknown>).message)).toMatch(/无法连接到模型服务|设置页/);
  });

  it("模型流中途卡住不再吐字节 → 报超时错误（不静默挂住，用户不会永远看到「分析中」）", async () => {
    seedRegistry();
    process.env["LLM_IDLE_TIMEOUT_MS"] = "80";
    const origFetch = globalThis.fetch;
    const enc = new TextEncoder();
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // 先吐一个字，然后**既不 enqueue 也不 close**：模拟供应商卡死
          controller.enqueue(
            enc.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const client = createDshClient();
      const h = await client.createSession({ title: "卡住" });
      const events: FollowEvent[] = [];
      for await (const e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
        events.push(e);
      }
      expect(events.some((e) => e.type === "text")).toBe(true);
      const last = events.at(-1)!;
      expect(last.type).toBe("error");
      expect(String((last as Record<string, unknown>).message)).toContain("超时");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env["LLM_IDLE_TIMEOUT_MS"];
    }
  });

  /**
   * 回归：连接超时**只能盖住"等到响应头"**，不能盖整条流
   *
   * 曾经把 `AbortSignal.timeout()` 直接挂在 fetch 上——到点连响应体读取一起中止，
   * 于是任何跑过 60 秒的分析都在第 60 秒被自己掐死（用户实机：重算第 3 步到 62 秒
   * 报「The operation was aborted due to timeout」）。这里把连接超时压到 40ms，
   * 再让流慢吞吞吐 200ms 才结束：必须正常收到全文，不许报错。
   */
  it("连接超时不会掐断长流：响应头已到后慢速吐完仍成功", async () => {
    seedRegistry();
    process.env["LLM_CONNECT_TIMEOUT_MS"] = "40";
    const origFetch = globalThis.fetch;
    const enc = new TextEncoder();
    // 桩必须**响应 abort 信号**（真实 fetch 会），否则这个用例连旧 bug 都照不出来
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
          for (const piece of ["长", "流", "没", "被", "掐"]) {
            await new Promise((r) => setTimeout(r, 40));
            controller.enqueue(
              enc.encode(`data: {"choices":[{"delta":{"content":"${piece}"}}]}\n\n`),
            );
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const client = createDshClient();
      const h = await client.createSession({ title: "长流" });
      const events: FollowEvent[] = [];
      for await (const e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
        events.push(e);
      }
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)!.type).toBe("done");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env["LLM_CONNECT_TIMEOUT_MS"];
    }
  });

  it("cancel 对不存在的会话不应抛错", async () => {
    const client = createDshClient();
    await client.cancel({ sessionId: "nonexistent-id" });
  });
});

describe("DshClient 接口实现完整性", () => {
  it("createDshClient 返回值应满足 DshClient 类型约束，prompt 返回 AsyncIterable", () => {
    const client: DshClient = createDshClient();
    expect(client.createSession).toBeInstanceOf(Function);
    const iter = client.prompt({ sessionId: "test" }, { system: "s", user: "u", outputContract: {} });
    expect(iter[Symbol.asyncIterator]).toBeInstanceOf(Function);
  });

  it("createSession 应接受 preset 可选参数", async () => {
    const client = createDshClient();
    const h = await client.createSession({ title: "带 preset", preset: "analysis" });
    expect(h.sessionId).toBeTruthy();
  });

  /**
   * 故障清单 #63：思考型模型（deepseek-flash / deepseek-reasoner / o1…）不接受强制 tool_choice，
   * 报 `Thinking mode does not support this tool_choice` → 整步分析 400。旧实现直接失败，
   * 用户表现为"点了整理成定义、表1-1 一片空白"。
   */
  it("思考型模型拒绝 tool_choice 时：去掉它重试一次，并把输出格式写进提示词", async () => {
    seedRegistry();
    const origFetch = globalThis.fetch;
    const enc = new TextEncoder();
    const seen: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push(body);
      if (body["tool_choice"]) {
        return new Response(
          JSON.stringify({
            error: { message: "Thinking mode does not support this tool_choice" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"已整理"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const client = createDshClient();
      const h = await client.createSession({ title: "思考型模型" });
      const events: FollowEvent[] = [];
      for await (const e of client.prompt(h, {
        system: "s",
        user: "u",
        outputContract: { type: "object", properties: { a: { type: "string" } } },
      })) {
        events.push(e);
      }
      expect(seen).toHaveLength(2); // 重试了一次
      expect(seen[1]!["tool_choice"]).toBeUndefined(); // 第二次不带 tool_choice
      // 模型看不到 Schema 了，必须把结构写进提示词，否则它会自起字段名（正文进 value）
      expect(JSON.stringify(seen[1]!["messages"])).toContain("输出格式（必须遵守）");
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.some((e) => e.type === "text" && e.text === "已整理")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  /**
   * 故障清单 #65：思考模式下模型 91 秒只吐 reasoning_content、正文一个字没出，
   * 连接被网络路径重置（terminated）→ 整张表作废。关掉思考后同样内容 10 秒出完。
   */
  it("默认关闭思考模式；LLM_THINKING=1 才打开", async () => {
    seedRegistry();
    const origFetch = globalThis.fetch;
    const seen: Record<string, unknown>[] = [];
    const enc = new TextEncoder();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const client = createDshClient();
      const h = await client.createSession({ title: "默认关思考" });
      for await (const _e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
        void _e;
      }
      expect(seen[0]!["thinking"]).toEqual({ type: "disabled" });

      process.env["LLM_THINKING"] = "1";
      const h2 = await client.createSession({ title: "打开思考" });
      for await (const _e of client.prompt(h2, { system: "s", user: "u", outputContract: {} })) {
        void _e;
      }
      expect(seen[1]!["thinking"]).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      delete process.env["LLM_THINKING"];
    }
  });

  it("供应商不认 thinking 参数时：丢掉它重试一次并成功", async () => {
    seedRegistry();
    const origFetch = globalThis.fetch;
    const enc = new TextEncoder();
    const seen: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push(body);
      if (body["thinking"]) {
        return new Response(
          JSON.stringify({ error: { message: "Unrecognized request argument supplied: thinking" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"好了"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const client = createDshClient();
      const h = await client.createSession({ title: "不认 thinking" });
      const events: FollowEvent[] = [];
      for await (const e of client.prompt(h, { system: "s", user: "u", outputContract: {} })) {
        events.push(e);
      }
      expect(seen).toHaveLength(2);
      expect(seen[1]!["thinking"]).toBeUndefined();
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.some((e) => e.type === "text" && e.text === "好了")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
