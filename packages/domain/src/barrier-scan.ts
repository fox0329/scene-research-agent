/**
 * barrier-scan — 门槛筛查（阶段 1，00b §3.2 表 1-3/表 1-4）
 *
 * 职责：五类门槛判定（过/绕/借道/等）、处置策略。
 * 规则：判定逻辑只在领域层（确定性层，AGENTS.md 规则 5），
 * LLM 只组织判据描述文本，不进入判定路径。
 */

// ─── 类型 ─────────────────────────────────────────────────────

/** 五类门槛（00b §3.2 表 1-3 A-E） */
export type BarrierType =
  | "技术"
  | "行业准入"
  | "经济"
  | "生态锁定"
  | "一票否决者";

/** 门槛判定结论（00b 表 1-3 现状 + 表 1-4 策略口径） */
export type BarrierJudgment =
  | "过得了"
  | "绕道"
  | "借道"
  | "过不了"
  | "等窗口"
  | "不知道";

/** 处置策略（00b §3.2 表 1-4） */
export type StrategyRecommendation =
  | "直接进入"
  | "找替代路径"
  | "找合作伙伴"
  | "不进入"
  | "等政策变化"
  | "列为调研重点";

// ─── 判定规则表（有序，先命中先判） ──────────────────────────

const BARRIER_TYPES: readonly BarrierType[] = [
  "技术",
  "行业准入",
  "经济",
  "生态锁定",
  "一票否决者",
];

/** 现状关键词 → 判定结论（顺序即优先级：未调研最先，负面先于正面——"不满足"含"满足"字样） */
const STATUS_RULES: ReadonlyArray<{
  keywords: readonly string[];
  judgment: BarrierJudgment;
}> = [
  // 未调研类：判不了 → 不知道（质量关 0 第 8 项要求标注为调研重点）
  { keywords: ["不知道", "待确认", "未调研", "不清楚", "待调研"], judgment: "不知道" },
  // 等待类：门槛本身可能变化（政策/窗口期）
  { keywords: ["等窗口", "等政策", "政策窗口", "窗口期"], judgment: "等窗口" },
  // 生态锁定类：借合作方过生态（表 1-3 D 应对策略）
  { keywords: ["借道", "合作"], judgment: "借道" },
  // 替代路径类：绕开门槛（表 1-3 D 应对策略）
  { keywords: ["绕道", "绕过", "替代"], judgment: "绕道" },
  // 不可过类：现状不满足判据（先于可过类，防止"不满足"误命中"满足"）
  { keywords: ["过不了", "不满足", "不具备", "未认证", "禁止", "否决"], judgment: "过不了" },
  // 可过类：现状满足判据
  { keywords: ["过得了", "满足", "已具备", "已认证", "达标"], judgment: "过得了" },
];

// ─── 公共接口 ─────────────────────────────────────────────────

/**
 * 门槛判定（五类门槛 → 过/绕/借道/等/不知道）
 *
 * 按有序关键词规则把现状描述归类为封闭判定集：
 * 先判"不知道"（未调研优先暴露，不淹没在后续规则里），
 * 再判 等窗口 → 借道 → 绕道 → 过不了 → 过得了（负面先于正面）；
 * 全部不命中时兜底"不知道"（宁可标调研重点，不做无据判定）。
 * 判据必须已由用户确认（技术方案 §六），空判据/空现状直接抛错。
 *
 * @param barrierType - 门槛类型（五类之一）
 * @param criteria - 判据（具体等级/标准号，须非空）
 * @param currentStatus - 现状描述（如"过得了"/"借道"/"等政策"）
 * @returns 门槛判定结论
 * @throws 门槛类型非法、判据或现状为空时抛错
 */
export function judgeBarrier(
  barrierType: BarrierType,
  criteria: string,
  currentStatus: string,
): BarrierJudgment {
  if (!BARRIER_TYPES.includes(barrierType)) {
    throw new Error(`门槛类型非法：${String(barrierType)}`);
  }
  if (!criteria.trim()) {
    throw new Error("门槛判据不能为空");
  }
  if (!currentStatus.trim()) {
    throw new Error("门槛现状不能为空");
  }

  for (const rule of STATUS_RULES) {
    if (rule.keywords.some((kw) => currentStatus.includes(kw))) {
      return rule.judgment;
    }
  }
  // 无法归类：按"不知道"处理，标注为调研重点（00b 质量关 0 第 8 项）
  return "不知道";
}

/**
 * 处置策略（00b §3.2 表 1-4：通过/绕过/借道/等窗口）
 *
 * 判定 → 策略的确定性映射；策略只是建议，是否执行由用户决定。
 *
 * @param judgment - 门槛判定结论
 * @returns 处置策略建议
 */
export function planStrategy(judgment: BarrierJudgment): StrategyRecommendation {
  switch (judgment) {
    case "过得了":
      return "直接进入";
    case "绕道":
      return "找替代路径";
    case "借道":
      return "找合作伙伴";
    case "过不了":
      return "不进入";
    case "等窗口":
      return "等政策变化";
    case "不知道":
      return "列为调研重点";
  }
}
