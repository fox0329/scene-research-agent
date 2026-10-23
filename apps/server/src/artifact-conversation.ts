/**
 * @scene/server — 产物唯一会话
 *
 * 产品定调（v2，变更表 #295）：
 *   - 右栏最小单元是「某个阶段的某个产物」；
 *   - 一个产物只有一条会话，不提供会话列表/新建/切换；
 *   - 会话历史完整保留，压缩只发生在模型上下文里。
 *
 * 本模块负责三件事：
 *   1. 产物身份校验与作用域查找（block 不参与唯一性）；
 *   2. 把产物当前内容、本步总结与调研来源组装成模型上下文；
 *   3. 确定性压缩：最近 12 条完整保留 + 更早消息摘要。
 *
 * 这里不重写 agent loop，也不复制消息正文；发送仍走 `converse.ts` 的现有管道。
 */

import { createHash } from "node:crypto";
import {
  FLOW_LAST_STEP,
  flowStep,
  rowBelongsToBlock,
  tableDef,
  tableDisplayName,
  type ArtifactRef,
  type ArtifactScopeType,
  type Conversation,
  type Message,
} from "@scene/contract";
import { normalizeConversationTitle, SESSION_STATUS_ACTIVE } from "@scene/domain";
import type { DbInstance } from "@scene/infra";
import type { DshClient } from "@scene/contract";
import { compactConversationHistory } from "./conversation-compaction.js";

/** 产物会话作用域；与 contract 的 ArtifactRef 同构，便于路由层直接透传 */
export type ArtifactThreadRef = ArtifactRef;

/** 一次会话读取的完整视图（GET /artifacts/thread 的响应体） */
export interface ArtifactThreadState {
  conversation_id: string | null;
  messages: Message[];
  summary: string;
  compacted: boolean;
  /** 最近保留的完整消息条数 */
  kept: number;
  /** 产物在会话创建后是否已变化 */
  stale: boolean;
  artifact: {
    step: number;
    type: ArtifactScopeType;
    id: string;
    title: string;
  };
}

/** 产物会话创建/查找所需的输入 */
export interface ArtifactThreadInput {
  step: number;
  stage: number | null;
  type: ArtifactScopeType;
  id: string;
  block?: string | null;
  title?: string;
}

const ARTIFACT_TYPES: readonly ArtifactScopeType[] = ["anchor", "table", "deliverable"];

/**
 * 产物会话系统提示词
 *
 * 与通用对话的区别：上下文已经由 `buildArtifactContext` 结构化注入，助手只需
 * 围绕当前产物回答；明确禁止它声称看过未提供的材料，也禁止在产物会话里执行
 * 「推进阶段 / 导出」这类会改变全局状态的动作——那些仍由用户在中栏按钮发起。
 */
export const ARTIFACT_SYSTEM_PROMPT = `你是场景通的「产物助手」。用户正在看某个阶段产物，你只围绕这个产物回答。
规则：
1. 先读本轮消息前的【当前产物】【本步阶段总结】【本步调研来源】；回答优先引用其中的表行与 URL。
2. 找不到依据就写「未知」或「当前产物里没有」，不要编造来源、页码或 URL，也不要声称看过未提供的材料。
3. 用户问「为什么 / 依据呢 / 这段怎么改」时，先指出具体行或字段，再给判断；不要泛泛谈方法论。
4. 不输出【执行命令】块，不替用户推进阶段、导出文件或修改表格；需要改表时给建议，由用户自己操作。
5. 回复里不要出现「表1-1」「表5-1」这类内部表号或英文字段名；用业务名（如「门槛与合规」「系统架构」）指代。
6. 输出纯文本：不要用「**」「##」「- 」这类 Markdown 符号；分段直接换行。
7. 保持简洁，中文回答；需要引用来源时用「标题｜URL」或「文件名:页码」。`;

/** 产物类型是否合法 */
export function isArtifactScopeType(value: unknown): value is ArtifactScopeType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/**
 * 规范化并校验产物身份。
 *
 * 只接受流程步里真实存在的产物，避免前端传任意字符串把会话写成孤儿：
 *  - anchor 只能是表1-1；
 *  - table 必须属于该流程步的表集；
 *  - deliverable 只接受 solution。
 *
 * @throws Error 产物不合法
 */
export function normalizeArtifactRef(input: ArtifactThreadInput): ArtifactRef {
  const step = Number(input.step);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`产物步骤不合法：${String(input.step)}`);
  }
  if (step > FLOW_LAST_STEP) {
    throw new Error(`产物步骤超出范围：${step}（共 ${FLOW_LAST_STEP} 步）`);
  }
  const def = flowStep(step);
  if (!isArtifactScopeType(input.type)) {
    throw new Error(`产物类型不合法：${String(input.type)}`);
  }
  const id = String(input.id ?? "").trim();
  if (!id) throw new Error("产物 id 不能为空");

  if (input.type === "anchor" && (step !== 1 || id !== "表1-1")) {
    throw new Error(`场景定义产物只能是第 1 步的表1-1（收到 第 ${step} 步 / ${id}）`);
  }
  if (input.type === "table" && !def.tables.includes(id)) {
    throw new Error(`产物 ${id} 不属于第 ${step} 步「${def.title}」`);
  }
  if (input.type === "deliverable" && (step !== FLOW_LAST_STEP || id !== "solution")) {
    throw new Error(`交付物产物只能是第 ${FLOW_LAST_STEP} 步的 solution（收到 第 ${step} 步 / ${id}）`);
  }

  const fallbackTitle =
    input.type === "deliverable"
      ? "解决方案"
      : input.type === "anchor"
        ? "场景定义与边界"
        : tableDisplayName(id);
  const block = input.block?.trim() || null;

  return {
    step,
    stage: def.stage,
    type: input.type,
    id,
    block,
    // 标题只做展示：统一用契约里的业务名，避免前端传的名字与表定义漂移
    title: fallbackTitle,
  };
}

/** 产物作用域查询条件（block 不参与唯一性） */
function scopeWhere(): string {
  return [
    "scenario_id = ?",
    "kind = '产物会话'",
    "status = ?",
    "step = ?",
    "scope_type = ?",
    "scope_id = ?",
  ].join(" AND ");
}

/**
 * 查找某产物当前的活跃会话。
 *
 * block 不参与唯一性：同一张表的不同子块共用一个讨论上下文。
 */
export function findArtifactConversation(
  db: DbInstance,
  scenarioId: string,
  ref: ArtifactRef,
): Conversation | undefined {
  return db.conversationRepo.list({
    where: scopeWhere(),
    params: [scenarioId, SESSION_STATUS_ACTIVE, ref.step, ref.type, ref.id],
    orderBy: "created_at DESC",
    limit: 1,
  })[0];
}

/**
 * 确保产物会话存在；不存在才创建（打开面板不创建，首次发送才调用）。
 *
 * 标题只是展示用；身份仍是 scope 四元组。若旧会话已存在，顺手更新 block 与
 * 最近活动时间，避免用户切到同一张表的另一个子块后右栏仍显示旧块名。
 */
export async function ensureArtifactConversation(
  db: DbInstance,
  dshClient: DshClient,
  scenarioId: string,
  ref: ArtifactRef,
): Promise<Conversation> {
  const existing = findArtifactConversation(db, scenarioId, ref);
  if (existing) {
    if ((existing.block ?? null) !== ref.block) {
      return db.conversationRepo.update(existing.id, { block: ref.block ?? null }) ?? existing;
    }
    return existing;
  }

  const title = normalizeConversationTitle(`第 ${ref.step} 步 · ${ref.title}`);
  const session = await dshClient.createSession({ title });
  try {
    return db.conversationRepo.insert({
      scenario_id: scenarioId,
      title,
      status: SESSION_STATUS_ACTIVE,
      dsh_session_id: session.sessionId,
      kind: "产物会话",
      scope_type: ref.type,
      scope_id: ref.id,
      step: ref.step,
      block: ref.block ?? null,
      purpose: "assistant",
      summary: "",
      context_hash: "",
      last_activity_at: null,
    });
  } catch (err: unknown) {
    // 两个请求同时打开同一产物：唯一索引兜底，后到者复用先建的那条
    if (!String(err).includes("UNIQUE constraint failed")) throw err;
    const raced = findArtifactConversation(db, scenarioId, ref);
    if (!raced) throw err;
    return raced;
  }
}

/** 读取产物会话；没有会话时返回空历史（不创建） */
export function readArtifactThread(
  db: DbInstance,
  scenarioId: string,
  ref: ArtifactRef,
): ArtifactThreadState {
  const conversation = findArtifactConversation(db, scenarioId, ref);
  const messages = conversation ? db.messageRepo.listByConversation(conversation.id) : [];
  const compaction = compactConversationHistory(messages);
  // 摘要按当前消息重新算，避免「发完这一轮后，最新被省略的一条还没进摘要」
  const summary = compaction.compacted ? compaction.summary : "";
  return {
    conversation_id: conversation?.id ?? null,
    messages,
    summary,
    compacted: compaction.compacted,
    kept: compaction.kept,
    stale: Boolean(
      conversation?.context_hash &&
        conversation.context_hash !== currentArtifactHash(db, scenarioId, ref),
    ),
    artifact: { step: ref.step, type: ref.type, id: ref.id, title: ref.title },
  };
}

/** 更新会话活动时间与产物指纹（发完消息后调用） */
export function touchArtifactConversation(
  db: DbInstance,
  conversationId: string,
  scenarioId: string,
  ref: ArtifactRef,
): void {
  db.conversationRepo.update(conversationId, {
    last_activity_at: new Date().toISOString(),
    context_hash: currentArtifactHash(db, scenarioId, ref),
  });
}

/**
 * 把产物当前内容、阶段总结与调研来源拼成模型上下文。
 *
 * 原则：能结构化给出的不进全文；表格最多 30 行、每格最多 120 字；
 * 总结最多 1200 字；来源最多 12 条。模型需要更多细节时应在对话里继续追问，
 * 而不是每轮把整个项目灌进 prompt。
 */
export function buildArtifactContext(
  db: DbInstance,
  scenarioId: string,
  ref: ArtifactRef,
): string {
  const scenario = db.scenarioRepo.getById(scenarioId);
  const def = flowStep(ref.step);
  const lines: string[] = [];

  lines.push("【当前场景】");
  lines.push(`场景名称：${scenario?.name ?? scenarioId}`);
  if (scenario?.description?.trim()) {
    lines.push(`场景定义（摘要）：${scenario.description.trim().slice(0, 600)}`);
  }
  lines.push("");
  lines.push("【当前产物】");
  lines.push(`流程步：第 ${ref.step} 步「${def.title}」`);
  // 不把内部表号写进上下文：模型会原样抄进回答（G-R9「中栏不露出处/表号」的同一口径）
  lines.push(`产物：${ref.title}`);
  if (ref.block) lines.push(`当前子块：${ref.block}`);
  lines.push("");

  if (ref.type === "deliverable") {
    lines.push("【产物内容】");
    lines.push(
      "交付物为《解决方案》，由前面各步的步骤总结装配；完整正文不在本次上下文中，不能假装看过全文。用户可在中栏打开报告。",
    );
    lines.push("");
    const summary = db.stageSummaryRepo.get(scenarioId, 5);
    if (summary?.content?.trim()) {
      lines.push("【交付物阶段总结节选】");
      lines.push(summary.content.trim().slice(0, 1200));
      lines.push("");
    }
  } else {
    const rows = db.stageDataRepo.list({
      where: "scenario_id = ? AND table_code = ?",
      params: [scenarioId, ref.id],
      orderBy: "rowid ASC",
    });
    const table = tableDef(ref.id);
    const filtered = ref.block
      ? rows.filter((r) => rowBelongsToBlock(table, ref.block!, r.row))
      : rows;
    lines.push("【产物内容】");
    lines.push(`表：${table.name}${ref.block ? ` · ${ref.block}` : ""}；共 ${filtered.length} 行，以下最多展示 30 行。`);
    if (filtered.length === 0) {
      lines.push("（本产物还没有内容）");
    } else {
      for (const [index, item] of filtered.slice(0, 30).entries()) {
        const parts = table.columns
          .map((col) => {
            const value = item.row[col.key];
            if (value === undefined || value === null || String(value).trim() === "") return "";
            return `${col.label}：${String(value).trim().slice(0, 120)}`;
          })
          .filter(Boolean);
        lines.push(`${index + 1}. ${parts.join("；") || "（空行）"}`);
      }
      if (filtered.length > 30) lines.push(`……其余 ${filtered.length - 30} 行未展开`);
    }
    lines.push("");
  }

  const stage = def.stage;
  if (stage !== null) {
    const summary = db.stageSummaryRepo.get(scenarioId, stage);
    if (summary?.content?.trim()) {
      lines.push("【本步阶段总结节选】");
      lines.push(summary.content.trim().slice(0, 1200));
      lines.push("");
    }
  }

  const sources = db.researchRepo
    .listByStep(scenarioId, ref.step)
    .filter((s) => s.status === "有效" && s.url)
    .slice(0, 12);
  if (sources.length > 0) {
    lines.push("【本步调研来源】");
    for (const source of sources) {
      lines.push(`- ${source.title || source.url}｜${source.url}`);
    }
    lines.push("");
  }

  lines.push("回答要求：优先引用上面的产物行与来源；找不到依据就写「未知」，不要编造来源或假装读过未提供的材料。");
  return `${lines.join("\n")}\n\n`;
}

/** 当前产物上下文指纹：产物行内容 + 更新时间；用于显示「产物已更新」 */
export function currentArtifactHash(
  db: DbInstance,
  scenarioId: string,
  ref: ArtifactRef,
): string {
  const hash = createHash("sha256");
  hash.update(`${scenarioId}|${ref.step}|${ref.type}|${ref.id}`);
  if (ref.type === "deliverable") {
    for (const summary of db.stageSummaryRepo.listByScenario(scenarioId)) {
      hash.update(`|${summary.stage}|${summary.updated_at}|${summary.content.length}`);
    }
  } else {
    const rows = db.stageDataRepo.list({
      where: "scenario_id = ? AND table_code = ?",
      params: [scenarioId, ref.id],
      orderBy: "rowid ASC",
    });
    for (const row of rows) {
      hash.update(`|${row.id}|${row.updated_at}|${JSON.stringify(row.row)}`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}
