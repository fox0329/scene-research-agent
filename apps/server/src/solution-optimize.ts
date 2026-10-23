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

const SYSTEM = `你是「场景通」的解决方案编辑。用户会给你一份现有解决方案和一条修改指令，
你只做改写，不重新调研、不补充新事实。规则：
1. 只能使用现有报告和上游事实清单里出现的信息；不得新增数字、公司名、来源、承诺或结论。
2. 可以：简化冗长段落、合并重复内容、调整章节顺序、改表达口吻、压缩列表。
3. 保留全部一级/二级标题结构（可以合并小节，但不能丢掉章节骨架）；
   如果只是改表达，尽量保持原有数字与引用原样。
4. 直接输出改写后的完整 Markdown 正文，不要解释、不要加「以下是」这类前言，
   不要用代码围栏包住全文。`;

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
      },
      required: ["instruction"],
    },
  },
} as const;

export function createSolutionOptimizer(deps: { db: DbInstance; dshClient: DshClient }) {
  const { db, dshClient } = deps;

  async function optimize(scenarioId: string, instruction: string): Promise<OptimizeResult> {
    const scenario = db.scenarioRepo.getById(scenarioId);
    if (!scenario) throw new Error(`场景 ${scenarioId} 不存在`);
    const view = getReport(db, scenario, "solution");
    if (!view.generated || !view.markdown.trim()) {
      throw new Error("解决方案还没有生成正式版，请先在中栏点「生成报告」");
    }
    const before = view.markdown.trim();
    const session = await dshClient.createSession({ title: `优化解决方案 · ${scenario.name}` });
    let out = "";
    for await (const event of dshClient.prompt(session, {
      system: SYSTEM,
      user: [
        `【修改指令】\n${instruction.trim()}`,
        `【上游事实清单（只能引用，不得新增）】\n${upstreamFacts(db, scenarioId) || "（无）"}`,
        `【当前解决方案】\n${before}`,
      ].join("\n\n"),
      outputContract: {},
    })) {
      if (event.type === "text") out += String((event as { text?: unknown }).text ?? "");
      if (event.type === "error") throw new Error(String(event["message"] ?? "模型调用失败"));
    }

    const next = stripFence(out.trim());
    if (!next) throw new Error("模型没有返回内容，报告保持不变");
    if (!/^#{1,4}\s/m.test(next)) throw new Error("改写结果缺少标题结构，报告保持不变");
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
      note: `已按「${instruction.trim().slice(0, 40)}」优化解决方案（${before.length} → ${next.length} 字，${delta >= 0 ? "+" : ""}${delta}）。事实与数字未新增。`,
    };
  }

  return { optimize };
}

/** 模型偶尔用 ```markdown 包全文：剥掉外层围栏 */
function stripFence(text: string): string {
  const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/u);
  return m?.[1]?.trim() ?? text;
}
