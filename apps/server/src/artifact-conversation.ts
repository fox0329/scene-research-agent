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
import { getAffectedStages } from "@scene/domain";
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
/**
 * #300：写表工具的 function 定义（原生 function calling）。
 * 行用该行第一列的现有值定位，列用界面列名——模型从【产物内容】上下文里直接抄，不用懂内部键。
 */
export const WRITE_TABLE_TOOL = {
  type: "function",
  function: {
    name: "write_table",
    description:
      "修改当前产物的表格：填格（fills）、新增行（add_rows）、删除行（delete_rows）。只在用户明确要求写入/补充/替换/增删时调用；一次最多各 10 处。",
    parameters: {
      type: "object",
      properties: {
        fills: {
          type: "array",
          description: "要写入的单元格列表，一次最多 10 处",
          items: {
            type: "object",
            properties: {
              row: { type: "string", description: "目标行第一列的现有值（照抄上下文【产物内容】里的值）" },
              column: { type: "string", description: "界面列名（如：代表企业、核实说明）" },
              value: { type: "string", description: "要写入的一句话，不超过 200 字" },
            },
            required: ["row", "column", "value"],
          },
        },
        add_rows: {
          type: "array",
          description: "要新增的行，一次最多 10 行；values 用界面列名作键",
          items: {
            type: "object",
            properties: {
              values: {
                type: "object",
                description: "列名 → 值，如 {\"环节\": \"新建环节\", \"代表企业\": \"…\"}",
              },
            },
            required: ["values"],
          },
        },
        delete_rows: {
          type: "array",
          description: "要删除的行，一次最多 10 行；row 用该行第一列的现有值",
          items: {
            type: "object",
            properties: {
              row: { type: "string", description: "该行第一列的现有值" },
            },
            required: ["row"],
          },
        },
      },
    },
  },
} as const;

/** 交付物会话的补充规则（#303）：只优化表达，不改事实 */
export const DELIVERABLE_ARTIFACT_NOTE = `
交付物规则：
- 你面对的是整份《解决方案》。用户要求简化、调整章节、改表达时调用 optimize_solution；
  不要声称自己读过了全文（正文由工具读取），也不要凭空补写内容。
- 用户要求增加新事实 / 新数据 / 新案例时，提示他回对应阶段的表格修改，再由表格重新装配。`;

export const ARTIFACT_SYSTEM_PROMPT = `你是场景通的「产物助手」。用户正在看某个阶段产物，你只围绕这个产物回答。
规则：
1. 先读本轮消息前的【当前产物】【本步阶段总结】【本步调研来源】；回答优先引用其中的表行与 URL。
2. 找不到依据就写「未知」或「当前产物里没有」，不要编造来源、页码或 URL，也不要声称看过未提供的材料。
3. 用户问「为什么 / 依据呢 / 这段怎么改」时，先指出具体行或字段，再给判断；不要泛泛谈方法论。
4. 不输出【执行命令】块，不替用户推进阶段、导出文件或修改表格；需要改表时给建议，由用户自己操作。
5. 回复里不要出现「表1-1」「表5-1」这类内部表号或英文字段名；用业务名（如「门槛与合规」「系统架构」）指代。
6. 输出纯文本：不要用「**」「##」「- 」这类 Markdown 符号；分段直接换行。
7. 保持简洁，中文回答；需要引用来源时用「标题｜URL」或「文件名:页码」。
8. 用户明确让你「补充进表格 / 写入 / 替换」时（或对你要写的提议表示肯定后），
   直接调用 write_table 工具写入；工具调用本身不显示给用户，执行结果会自动回显确认。
   - 一次最多 10 处；单条 value 不超过 200 字；只写当前产物表格里已有的列。
   - 用户要求补充内容/新增一行时用 add_rows（values 用界面列名作键）；明确要求删除某行时用 delete_rows；
     不确定要删哪一行就问，不要猜。
   - row 照抄【产物内容】里该行第一列的值；column 用界面列名；找不到就别调工具，正文里说明。
   - **确认循环禁令**（实测事故）：如果你上一条已经说过「要写就说一声」，用户回复肯定
     （可以/好/写吧/确认/嗯），必须立刻调用 write_table，不许再复述「要我写就说一声」。
   - 没有让你写表时，不要调用工具，也不要输出任何 JSON。`;

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
  /* #308：第 1 步产物就是「场景定义」对话——右栏历史必须和定义弹窗同一条，
     否则新建场景后右栏是空的（用户实测质问「场景定义的历史记录没有显示」）。 */
  if (ref.type === "anchor") {
    const definition = db.conversationRepo
      .list({
        where: "scenario_id = ? AND status = ?",
        params: [scenarioId, SESSION_STATUS_ACTIVE],
      })
      .find((c) => c.title === "场景定义");
    if (definition) return definition;
  }
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
  if (ref.type === "anchor") {
    /* 锚产物首次发送：建的就是「场景定义」会话，定义弹窗之后会复用同一条 */
    return db.conversationRepo.insert({
      scenario_id: scenarioId,
      title: "场景定义",
      status: SESSION_STATUS_ACTIVE,
      dsh_session_id: session.sessionId,
      block: ref.block ?? null,
      purpose: "definition",
      summary: "",
      context_hash: "",
      last_activity_at: null,
    });
  }
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
      "交付物为《解决方案》，由前面各步的步骤总结装配；完整正文不在本次上下文中，不能假装看过全文。" +
        "用户要求简化 / 调整章节 / 改表达时，调用 optimize_solution 工具（服务端会读正文改写，不会新增事实）；" +
        "用户要补事实或改数据时，应回到对应阶段的表格去改。",
    );
    lines.push("");
    lines.push("（交付物正文由优化工具读取，不在此处展开。）");
    lines.push("");
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

  // #304 阶段总结已下线：对话上下文不再注入总结正文（来源在下方，结论由表行承担）

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

/** #298 fill_table 单次写入上限：防止一次回复把整表刷掉 */
const MAX_FILLS_PER_REPLY = 10;
/** #302 单次增/删行上限（与写入同量级，防止模型一口气重建整表） */
const MAX_ROW_OPS_PER_REPLY = 10;
/** 单格写入上限（与中栏「一格一句话」同量级） */
const MAX_FILL_VALUE_CHARS = 200;

export interface FillCommand {
  command: string;
  params: { fills?: unknown; add_rows?: unknown; delete_rows?: unknown };
}

/**
 * 把助手回复里的「写入表格」命令落到当前产物的表。
 *
 * 定位方式对模型友好：行用**该行第一列的现有值**（如「器件」）匹配，列用**界面列名或列键**。
 * 写入不改 source_type（不冒充有来源）；在该行 JSON 的 `__ai_cells` 记下补写列，
 * 前端据此用蓝色字体提醒，用户一编辑该格服务端就摘掉标记。
 */
export async function fillTableFromCommand(
  db: DbInstance,
  scenarioId: string,
  ref: ArtifactRef,
  raw: { command: string; params: Record<string, unknown> },
  hooks?: { onUndo?: (undo: Array<Record<string, unknown>>) => void },
): Promise<string> {
  if (raw.command !== "写入表格" && raw.command !== "write_table") {
    throw new Error(`产物会话只支持「写入表格」，不支持「${raw.command}」`);
  }
  if (ref.type === "deliverable") {
    throw new Error("交付物由前面各步装配，不提供格子写入");
  }
  const fills = Array.isArray(raw.params.fills) ? raw.params.fills : [];
  const addRows = Array.isArray(raw.params.add_rows) ? raw.params.add_rows : [];
  const deleteRows = Array.isArray(raw.params.delete_rows) ? raw.params.delete_rows : [];
  if (fills.length === 0 && addRows.length === 0 && deleteRows.length === 0) {
    throw new Error("没有任何操作：需要 fills / add_rows / delete_rows 之一");
  }
  if (fills.length > MAX_FILLS_PER_REPLY) {
    throw new Error(`一次最多写入 ${MAX_FILLS_PER_REPLY} 处`);
  }
  if (addRows.length > MAX_ROW_OPS_PER_REPLY || deleteRows.length > MAX_ROW_OPS_PER_REPLY) {
    throw new Error(`一次最多增/删 ${MAX_ROW_OPS_PER_REPLY} 行`);
  }

  const table = tableDef(ref.id);
  const rows = db.stageDataRepo.list({
    where: "scenario_id = ? AND table_code = ?",
    params: [scenarioId, ref.id],
    orderBy: "rowid ASC",
  });
  const filtered = ref.block
    ? rows.filter((r) => rowBelongsToBlock(table, ref.block!, r.row))
    : rows;
  const firstCol = table.columns[0]!;
  /* #312：边写边留底，成功后交给调用方记审计、换可撤销句柄 */
  const undo: Array<Record<string, unknown>> = [];
  let applied = 0;
  let added = 0;
  let deleted = 0;
  for (const [index, item] of fills.entries()) {
    const spec = (item ?? {}) as { row?: unknown; column?: unknown; value?: unknown };
    const rowNeedle = String(spec.row ?? "").trim();
    const colNeedle = String(spec.column ?? "").trim();
    const value = String(spec.value ?? "").trim();
    if (!rowNeedle || !colNeedle || !value) {
      throw new Error(`第 ${index + 1} 条缺 row / column / value`);
    }
    if (value.length > MAX_FILL_VALUE_CHARS) {
      throw new Error(`第 ${index + 1} 条超过 ${MAX_FILL_VALUE_CHARS} 字`);
    }
    const col = table.columns.find(
      (c) => c.key === colNeedle || c.label === colNeedle,
    );
    if (!col) throw new Error(`第 ${index + 1} 条：表里没有「${colNeedle}」列`);

    const target = filtered.find((r) =>
      String(r.row[firstCol.key] ?? "").trim() === rowNeedle,
    ) ??
      filtered.find((r) =>
        JSON.stringify(r.row).includes(rowNeedle),
      );
    if (!target) throw new Error(`第 ${index + 1} 条：找不到「${rowNeedle}」行`);

    /* 同一条回复可能写同一行多处：每次都重读最新行，避免第二处把第一处覆盖回去 */
    const fresh = db.stageDataRepo.getById(target.id) ?? target;
    const beforeFill = db.db.prepare("SELECT * FROM stage_data WHERE id = ?").get(target.id) as
      | Record<string, unknown>
      | undefined;
    if (beforeFill) undo.push({ kind: "update", table: "stage_data", id: target.id, before: beforeFill });
    const aiCells = new Set(
      Array.isArray(fresh.row.__ai_cells)
        ? (fresh.row.__ai_cells as unknown[]).map(String)
        : [],
    );
    aiCells.add(col.key);
    db.stageDataRepo.update(target.id, {
      row: { ...fresh.row, [col.key]: value, __ai_cells: [...aiCells] },
    });
    applied += 1;
  }

  /* #302 新增行：模型按「界面列名 → 值」给整行，服务端映射成列键后插入 */
  const stageId = (ref.stage ?? Math.max(0, ref.step - 1)) as 0 | 1 | 2 | 3 | 4 | 5;
  for (const [index, item] of addRows.entries()) {
    const spec = (item ?? {}) as { values?: unknown };
    const values = (spec.values ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    const aiCells: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      const col = table.columns.find((c) => c.key === name || c.label === name);
      if (!col) throw new Error(`新增第 ${index + 1} 行：表里没有「${name}」列`);
      const text = String(value ?? "").trim();
      if (!text) continue;
      if (text.length > MAX_FILL_VALUE_CHARS) {
        throw new Error(`新增第 ${index + 1} 行「${col.label}」超过 ${MAX_FILL_VALUE_CHARS} 字`);
      }
      row[col.key] = text;
      aiCells.push(col.key);
    }
    if (Object.keys(row).length === 0) {
      throw new Error(`新增第 ${index + 1} 行没有任何内容`);
    }
    if (aiCells.length > 0) row.__ai_cells = aiCells;
    const created = db.stageDataRepo.insert({
      scenario_id: scenarioId,
      stage: stageId,
      table_code: ref.id,
      row,
      is_stale: false,
    });
    undo.push({ kind: "delete", table: "stage_data", id: created.id });
    added += 1;
  }

  /* #302 删除行：按第一列值精确匹配，避免模型误删；找不到就报错，不静默跳过 */
  for (const [index, item] of deleteRows.entries()) {
    const spec = (item ?? {}) as { row?: unknown };
    const needle = String(spec.row ?? "").trim();
    if (!needle) throw new Error(`删除第 ${index + 1} 行缺 row`);
    const freshRows = db.stageDataRepo.list({
      where: "scenario_id = ? AND table_code = ?",
      params: [scenarioId, ref.id],
      orderBy: "rowid ASC",
    });
    const target =
      freshRows.find((r) => String(r.row[firstCol.key] ?? "").trim() === needle) ??
      freshRows.find((r) => JSON.stringify(r.row).includes(needle));
    if (!target) throw new Error(`删除第 ${index + 1} 行：找不到「${needle}」`);
    const beforeDelete = db.db.prepare("SELECT * FROM stage_data WHERE id = ?").get(target.id) as
      | Record<string, unknown>
      | undefined;
    if (beforeDelete) undo.push({ kind: "insert", table: "stage_data", row: beforeDelete });
    db.stageDataRepo.deleteById(target.id);
    deleted += 1;
  }

  const downstream = getAffectedStages(ref.id);
  if (downstream.length > 0) {
    db.stageDataRepo.markStale(scenarioId, downstream, true);
  }
  const parts = [`写入 ${applied} 处`];
  if (added > 0) parts.push(`新增 ${added} 行`);
  if (deleted > 0) parts.push(`删除 ${deleted} 行`);
  if (undo.length > 0) hooks?.onUndo?.(undo);
  return `已按建议修改表格：${parts.join("、")}（蓝色字体为助手补写，点击即可修改；改动会像手填一样参与下游重算）。`;
}
