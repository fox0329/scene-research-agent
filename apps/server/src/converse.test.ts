/**
 * @scene/server — converse command 测试
 *
 * Mock db + dshClient，测 CRUD 操作 + sendMessage 流式输出。
 * 不实际调用外部服务或数据库。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Conversation,
  Message,
  DshClient,
  FollowEvent,
} from "@scene/contract";
import type { Repo, MessageRepo } from "@scene/infra";

import {
  buildHistoryBlock,
  createConverseCommand,
  HISTORY_MAX_CHARS,
  HISTORY_MAX_MESSAGES,
} from "./converse.js";
import { parseCommandBlock } from "./scenario-commands.js";
import type { ConverseDeps, ConverseDb } from "./converse.js";

// ─── Mock 工厂 ─────────────────────────────────────────────

/** 创建 mock ConversationRepo（内存 Map 存储） */
function createMockConversationRepo(): Repo<Conversation> {
  const store = new Map<string, Conversation>();
  let counter = 0;

  return {
    list: vi.fn((filters?) => {
      let items = [...store.values()];

      // 简单 WHERE 模拟
      if (filters?.where) {
        const where = filters.where;
        const params = filters.params ?? [];

        if (where.includes("scenario_id = ?") && where.includes("status = ?")) {
          const scenarioId = params[0] as string;
          const status = params[1] as string;
          items = items.filter(
            (c) => c.scenario_id === scenarioId && c.status === status,
          );
        } else if (where.includes("scenario_id = ?")) {
          const scenarioId = params[0] as string;
          items = items.filter((c) => c.scenario_id === scenarioId);
        }
      }

      if (filters?.orderBy === "created_at DESC") {
        items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      }

      return items;
    }),

    getById: vi.fn((id: string) => store.get(id)),

    insert: vi.fn((row) => {
      const id = `conv-${++counter}`;
      const now = new Date().toISOString();
      const full: Conversation = {
        ...row,
        id,
        created_at: now,
        updated_at: now,
      };
      store.set(id, full);
      return full;
    }),

    update: vi.fn((id: string, patch) => {
      const existing = store.get(id);
      if (!existing) return undefined;
      const updated: Conversation = {
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      store.set(id, updated);
      return updated;
    }),

    deleteById: vi.fn((id: string) => store.delete(id)),
  };
}

/** 创建 mock MessageRepo（内存 Map 存储） */
function createMockMessageRepo(): MessageRepo {
  const store = new Map<string, Message>();
  let counter = 0;

  return {
    list: vi.fn(() => [...store.values()]),

    listByConversation: vi.fn((conversationId: string) =>
      [...store.values()]
        .filter((m) => m.conversation_id === conversationId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    ),

    insert: vi.fn((row) => {
      const id = `msg-${++counter}`;
      const now = new Date().toISOString();
      const full: Message = {
        ...row,
        id,
        created_at: now,
      };
      store.set(id, full);
      return full;
    }),

    deleteById: vi.fn((id: string) => store.delete(id)),

    deleteByConversation: vi.fn((conversationId: string) => {
      let deleted = 0;
      for (const [id, msg] of store) {
        if (msg.conversation_id === conversationId) {
          store.delete(id);
          deleted++;
        }
      }
      return deleted;
    }),
  };
}

/** 创建 mock DshClient */
function createMockDshClient(
  responseEvents?: FollowEvent[],
): DshClient {
  const events = responseEvents ?? [
    { type: "text", text: "这是 AI 的回复。" },
    { type: "done" },
  ];

  return {
    createSession: vi.fn(async () => ({ sessionId: "dsh-session-1" })),
    prompt: vi.fn(async function* (): AsyncGenerator<FollowEvent> {
      for (const e of events) {
        yield e;
      }
    }),
    cancel: vi.fn(async () => {}),
  };
}

/** 组装完整 ConverseDeps */
function createDeps(
  dshClient?: DshClient,
): { deps: ConverseDeps; db: ConverseDb } {
  const conversationRepo = createMockConversationRepo();
  const messageRepo = createMockMessageRepo();
  // scenarioRepo mock：getById 返回 undefined（无场景上下文，行为同旧）
  const scenarioRepo = {
    getById: vi.fn(() => undefined),
    list: vi.fn(() => []),
    insert: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(() => false),
  };
  const db: ConverseDb = { conversationRepo, messageRepo, scenarioRepo } as unknown as ConverseDb;
  const client = dshClient ?? createMockDshClient();

  return {
    deps: { db, dshClient: client },
    db,
  };
}

// ─── 测试用例 ──────────────────────────────────────────────

describe("parseCommandBlock（#298 容错）", () => {
  const BLOCK =
    '{\"command\":\"写入表格\",\"params\":{\"fills\":[{\"row\":\"器件\",\"column\":\"代表企业\",\"value\":\"欧普照明\"}]}}';

  it("命令块在结尾：照常解析", () => {
    const r = parseCommandBlock("好的。\n\n【执行命令】" + BLOCK);
    expect(r.command?.command).toBe("写入表格");
    expect(r.clean).toBe("好的。");
  });

  it("命令块后还有一句话：也能解析（用户实测事故）", () => {
    const r = parseCommandBlock("好的。\n\n【执行命令】" + BLOCK + "\n以上已按 6 行整理，蓝字可改。");
    expect(r.command?.command).toBe("写入表格");
    expect(r.clean).toContain("好的。");
    expect(r.clean).toContain("以上已按 6 行整理");
    expect(r.clean).not.toContain("执行命令");
  });

  it("value 里带大括号/引号也能配平提取", () => {
    const tricky =
      '{\"command\":\"写入表格\",\"params\":{\"fills\":[{\"row\":\"器件\",\"column\":\"核实说明\",\"value\":\"格式 {a: 1} 与 \\u3010执行命令\\u3011 字样示例\"}]}}';
    const r = parseCommandBlock("【执行命令】" + tricky);
    expect(r.command?.command).toBe("写入表格");
  });
});

describe("createConverseCommand", () => {
  let deps: ConverseDeps;
  let db: ConverseDb;
  let dshClient: DshClient;

  beforeEach(() => {
    const setup = createDeps();
    deps = setup.deps;
    db = setup.db;
    dshClient = setup.deps.dshClient;
  });

  // ── create ────────────────────────────────────────────────

  describe("create", () => {
    it("应创建会话并返回 Conversation", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({
        scenario_id: "s1",
        title: "产品调研",
      });

      expect(conv.id).toBeDefined();
      expect(conv.scenario_id).toBe("s1");
      expect(conv.title).toBe("产品调研");
      expect(conv.status).toBe("活跃");
      expect(conv.dsh_session_id).toBe("dsh-session-1");
      expect(conv.created_at).toBeDefined();
    });

    it("应调用 dshClient.createSession", async () => {
      const cmd = createConverseCommand(deps);
      await cmd.create({ scenario_id: "s1", title: "测试" });

      expect(dshClient.createSession).toHaveBeenCalledWith({
        title: "测试",
      });
    });

    it("应规范化标题（去除首尾空白）", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({
        scenario_id: "s1",
        title: "  有效标题  ",
      });

      expect(conv.title).toBe("有效标题");
    });

    it("标题为空时应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);

      await expect(
        cmd.create({ scenario_id: "s1", title: "" }),
      ).rejects.toThrow("标题校验失败");
    });

    it("标题超过 50 字符时应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);
      const longTitle = "a".repeat(51);

      await expect(
        cmd.create({ scenario_id: "s1", title: longTitle }),
      ).rejects.toThrow("标题校验失败");
    });

    it("标题为纯空白时应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);

      await expect(
        cmd.create({ scenario_id: "s1", title: "   " }),
      ).rejects.toThrow("标题校验失败");
    });
  });

  // ── list ──────────────────────────────────────────────────

  describe("list", () => {
    it("无会话时返回空数组", () => {
      const cmd = createConverseCommand(deps);
      const result = cmd.list("s1");

      expect(result).toEqual([]);
    });

    it("只返回指定 scenario 的活跃会话", async () => {
      const cmd = createConverseCommand(deps);
      await cmd.create({ scenario_id: "s1", title: "会话1" });
      await cmd.create({ scenario_id: "s1", title: "会话2" });
      await cmd.create({ scenario_id: "s2", title: "会话3" });

      const result = cmd.list("s1");
      expect(result).toHaveLength(2);
      for (const conv of result) {
        expect(conv.scenario_id).toBe("s1");
        expect(conv.status).toBe("活跃");
      }
    });

    it("阶段分析内部会话不出现在列表中，但数据还在（变更表 #174）", () => {
      const cmd = createConverseCommand(deps);
      // 历史库里的「阶段 N · 分析」（现在不再新建，但老数据要藏起来）
      deps.db.conversationRepo.insert({
        scenario_id: "s1",
        title: "阶段 1 · 分析",
        status: "活跃",
        dsh_session_id: "sess-1",
        kind: "阶段分析",
      });

      expect(cmd.list("s1")).toHaveLength(0);
      // 数据保留：按 id 仍可查（消息接口照旧可用），只是不列在左侧栏
      const all = deps.db.conversationRepo.list({ where: "scenario_id = ?", params: ["s1"] });
      expect(all).toHaveLength(1);
    });

    it("归档的会话不出现在列表中", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "将归档" });

      cmd.archive(conv.id);

      const result = cmd.list("s1");
      expect(result).toHaveLength(0);
    });
  });

  // ── get ──────────────────────────────────────────────────

  describe("get", () => {
    it("获取存在的会话返回 Conversation", async () => {
      const cmd = createConverseCommand(deps);
      const created = await cmd.create({ scenario_id: "s1", title: "测试" });

      const found = cmd.get(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it("获取不存在的会话返回 undefined", () => {
      const cmd = createConverseCommand(deps);
      expect(cmd.get("nonexistent")).toBeUndefined();
    });
  });

  // ── rename ───────────────────────────────────────────────

  describe("rename", () => {
    it("应更新标题并返回更新后的会话", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "原标题" });

      const renamed = cmd.rename(conv.id, "新标题");

      expect(renamed.title).toBe("新标题");
      expect(renamed.id).toBe(conv.id);
    });

    it("应规范化新标题（去除首尾空白）", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "原标题" });

      const renamed = cmd.rename(conv.id, "  新标题  ");
      expect(renamed.title).toBe("新标题");
    });

    it("新标题为空时应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "原标题" });

      expect(() => cmd.rename(conv.id, "")).toThrow("标题校验失败");
    });

    it("新标题超长时应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "原标题" });

      expect(() => cmd.rename(conv.id, "a".repeat(51))).toThrow(
        "标题校验失败",
      );
    });

    it("会话不存在时应抛出 Error", () => {
      const cmd = createConverseCommand(deps);

      expect(() => cmd.rename("nonexistent", "新标题")).toThrow("不存在");
    });
  });

  // ── archive ──────────────────────────────────────────────

  describe("archive", () => {
    it("活跃会话可归档", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const archived = cmd.archive(conv.id);

      expect(archived.status).toBe("已归档");
    });

    it("已归档会话不可重复归档", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      cmd.archive(conv.id);

      expect(() => cmd.archive(conv.id)).toThrow("不可归档");
    });

    it("会话不存在时应抛出 Error", () => {
      const cmd = createConverseCommand(deps);

      expect(() => cmd.archive("nonexistent")).toThrow("不存在");
    });
  });

  // ── remove ───────────────────────────────────────────────

  describe("remove", () => {
    it("无消息的会话可直接删除", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      // remove 不应抛出
      cmd.remove(conv.id);

      // 确认已删除
      expect(cmd.get(conv.id)).toBeUndefined();
    });

    it("有消息的会话不传 force 应抛出 Error", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      // 手动插入一条消息
      db.messageRepo.insert({
        conversation_id: conv.id,
        role: "用户",
        content: "hello",
      });

      expect(() => cmd.remove(conv.id)).toThrow("force=true");
    });

    it("有消息的会话传 force=true 可删除", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      db.messageRepo.insert({
        conversation_id: conv.id,
        role: "用户",
        content: "hello",
      });

      cmd.remove(conv.id, true);

      expect(cmd.get(conv.id)).toBeUndefined();
    });

    it("会话不存在时应抛出 Error", () => {
      const cmd = createConverseCommand(deps);

      expect(() => cmd.remove("nonexistent")).toThrow("不存在");
    });
  });

  // ── sendMessage ──────────────────────────────────────────

  describe("sendMessage", () => {
    it("应写入用户消息", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "你好")) {
        events.push(e);
      }

      // 用户消息已写入
      const messages = db.messageRepo.listByConversation(conv.id);
      const userMessages = messages.filter((m) => m.role === "用户");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]!.content).toBe("你好");
    });

    it("命令块在流式输出里被拦截，不滚进气泡（#298 用户反馈）", async () => {
      // 模拟逐字流式：把含命令块的整段回复按单字符吐出
      const full = "好的，写进表格。\n\n【执行命令】{\"command\":\"写入表格\",\"params\":{}}\n以上。";
      const charStream = createMockDshClient(
        [...full].flatMap((ch) => [
          { type: "text" as const, text: ch },
          { type: "done" as const },
        ]),
      );
      const local = createDeps(charStream);
      const cmd = createConverseCommand(local.deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "产物" });

      const text: string[] = [];
      for await (const e of cmd.sendMessage(conv.id, "写", {
        allowCommands: false,
        handleCommand: async () => "已写入",
      })) {
        if (e.type === "text") text.push((e as { type: "text"; text: string }).text);
      }
      const visible = text.join("");
      expect(visible).toContain("好的，写进表格。");
      expect(visible).not.toContain("【执行命令】");
      expect(visible).not.toContain("params");
    });

    it("handleCommand 提供时命令块交给调用方（产物会话写入表格，#298）", async () => {
      const client = createMockDshClient([
        {
          type: "text",
          text: "好的，补进表格。\n\n【执行命令】{\"command\":\"写入表格\",\"params\":{\"fills\":[]}}",
        },
        { type: "done" },
      ]);
      const handled: Array<{ command: string; params: Record<string, unknown> }> = [];
      const local = createDeps(client);
      const cmd = createConverseCommand(local.deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "产物" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "补进表格", {
        allowCommands: false,
        handleCommand: async (command) => {
          handled.push(command);
          return "已按建议写入表格 1 处（蓝字提醒）";
        },
      })) {
        events.push(e);
      }

      expect(handled).toHaveLength(1);
      expect(handled[0]!.command).toBe("写入表格");
      const text = events
        .filter((e): e is { type: "text"; text: string } => e.type === "text")
        .map((e) => e.text)
        .join("");
      expect(text).toContain("已按建议写入表格");
      const persisted = local.db.messageRepo
        .listByConversation(conv.id)
        .filter((m) => m.role === "系统");
      expect(persisted[0]!.content).not.toContain("执行命令");
    });

    it("产物会话禁用命令块：不执行、不把命令写进消息", async () => {
      const client = createMockDshClient([
        { type: "text", text: "建议先补一条来源。\n\n【执行命令】{\"command\":\"no_such_command\"}" },
        { type: "done" },
      ]);
      const local = createDeps(client);
      const cmd = createConverseCommand(local.deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "产物" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "改一下", {
        allowCommands: false,
      })) {
        events.push(e);
      }

      const text = events
        .filter((e): e is { type: "text"; text: string } => e.type === "text")
        .map((e) => e.text)
        .join("");
      expect(text).toContain("建议先补一条来源");
      expect(text).not.toContain("正在执行");
      const persisted = local.db.messageRepo
        .listByConversation(conv.id)
        .filter((m) => m.role === "系统");
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.content).toBe("建议先补一条来源。");
    });

    it("应 yield DSH 流式事件（text + done）", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "问题")) {
        events.push(e);
      }

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("text");
      expect((events[0] as { type: "text"; text: string }).text).toBe(
        "这是 AI 的回复。",
      );
      expect(events[1]!.type).toBe("done");
    });

    it("应将 AI 回复写入系统消息", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "问题")) {
        events.push(e);
      }

      const messages = db.messageRepo.listByConversation(conv.id);
      const systemMessages = messages.filter((m) => m.role === "系统");
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]!.content).toBe("这是 AI 的回复。");
    });

    it("应调用 dshClient.prompt 并传入正确的参数", async () => {
      const cmd = createConverseCommand(deps);
      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "问题")) {
        events.push(e);
      }

      expect(dshClient.prompt).toHaveBeenCalledTimes(1);
      const callArgs = (dshClient.prompt as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(callArgs[1].user).toBe("问题");
      expect(callArgs[1].system).toContain("对话助手");
    });

    it("会话不存在时应 yield error 事件", async () => {
      const cmd = createConverseCommand(deps);

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage("nonexistent", "问题")) {
        events.push(e);
      }

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
      expect((events[0] as { type: "error"; message: string }).message).toContain(
        "不存在",
      );
    });

    it("DSH 流中出现 error 事件时不写入系统消息", async () => {
      // 构造发出 error 的 DSH client
      const errorClient = createMockDshClient([
        { type: "text", text: "部分回复" },
        { type: "error", message: "超时" },
      ]);
      const setup = createDeps(errorClient);
      const cmd = createConverseCommand(setup.deps);

      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "问题")) {
        events.push(e);
      }

      expect(events).toHaveLength(2);
      expect(events[1]!.type).toBe("error");

      // 系统消息不应写入（因 error）
      const messages = setup.db.messageRepo.listByConversation(conv.id);
      const systemMessages = messages.filter((m) => m.role === "系统");
      expect(systemMessages).toHaveLength(0);
    });

    it("多 chunk 流式应正确拼接回复", async () => {
      // 模拟分 chunk 发送
      const multiChunkClient = createMockDshClient([
        { type: "text", text: "你好，" },
        { type: "text", text: "我是" },
        { type: "text", text: "AI 助手。" },
        { type: "done" },
      ]);
      const setup = createDeps(multiChunkClient);
      const cmd = createConverseCommand(setup.deps);

      const conv = await cmd.create({ scenario_id: "s1", title: "测试" });

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "你好")) {
        events.push(e);
      }

      // 4 个事件：3 text + 1 done
      expect(events).toHaveLength(4);

      // 系统消息应拼接所有 text
      const messages = setup.db.messageRepo.listByConversation(conv.id);
      const systemMessages = messages.filter((m) => m.role === "系统");
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]!.content).toBe("你好，我是AI 助手。");
    });

    it("DSH createSession 抛出异常时应 yield error 事件", async () => {
      const failingClient: DshClient = {
        createSession: vi.fn(async () => {
          throw new Error("DSH 未启动");
        }),
        prompt: vi.fn(),
        cancel: vi.fn(async () => {}),
      };
      const setup = createDeps(failingClient);
      const cmd = createConverseCommand(setup.deps);

      // 先用一个正常 client 创建会话（需要在 sendMessage 之前有会话存在）
      // 换回 failingClient 来触发 sendMessage 中 createSession 失败
      // 注意：createConversation 在 create 时已用 failingClient，会失败
      // 所以直接手动往 db 里插入一个会话
      setup.db.conversationRepo.insert({
        scenario_id: "s1",
        title: "手动会话",
        status: "活跃",
        dsh_session_id: "existing-dsh-session",
      });
      const convs = setup.db.conversationRepo.list();
      const conv = convs[0]!;

      const events: FollowEvent[] = [];
      for await (const e of cmd.sendMessage(conv.id, "问题")) {
        events.push(e);
      }

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
      expect((events[0] as { type: "error"; message: string }).message).toContain(
        "DSH 会话创建失败",
      );
    });
  });
});
// ─── 对话即导入（消息内文件路径 → 解析入库 → 结果回显） ────

describe("对话即导入", () => {
  it("消息含文件路径：逐个导入并把结果回显 + 附给模型 + 持久化", async () => {
    const setup = createDeps();
    const importFiles = vi.fn(async (paths: string[]) =>
      paths.map((p) => ({
        path: p,
        ok: true,
        rowsInserted: 5,
        tableCounts: { M1: 2, M2: 3 },
        lineName: "产品线A",
      })),
    );
    const cmd = createConverseCommand({ ...setup.deps, importFiles });
    const conv = setup.db.conversationRepo.insert({
      scenario_id: "s1",
      title: "导入会话",
      status: "活跃",
      dsh_session_id: "dsh-1",
    });

    const events: FollowEvent[] = [];
    for await (const e of cmd.sendMessage(conv.id, "请导入 /tmp/a.pdf 和 ~/b.xlsx")) {
      events.push(e);
    }

    // 识别到 2 个路径并逐一导入
    expect(importFiles).toHaveBeenCalledTimes(1);
    expect(importFiles.mock.calls[0]![0]).toEqual(["/tmp/a.pdf", "~/b.xlsx"]);
    // 流式回显：进度 + 导入报告（含每表分布）
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { type: "text"; text: string }).text)
      .join("");
    expect(text).toContain("识别到 2 个文件");
    expect(text).toContain("【材料导入结果】");
    expect(text).toContain("✅ /tmp/a.pdf → 产品线「产品线A」：入库 5 行（M1×2、M2×3）");
    // 模型 prompt 前缀含导入报告（模型感知新资料）
    const client = setup.deps.dshClient as unknown as { prompt: ReturnType<typeof vi.fn> };
    const promptArg = client.prompt.mock.calls[0]![1] as { user: string };
    expect(promptArg.user).toContain("【材料导入结果】");
    // 持久化系统消息含报告
    const persisted = setup.db.messageRepo
      .listByConversation(conv.id)
      .map((m) => m.content)
      .join("\n");
    expect(persisted).toContain("【材料导入结果】");
  });

  it("无路径不触发导入；导入失败在报告中带原因", async () => {
    const setup = createDeps();
    const importFiles = vi.fn(async (paths: string[]) =>
      paths.map((p) => ({ path: p, ok: false, error: "文件不存在，请检查路径" })),
    );
    const cmd = createConverseCommand({ ...setup.deps, importFiles });
    const conv = setup.db.conversationRepo.insert({
      scenario_id: "s1",
      title: "导入会话2",
      status: "活跃",
      dsh_session_id: "dsh-2",
    });

    const plain: FollowEvent[] = [];
    for await (const e of cmd.sendMessage(conv.id, "今天天气不错")) {
      plain.push(e);
    }
    expect(importFiles).not.toHaveBeenCalled();

    const withBadPath: FollowEvent[] = [];
    for await (const e of cmd.sendMessage(conv.id, "导入 /nope/ghost.pdf")) {
      withBadPath.push(e);
    }
    const text = withBadPath
      .filter((e) => e.type === "text")
      .map((e) => (e as { type: "text"; text: string }).text)
      .join("");
    expect(text).toContain("❌ /nope/ghost.pdf：文件不存在，请检查路径");
  });
});

describe("对话上下文（多轮记忆，v1.7 接上）", () => {
  it("buildHistoryBlock：无历史时返回空串（不产生空块）", () => {
    expect(buildHistoryBlock([])).toBe("");
    expect(buildHistoryBlock([{ role: "用户", content: "   " }])).toBe("");
  });

  it("buildHistoryBlock：标注用户/助手角色，保留时间顺序", () => {
    const block = buildHistoryBlock([
      { role: "用户", content: "客户是杭州水务集团" },
      { role: "系统", content: "收到" },
    ]);
    expect(block).toContain("【对话历史】");
    expect(block).toContain("用户：客户是杭州水务集团");
    expect(block).toContain("助手：收到");
    expect(block.indexOf("用户：")).toBeLessThan(block.indexOf("助手："));
  });

  it("buildHistoryBlock：超条数上限时从最早处丢弃并标注省略", () => {
    const many = Array.from({ length: HISTORY_MAX_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 === 0 ? "用户" : "系统",
      content: `第${i}条`,
    }));
    const block = buildHistoryBlock(many);
    expect(block).toContain("（更早的 5 条已省略）");
    // 早先消息不再整条丢弃：被压成摘要后仍以「对话：…」保留关键记忆
    expect(block).toContain("【更早对话摘要】");
    expect(block).toContain("对话：第0条");
    expect(block).toContain(`第${HISTORY_MAX_MESSAGES + 4}条`);
  });

  it("buildHistoryBlock：超字符上限时同样截断", () => {
    const big = "水".repeat(HISTORY_MAX_CHARS);
    const block = buildHistoryBlock([
      { role: "用户", content: big },
      { role: "用户", content: "最近这条要留住" },
    ]);
    expect(block).toContain("最近这条要留住");
    expect(block).toContain("（更早的 1 条已省略）");
  });

  it("第二轮会把上一轮的用户话与助手回复带进 prompt（关键回归）", async () => {
    const client = createMockDshClient();
    const { deps } = createDeps(client);
    const cmd = createConverseCommand(deps);
    const conv = await cmd.create({ scenario_id: "s1", title: "上下文" });

    for await (const _ of cmd.sendMessage(conv.id, "项目代号是「麒麟-7」，客户是杭州水务集团")) {
      /* 消费 */
    }
    for await (const _ of cmd.sendMessage(conv.id, "我刚才说的项目代号和客户是什么？")) {
      /* 消费 */
    }

    const calls = (client.prompt as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    const firstUser = (calls[0]![1] as { user: string }).user;
    const secondUser = (calls[1]![1] as { user: string }).user;

    // 首轮没有历史块；第二轮必须有，且**含上一轮的原话与助手回复**
    expect(firstUser).not.toContain("【对话历史】");
    expect(secondUser).toContain("【对话历史】");
    expect(secondUser).toContain("麒麟-7");
    expect(secondUser).toContain("这是 AI 的回复。");
    // 本轮消息仍在最后（历史不能把它顶掉）
    expect(secondUser.trimEnd().endsWith("我刚才说的项目代号和客户是什么？")).toBe(true);
  });

  it("场景定义对话（override）同样带历史，且保留调用方上下文", async () => {
    const client = createMockDshClient();
    const { deps } = createDeps(client);
    const cmd = createConverseCommand(deps);
    const conv = await cmd.create({ scenario_id: "s1", title: "场景定义" });

    for await (const _ of cmd.sendMessage(conv.id, "客户是市政水务集团")) {
      /* 消费 */
    }
    for await (const _ of cmd.sendMessage(conv.id, "覆盖什么来着？", {
      system: "定义助手",
      contextPrefix: "【表1-1 现状】\n",
    })) {
      /* 消费 */
    }

    const calls = (client.prompt as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const second = calls[1]![1] as { system: string; user: string };
    expect(second.system).toBe("定义助手");
    expect(second.user).toContain("【对话历史】");
    expect(second.user).toContain("市政水务集团");
    expect(second.user).toContain("【表1-1 现状】");
  });

  it("dsh_session_id 回写为**实际使用**的会话（历史实现写的是从未使用的那个）", async () => {
    const client = createMockDshClient();
    const { deps, db } = createDeps(client);
    const cmd = createConverseCommand(deps);
    const conv = await cmd.create({ scenario_id: "s1", title: "写回" });

    for await (const _ of cmd.sendMessage(conv.id, "第一句")) {
      /* 消费 */
    }
    const update = db.conversationRepo.update as unknown as { mock: { calls: unknown[][] } };
    expect(update.mock.calls.some((c) => (c[1] as { dsh_session_id?: string }).dsh_session_id === "dsh-session-1")).toBe(true);
  });
});
