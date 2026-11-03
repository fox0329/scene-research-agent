/**
 * table-summary — 表头上方那一行「内容总结」（用户定调 2026-11-03）
 *
 * 用户的口径很明确：**总结的是这张表已经填写的内容**，不是介绍这张表是干什么用的
 * （第一版拿表定义 `purpose` 兜底，被用户当场否掉：「不是让你对表格做说明，
 * 而是对表格填写的内容用不到 100 字作总结」）。
 *
 * 因此：
 *  - 生成阶段已有 `summary`（随表产出、零额外成本）时直接用，本模块不参与；
 *  - 只有**存量表**（生成时还没有这个字段）才走这里：把已填的内容交给模型压成一句；
 *  - 空表没有内容可总结，返回 null，界面不显示这一行。
 *
 * 成本：每张表一次小调用（输入是这张表自己的行，几百到两千 token），落库后不再重复。
 */

import { middleColumns, tableDef, type DshClient } from "@scene/contract";
import type { InfoRow } from "@scene/domain";
import type { DbInstance } from "@scene/infra";

export interface TableSummaryDeps {
  db: DbInstance;
  dshClient: DshClient;
}

/** 送给模型的表格内容最多几行（行数太多时只取前面的，够看出中心思想） */
const MAX_ROWS_IN_PROMPT = 40;
/** 总结字数上限（用户要求「不到 100 字」） */
export const SUMMARY_MAX_CHARS = 100;

const SYSTEM = [
  "你是解决方案架构师，负责把一张信息表里已经填写的内容压成一句话。",
  "只总结内容本身：这批数据说明了什么、最关键的信息是什么。",
  "不要介绍这张表的用途，不要复述列名，不要逐行罗列，不要加任何前缀。",
  `不超过 ${SUMMARY_MAX_CHARS} 个汉字，一句话说完。`,
].join("\n");

/** 把行内容拼成模型能读的清单（只用中栏列，来源类列不进上下文） */
export function summaryPromptOf(tableCode: string, rows: InfoRow[]): string {
  const def = tableDef(tableCode);
  const cols = def ? middleColumns(def) : [];
  const picked = rows.slice(0, MAX_ROWS_IN_PROMPT).map((row) => {
    const parts = cols
      .map((c) => {
        const value = row[c.key];
        const text = Array.isArray(value) ? value.join("、") : String(value ?? "").trim();
        return text === "" ? "" : `${c.label}：${text}`;
      })
      .filter((s) => s !== "");
    return `- ${parts.join("；")}`;
  });
  return [
    `表：${def?.name ?? tableCode}（共 ${rows.length} 行${rows.length > MAX_ROWS_IN_PROMPT ? `，下面只列前 ${MAX_ROWS_IN_PROMPT} 行` : ""}）`,
    ...picked,
    "",
    `请用不超过 ${SUMMARY_MAX_CHARS} 个汉字总结这些内容。`,
  ].join("\n");
}

/** 去掉模型可能加的前缀、引号与换行，截到上限 */
export function cleanSummary(raw: string): string {
  const text = raw
    .replace(/^\s*(总结|摘要|一句话总结)\s*[:：]\s*/u, "")
    .replace(/^["'「『“]+|["'」』”]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length <= SUMMARY_MAX_CHARS ? text : `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join("")}…`;
}

/**
 * 确保这张表有内容摘要：有就返回旧的，没有就现生成一次并落库
 *
 * 空表返回 null（没内容可总结，界面不显示这一行）。
 */
export async function ensureTableSummary(
  deps: TableSummaryDeps,
  scenarioId: string,
  tableCode: string,
): Promise<string | null> {
  const cached = deps.db.tableSummaryRepo.get(scenarioId, tableCode);
  if (cached && cached.summary.trim() !== "") return cached.summary;

  const rows = deps.db.stageDataRepo.list({
    where: "scenario_id = ? AND table_code = ?",
    params: [scenarioId, tableCode],
    orderBy: "rowid ASC",
  });
  if (rows.length === 0) return null;

  const handle = await deps.dshClient.createSession({ title: `表摘要-${tableCode}` });
  let raw = "";
  try {
    for await (const ev of deps.dshClient.prompt(handle, {
      system: SYSTEM,
      user: summaryPromptOf(tableCode, rows.map((r) => r.row)),
      outputContract: {
        type: "object",
        properties: { summary: { type: "string", description: `不超过 ${SUMMARY_MAX_CHARS} 字的一句话总结` } },
        required: ["summary"],
      },
    })) {
      if (ev.type === "text") raw += ev.text;
      if (ev.type === "error") throw new Error(String(ev.message ?? "模型调用失败"));
    }
  } finally {
    await deps.dshClient.cancel(handle);
  }

  /* 模型偶尔会包一层 JSON（outputContract 推着它这么做）：能解析就取字段 */
  let text = raw;
  try {
    const parsed = JSON.parse(raw.trim()) as { summary?: unknown };
    if (typeof parsed.summary === "string") text = parsed.summary;
  } catch {
    /* 不是 JSON 就直接用正文 */
  }
  const summary = cleanSummary(text);
  if (summary === "") return null;
  deps.db.tableSummaryRepo.upsert(scenarioId, tableCode, summary);
  return summary;
}
