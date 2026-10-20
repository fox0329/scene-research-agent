/**
 * value-check — 「这一行值不值得进表」判定（全表通用，确定性层）
 *
 * 用户定调（2026-10-20）：「同时要确认表格内容是否真有价值，进入表格的内容要确认价值」。
 *
 * 为什么必须有这道闸：材料不足时模型倾向于「把表填满」——中栏一格一格写「未提供」「待补」
 * 「行业通例」，表看起来是满的，用户读起来一个字都用不上。配额式完整度（某类各 ≥1 行）
 * 会放大这个问题。所以「有内容」不等于「有价值」，两者要分开判。
 *
 * 判定口径（宁可漏判，不误删）：
 *   - 整行中栏一格实质内容都没有（全是空值/占位词）→ 无价值
 *   - 中栏去掉占位词后总字数少于 6 → 信息量不足
 *   - 占位词以外的内容只是「待确认/需调研/视情况」这类空话 → 无价值
 */

/** 占位词：写了等于没写 */
const PLACEHOLDERS = new Set([
  "未提供",
  "未给出",
  "未说明",
  "未获取",
  "未查到",
  "未见",
  "无材料",
  "材料未含",
  "暂无",
  "待补",
  "待补充",
  "待确认",
  "待核实",
  "不详",
  "未知",
  "无",
  "-",
  "—",
  "／",
  "/",
  "n/a",
  "na",
]);

/** 空话：有字但没有信息 */
const EMPTY_TALK = /^(待确认|待补充|待核实|需进一步调研|需调研|建议核实|视情况而定|按需|待定|视情况)[。；;，,]*$/;

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s。；;，,]/g, "");
}

export interface ValueVerdict {
  hasValue: boolean;
  reason: string | null;
}

/** 去掉占位词后的最少字数：低于此值基本是「填了个字」而非信息 */
const MIN_SUBSTANTIVE_CHARS = 4;

/**
 * 判定一行有没有实质内容
 *
 * @param cells - 该行中栏各格的文本（调用方从契约取中栏列，别把右栏溯源留痕算进来）
 */
export function judgeRowValue(cells: ReadonlyArray<unknown>): ValueVerdict {
  const texts = cells.map((c) => String(c ?? "").trim());
  const substantive = texts.filter((t) => t !== "" && !PLACEHOLDERS.has(t.toLowerCase()) && !PLACEHOLDERS.has(t));

  if (substantive.length === 0) {
    return { hasValue: false, reason: "整行没有实质内容（中栏全是空值或「未提供」类占位词）" };
  }

  const joined = normalize(substantive.join(""));
  if (joined.length < MIN_SUBSTANTIVE_CHARS) {
    return { hasValue: false, reason: `信息量不足（去掉占位词后只有 ${joined.length} 个字）` };
  }
  if (substantive.every((t) => EMPTY_TALK.test(normalize(t)))) {
    return { hasValue: false, reason: "只有「待确认/待补充」这类空话，没有任何可用的信息" };
  }
  return { hasValue: true, reason: null };
}
