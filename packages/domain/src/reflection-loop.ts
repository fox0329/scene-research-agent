/**
 * @scene/domain — 反思循环判定（MR2-T1，纯函数，零 IO）
 *
 * 锚点比对是「给文档造测试」：锚点定义什么叫违反，产物文本+度量代入即得结果。
 * 分轮停止：默认 1 轮、最多 2 轮（方案 6.3），复查仍违反如实报告、不触发第三轮。
 * 三路必改项（postcheck ∥ reflection ∥ completeness）由 mergeFindings 并成一份偏差清单，
 * 一次差分（方案 6.5）。
 */

import type { CheckAnchor, CheckAnchorMode, RequirementEntry } from "@scene/contract";

/** 产物代入物：text 供 keyword/regex 比对，metrics 供 numeric 取值（篇幅等经导出度量折算） */
export interface AnchorTarget {
  text: string;
  metrics: Record<string, number>;
}

export interface AnchorViolation {
  entryId: string;
  kind: RequirementEntry["kind"];
  /** 条目原文（差分清单里展示给用户「为什么算违反」） */
  entryText: string;
  anchor: CheckAnchor;
  mode: CheckAnchorMode;
  /** 违反说明（确定性生成，不带模型措辞） */
  detail: string;
}

/** 锚点判定：返回 true = 违反（命中即违反 / 未出现即违反 / numeric 不满足） */
export function anchorViolated(anchor: CheckAnchor, target: AnchorTarget): boolean {
  switch (anchor.type) {
    case "keyword": {
      const hit = anchor.terms.some((t) => target.text.includes(t));
      return anchor.mode === "命中即违反" ? hit : !hit;
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(anchor.pattern, anchor.flags ?? "u");
      } catch {
        return false; // 非法正则不判违反（宁可漏改不可误改）
      }
      const hit = re.test(target.text);
      return anchor.mode === "命中即违反" ? hit : !hit;
    }
    case "numeric": {
      const actual = target.metrics[anchor.field];
      if (actual === undefined) return false; // 度量缺失不判违反，如实缺报
      switch (anchor.op) {
        case ">":
          return !(actual > anchor.value);
        case "<":
          return !(actual < anchor.value);
        case ">=":
          return !(actual >= anchor.value);
        case "<=":
          return !(actual <= anchor.value);
        case "==":
          return actual !== anchor.value;
      }
    }
  }
}

const VIOLATION_ELIGIBLE_KINDS = new Set<RequirementEntry["kind"]>(["constraint", "explicit"]);

/**
 * 单条目比对：constraint/explicit 带锚点才进必改；
 * preference 与无锚点条目永远不进必改（建议级，用例矩阵口径）。
 */
export function evaluateEntry(entry: RequirementEntry, target: AnchorTarget): AnchorViolation | null {
  if (!VIOLATION_ELIGIBLE_KINDS.has(entry.kind)) return null;
  if (entry.status !== "active" || entry.check_anchor === null) return null;
  if (!anchorViolated(entry.check_anchor, target)) return null;
  return {
    entryId: entry.id,
    kind: entry.kind,
    entryText: entry.text,
    anchor: entry.check_anchor,
    mode: entry.check_anchor.mode,
    detail: describeViolation(entry.check_anchor, target),
  };
}

function describeViolation(anchor: CheckAnchor, target: AnchorTarget): string {
  switch (anchor.type) {
    case "keyword":
      return anchor.mode === "命中即违反"
        ? `产物出现禁忌词：${anchor.terms.filter((t) => target.text.includes(t)).join("、")}`
        : `要求出现的关键词未出现：${anchor.terms.join("、")}`;
    case "regex":
      return anchor.mode === "命中即违反"
        ? `产物命中禁忌模式：/${anchor.pattern}/`
        : `要求匹配的内容未出现：/${anchor.pattern}/`;
    case "numeric": {
      const actual = target.metrics[anchor.field];
      return `${anchor.field}要求 ${anchor.op}${anchor.value}${anchor.unit ?? ""}，实际 ${
        actual ?? "（缺度量）"
      }`;
    }
  }
}

/** 全量比对：active 条目 × 产物 → 必改项清单（顺序与条目传入序一致，可复现） */
export function evaluateEntries(entries: RequirementEntry[], target: AnchorTarget): AnchorViolation[] {
  return entries
    .map((e) => evaluateEntry(e, target))
    .filter((v): v is AnchorViolation => v !== null);
}

/** 来源条目被 dismissed → 该锚点即刻失效（比对前过滤，不参与任何轮次） */
export function excludeDismissed(
  entries: RequirementEntry[],
  dismissedIds: ReadonlySet<string>,
): RequirementEntry[] {
  return entries.filter((e) => e.status === "active" && !dismissedIds.has(e.id));
}

// ─── 分轮停止（方案 6.3：默认 1 轮，最大 2） ─────────────────

export const DEFAULT_REFLECTION_ROUNDS = 1;
export const MAX_REFLECTION_ROUNDS = 2;

export type RoundDecision =
  | { action: "revise"; round: number }
  | { action: "stop"; reason: "clean" | "max-rounds"; /** 停止时仍违反的清单（如实报告） */ remaining: AnchorViolation[] };

/**
 * 轮次推进：有违反且未到上限 → 修订一轮；到上限仍有违反 → 停止并如实报告（不触发第三轮）。
 * round 从 1 计（第 1 轮比对完、修订后复查算第 2 轮）。
 */
export function decideRound(
  round: number,
  violations: AnchorViolation[],
  opts: { maxRounds?: number } = {},
): RoundDecision {
  const max = opts.maxRounds ?? MAX_REFLECTION_ROUNDS;
  if (violations.length === 0) return { action: "stop", reason: "clean", remaining: [] };
  if (round >= max) return { action: "stop", reason: "max-rounds", remaining: violations };
  return { action: "revise", round: round + 1 };
}

// ─── 三路必改项合并（方案 6.5：一次差分） ────────────────────

/** 合并键：同条目同锚点的重复发现只留一条（postcheck/reflection/completeness 交叉报告去重） */
function findingKey(v: AnchorViolation): string {
  return `${v.entryId}::${JSON.stringify(v.anchor)}`;
}

export function mergeFindings(...groups: AnchorViolation[][]): AnchorViolation[] {
  const seen = new Set<string>();
  const out: AnchorViolation[] = [];
  for (const group of groups) {
    for (const v of group) {
      const key = findingKey(v);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}
