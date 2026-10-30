/**
 * agent-runtime 测试：正文泄漏过滤（#346）与工具结果 display 透传。
 *
 * 泄漏实测形态（0.9.5 真机）：模型发起 web_search 时在正文里复述参数
 * `{"query": "…"}`（可连排多条）、`` 整段，且 text 分片到达、JSON 会被切碎。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createToolLeakFilter,
  runAgent,
  type AgentRuntimeEvent,
} from "./agent-runtime.js";
import type { DshClient, SessionHandle } from "@scene/contract";

type FakeEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; calls: Array<{ id?: string; name: string; arguments: string }> }
  | { type: "done" };

const session = {} as SessionHandle;

function fakeClient(steps: FakeEvent[][]): DshClient {
  let step = 0;
  return {
    prompt: vi.fn(async function* () {
      for (const ev of steps[Math.min(step, steps.length - 1)] ?? []) yield ev;
      step += 1;
    }),
    cancel: vi.fn(async () => {}),
  } as unknown as DshClient;
}

async function collect(gen: AsyncGenerator<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const WEB_SEARCH_DEF = [
  {
    type: "function",
    function: {
      name: "web_search",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
];

describe("createToolLeakFilter", () => {
  it("剥除连排的 {\"query\":…} 泄漏，保留正常文本", () => {
    const f = createToolLeakFilter();
    const out =
      f.push('好的。{"query": "高德地图 服务区 数据 采集 来源"}{"query": "高德地图 高速服务区 合作"}') +
      f.flush();
    expect(out).toBe("好的。");
  });

  it("跨片切碎的 JSON 也被剥（流式逐字到达）", () => {
    const f = createToolLeakFilter();
    const pieces = ['正在检索 {"que', 'ry": "高德 服务区"} 完', "成"];
    let out = "";
    for (const p of pieces) out += f.push(p);
    out += f.flush();
    expect(out).toBe("正在检索 完成");
  });

  it("剥除  工具调用标签", () => {
    const f = createToolLeakFilter();
    const out = f.push('结果如下') + f.flush();
    expect(out).toBe("结果如下");
  });

  it("剥除 {\"name\":…,\"arguments\":…} 形态", () => {
    const f = createToolLeakFilter();
    const out =
      f.push('先查 {"name":"web_search","arguments":{"query":"服务区"}} 再答') + f.flush();
    expect(out).toBe("先查 再答");
  });

  it("正常长文本分片推进，内容不丢", () => {
    const f = createToolLeakFilter();
    const long = "这是一段很长的正常回答内容。".repeat(40);
    let out = "";
    for (let i = 0; i < long.length; i += 40) out += f.push(long.slice(i, i + 40));
    out += f.flush();
    expect(out).toBe(long);
  });

  it("正文里与泄漏无关的花括号不被误删", () => {
    const f = createToolLeakFilter();
    const out = f.push("命令块是 {\"command\":\"advance_stage\"} 这样。") + f.flush();
    expect(out).toContain('"command"');
  });

  it("流结束时未闭合的半截 JSON 按原文输出", () => {
    const f = createToolLeakFilter();
    const out = f.push('正文 {"query": "没闭合') + f.flush();
    expect(out).toBe('正文 {"query": "没闭合');
  });
});

describe("runAgent 泄漏过滤与 display 透传", () => {
  it("正文里的参数 JSON 不进 text 事件，工具照常执行", async () => {
    const client = fakeClient([
      [
        { type: "text", text: '查一下 {"query": "高德 服务区"}' },
        { type: "tool_call", calls: [{ id: "c1", name: "web_search", arguments: '{"query":"高德 服务区"}' }] },
        { type: "done" },
      ],
      [{ type: "text", text: "梳理后的回答。" }, { type: "done" }],
    ]);
    const callTool = vi.fn(async () => ({ note: "检索结果素材", display: false as const }));
    const events = await collect(
      runAgent({
        client,
        session,
        system: "s",
        user: "问",
        tools: WEB_SEARCH_DEF,
        callTool,
      }),
    );
    const texts = events.filter((ev) => ev.type === "text").map((ev) => (ev as { text: string }).text);
    expect(texts.join("")).not.toContain('"query"');
    expect(texts.join("")).toContain("梳理后的回答");
    expect(callTool).toHaveBeenCalledWith("web_search", { query: "高德 服务区" });
  });

  it("display:false 透传到 tool 事件；缺省时不带 display 字段", async () => {
    const client = fakeClient([
      [
        { type: "tool_call", calls: [{ id: "c1", name: "web_search", arguments: '{"query":"q"}' }] },
        { type: "tool_call", calls: [{ id: "c2", name: "write_table", arguments: "{}" }] },
        { type: "done" },
      ],
      [{ type: "done" }],
    ]);
    const callTool = vi.fn(async (_name: string) =>
      _name === "web_search" ? { note: "素材", display: false as const } : "已写入",
    );
    const events = await collect(
      runAgent({ client, session, system: "s", user: "问", tools: WEB_SEARCH_DEF, callTool }),
    );
    const toolEvents = events.filter((ev) => ev.type === "tool") as Array<{
      name: string;
      display?: boolean;
    }>;
    expect(toolEvents.find((ev) => ev.name === "web_search")?.display).toBe(false);
    expect(toolEvents.find((ev) => ev.name === "write_table")?.display).toBeUndefined();
  });
});
