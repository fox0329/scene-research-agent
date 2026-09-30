/**
 * @scene/server — 场景锚（表1-1）服务
 *
 * 承载 04 v1.4 §3.0 的两件事：
 *  1. **场景诉求**（第一输入）：一场景一行，`raw_text` 保留用户原文作对照基准
 *  2. **场景锚 = 表1-1 场景概述**（表格形态，中栏顶部常驻）：
 *     锚行存在 `stage_data`（stage=1, table_code=表1-1），逐格可编辑、可确认
 *
 * 设计要点：
 *  - `scenario.description` 降级为**派生展示缓存**（由锚行生成），锚才是唯一事实源
 *  - 起草（LLM）只写锚行，**不直接写缓存**；缓存由 `syncDerivedDescription` 统一生成
 *  - 用户确认过的行**不被系统重算覆盖**（`mergeAnchorRows`）
 */

import {
  ANCHOR_STAGE,
  ANCHOR_TABLE_CODE,
  type AnchorRow,
  type DshClient,
  type Scenario,
  type ScenarioBrief,
  type SessionHandle,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  anchorFixedRows,
  briefDraftHints,
  buildAnchorSkeleton,
  descriptionFromAnchor,
  mergeAnchorRows,
} from "@scene/domain";

/** 起草结果 */
export interface AnchorDraftOutcome {
  rows: AnchorRow[];
  openQuestions: string[];
  conversationId: string;
  /** 是否真的调用了模型（false = 降级为按用户线索预填） */
  usedLlm: boolean;
}

// ─── 锚行读写（stage_data） ────────────────────────────────

function toAnchorRow(row: Record<string, unknown>): AnchorRow {
  return {
    item: String(row["item"] ?? "").trim(),
    content: String(row["content"] ?? ""),
    source: (row["source"] as string | undefined) ?? null,
    source_type: (row["source_type"] as AnchorRow["source_type"]) ?? null,
    confirm_state: (row["confirm_state"] as string | undefined) ?? null,
  };
}

/** 读锚行（按注册表固定行顺序返回；缺失的行不补） */
export function readAnchorRows(db: DbInstance, scenarioId: string): AnchorRow[] {
  const order = anchorFixedRows().map((r) => r.label);
  return db.stageDataRepo
    .listByScenarioStage(scenarioId, ANCHOR_STAGE)
    .filter((r) => r.table_code === ANCHOR_TABLE_CODE)
    .map((r) => toAnchorRow(r.row))
    .sort((a, b) => order.indexOf(a.item) - order.indexOf(b.item));
}

/** 建锚骨架（幂等）：只在没有任何锚行时创建 12 行框架 */
export function ensureAnchorRows(db: DbInstance, scenarioId: string, sceneName: string): AnchorRow[] {
  const existing = readAnchorRows(db, scenarioId);
  if (existing.length > 0) return existing;
  return writeAnchorRows(db, scenarioId, buildAnchorSkeleton(sceneName));
}

/** 写锚行（按 `item` upsert；返回写后的全量锚行） */
export function writeAnchorRows(
  db: DbInstance,
  scenarioId: string,
  rows: readonly AnchorRow[],
): AnchorRow[] {
  const existing = db.stageDataRepo
    .listByScenarioStage(scenarioId, ANCHOR_STAGE)
    .filter((r) => r.table_code === ANCHOR_TABLE_CODE);
  const byItem = new Map(existing.map((r) => [String(r.row["item"] ?? "").trim(), r]));

  for (const row of rows) {
    const payload: Record<string, unknown> = {
      item: row.item,
      content: row.content,
      source: row.source ?? undefined,
      source_type: row.source_type ?? undefined,
      confirm_state: row.confirm_state ?? undefined,
    };
    const prev = byItem.get(row.item);
    if (prev) {
      db.stageDataRepo.update(prev.id, {
        row: { ...prev.row, ...payload },
        source_type: row.source_type ?? undefined,
      });
    } else {
      db.stageDataRepo.insert({
        scenario_id: scenarioId,
        stage: ANCHOR_STAGE,
        table_code: ANCHOR_TABLE_CODE,
        row: payload,
        is_stale: false,
        source_type: row.source_type ?? undefined,
        source: row.source ?? undefined,
      });
    }
  }
  return readAnchorRows(db, scenarioId);
}

/**
 * 由锚行重算派生展示缓存 `scenario.description`
 *
 * 旧代码/旧提示词仍读这个字段，因此保留；但它是**派生**的，锚变了就重算。
 */
export function syncDerivedDescription(db: DbInstance, scenarioId: string): string {
  const text = descriptionFromAnchor(readAnchorRows(db, scenarioId));
  db.scenarioRepo.update(scenarioId, { description: text || null } as never);
  return text;
}

// ─── 场景诉求 ──────────────────────────────────────────────

/** 读场景诉求（不存在返回 undefined） */
export function readBrief(db: DbInstance, scenarioId: string): ScenarioBrief | undefined {
  return db.scenarioBriefRepo.get(scenarioId);
}

/** 写场景诉求（upsert） */
export function upsertBrief(
  db: DbInstance,
  scenarioId: string,
  input: Partial<Omit<ScenarioBrief, "scenario_id" | "created_at" | "updated_at">>,
): ScenarioBrief {
  const prev = db.scenarioBriefRepo.get(scenarioId);
  const sceneName =
    String(input.scene_name ?? prev?.scene_name ?? "").trim() || "未命名场景";
  const intent = String(input.intent ?? prev?.intent ?? "").trim();
  // raw_text：首次写入时留用户原文；已存在则不覆盖（它是基准，不可被后续编辑改写）
  const rawText = prev?.raw_text ?? buildRawText({ ...prev, ...input, scene_name: sceneName, intent });
  const brief = db.scenarioBriefRepo.upsert(scenarioId, {
    scene_name: sceneName,
    intent,
    customer_hint: strOrNull(input.customer_hint ?? prev?.customer_hint),
    region_hint: strOrNull(input.region_hint ?? prev?.region_hint),
    scope_hint: strOrNull(input.scope_hint ?? prev?.scope_hint),
    audience: strOrNull(input.audience ?? prev?.audience),
    deadline: strOrNull(input.deadline ?? prev?.deadline),
    raw_text: rawText,
  });
  // 场景名同步到 scenario.name（诉求是用户输入的第一事实源）
  const scenario = db.scenarioRepo.getById(scenarioId);
  if (scenario && sceneName && scenario.name !== sceneName) {
    db.scenarioRepo.update(scenarioId, { name: sceneName } as never);
  }
  return brief;
}

function strOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

/** 组装用户诉求原文（对照确认的基准） */
function buildRawText(input: {
  scene_name?: string;
  intent?: string;
  customer_hint?: string | null;
  region_hint?: string | null;
  scope_hint?: string | null;
  audience?: string | null;
  deadline?: string | null;
}): string {
  const lines = [
    `场景名称：${input.scene_name ?? ""}`,
    `想搞清楚什么：${input.intent ?? ""}`,
  ];
  if (input.customer_hint) lines.push(`客户/行业：${input.customer_hint}`);
  if (input.region_hint) lines.push(`地域/客户名：${input.region_hint}`);
  if (input.scope_hint) lines.push(`想覆盖范围：${input.scope_hint}`);
  if (input.audience) lines.push(`用途：${input.audience}`);
  if (input.deadline) lines.push(`时间要求：${input.deadline}`);
  return lines.join("\n");
}

// ─── 起草锚行（LLM） ───────────────────────────────────────

const DRAFT_SYSTEM = `你是场景认识助手。根据用户的场景诉求与已入库的产品资料，填写「场景概述」表的 12 个固定项，作为全链分析锚。

铁律：
1. 只写「这个场景长什么样、范围在哪」——禁止出现任何具体产品、型号、厂商或技术方案（用什么产品打是后续阶段的结论，不预设）。
2. **不写「要解决的问题」「目标」「痛点」**——那是后续阶段结合产品能力有目的调研的内容。
3. 依据不足时填「未提供」，**禁止编造**客户名、数字、标准号。
4. 每项的 source_type 只能是 ` + "`AI提取`" + `（有材料依据）或 ` + "`AI推断`" + `（无依据的合理推断）；**不得自称用户确认**。
5. 待确认点只问场景本体（这个场景具体指什么、范围边界在哪），最多 3 个。`;

const DRAFT_CONTRACT: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "content", "source_type"],
        properties: {
          item: { type: "string", description: "固定项名称，必须取自给定清单" },
          content: { type: "string" },
          source_type: { type: "string", enum: ["AI提取", "AI推断"] },
          source: { type: "string", description: "出处，如 文件名:页码" },
        },
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["items", "open_questions"],
};

interface DraftPayload {
  items: { item?: unknown; content?: unknown; source_type?: unknown; source?: unknown }[];
  open_questions?: unknown;
}

function parseDraft(text: string): DraftPayload | null {
  const candidates = [text.trim()];
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block?.[1]) candidates.push(block[1].trim());
  const start = text.indexOf("{");
  if (start >= 0) candidates.push(text.slice(start));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as DraftPayload;
      if (Array.isArray(parsed.items)) return parsed;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

/** 把模型输出收敛成合法锚行（项名必须命中固定行；source_type 只接受 AI提取/AI推断） */
export function normalizeDraftItems(payload: DraftPayload): AnchorRow[] {
  const labels = new Set(anchorFixedRows().map((r) => r.label));
  const rows: AnchorRow[] = [];
  for (const raw of payload.items ?? []) {
    const item = String(raw.item ?? "").trim();
    if (!labels.has(item)) continue;
    const sourceType = raw.source_type === "AI提取" ? "AI提取" : "AI推断";
    rows.push({
      item,
      content: String(raw.content ?? "").trim(),
      source: strOrNull(raw.source) ?? "系统起草",
      source_type: sourceType,
    });
  }
  return rows;
}

/**
 * 起草场景锚：读诉求 + 资料库 → 生成表1-1 各行 → 写锚 → 重算缓存 → 发进「场景梳理」对话
 *
 * LLM 失败时**降级**为按用户线索预填（不阻断建场景），并返回 `usedLlm=false`。
 * 无论成功与否，用户已确认的行都不会被覆盖。
 */
export async function draftAnchor(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
  brief: ScenarioBrief,
): Promise<AnchorDraftOutcome> {
  let incoming: AnchorRow[] = [];
  let openQuestions: string[] = [];
  let usedLlm = false;

  const hints = briefDraftHints(brief);
  const materialSummary = summarizeMaterials(db, scenario.product_line_id);
  const itemList = anchorFixedRows()
    .map((r) => `- ${r.label}${r.required ? "（必填）" : ""}`)
    .join("\n");

  try {
    const session: SessionHandle = await dshClient.createSession({
      title: `场景认识起草 · ${scenario.name}`,
    });
    let fullText = "";
    for await (const ev of dshClient.prompt(session, {
      system: DRAFT_SYSTEM,
      user: [
        "## 用户诉求（第一输入，是唯一基准）",
        ...hints,
        "",
        "## 已入库资料摘要",
        materialSummary || "（暂无资料）",
        "",
        "## 固定项清单（item 必须严格取自这里）",
        itemList,
        "",
        "请输出 JSON：items（按上面清单逐项填写，缺依据的填「未提供」）+ open_questions。",
      ].join("\n"),
      outputContract: DRAFT_CONTRACT,
    })) {
      if (ev.type === "text") fullText += (ev as { type: "text"; text: string }).text;
    }
    const parsed = parseDraft(fullText);
    if (parsed) {
      incoming = normalizeDraftItems(parsed);
      openQuestions = Array.isArray(parsed.open_questions)
        ? parsed.open_questions.map(String).slice(0, 3)
        : [];
      usedLlm = incoming.length > 0;
    }
  } catch {
    /* 降级见下 */
  }

  if (!usedLlm) {
    // 降级：用场景名 + 用户线索预填能直接对应的项，其余留空待用户补
    incoming = [
      { item: "场景名称", content: scenario.name, source: "用户输入", source_type: "用户补充" },
      ...(brief.customer_hint
        ? [{ item: "客户类型/行业", content: brief.customer_hint, source: "用户诉求", source_type: "用户补充" as const }]
        : []),
      ...(brief.scope_hint
        ? [{ item: "覆盖什么", content: brief.scope_hint, source: "用户诉求", source_type: "用户补充" as const }]
        : []),
      ...(brief.intent
        ? [{ item: "核心用途", content: brief.intent, source: "用户诉求", source_type: "用户补充" as const }]
        : []),
    ];
  }

  // 建骨架 → 合并（用户确认优先）→ 写锚 → 重算缓存
  ensureAnchorRows(db, scenario.id, scenario.name);
  const merged = mergeAnchorRows(readAnchorRows(db, scenario.id), incoming);
  const rows = writeAnchorRows(db, scenario.id, merged);
  syncDerivedDescription(db, scenario.id);

  const conversationId = await ensureScenarioConversation(db, dshClient, scenario);
  db.messageRepo.insert({
    conversation_id: conversationId,
    role: "系统",
    content: buildDraftMessage(rows, openQuestions, usedLlm),
  });

  return { rows, openQuestions, conversationId, usedLlm };
}

/** 资料库摘要（起草输入：我们能用什么材料认识这个场景） */
function summarizeMaterials(db: DbInstance, productLineId: string): string {
  const counts: string[] = [];
  const n = (code: string): number =>
    db.stageDataRepo.list({ where: "table_code = ?", params: [code] }).length;
  const lines: string[] = [];
  const line = db.productLineRepo.getById(productLineId);
  if (line) lines.push(`资料库：${line.name}`);
  for (const code of ["M1", "M2", "M3", "M4", "M5", "M6"]) {
    const c = n(code);
    if (c > 0) counts.push(`${code} ${c} 行`);
  }
  if (counts.length) lines.push(`已入库：${counts.join("、")}`);
  return lines.join("\n");
}

/** 找或建「场景梳理」对话 */
async function ensureScenarioConversation(
  db: DbInstance,
  dshClient: DshClient,
  scenario: Scenario,
): Promise<string> {
  const existing = db.conversationRepo
    .list({ where: "scenario_id = ? AND status = ?", params: [scenario.id, "活跃"] })
    .find((c) => c.title === "场景梳理");
  if (existing) return existing.id;
  const handle = await dshClient.createSession({ title: "场景梳理" });
  const conv = db.conversationRepo.insert({
    scenario_id: scenario.id,
    title: "场景梳理",
    status: "活跃",
    dsh_session_id: handle.sessionId,
  });
  return conv.id;
}

function buildDraftMessage(
  rows: readonly AnchorRow[],
  openQuestions: readonly string[],
  usedLlm: boolean,
): string {
  const filled = rows.filter((r) => r.content.trim() !== "" && r.content !== "未提供");
  const head = usedLlm
    ? `【场景认识草稿】已根据你的诉求与资料库填写「场景概述」表（表1-1），共 ${filled.length}/12 项有内容。`
    : `【场景认识草稿】起草暂时不可用，已先按你的诉求预填能直接对应的项；其余请在表1-1 里补充。`;
  const body = filled.map((r) => `- ${r.item}：${r.content}`).join("\n");
  const questions = openQuestions.length
    ? ["", "请确认的仅是场景本体（有出入直接说，我改表）：", ...openQuestions.map((q, i) => `${i + 1}. ${q}`)]
    : [];
  return [
    head,
    "",
    body,
    ...questions,
    "",
    "没有大问题就可以进下一步了——客户细节、接入对象、合规等由后续阶段结合产品能力有目的地调研。",
  ].join("\n");
}
