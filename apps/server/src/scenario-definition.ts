/**
 * @scene/server — 场景定义（对话式）
 *
 * 用户定调："场景定义不该让用户一项一项填空——难度大、不友好，不是智能体该有的模式"。
 * 因此流程第 1 步改为**对话**：
 *   只输场景名 → 弹出「场景定义」对话页 → 模型先给理解 + 提 ≤3 个场景本体问题
 *   → 用户对话回答 → **用户点「整理成定义」** → 把对话整理成表1-1 场景锚
 *
 * 三条硬规则：
 *  1. **只在用户点「整理成定义」时才写表**（不自动增量改用户的表）
 *  2. 整理时**保留用户已确认的行**（用户的决定优先）
 *  3. 模型只能标 `用户补充`（转述用户原话）或 `AI推断`（猜的）——
 *     **`用户确认` 永远只能由用户动作产生**
 */

import {
  TABLES_BY_CODE,
  type AnchorRow,
  type DshClient,
  type Scenario,
  type SessionHandle,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  anchorConfirmRows,
  anchorFixedRows,
  mergeAnchorRows,
  type InfoRow,
} from "@scene/domain";
import { readAnchorRows, readBrief, upsertBrief, writeAnchorRows, syncDerivedDescription } from "./scenario-anchor.js";

const ANCHOR = "表1-1";

/**
 * 场景定义对话的系统提示词
 *
 * 关键约束（都来自产品原则）：
 *  - **只谈场景本体**，不谈产品/方案/技术选型（那些是后续阶段的事）
 *  - 每轮：先给我的理解（2-4 句），再提 **最多 3 个**问题——不要一次问一堆
 *  - 用户说不知道就跳过，标为待定，**不追问**
 *  - 不提"能不能做/值不值得"这类判断（产品只产出信息）
 */
export const DEFINITION_SYSTEM = `你是「场景通」的场景定义助手。用户只给了一个场景名称，你要通过**对话**帮他把场景聊清楚。

## 每一轮回复的结构（务必照做）
1. **先给理解**：用 2–4 句说"我目前理解这个场景是……"（基于场景名、已入库资料与用户前面说的话）；
2. **再提问题**：**最多 3 个**，且只问**场景本体**：
   - 客户/行业是谁（谁在用、谁付钱）
   - 覆盖什么范围（哪些环节/对象在内）
   - **明确不含什么**（边界——这条最容易漏，但很关键）
   - 核心用途（解决什么、用在哪）
   - 切入点（从哪个环节/对象开始）
   - 价值主张（对客户意味着什么）

## 铁律
- **只谈场景本体**：不要谈具体产品、型号、厂商、技术选型、方案架构——那些是后续阶段结合产品能力有目的地调研的内容。
- **不要给判断**：不要写"能不能做/值不值得/建议……"，你只负责把场景问清楚。
- **不要一次问一堆**：每轮 ≤3 个问题；用户回答了再问下一批。
- 用户说"不知道/不清楚/跳过"就**接受并标为待定**，不要追问同一个问题。
- **不要编造**客户名、数字、标准号；依据不足就留待用户补充。
- 说人话（术语首次出现要解释）。
- 用户没主动提就**不要**输出任何 JSON 或"定义块"——整理成表由用户点「整理成定义」触发。`;

/** 定义整理时给模型的任务（要求严格 JSON） */
const CONSOLIDATE_TASK = `请把上面的对话**整理成场景定义表**（表1-1 的固定项）。

要求：
0. **优先用 \`item_key\`**（清单里每项前面的英文名，如 \`customer_type\`）——中文标签容易写错导致对不上。
1. 只填有依据的项：
   - 用户明确说过的 → \`source_type: "用户补充"\`
   - 你根据已有信息推断的 → \`source_type: "AI推断"\`
   - **不确定或对话里没提到的项，content 填 ""（空字符串）**，不要编造
2. \`item\` 必须严格取自下面的固定项清单（不得自创、不得改字）。
3. 如果对话里能看出"用户想搞清楚什么"，把它放进 \`intent\`（没有就留空字符串）。
4. \`open_questions\` 只放**仍然没问清的场景本体问题**，最多 3 个。
5. 不要输出任何判断或建议。`;

const CONSOLIDATE_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "content", "source_type"],
        properties: {
          item_key: {
            type: "string",
            description: "固定项的英文 key（**优先用这个**，必须严格取自清单，如 customer_type）",
          },
          item: { type: "string", description: "固定项中文名（item_key 不确定时才用）" },
          content: { type: "string" },
          source_type: { type: "string", enum: ["用户补充", "AI推断"] },
          source: { type: "string", description: "出处（如 对话、产品资料）" },
        },
      },
    },
    intent: { type: "string", description: "用户想搞清楚什么（看不出就留空）" },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["items", "open_questions"],
};

/**
 * 构建定义对话的上下文（追加在用户消息前）
 *
 * 让模型知道：场景名、表1-1 现在的填写情况（哪些已定、哪些还空）——
 * 这样它只补空缺、不重复问已经明确的项。
 */
export function buildDefinitionContext(db: DbInstance, scenario: Scenario): string {
  const byItem = new Map(readAnchorRows(db, scenario.id).map((r) => [r.item, r]));
  const lines = anchorFixedRows().map((r) => {
    const row = byItem.get(r.label);
    const content = String(row?.content ?? "").trim();
    const state =
      content === "" || content === "未提供"
        ? "【还空着】"
        : String(row?.source_type ?? "") === "用户确认"
          ? "【用户已确认】"
          : String(row?.source_type ?? "") === "用户补充"
            ? "【用户说的】"
            : "【系统推断·待确认】";
    return `- ${r.label}${r.confirmRequired ? "（必确认）" : ""}：${content || "（空）"} ${state}`;
  });
  const brief = readBrief(db, scenario.id);
  return [
    "【当前场景】",
    `场景名称：${scenario.name}`,
    brief?.intent ? `用户想搞清楚什么：${brief.intent}` : "用户想搞清楚什么：（尚未说明——请通过提问了解）",
    "",
    "【表1-1 场景定义现状】（只补空着的项，已确认的不要改）",
    ...lines,
    "",
  ].join("\n");
}

/** 解析整理结果（容错：模型可能带代码块或前后缀） */
function parseConsolidation(text: string): {
  items: { item?: unknown; content?: unknown; source_type?: unknown; source?: unknown }[];
  intent?: unknown;
  open_questions?: unknown;
} | null {
  const candidates = [text.trim()];
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) candidates.push(block[1].trim());
  const start = text.indexOf("{");
  if (start >= 0) candidates.push(text.slice(start));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as {
        items?: unknown;
        intent?: unknown;
        open_questions?: unknown;
      };
      if (Array.isArray(parsed.items)) return { ...parsed, items: parsed.items as never[] };
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 规范化项名：去空白、统一分隔符（用于容错匹配模型输出的中文标签） */
function normalizeLabel(text: string): string {
  return text
    .replace(/[\s/、·・,，;；:：()（）\[\]]/g, "")
    .replace(/行业|类型|环节/g, (m) => m) // 保留语义词，仅做去噪
    .trim();
}

/**
 * 项名 → 固定行 key 的查找表
 *
 * 为什么需要：模型输出的中文标签常与注册表**不完全一致**
 * （如「客户类型」vs「客户类型/行业」、「不含什么」vs「明确不含什么」）。
 * 早期实现用精确标签匹配，导致产出行被**静默丢弃**——真机联调时表现为
 * "整理成定义后 L1 全空"，而 used_llm=true（只有「场景名称」侥幸匹配）。
 * 因此改为：**优先 item_key**，其次规范化标签匹配。
 */
/**
 * 中文别名表（模型常用近义改写）
 *
 * 为什么用**显式别名**而不是模糊打分：这一步会写进用户的场景定义，
 * 宁可漏匹配（记为 dropped 暴露出来）也不要猜错。别名表确定性、可审计、可测试。
 */
const ITEM_ALIASES: Readonly<Record<string, string>> = {
  场景名称: "scene_name",
  场景: "scene_name",
  客户类型: "customer_type",
  客户行业: "customer_type",
  客户: "customer_type",
  行业: "customer_type",
  覆盖什么: "scope_in",
  覆盖范围: "scope_in",
  场景范围: "scope_in",
  范围: "scope_in",
  明确不含什么: "scope_out",
  不含什么: "scope_out",
  不含: "scope_out",
  边界: "scope_out",
  明确边界: "scope_out",
  买方类型: "buyer_type",
  买方: "buyer_type",
  拍板者: "decision_maker",
  决策人: "decision_maker",
  使用者: "user_role",
  使用方: "user_role",
  付费者: "payer",
  付款方: "payer",
  核心业务流程: "core_process",
  业务流程: "core_process",
  核心流程: "core_process",
  核心用途: "use_case",
  场景用途: "use_case",
  用途: "use_case",
  切入点: "entry_point",
  切入环节: "entry_point",
  入口: "entry_point",
  价值主张: "value_proposition",
  价值点: "value_proposition",
  客户价值: "value_proposition",
};

function buildItemResolver(): (raw: { item_key?: unknown; item?: unknown }) => string | null {
  const byKey = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const r of anchorFixedRows()) {
    byKey.set(r.key.toLowerCase(), r.key);
    byLabel.set(normalizeLabel(r.label), r.key);
  }
  const byAlias = new Map(Object.entries(ITEM_ALIASES).map(([k, v]) => [normalizeLabel(k), v]));

  return (raw) => {
    const key = String(raw.item_key ?? "").trim().toLowerCase();
    if (key && byKey.has(key)) return byKey.get(key)!;
    const label = String(raw.item ?? "").trim();
    if (!label) return null;
    const norm = normalizeLabel(label);
    if (byLabel.has(norm)) return byLabel.get(norm)!;
    if (byAlias.has(norm)) return byAlias.get(norm)!;
    // 最后兜一层：子串/超串（如「覆盖率」≈「覆盖什么」）
    for (const [n, k] of byLabel) {
      if (n && (n.includes(norm) || norm.includes(n))) return k;
    }
    return null;
  };
}

export interface NormalizeResult {
  rows: AnchorRow[];
  /** 未能匹配到固定项的原始项名（用于暴露问题，而不是静默丢弃） */
  dropped: string[];
}

/**
 * 把模型输出收敛成合法锚行
 *
 * `用户确认` 一律不接受（只能由用户动作产生）；空内容不落行。
 */
export function normalizeConsolidatedItems(payload: {
  items: {
    item_key?: unknown;
    item?: unknown;
    content?: unknown;
    source_type?: unknown;
    source?: unknown;
  }[];
}): NormalizeResult {
  const resolve = buildItemResolver();
  const byKey = new Map(anchorFixedRows().map((r) => [r.key, r]));
  const rows: AnchorRow[] = [];
  const dropped: string[] = [];

  for (const raw of payload.items ?? []) {
    const key = resolve(raw);
    const name = String(raw.item ?? raw.item_key ?? "").trim();
    if (!key) {
      if (name) dropped.push(name);
      continue;
    }
    const content = String(raw.content ?? "").trim();
    if (content === "" || content === "未提供") continue; // 空内容不落行（不算丢弃）
    if (rows.some((r) => r.item === byKey.get(key)!.label)) continue; // 同项去重，先到先得
    const sourceType = raw.source_type === "用户补充" ? "用户补充" : "AI推断";
    rows.push({
      item: byKey.get(key)!.label,
      content,
      source: String(raw.source ?? "").trim() || (sourceType === "用户补充" ? "对话" : "系统推断"),
      source_type: sourceType,
    });
  }
  return { rows, dropped };
}

/** 「整理成定义」等待模型的上限（毫秒）；超时即降级为不写任何内容，避免请求无限挂起 */
export const CONSOLIDATE_TIMEOUT_MS = 120_000;

export interface ConsolidateOutcome {
  rows: AnchorRow[];
  updated: number;
  skipped: number;
  openQuestions: string[];
  usedLlm: boolean;
  /** 模型给了但匹配不到固定项的项名（暴露问题，避免静默丢失） */
  dropped: string[];
}

/**
 * 「整理成定义」：把「场景定义」对话整理成表1-1
 *
 * - 读该会话全部消息作为输入
 * - 保留用户已确认/已补充的行（用户的决定优先，见 `mergeAnchorRows`）
 * - 若识别到"想搞清楚什么"，写入诉求
 */
export async function consolidateDefinition(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
  conversationId: string,
  opts?: { timeoutMs?: number },
): Promise<ConsolidateOutcome> {
  const timeoutMs = opts?.timeoutMs ?? CONSOLIDATE_TIMEOUT_MS;
  const messages = db.messageRepo.listByConversation(conversationId);
  const transcript = messages
    .map((m) => `${m.role === "用户" ? "用户" : "助手"}：${m.content}`)
    .join("\n");

  const itemList = anchorFixedRows()
    .map(
      (r) =>
        `- item_key=\`${r.key}\`  中文名「${r.label}」${r.confirmRequired ? "（必确认）" : ""}`,
    )
    .join("\n");

  let incoming: AnchorRow[] = [];
  let intent = "";
  let openQuestions: string[] = [];
  let dropped: string[] = [];

  try {
    const session: SessionHandle = await dshClient.createSession({
      title: `场景定义整理 · ${scenario.name}`,
    });
    let full = "";
    const deadline = Date.now() + timeoutMs;
    for await (const ev of dshClient.prompt(session, {
      system: DEFINITION_SYSTEM,
      user: [
        "【固定项清单】（item 必须严格取自这里）",
        itemList,
        "",
        "【对话记录】",
        transcript || "（还没有对话）",
        "",
        CONSOLIDATE_TASK,
      ].join("\n"),
      outputContract: CONSOLIDATE_CONTRACT,
    })) {
      if (ev.type === "text") full += (ev as { type: string; text: string }).text;
      // 有界等待：模型长时间无输出就断开（break 会关闭该异步生成器），
      // 降级为"不写任何内容"——用户可再点一次，而不是让请求悬着
      if (Date.now() > deadline) break;
    }
    const parsed = parseConsolidation(full);
    if (parsed) {
      const normalized = normalizeConsolidatedItems(parsed);
      incoming = normalized.rows;
      dropped = normalized.dropped;
      intent = String(parsed.intent ?? "").trim();
      openQuestions = Array.isArray(parsed.open_questions)
        ? parsed.open_questions.map(String).slice(0, 3)
        : [];
    }
  } catch {
    /* 降级：不写任何内容，让用户继续聊 */
  }

  const usedLlm = incoming.length > 0;
  const before = readAnchorRows(db, scenario.id);
  // 保留用户已确认行：mergeAnchorRows 内部对本场景/用户持有的行不覆盖
  const merged = mergeAnchorRows(before, incoming);
  const rows = writeAnchorRows(db, scenario.id, merged);
  syncDerivedDescription(db, scenario.id);

  if (intent) {
    // 只补空缺，不覆盖用户已填的「想搞清楚什么」
    const brief = readBrief(db, scenario.id);
    if (!brief || brief.intent.trim() === "") {
      upsertBrief(db, scenario.id, {
        scene_name: scenario.name,
        intent,
      });
    }
  }

  const beforeFilled = new Set(
    before.filter((r) => String(r.content).trim() !== "").map((r) => r.item),
  );
  const updated = rows.filter(
    (r) => String(r.content).trim() !== "" && !beforeFilled.has(r.item),
  ).length;

  return {
    rows,
    updated,
    skipped: Math.max(0, anchorConfirmRows().length - updated),
    openQuestions,
    usedLlm,
    dropped,
  };
}

/** 只查不建：「场景定义」会话已存在则返回其 id（读路径用，避免读操作产生副作用） */
export function findDefinitionConversation(db: DbInstance, scenarioId: string): string | null {
  const existing = db.conversationRepo
    .list({ where: "scenario_id = ? AND status = ?", params: [scenarioId, "活跃"] })
    .find((c) => c.title === "场景定义");
  return existing?.id ?? null;
}

/** 找或建「场景定义」会话（幂等） */
export async function ensureDefinitionConversation(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
): Promise<string> {
  const existing = findDefinitionConversation(db, scenario.id);
  if (existing) return existing;
  const handle = await dshClient.createSession({ title: "场景定义" });
  const conv = db.conversationRepo.insert({
    scenario_id: scenario.id,
    title: "场景定义",
    status: "活跃",
    dsh_session_id: handle.sessionId,
  });
  return conv.id;
}

/** 定义对话已产生的消息（给前端渲染对话页） */
export function definitionMessages(
  db: DbInstance,
  conversationId: string,
): { id: string; role: string; content: string; created_at: string }[] {
  return db.messageRepo
    .listByConversation(conversationId)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    }));
}

/**
 * L1 六项（场景本体）中已填的数量
 *
 * 为什么就绪判定要看 **L1** 而不是"表1-1 任一行有内容"：
 * 锚骨架在**新建场景时**就用项目名填了「场景名称」，若按"任一行有内容"判定，
 * 项目一建好第 1 步就 ready，直接架空了"先聊清楚再整理成定义"的设计意图
 * （前端面板的「已整理成定义」徽标也是按 L1 判定——两处口径必须一致）。
 */
export function l1FilledCount(db: DbInstance, scenarioId: string): number {
  const byItem = new Map(readAnchorRows(db, scenarioId).map((r) => [r.item, r]));
  return anchorConfirmRows().filter((r) => {
    const row = byItem.get(r.label);
    const content = String(row?.content ?? "").trim();
    return content !== "" && content !== "未提供";
  }).length;
}

/** 定义是否已整理（流程第 1 步就绪判定：L1 至少一项有内容） */
export function hasDefinition(db: DbInstance, scenarioId: string): boolean {
  return l1FilledCount(db, scenarioId) > 0;
}

/** L1 待确认项数（右栏确认清单与就绪提示共用口径） */
export function l1PendingCount(db: DbInstance, scenarioId: string): number {
  return anchorConfirmRows().length - l1FilledCount(db, scenarioId);
}

/** 供测试与调试：表1-1 定义项定义 */
export function anchorRowCount(): number {
  return TABLES_BY_CODE[ANCHOR]?.fixedRows?.length ?? 0;
}

/** 类型再导出（前端契约用 InfoRow 判空） */
export type { InfoRow };
