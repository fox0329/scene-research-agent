/**
 * @scene/server — 会话上下文压缩（确定性）
 *
 * 历史实现只截断最近 12 条 / 6000 字，更早的内容只留一句「已省略」——
 * 用户追问早先的客户/约束时，模型真的看不到。v2 产物会话仍保留完整历史，
 * 但把被截断的部分压成「决策 / 约束 / 未决 / 对话」摘要，随每轮 prompt 带上。
 *
 * 为什么先做确定性摘要而不是调用模型：
 *   1. 压缩发生在每轮请求前，额外模型调用会把首字延迟翻倍；
 *   2. 摘要必须可测试、可审计，不能每次措辞漂移；
 *   3. 后续接入 DSH compaction 时，只替换本文件实现，数据字段与 UI 不变。
 */

/** 完整保留的最近消息条数 */
export const HISTORY_MAX_MESSAGES = 12;
/** 完整保留的消息字符上限（按字符近似，中文为主） */
export const HISTORY_MAX_CHARS = 6000;
/** 摘要最多条数 */
const SUMMARY_MAX_LINES = 12;
/** 单条摘要最大字符 */
const SUMMARY_MAX_CHARS = 120;

export interface CompactionResult {
  /** 直接拼进 prompt 的「对话历史」块；无历史时为空串 */
  block: string;
  /** 被省略消息的摘要；没有压缩时为空串 */
  summary: string;
  /** 完整保留的条数 */
  kept: number;
  /** 是否发生了压缩 */
  compacted: boolean;
  /** 本轮之前的有效消息总数 */
  total: number;
}

/**
 * 压缩会话历史：最近若干条完整保留，更早消息抽取关键记忆。
 *
 * 保留旧格式里的「（更早的 N 条已省略）」提示，避免既有 prompt 行为突变；
 * 同时在后面补一段结构化摘要。
 */
export function compactConversationHistory(
  messages: readonly { role: string; content: string }[],
  limits: { maxMessages?: number; maxChars?: number } = {},
): CompactionResult {
  const maxMessages = limits.maxMessages ?? HISTORY_MAX_MESSAGES;
  const maxChars = limits.maxChars ?? HISTORY_MAX_CHARS;
  const usable = messages.filter((m) => String(m.content ?? "").trim() !== "");
  if (usable.length === 0) {
    return { block: "", summary: "", kept: 0, compacted: false, total: 0 };
  }

  const picked: string[] = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]!;
    const line = `${m.role === "用户" ? "用户" : "助手"}：${m.content.trim()}`;
    if (picked.length >= maxMessages || chars + line.length > maxChars) break;
    picked.unshift(line);
    chars += line.length;
  }

  const omitted = usable.slice(0, usable.length - picked.length);
  const compacted = omitted.length > 0;
  const summary = compacted ? summarizeOlderMessages(omitted) : "";
  const note = compacted ? `（更早的 ${omitted.length} 条已省略）` : "";
  const summaryBlock = summary ? `【更早对话摘要】\n${summary}\n` : "";
  return {
    block: `【对话历史】${note}\n${summaryBlock}${picked.join("\n")}\n\n`,
    summary,
    kept: picked.length,
    compacted,
    total: usable.length,
  };
}

/** 从被省略的消息里抽取「决策 / 约束 / 未决 / 对话」记忆，最多 12 条 */
export function summarizeOlderMessages(
  messages: readonly { role: string; content: string }[],
): string {
  const seen = new Set<string>();
  const entries: { index: number; kind: string; text: string }[] = [];
  for (const [index, m] of messages.entries()) {
    const text = oneLine(m.content);
    if (!text) continue;
    const key = text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ index, kind: memoryKind(text), text: text.slice(0, SUMMARY_MAX_CHARS) });
  }

  /*
   * 先选「决策/约束/未决」，再拿普通对话补位；同类都取较新的。
   * 只按时间顺序取前 12 条会被早期寒暄占满，真正的约束反而丢掉。
   */
  const important = entries
    .filter((e) => e.kind !== "对话")
    .sort((a, b) => b.index - a.index);
  const chatter = entries
    .filter((e) => e.kind === "对话")
    .sort((a, b) => b.index - a.index);
  const chosen = [...important, ...chatter]
    .slice(0, SUMMARY_MAX_LINES)
    .sort((a, b) => a.index - b.index);
  return chosen.map((e) => `${e.kind}：${e.text}`).join("\n");
}

/** 一条记忆的类别：优先识别决策/约束/未决，识别不出时退回对话 */
function memoryKind(text: string): string {
  if (/(决策|决定|确定|采用|已确认|定为|改成)/u.test(text)) return "决策";
  if (/(约束|必须|不能|不要|限制|边界|不允许)/u.test(text)) return "约束";
  if (/(待确认|未决|是否|要不要|需要确认|开放问题)/u.test(text)) return "未决";
  return "对话";
}

/** 压成一行，去掉换行/多余空白 */
function oneLine(content: string): string {
  return String(content ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}
