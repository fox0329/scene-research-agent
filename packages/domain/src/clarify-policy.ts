/**
 * @scene/domain — clarify-policy 阈值裁决（MR3-T1，方案 6.2，纯函数零 IO）
 *
 * shouldAsk = (存在冲突对 ≥1 或 必填维度缺失 ≥2 或 近 3 轮内 rewrite/undo ≥2)
 *             且 本会话已问 < 2 次
 *             且 用户未选「别再问」
 *
 * 命中后由 LLM 生成候选澄清问题 → 答案存在性检查（确定性，见 answerExists）→
 * 至多 1 个进右栏会话。阈值常量集中管理。
 */

/** 阈值常量（集中管理，方案 6.2 口径） */
export const CLARIFY_THRESHOLDS = {
  /** 触发所需的冲突对最小数 */
  MIN_CONFLICT_PAIRS: 1,
  /** 触发所需的必填维度缺失最小数 */
  MIN_MISSING_DIMENSIONS: 2,
  /** 触发所需的近 3 轮纠偏（rewrite+undo）最小数 */
  MIN_RECENT_CORRECTIONS: 2,
  /** 近 N 轮窗口 */
  RECENT_ROUNDS: 3,
  /** 单会话最多提问次数 */
  MAX_ASKS_PER_SESSION: 2,
} as const;

/** 会话画像输入：裁决所需的最小事实集（应用层组装，领域层不查库） */
export interface ClarifyContext {
  /** 未裁决的冲突对（如「预算最小化」vs「上高端配置」），元素为两句话 */
  conflictPairs: [string, string][];
  /** 必填维度缺失清单（dimension_gap 条目文本） */
  missingDimensions: string[];
  /** 近 3 轮的纠偏动作序（按时间序，调用方裁剪窗口） */
  recentCorrections: ("rewrite" | "undo")[];
  /** 本会话已问过几次 */
  askedCount: number;
  /** 用户是否选了「别再问」（本场景或全局） */
  muted: boolean;
}

export type ClarifyReason = "conflict" | "dimension-gap" | "correction";

export interface ClarifyDecision {
  shouldAsk: boolean;
  /** 命中的原因（供问题生成 prompt 点名「为什么问」） */
  reasons: ClarifyReason[];
}

/** 阈值裁决：确定性，不调模型 */
export function shouldAskClarify(ctx: ClarifyContext): ClarifyDecision {
  if (ctx.muted) return { shouldAsk: false, reasons: [] };
  if (ctx.askedCount >= CLARIFY_THRESHOLDS.MAX_ASKS_PER_SESSION) {
    return { shouldAsk: false, reasons: [] };
  }

  const reasons: ClarifyReason[] = [];
  if (ctx.conflictPairs.length >= CLARIFY_THRESHOLDS.MIN_CONFLICT_PAIRS) reasons.push("conflict");
  if (ctx.missingDimensions.length >= CLARIFY_THRESHOLDS.MIN_MISSING_DIMENSIONS) reasons.push("dimension-gap");
  if (ctx.recentCorrections.length >= CLARIFY_THRESHOLDS.MIN_RECENT_CORRECTIONS) reasons.push("correction");

  return { shouldAsk: reasons.length > 0, reasons };
}

// ─── 答案存在性检查（评审修订：答案就在手边的提问比不问更糟） ──

const TOKEN_MIN_LENGTH = 2;

/**
 * 确定性检查：条目文本的 2-gram 片段出现在问句中 → 答案已存在 → 丢弃候选。
 * 中文无分词依赖（不引第三方库），反向匹配（条目短句片段 ⊂ 问句）比正向抽词可靠；
 * 常用词误命中方向是「多丢不误问」，与宁可漏改不可误改同向。
 * 材料库全文索引检查由应用层补（领域层不碰 IO），本函数只做画像侧。
 */
export function answerExistsInProfile(question: string, entries: readonly { text: string }[]): boolean {
  if (question.trim().length < TOKEN_MIN_LENGTH) return false;
  return entries.some((e) => {
    const t = e.text.replace(/[\s，,。.、；;：:"'「」]/gu, "");
    if (t.length < TOKEN_MIN_LENGTH) return false;
    for (let i = 0; i + TOKEN_MIN_LENGTH <= t.length; i++) {
      if (question.includes(t.slice(i, i + TOKEN_MIN_LENGTH))) return true;
    }
    return false;
  });
}

/** 从问句抽关键词（展示用）：去停用词、取 ≥2 字片段 */
export function extractKeywords(question: string): string[] {
  const stripped = question.replace(/[？?！!，,。.、\s「」『』]/gu, " ");
  const STOP = new Set(["是否", "你们", "请问", "什么", "多少", "还是", "需要", "有没有", "哪个", "怎么", "关于", "目前"]);
  return stripped
    .split(" ")
    .filter((t) => t.length >= TOKEN_MIN_LENGTH && !STOP.has(t))
    .slice(0, 6); // 最多 6 个关键词，防止长问句稀释
}
