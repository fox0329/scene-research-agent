/**
 * @scene/server — 解决方案对话优化（变更表 #303）
 *
 * 用户在交付物会话里说「简化一点 / 调整章节 / 第三章更口语」，助手调用 optimize_solution：
 * 读当前正式版报告 → 按指令改写 → 落回同一份文件。
 *
 * 硬约束：只做结构、篇幅、表达层面的改写，不得新增事实、数字、来源或承诺。
 * 上游事实清单会随报告一起进提示词，让模型有据可依；改完做确定性校验
 * （非空、含标题、篇幅在 0.4–1.8 倍之间），不合格不落盘。
 */

import type { DshClient } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { getReport, saveReportFile } from "./report-service.js";

/** 优化结果（返回给调用方与测试） */
/** 从 Markdown 里取某个二级章节的正文（含标题行）；找不到返回 null */
export function sectionText(markdown: string, title: string): string | null {
  const lines = markdown.split("\n");
  const needle = title.replace(/^#+\s*/u, "").trim();
  const start = lines.findIndex(
    (line) => /^##\s+/u.test(line) && line.replace(/^##\s+/u, "").trim().includes(needle),
  );
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/** 用改写后的章节替换原文中的同名章节（保留其余章节一字不动） */
export function replaceSection(markdown: string, title: string, replacement: string): string {
  const lines = markdown.split("\n");
  const needle = title.replace(/^#+\s*/u, "").trim();
  const start = lines.findIndex(
    (line) => /^##\s+/u.test(line) && line.replace(/^##\s+/u, "").trim().includes(needle),
  );
  if (start < 0) return markdown;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), replacement.trim(), ...lines.slice(end)].join("\n");
}

export interface OptimizeResult {
  before: number;
  after: number;
  note: string;
}

const MIN_RATIO = 0.4;
const MAX_RATIO = 1.8;

/** 上游事实清单：每张表最多 20 行、每行 200 字，避免把整库灌进提示词 */
function upstreamFacts(db: DbInstance, scenarioId: string): string {
  const rows = db.stageDataRepo.list({
    where: "scenario_id = ?",
    params: [scenarioId],
    orderBy: "stage ASC, table_code ASC, rowid ASC",
  });
  const byTable = new Map<string, string[]>();
  for (const item of rows) {
    const list = byTable.get(item.table_code) ?? [];
    if (list.length >= 20) continue;
    const cells = Object.entries(item.row)
      .filter(([k]) => !k.startsWith("__"))
      .map(([, v]) => String(v ?? "").trim())
      .filter(Boolean)
      .slice(0, 6);
    if (cells.length > 0) list.push(cells.join("｜").slice(0, 200));
    byTable.set(item.table_code, list);
  }
  return [...byTable.entries()]
    .map(([table, list]) => `【${table}】\n${list.join("\n")}`)
    .join("\n\n");
}

const SYSTEM = `你是「场景通」的解决方案编辑。用户会给你一份现有解决方案和一条修改指令。
唯一的硬边界：不得新增报告和上游事实清单里没有的数字、公司名、来源、承诺或结论——这是防伪造，
不是内容配额。其余按用户指令和你的判断来：
- 可以简化、合并、调整章节、改表达、删减事实与数据；用户要求删的，删掉即可，不要再补回。
- 章节结构按用户要求处理，不强制保留全部标题；用户没说就保持原有骨架。
- 用户点名章节时只输出那一节（含 ## 标题）；没点名就输出完整正文。
- 不要解释、不要加「以下是」这类前言，不要用代码围栏包住全文。`;

/** 交付物会话的工具定义（#303）：指令式改写，报告内容由服务端读取，不进对话上下文 */
export const OPTIMIZE_SOLUTION_TOOL = {
  type: "function",
  function: {
    name: "optimize_solution",
    description:
      "按用户指令优化当前解决方案：简化、合并、调整章节顺序、改表达。只改表达与结构，不得新增事实。",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "用户要的优化方向，如「整体压缩到一半」「第三章改得更口语」「把重复的案例合并」",
        },
        section: {
          type: "string",
          description:
            "用户点名的章节标题（可选），如「现状与问题」；点名章节时必须传，工具只校验并回报该章节",
        },
      },
      required: ["instruction"],
    },
  },
} as const;

export function createSolutionOptimizer(deps: { db: DbInstance; dshClient: DshClient }) {
  const { db, dshClient } = deps;

  async function optimize(
    scenarioId: string,
    instruction: string,
    section?: string,
  ): Promise<OptimizeResult> {
    const scenario = db.scenarioRepo.getById(scenarioId);
    if (!scenario) throw new Error(`场景 ${scenarioId} 不存在`);
    const view = getReport(db, scenario, "solution");
    if (!view.generated || !view.markdown.trim()) {
      throw new Error("解决方案还没有生成正式版，请先在中栏点「生成报告」");
    }
    const before = view.markdown.trim();
    const target = section?.trim() ? sectionText(before, section) : null;
    if (section?.trim() && !target) {
      throw new Error(`报告里没有「${section}」章节，请核对章节名`);
    }
    const heads = before
      .split("\n")
      .filter((line) => /^##\s+/u.test(line))
      .map((line) => line.trim())
      .join("\n");
    const session = await dshClient.createSession({ title: `优化解决方案 · ${scenario.name}` });
    let out = "";
    const userPrompt = target
      ? [
          `【修改指令】\n${instruction.trim()}`,
          `【报告章节骨架（仅供衔接，不要改写其他章节）】\n${heads}`,
          `【上游事实清单（只能引用，不得新增）】\n${upstreamFacts(db, scenarioId) || "（无）"}`,
          `【本节原文】\n${target}`,
          `【篇幅】按用户指令删减（原文 ${target.length} 字）；没有明确幅度时由你判断，但不要只改标点。`,
          "只输出改写后的这一节（含 ## 标题），不要输出其他章节。",
        ].join("\n\n")
      : [
          `【修改指令】\n${instruction.trim()}`,
          `【上游事实清单（只能引用，不得新增）】\n${upstreamFacts(db, scenarioId) || "（无）"}`,
          `【当前解决方案】\n${before}`,
        ].join("\n\n");
    const run = async (prompt: string): Promise<string> => {
      let text = "";
      for await (const event of dshClient.prompt(session, {
        system: SYSTEM,
        user: prompt,
        outputContract: {},
      })) {
        if (event.type === "text") text += String((event as { text?: unknown }).text ?? "");
        if (event.type === "error") throw new Error(String(event["message"] ?? "模型调用失败"));
      }
      return text;
    };

    out = await run(userPrompt);

    let next = stripFence(out.trim());
    if (!next) throw new Error("模型没有返回内容，报告保持不变");
    if (!/^#{1,4}\s/m.test(next)) throw new Error("改写结果缺少标题结构，报告保持不变");

    if (target) {
      /* 章节模式：只回填这一节，其余章节原样保留 */
      if (!/^##\s+/m.test(next)) next = `## ${section!.trim()}\n\n${next}`;
      const ratio = next.length / target.length;
      if (ratio < 0.3 || ratio > 1.8) {
        throw new Error(
          `「${section}」改写后篇幅变化过大（${Math.round(ratio * 100)}%），已放弃本次修改`,
        );
      }
      const beforeSectionLen = target.length;
      const afterSectionLen = next.length;
      next = replaceSection(before, section!, next);
      const deltaAll = next.length - before.length;
      saveReportFile(scenario, "solution", next);
      return {
        before: before.length,
        after: next.length,
        note:
          `已优化「${section!.trim()}」：本章 ${beforeSectionLen} → ${afterSectionLen} 字` +
          `（${Math.round((afterSectionLen / beforeSectionLen) * 100)}%）；` +
          `全文 ${before.length} → ${next.length} 字（${deltaAll >= 0 ? "+" : ""}${deltaAll}）。事实与数字未新增。`,
      };
    }

    const ratio = next.length / before.length;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      throw new Error(
        `改写后篇幅变化过大（${Math.round(ratio * 100)}%），为避免丢内容已放弃本次修改`,
      );
    }
    saveReportFile(scenario, "solution", next);
    const delta = next.length - before.length;
    return {
      before: before.length,
      after: next.length,
      note: `已优化解决方案：${before.length} → ${next.length} 字（${delta >= 0 ? "+" : ""}${delta}）。事实与数字未新增。`,
    };
  }

  return { optimize };
}

/** 模型偶尔用 ```markdown 包全文：剥掉外层围栏 */
function stripFence(text: string): string {
  const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/u);
  return m?.[1]?.trim() ?? text;
}
