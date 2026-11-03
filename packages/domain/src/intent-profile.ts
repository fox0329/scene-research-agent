/**
 * @scene/domain — 意图画像判定规则（MR1-T3，纯函数，零 IO）
 *
 * 抽取管道（MR1-T4）拿到新条目后，先过这里的确定性判定再落库；
 * 模型只负责「抽出来」，合不合、顶不顶、进不进黑名单全部由本文件说了算。
 * 判定顺序即调用链：黑名单 → 同维度查找 → 相似合并 / 冲突取代（过置信铁律）→ 新增。
 */

import type { RequirementEntry } from "@scene/contract";

/** 置信铁律的秩：用户原话 > 用户操作 > AI推断（低置信永不顶高置信） */
const CONFIDENCE_RANK: Record<RequirementEntry["confidence"], number> = {
  用户原话: 3,
  用户操作: 2,
  AI推断: 1,
};

export function confidenceRank(confidence: RequirementEntry["confidence"]): number {
  return CONFIDENCE_RANK[confidence];
}

// ─── 文本归一化与相似度（确定性相似判定：字符二元组 Jaccard） ───

/** 归一化：全角转半角 → 去空白 → 去标点 → 小写。同文判定与黑名单比对都用它 */
export function normRequirementText(text: string): string {
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]/g, "")
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~！？。，、；：「」『』（）《》“”‘’·…—]/g, "")
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const norm = normRequirementText(text);
  const set = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
  return set;
}

/** 字符二元组 Jaccard 相似度：中文无现成分词，n-gram 是可解释的确定性近似 */
export function requirementSimilarity(a: string, b: string): number {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 主题同维度阈值（Jaccard 通道）：低于它看首词组通道 */
const SAME_DIMENSION_THRESHOLD = 0.4;

const NEGATION_WORDS = ["不", "别", "禁", "无需", "不用", "不要"];

/** 首词组：剥掉否定前缀后的头两个字，作为主题词（短句 Jaccard 失真时的兜底通道） */
function firstTopic(text: string): string {
  const stripped = normRequirementText(text).replace(/^(不要|不用|无需|别|不)/, "");
  return stripped.slice(0, 2);
}

/** 同维度判定：Jaccard 达标 OR 首词组相同（覆盖「篇幅两页纸」→「篇幅不要两页纸要五页」这类改口） */
function isSameDimension(a: string, b: string): boolean {
  if (requirementSimilarity(a, b) >= SAME_DIMENSION_THRESHOLD) return true;
  const fa = firstTopic(a);
  return fa.length >= 2 && fa === firstTopic(b);
}

function hasNegation(text: string): boolean {
  return NEGATION_WORDS.some((w) => text.includes(w));
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0])).sort((a, b) => a - b);
}

// ─── 黑名单（dismissed 即黑名单，同文不得抽回） ───────────────

export function isBlacklisted(text: string, dismissedTexts: string[]): boolean {
  const norm = normRequirementText(text);
  return dismissedTexts.some((t) => normRequirementText(t) === norm);
}

// ─── 抽取条目处置判定（核心入口） ─────────────────────────────

export type ExtractionOutcome =
  | { action: "merged"; entry: RequirementEntry }
  | { action: "superseded"; entry: RequirementEntry; supersededIds: string[] }
  | { action: "kept"; entry: RequirementEntry }
  | { action: "rejected"; reason: "blacklisted" | "low-confidence"; against?: RequirementEntry };

export interface ResolveContext {
  /** 当前场景视图全部条目（scene + user），不含 dismissed */
  existing: RequirementEntry[];
  /** dismissed 条目文本（黑名单指纹集） */
  dismissedTexts: string[];
}

/**
 * 新条目处置判定。返回的 entry 一律以传入 incoming 为基底（调用方按 action 落库）：
 * merged → 以 existing 为底、来源追加；superseded → 新条目 active、旧的由调用方标 superseded。
 */
export function resolveIncoming(incoming: RequirementEntry, ctx: ResolveContext): ExtractionOutcome {
  if (isBlacklisted(incoming.text, ctx.dismissedTexts)) {
    return { action: "rejected", reason: "blacklisted" };
  }
  const sameDim = ctx.existing.filter(
    (e) => e.kind === incoming.kind && e.status === "active" && isSameDimension(e.text, incoming.text),
  );
  if (sameDim.length === 0) return { action: "kept", entry: incoming };
  // 同维度里取相似度最高者作为比对对象（并列时取更新近的，与场景视图排序一致）
  const target = [...sameDim].sort(
    (a, b) =>
      requirementSimilarity(b.text, incoming.text) - requirementSimilarity(a.text, incoming.text) ||
      b.updated_at.localeCompare(a.updated_at),
  )[0]!;
  const conflict = isConflicting(target.text, incoming.text);
  if (conflict) return resolveConflict(target, incoming);
  return mergeInto(target, incoming);
}

/** 正面后接负面（或数值变了）＝冲突；同义不同文＝合并 */
function isConflicting(existing: string, incoming: string): boolean {
  if (normRequirementText(existing) === normRequirementText(incoming)) return false;
  const numsE = numbersIn(existing);
  const numsI = numbersIn(incoming);
  if (numsE.length > 0 && numsI.length > 0) {
    return numsE.join(",") !== numsI.join(",");
  }
  return hasNegation(existing) !== hasNegation(incoming);
}

/** 冲突处置：先过置信铁律——严格低置信才拒；同级冲突（用户改口）以新近为准 */
function resolveConflict(
  target: RequirementEntry,
  incoming: RequirementEntry,
): ExtractionOutcome {
  if (confidenceRank(incoming.confidence) < confidenceRank(target.confidence)) {
    return { action: "rejected", reason: "low-confidence", against: target };
  }
  return { action: "superseded", entry: incoming, supersededIds: [target.id] };
}

/** 相似合并：以 existing 为底，来源追加、置信取高、更新时间取新 */
function mergeInto(target: RequirementEntry, incoming: RequirementEntry): ExtractionOutcome {
  const sources = [...target.sources];
  for (const s of incoming.sources) {
    const dup = sources.some((x) => JSON.stringify(x) === JSON.stringify(s));
    if (!dup) sources.push(s);
  }
  const entry: RequirementEntry = {
    ...target,
    sources,
    confidence:
      confidenceRank(incoming.confidence) > confidenceRank(target.confidence)
        ? incoming.confidence
        : target.confidence,
    updated_at: incoming.updated_at > target.updated_at ? incoming.updated_at : target.updated_at,
  };
  return { action: "merged", entry };
}

// ─── undo 信号：只打待复核，不生成条目 ───────────────────────

export interface ReviewHint {
  entryId: string;
  reason: "undo";
}

/** 撤销命中的条目引用：按 artifact_refs 命中（撤销对象行在哪些条目的出处里） */
export function undoReviewTargets(entries: RequirementEntry[], affectedArtifactRefs: string[]): ReviewHint[] {
  const affected = new Set(affectedArtifactRefs);
  return entries
    .filter((e) => e.artifact_refs.some((ref) => affected.has(ref)))
    .map((e) => ({ entryId: e.id, reason: "undo" }));
}

// ─── 并发规则：用户手编永远赢 ────────────────────────────────

/**
 * 手编与抽取同时写 → 手编赢：current 的 text/status/scope/check_anchor 保留，
 * 抽取侧只允许追加来源与出处引用（MR1-T4 落库前必经此函数）。
 */
export function applyUserEditWins(
  current: RequirementEntry,
  incomingSources: RequirementEntry["sources"],
  incomingArtifactRefs: string[],
): RequirementEntry {
  const sources = [...current.sources];
  for (const s of incomingSources) {
    const dup = sources.some((x) => JSON.stringify(x) === JSON.stringify(s));
    if (!dup) sources.push(s);
  }
  const refs = [...new Set([...current.artifact_refs, ...incomingArtifactRefs])];
  return { ...current, sources, artifact_refs: refs };
}

// ─── 升级判定：同维度 ≥2 场景 active → 进候选（确认前 scope 不动） ──

/**
 * 升级候选判定（纯判定，不改 scope）：同归一化文本在 ≥2 个场景保持 active。
 * repo 的 listUpgradeCandidates 供数，本函数是领域层的可单测判定。
 */
export function upgradeCandidates(entries: RequirementEntry[]): RequirementEntry[] {
  const byText = new Map<string, RequirementEntry[]>();
  for (const e of entries) {
    if (e.scope !== "scene" || e.status !== "active" || e.scenario_id === null) continue;
    const key = normRequirementText(e.text);
    byText.set(key, [...(byText.get(key) ?? []), e]);
  }
  const out: RequirementEntry[] = [];
  for (const group of byText.values()) {
    if (new Set(group.map((e) => e.scenario_id)).size >= 2) out.push(group[0]!);
  }
  return out;
}

// ─── dimension_gap：缺维度记条目，不产生任何加列动作 ─────────

/**
 * 缺维度条目构造：锚点恒空（无锚点可匹配）、出处恒空（不指向任何产出物，
 * 因此不会触发任何加列/改表动作——gap 只是记录，动作永远留给用户）。
 */
export function buildDimensionGapEntry(
  base: Omit<RequirementEntry, "kind" | "check_anchor" | "artifact_refs">,
  source: RequirementEntry["sources"][number],
): RequirementEntry {
  return {
    ...base,
    kind: "dimension_gap",
    check_anchor: null,
    artifact_refs: [],
    sources: [source],
  };
}
