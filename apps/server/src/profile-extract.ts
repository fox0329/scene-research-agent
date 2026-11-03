/**
 * @scene/server — profile-extract 抽取管道（MR1-T4）
 *
 * 攒批触发（3 条消息或空闲 30s）→ 调 DSH 抽需求条目（JSON）→ 过 intent-profile
 * 确定性判定 → 落库。模型只产出候选条目，合不合/顶不顶/进不进黑名单由领域层说了算。
 * token 熔断：每场景每日抽取调用超上限直接跳过（方案 §7）。
 */

import type { DshClient, RequirementEntry, RequirementSource } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { randomUUID } from "node:crypto";
import {
  applyUserEditWins,
  buildDimensionGapEntry,
  resolveIncoming,
  undoReviewTargets,
  type ReviewHint,
} from "@scene/domain";
import {
  insertRequirement,
  listDismissedTexts,
  listInteractionEvents,
  listRequirements,
  updateRequirement,
} from "./requirement-profile.js";

const BATCH_TRIGGER_COUNT = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DAILY_CALL_LIMIT = 50;
/** 抽取输入的消息窗口：只给最近这些条，防止上下文爆炸（G-0.3） */
const MESSAGE_WINDOW = 12;

export interface ExtractorDeps {
  db: DbInstance;
  dshClient: DshClient;
  /** 测试注入：空闲触发超时 */
  idleTimeoutMs?: number;
  /** 测试注入：每场景每日抽取调用上限 */
  dailyCallLimit?: number;
  now?: () => Date;
}

export interface FlushResult {
  /** 本次抽取落库的条目数（kept + merged + superseded 的净结果） */
  kept: number;
  merged: number;
  superseded: number;
  rejected: number;
  /** true = 因攒批不足/熔断/无消息而跳过 */
  skipped: boolean;
}

export interface ExtractorHandle {
  /** 对话每来一条用户消息调一次；达到阈值自动 flush */
  noteMessage(scenarioId: string, conversationId: string): Promise<void>;
  /** 立即抽取（攒批不足时调用方也可强制） */
  flush(scenarioId: string, conversationId: string | null): Promise<FlushResult>;
  /** undo 待复核引用（只提示，不生成条目） */
  pendingReviewHints(scenarioId: string): ReviewHint[];
}

export function createProfileExtractor(deps: ExtractorDeps): ExtractorHandle {
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const dailyLimit = deps.dailyCallLimit ?? DEFAULT_DAILY_CALL_LIMIT;
  const now = deps.now ?? (() => new Date());
  const counters = new Map<string, number>();
  const callDates = new Map<string, string>();
  const callCounts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function noteMessage(scenarioId: string, conversationId: string): Promise<void> {
    const next = (counters.get(scenarioId) ?? 0) + 1;
    counters.set(scenarioId, next);
    clearTimeout(timers.get(scenarioId));
    if (next >= BATCH_TRIGGER_COUNT) {
      counters.set(scenarioId, 0);
      await flush(scenarioId, conversationId);
      return;
    }
    // 空闲触发：窗口内没有新消息就抽一次
    timers.set(
      scenarioId,
      setTimeout(() => {
        counters.set(scenarioId, 0);
        void flush(scenarioId, conversationId);
      }, idleMs),
    );
  }

  function isOverDailyLimit(scenarioId: string): boolean {
    const today = now().toISOString().slice(0, 10);
    if (callDates.get(scenarioId) !== today) {
      callDates.set(scenarioId, today);
      callCounts.set(scenarioId, 0);
    }
    return (callCounts.get(scenarioId) ?? 0) >= dailyLimit;
  }

  async function flush(scenarioId: string, conversationId: string | null): Promise<FlushResult> {
    const idle: FlushResult = { kept: 0, merged: 0, superseded: 0, rejected: 0, skipped: true };
    const messages = conversationId
      ? deps.db.messageRepo.listByConversation(conversationId).slice(-MESSAGE_WINDOW)
      : [];
    if (messages.length === 0 || isOverDailyLimit(scenarioId)) return idle;
    callCounts.set(scenarioId, (callCounts.get(scenarioId) ?? 0) + 1);

    const raw = await extractViaDsh(deps.dshClient, messages.map((m) => `${m.role}: ${m.content}`));
    if (!raw) return idle;
    const candidates = parseCandidates(raw);
    if (candidates.length === 0) return idle;
    return applyCandidates(deps.db, scenarioId, candidates, now);
  }

  function pendingReviewHints(scenarioId: string): ReviewHint[] {
    const undoEvents = listInteractionEvents(deps.db, scenarioId, { limit: 50 }).filter(
      (e) => e.action === "undo",
    );
    if (undoEvents.length === 0) return [];
    // undo 撤销的是操作；条目出处引用按会话最近操作的目标行反查（简化：以事件 target 为引用键）
    return undoReviewTargets(listRequirements(deps.db, scenarioId), undoEvents.map((e) => e.target));
  }

  return { noteMessage, flush, pendingReviewHints };
}

// ─── DSH 抽取调用 ────────────────────────────────────────────

const EXTRACT_SYSTEM = `你是需求抽取器。从对话中提取用户对产出物的明确要求（篇幅、口径、重点、禁忌、偏好）。
只提取有依据的，输出 JSON 数组，每项：
{"text":"要求原文归纳","kind":"explicit|preference|constraint|dimension_gap","confidence":"用户原话|用户操作|AI推断","anchor":{"type":"keyword","terms":["词"],"mode":"命中即违反"}|null,"sourceRef":"消息id","sourceSnippet":"原话片段"}
规则：confidence 只在用户原话明确说出时给"用户原话"；从行为推断给"AI推断"；用户说"不要提X"用 constraint 且 anchor terms 含 X。没有要求就输出 []。`;

async function extractViaDsh(dshClient: DshClient, lines: string[]): Promise<string | null> {
  try {
    const session = await dshClient.createSession({ title: "需求画像抽取" });
    let out = "";
    for await (const ev of dshClient.prompt(session, {
      system: EXTRACT_SYSTEM,
      user: lines.join("\n"),
      outputContract: { type: "json_array" },
    })) {
      const e = ev as { type: string; text?: string };
      if (e.type === "text" && e.text) out += e.text;
    }
    await dshClient.cancel(session);
    return out.trim() || null;
  } catch {
    // 抽取失败不阻断主流程：画像缺失比对话中断可接受（宁可漏改不可误改）
    return null;
  }
}

interface ExtractedCandidate {
  text: string;
  kind: RequirementEntry["kind"];
  confidence: RequirementEntry["confidence"];
  anchor: RequirementEntry["check_anchor"];
  sourceRef: string;
  sourceSnippet: string;
}

/** 模型输出 → 候选条目：解析失败逐条丢弃（不因一条脏数据废掉整批） */
function parseCandidates(raw: string): ExtractedCandidate[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const kinds = new Set(["explicit", "preference", "constraint", "dimension_gap"]);
  const confidences = new Set(["用户原话", "用户操作", "AI推断"]);
  const out: ExtractedCandidate[] = [];
  for (const item of parsed) {
    const o = item as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    if (typeof o.kind !== "string" || !kinds.has(o.kind)) continue;
    if (typeof o.confidence !== "string" || !confidences.has(o.confidence)) continue;
    out.push({
      text,
      kind: o.kind as RequirementEntry["kind"],
      confidence: o.confidence as RequirementEntry["confidence"],
      anchor: (o.anchor ?? null) as RequirementEntry["check_anchor"],
      sourceRef: typeof o.sourceRef === "string" ? o.sourceRef : "unknown",
      sourceSnippet: typeof o.sourceSnippet === "string" ? o.sourceSnippet : text,
    });
  }
  return out;
}

// ─── 判定落库（intent-profile 领域层说了算） ─────────────────

function applyCandidates(
  db: DbInstance,
  scenarioId: string,
  candidates: ExtractedCandidate[],
  now: () => Date,
): FlushResult {
  const result: FlushResult = { kept: 0, merged: 0, superseded: 0, rejected: 0, skipped: false };
  const dismissed = listDismissedTexts(db);
  for (const c of candidates) {
    const ts = now().toISOString();
    const source: RequirementSource = { type: "message", ref: c.sourceRef, snippet: c.sourceSnippet };
    const incoming: RequirementEntry = {
      id: randomUUID(),
      scenario_id: scenarioId,
      origin_scenario_id: null,
      scope: "scene",
      kind: c.kind,
      text: c.text,
      check_anchor: c.anchor,
      status: "active",
      confidence: c.confidence,
      sources: [source],
      artifact_refs: [],
      created_at: ts,
      updated_at: ts,
    };
    const gap = c.kind === "dimension_gap"
      ? buildDimensionGapEntry(incoming, source)
      : null;
    const entry = gap ?? incoming;
    const outcome = resolveIncoming(entry, {
      existing: listRequirements(db, scenarioId),
      dismissedTexts: dismissed,
    });
    applyOutcome(db, scenarioId, entry, outcome, result);
  }
  return result;
}

function applyOutcome(
  db: DbInstance,
  scenarioId: string,
  incoming: RequirementEntry,
  outcome: ReturnType<typeof resolveIncoming>,
  result: FlushResult,
): void {
  if (outcome.action === "kept") {
    insertRequirement(db, {
      scenario_id: scenarioId,
      scope: incoming.scope,
      kind: incoming.kind,
      text: incoming.text,
      check_anchor: incoming.check_anchor,
      confidence: incoming.confidence,
      sources: incoming.sources,
      artifact_refs: incoming.artifact_refs,
    });
    result.kept++;
    return;
  }
  if (outcome.action === "merged") {
    // 合并落库：text 取领域层合并结果，sources 由 repo 去重追加（旧来源一条不丢）
    const merged = applyUserEditWins(outcome.entry, incoming.sources, incoming.artifact_refs);
    updateRequirement(db, merged.id, { text: merged.text, sources: incoming.sources });
    result.merged++;
    return;
  }
  if (outcome.action === "superseded") {
    insertRequirement(db, {
      scenario_id: scenarioId,
      scope: incoming.scope,
      kind: incoming.kind,
      text: incoming.text,
      check_anchor: incoming.check_anchor,
      confidence: incoming.confidence,
      sources: incoming.sources,
      artifact_refs: incoming.artifact_refs,
    });
    for (const id of outcome.supersededIds) {
      updateRequirement(db, id, { status: "superseded" });
    }
    result.superseded++;
    return;
  }
  result.rejected++;
}
