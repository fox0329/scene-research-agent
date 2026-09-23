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

import { createConverseCommand } from "./converse.js";
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
  const db: ConverseDb = { conversationRepo, messageRepo };
  const client = dshClient ?? createMockDshClient();

  return {
    deps: { db, dshClient: client },
    db,
  };
}

// ─── 测试用例 ──────────────────────────────────────────────

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