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
  DshClient,
  FollowEvent,
  Scenario,
  SessionHandle,
} from "@scene/contract";
import type { Repo, MessageRepo } from "@scene/infra";
import { parseCommandBlock, executeAppCommand } from "./scenario-commands.js";
import {
  validateSessionTitle,
  canArchive,
  normalizeConversationTitle,
  extractImportablePaths,
  SESSION_STATUS_ACTIVE,
  SESSION_STATUS_ARCHIVED,
} from "@scene/domain";

// ─── 依赖注入接口 ──────────────────────────────────────────

/** converse command 依赖的数据库子集 */
export interface ConverseDb {
  conversationRepo: Repo<Conversation>;
  messageRepo: MessageRepo;
  /** 场景梳理（v1.13）：注入场景上下文 + 解析【场景定义 vN】回写描述 */
  scenarioRepo: Repo<Scenario>;
}

/** 对话即导入：单个文件的导入结果 */
export interface ChatImportOutcome {
  /** 用户消息中的原始路径 */
  path: string;
  ok: boolean;
  /** 成功：入库行数与每表分布 */
  rowsInserted?: number;
  tableCounts?: Record<string, number>;
  /** 成功时的归属产品线名（多产品线时在报告中注明） */
  lineName?: string;
  /** 失败：原因（中文，可直接展示） */
  error?: string;
}

/** converse command 依赖 */
export interface ConverseDeps {
  db: ConverseDb;
  dshClient: DshClient;
  /**
   * 对话即导入钩子：消息里写了本地文件路径时由 routes 注入的编排
   * （解析文件 → DSH 归类 → 写库）。缺省 = 不支持导入，普通对话不受影响。
   */
  importFiles?: (paths: string[]) => Promise<ChatImportOutcome[]>;
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
  const { db, dshClient, importFiles } = deps;

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
     * 流程：写入用户消息 → 消息内路径识别与导入（对话即导入）→
     * 创建 DSH session → 流式获取回复 → 写入系统消息。
     */
    sendMessage: (
      conversationId: string,
      content: string,
      /**
       * 覆盖项（v1.5 场景定义对话复用本管道）：
       * - `system`：替换默认对话系统提示词
       * - `contextPrefix`：追加在用户消息前的场景上下文
       */
      override?: { system?: string; contextPrefix?: string },
    ): AsyncIterable<FollowEvent> =>
      sendMessage(db, dshClient, conversationId, content, importFiles, override),
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

/** DSH 系统 prompt：对话助手 + 业务流手册（v1.6：8 阶段 / 8 流程步 / 无质量关） */
export const CONVERSE_SYSTEM_PROMPT = `你是场景通的对话助手。基于已有的产品资料和场景分析结果回答用户问题。
保持专业、简洁，必要时引用数据来源。

应用与业务流（你必须知道的操作手册）：
- 应用「场景通」：场景落地分析。**8 个阶段（0-7）**：0 材料解析与入库（= 常驻的产品资料库/知识库，不是用户要走的步）→ 1 认识场景（含门槛与合规）→ 2 理解商业 → 3 能力匹配 → 4 方案与实现 → 5 价值与验证 → 6 总结沉淀 → 7 最终交付物。
- 用户界面按**流程逐页推进，共 8 步**（与阶段**数量对齐但编号不等**：第 1、2 步同属阶段 1——第 1 步确认定义与边界，第 2 步做认识场景分析；第 3-8 步依次对应阶段 2-7）：1 场景定义与边界 → 2 认识场景 → 3 理解商业 → 4 能力匹配 → 5 方案与实现 → 6 价值与验证 → 7 总结沉淀 → 8 交付物。
- **「场景定义」对话不计入 8 步**：它是「新建场景」的一部分（新建时自动弹出的对话框）——模型先给理解、再提 ≤3 个场景本体问题，聊清楚后由用户点「整理成定义」落成表1-1；第 1 步页面也能再打开它。
- **场景定义只以表1-1（场景锚）为准**：scenario.description 只是由表1-1 派生的缓存，**不要直接改它**。用户要改定义，请引导他到「场景定义」对话或第 1 步逐项确认/就地编辑表格。
- **本产品不产出判断**：没有"质量关"、没有"建议进/不建议进"，也不替用户拍板；缺口与待确认项只进右栏清单，**不阻断**推进（推进的开关是"数据就绪 + 用户点完成本步"）。
- 你能替用户操作应用：输出命令块执行。
【执行命令】{"command":"advance_stage","params":{"stage":1}}
支持命令：advance_stage（跑指定/当前阶段分析，params.stage 可省）、export_deliverables（导出双口径交付物）、dedupe_products（产品去重）、clarify_scenario（发起场景澄清）。
- 用户下达操作（如「开始下一阶段」「跑一下阶段1」「导出交付物」「去重」）时：先一句话回应确认（含业务流语境，如下一阶段是哪个、干什么），然后单独输出命令块（命令块后不得再有其他内容）。
- 纯聊天/提问/场景梳理时不要输出命令块；用户问业务流程/怎么操作时，按上面的手册讲清并给出可执行的下一步。

场景梳理职责：你可以在对话里帮用户**理清**场景（客户是谁、覆盖什么、明确不含什么），但
**不要输出任何"定义更新块"、也不要声称已改写定义**——定义只以表1-1 为准。用户想定稿时，
告诉他打开「场景定义」对话（聊清楚后点「整理成定义」），或直接在第 1 步的表格里逐项确认/编辑。`;

async function* sendMessage(
  db: ConverseDb,
  dshClient: DshClient,
  conversationId: string,
  content: string,
  importFiles?: (paths: string[]) => Promise<ChatImportOutcome[]>,
  override?: { system?: string; contextPrefix?: string },
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

  // 2.5 对话即导入：消息里的本地文件路径 → 解析入库，
  //     结果随流回显（可见）并附给模型（感知新资料）
  let importReport = "";
  const paths = importFiles ? extractImportablePaths(content) : [];
  if (importFiles && paths.length > 0) {
    yield { type: "text", text: `📎 识别到 ${paths.length} 个文件，开始解析入库…\n` };
    let outcomes: ChatImportOutcome[];
    try {
      outcomes = await importFiles(paths);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `导入失败：${msg}` };
      return;
    }
    const lines = outcomes.map((o) => formatOutcome(o));
    importReport =
      `【材料导入结果】（已解析入库，后续回答请基于这些资料）\n` +
      `${lines.join("\n")}\n\n`;
    yield { type: "text", text: importReport };
  }

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
    // 场景上下文（v1.13）：对话里始终带着当前场景定义，支撑场景梳理闭环
    const scenarioCtx = (() => {
      const sc = db.scenarioRepo.getById(conversation.scenario_id);
      if (!sc) return "";
      return [
        "【当前场景】",
        `场景名称：${sc.name}`,
        `当前阶段：${sc.current_stage}（业务流位置，供「开始下一阶段」等操作定位）`,
        `场景定义（表1-1 派生缓存，仅供参考；定义以表1-1 为准）：${
          sc.description?.trim() || "（尚未整理——引导用户走「场景定义」对话，然后点「整理成定义」）"
        }`,
        "",
      ].join("\n");
    })();
    const stream = dshClient.prompt(session, {
      // v1.5：场景定义对话复用本管道，用覆盖项换掉系统提示词与上下文
      system: override?.system ?? CONVERSE_SYSTEM_PROMPT,
      user: `${override?.contextPrefix ?? ""}${scenarioCtx}${importReport ? importReport : ""}${content}`,
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

  // 3.5 应用命令块（v1.17）：解析【执行命令】→ 执行应用能力，结果随流回显并入消息
  const { clean: replyWithoutCmd, command } = parseCommandBlock(fullReply);
  let commandResult = "";
  if (command) {
    yield {
      type: "text",
      text: `\n\n⏳ 正在执行：${command.command}…\n`,
    };
    try {
      const target = db.scenarioRepo.getById(conversation.scenario_id);
      if (!target) throw new Error(`场景 ${conversation.scenario_id} 不存在`);
      commandResult = `\n\n${await executeAppCommand(db as unknown as import("@scene/infra").DbInstance, dshClient, target, command)}`;
    } catch (err: unknown) {
      commandResult = `\n\n【执行结果】命令执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
    yield { type: "text", text: commandResult };
    fullReply = replyWithoutCmd;
  }

  // 4. 场景定义**不再**由对话直接改写（v1.6 起）
  //
  // 历史实现会解析回复里的【场景定义 vN】块并直接 update scenario.description——
  // 但 description 自信息模型重构后只是**表1-1 的派生缓存**（syncDerivedDescription 会覆盖它），
  // 那条路径等于开了第二个定义来源：写进去会被下次锚行写入悄悄冲掉，且下游读到的"定义"
  // 可能根本不在表1-1 里。定义改由「场景定义」对话 + 用户点「整理成定义」落表1-1 产生。
  const cleanReply = fullReply;

  // 5. 将 AI 回复（含导入报告）写入系统消息（只在有实际内容时写入）
  const persisted = importReport + cleanReply + (commandResult ?? "");
  if (persisted.length > 0 && !hasError) {
    db.messageRepo.insert({
      conversation_id: conversationId,
      role: "系统",
      content: persisted,
    });
  }
}

/** 单个文件导入结果 → 一行人类可读文案 */
function formatOutcome(o: ChatImportOutcome): string {
  if (!o.ok) return `❌ ${o.path}：${o.error ?? "导入失败"}`;
  const counts = Object.entries(o.tableCounts ?? {})
    .map(([t, n]) => `${t}×${n}`)
    .join("、");
  const line = o.lineName ? ` → 产品线「${o.lineName}」` : "";
  return `✅ ${o.path}${line}：入库 ${o.rowsInserted ?? 0} 行${counts ? `（${counts}）` : ""}`;
}