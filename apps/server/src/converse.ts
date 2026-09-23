/**
 * @scene/server — converse command（会话管理 + 消息 SSE 流式）
 *
 * 应用层编排：infra(db / dshClient) + domain(session 纯函数)
 * 提供 CRUD 操作（create / list / rename / archive / remove）和 sendMessage 流式输出。
 *
 * 每个 conversation 对应一个 DSH session（1:1 映射）。
 */

import type {
  Conversation,
  Message,
  DshClient,
  FollowEvent,
  SessionHandle,
} from "@scene/contract";
import type { Repo, MessageRepo } from "@scene/infra";
import {
  validateSessionTitle,
  canArchive,
  canDelete,
  normalizeConversationTitle,
  SESSION_STATUS_ACTIVE,
  SESSION_STATUS_ARCHIVED,
} from "@scene/domain";

// ─── 依赖注入接口 ──────────────────────────────────────────

/** converse command 依赖的数据库子集 */
export interface ConverseDb {
  conversationRepo: Repo<Conversation>;
  messageRepo: MessageRepo;
}

/** converse command 依赖 */
export interface ConverseDeps {
  db: ConverseDb;
  dshClient: DshClient;
}

// ─── 创建请求 ──────────────────────────────────────────────

/** 会话创建请求 */
export interface CreateConversationRequest {
  scenario_id: string;
  title: string;
}

// ─── 工厂函数 ──────────────────────────────────────────────

/**
 * 创建 converse command。
 *
 * @param deps - 注入的依赖（db 子集 / dshClient）
 * @returns 包含 CRUD + sendMessage 方法的 command 对象
 */
export function createConverseCommand(deps: ConverseDeps) {
  const { db, dshClient } = deps;

  return {
    /**
     * 创建新会话：校验标题 → 创建 DSH session → 写入 DB。
     *
     * @throws 标题校验失败时抛出 Error
     */
    create: (req: CreateConversationRequest): Promise<Conversation> =>
      createConversation(db, dshClient, req),

    /**
     * 列出会话（默认活跃状态，按创建时间倒序）。
     */
    list: (scenarioId: string): Conversation[] =>
      listConversations(db, scenarioId),

    /**
     * 获取单个会话。
     */
    get: (conversationId: string): Conversation | undefined =>
      getConversation(db, conversationId),

    /**
     * 重命名会话：校验新标题 → 更新 DB。
     *
     * @throws 会话不存在或标题校验失败时抛出 Error
     */
    rename: (conversationId: string, newTitle: string): Conversation =>
      renameConversation(db, conversationId, newTitle),

    /**
     * 归档会话：校验状态 → 更新为「已归档」。
     *
     * @throws 会话不存在或状态不允许归档时抛出 Error
     */
    archive: (conversationId: string): Conversation =>
      archiveConversation(db, conversationId),

    /**
     * 删除会话：无消息直接删，有消息需 force=true。
     *
     * @throws 会话不存在、有消息且未 force 时抛出 Error
     */
    remove: (conversationId: string, force?: boolean): void =>
      removeConversation(db, dshClient, conversationId, force),

    /**
     * 发送消息并流式获取 DSH 回复。
     * 返回 AsyncIterable<FollowEvent>，yield text/done/error 事件。
     *
     * 流程：写入用户消息 → 创建 DSH session → 流式获取回复 → 写入系统消息。
     */
    sendMessage: (
      conversationId: string,
      content: string,
    ): AsyncIterable<FollowEvent> =>
      sendMessage(db, dshClient, conversationId, content),
  };
}

// ─── CRUD 实现 ─────────────────────────────────────────────

async function createConversation(
  db: ConverseDb,
  dshClient: DshClient,
  req: CreateConversationRequest,
): Promise<Conversation> {
  // 先校验原始标题（normalize 会截断，掩盖超长问题）
  if (!validateSessionTitle(req.title)) {
    throw new Error(
      `会话标题校验失败：标题非空且不超过 50 字符（收到 "${req.title}"）`,
    );
  }

  const normalized = normalizeConversationTitle(req.title);

  // 创建 DSH session（1:1 映射）
  const session: SessionHandle = await dshClient.createSession({
    title: normalized,
  });

  const conversation = db.conversationRepo.insert({
    scenario_id: req.scenario_id,
    title: normalized,
    status: SESSION_STATUS_ACTIVE,
    dsh_session_id: session.sessionId,
  });

  return conversation;
}

function listConversations(
  db: ConverseDb,
  scenarioId: string,
): Conversation[] {
  return db.conversationRepo.list({
    where: "scenario_id = ? AND status = ?",
    params: [scenarioId, SESSION_STATUS_ACTIVE],
    orderBy: "created_at DESC",
  });
}

function getConversation(
  db: ConverseDb,
  conversationId: string,
): Conversation | undefined {
  return db.conversationRepo.getById(conversationId);
}

function renameConversation(
  db: ConverseDb,
  conversationId: string,
  newTitle: string,
): Conversation {
  const existing = db.conversationRepo.getById(conversationId);
  if (!existing) {
    throw new Error(`会话 ${conversationId} 不存在`);
  }

  // 先校验原始标题（normalize 会截断，掩盖超长问题）
  if (!validateSessionTitle(newTitle)) {
    throw new Error(
      `会话标题校验失败：标题非空且不超过 50 字符（收到 "${newTitle}"）`,
    );
  }

  const normalized = normalizeConversationTitle(newTitle);

  const updated = db.conversationRepo.update(conversationId, {
    title: normalized,
  });

  return updated!;
}

function archiveConversation(
  db: ConverseDb,
  conversationId: string,
): Conversation {
  const existing = db.conversationRepo.getById(conversationId);
  if (!existing) {
    throw new Error(`会话 ${conversationId} 不存在`);
  }

  if (!canArchive(existing.status)) {
    throw new Error(
      `会话 ${conversationId} 状态为「${existing.status}」，不可归档`,
    );
  }

  const updated = db.conversationRepo.update(conversationId, {
    status: SESSION_STATUS_ARCHIVED,
  });

  return updated!;
}

function removeConversation(
  db: ConverseDb,
  _dshClient: DshClient,
  conversationId: string,
  force = false,
): void {
  const existing = db.conversationRepo.getById(conversationId);
  if (!existing) {
    throw new Error(`会话 ${conversationId} 不存在`);
  }

  const messages = db.messageRepo.listByConversation(conversationId);
  const hasMessages = messages.length > 0;

  if (hasMessages && !force) {
    throw new Error(
      `会话 ${conversationId} 已有 ${messages.length} 条消息，需 force=true 才能删除`,
    );
  }

  // 先删消息，再删会话（外键约束）
  if (hasMessages) {
    db.messageRepo.deleteByConversation(conversationId);
  }

  db.conversationRepo.deleteById(conversationId);
}

// ─── sendMessage 流式实现 ──────────────────────────────────

/** DSH 系统 prompt：对话助手 */
const CONVERSE_SYSTEM_PROMPT = `你是场景通的对话助手。基于已有的产品资料和场景分析结果回答用户问题。
保持专业、简洁，必要时引用数据来源。`;

async function* sendMessage(
  db: ConverseDb,
  dshClient: DshClient,
  conversationId: string,
  content: string,
): AsyncIterable<FollowEvent> {
  // 1. 校验会话存在且活跃
  const conversation = db.conversationRepo.getById(conversationId);
  if (!conversation) {
    yield { type: "error", message: `会话 ${conversationId} 不存在` };
    return;
  }

  // 2. 写入用户消息
  db.messageRepo.insert({
    conversation_id: conversationId,
    role: "用户",
    content,
  });

  // 3. 创建 DSH session 并流式获取回复
  let session: SessionHandle;
  try {
    session = await dshClient.createSession({
      title: conversation.title,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: `DSH 会话创建失败：${msg}` };
    return;
  }

  let fullReply = "";
  let hasError = false;

  try {
    const stream = dshClient.prompt(session, {
      system: CONVERSE_SYSTEM_PROMPT,
      user: content,
      outputContract: {},
    });

    for await (const event of stream) {
      yield event;

      // 拼接回复文本（用于持久化）
      if (event.type === "text") {
        fullReply += (event as { type: "text"; text: string }).text;
      }
      if (event.type === "error") {
        hasError = true;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: `DSH 流式调用失败：${msg}` };
    hasError = true;
  }

  // 4. 将 AI 回复写入系统消息（只在有实际内容时写入）
  if (fullReply.length > 0 && !hasError) {
    db.messageRepo.insert({
      conversation_id: conversationId,
      role: "系统",
      content: fullReply,
    });
  }
}