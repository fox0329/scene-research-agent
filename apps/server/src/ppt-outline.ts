/**
 * @scene/server — PPT 大纲（变更表 #341）
 *
 * 用户定调：PPT 大纲必须**依据解决方案正文**生成，作为独立交付物可编辑；
 * 导出 PPT 时优先用这份大纲，而不是每次从解决方案重新抽。
 *
 * 存法：`data/deliverables/<场景 id>.ppt-outline.md`，与报告同目录、不同后缀；
 * 不落库——大纲是产物，解决方案改了可以重新生成，但不会自动覆盖用户改过的版本。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PPT_LAYOUTS, PPT_LIMITS, type DshClient, type Scenario } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { safeWriteFile } from "@scene/infra";
import { deliverableDir } from "./deliverable-report.js";
import { getReport } from "./report-service.js";
import { streamPrompt } from "./dsh-stream.js";

export interface PptOutlineView {
  markdown: string;
  chars: number;
  generated: boolean;
  generated_at: string | null;
}

export function pptOutlinePath(scenarioId: string): string {
  return join(deliverableDir(), `${scenarioId}.ppt-outline.md`);
}

function countChars(markdown: string): number {
  return markdown.replace(/\s/g, "").length;
}

export function getPptOutline(scenario: Scenario): PptOutlineView {
  const path = pptOutlinePath(scenario.id);
  if (!existsSync(path)) return { markdown: "", chars: 0, generated: false, generated_at: null };
  const markdown = readFileSync(path, "utf8");
  if (markdown.trim() === "") return { markdown: "", chars: 0, generated: false, generated_at: null };
  return {
    markdown,
    chars: countChars(markdown),
    generated: true,
    generated_at: statSync(path).mtime.toISOString(),
  };
}

export function savePptOutlineFile(
  scenario: Scenario,
  markdown: string,
): { path: string; written: boolean; overwritten: boolean; notice?: string } {
  const dir = deliverableDir();
  mkdirSync(dir, { recursive: true });
  const saved = safeWriteFile(pptOutlinePath(scenario.id), markdown);
  if (saved.notice) console.warn(`[ppt-outline] ${saved.notice}`);
  return saved;
}

/** 大纲页数（只认 `## 第 N 页` 标题；用户手改格式后可能数不准，仅用于提示） */
export function countOutlinePages(markdown: string): number {
  return (markdown.match(/^##\s*第\s*\d+\s*页/mg) ?? []).length;
}

export function buildPptOutlineDocPrompt(
  scenarioName: string,
  solution: string,
): { system: string; user: string } {
  const system = [
    `你是《${scenarioName}》的汇报策划，负责把解决方案正文整理成一份**可直接交给 PPT 排版**的大纲。`,
    "只输出 Markdown 大纲，不要输出 PPT、JSON、解释或客套话。",
    "",
    "## 页数",
    `- 整份 ${PPT_LIMITS.minPages}–${PPT_LIMITS.maxPages} 页，页数由解决方案的内容决定，不要为凑页数拆空页，也不要为压页数删掉关键内容。`,
    "- 第 1 页是封面；不要目录页，不要「谢谢 / 结束」尾页。",
    "- 叙事顺序：现状与问题 → 方案与建设内容 → 价值与下一步。",
    "",
    "## 每页格式（严格照这个写）",
    "## 第 N 页｜页面标题｜版式：<版式名>",
    "- 标题：一句话判断，≤ 20 字",
    "- 要点：",
    "  - 一条一个事实或判断，≤ 26 字；每页 4–6 条",
    "- 结论：这一页要读者记住的一句话，≤ 34 字",
    "",
    `版式名只能从这些里选：${PPT_LAYOUTS.join("、")}。`,
    "第 1 页固定用「封面」；一页只讲一件事，相邻页不要重复同一个意思。",
    "",
    "## 内容边界",
    "- 只能使用解决方案正文里出现过的名词、数字和结论；不许编造金额、台数、比例、时间。",
    "- 不许写「待客户提供」「待补齐」；不许写「建议采用 / 推荐 / 值得投入」这类决策建议。",
    "- 不写表号、来源、页码、证据等级、核实结论。",
    "- 每条短句说人话、能独立看懂，不要空话套话。",
  ].join("\n");
  return {
    system,
    user: ["## 解决方案正文", "", solution].join("\n"),
  };
}

/** 去掉模型偶尔包的 Markdown 围栏 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return m ? (m[1] ?? "").trim() : trimmed;
}

/**
 * 根据已生成的解决方案写大纲并落盘。
 *
 * 不自动重试：大纲是用户可改的交付物，失败就让用户看到原因、重试一次；
 * 页数越界只提示、不删内容（用户可能故意多写）。
 */
export async function generatePptOutline(args: {
  db: DbInstance;
  scenario: Scenario;
  dshClient: DshClient;
}): Promise<{ markdown: string; chars: number; generated: true; notice?: string }> {
  const solution = getReport(args.db, args.scenario, "solution").markdown.trim();
  if (solution === "") throw new Error("解决方案还没有生成，请先生成解决方案，再生成 PPT 大纲");

  const session = await args.dshClient.createSession({
    title: `${args.scenario.name} · PPT 大纲`,
  });
  const prompt = buildPptOutlineDocPrompt(args.scenario.name, solution);
  const result = await streamPrompt({
    dshClient: args.dshClient,
    session,
    system: prompt.system,
    user: prompt.user,
    label: "PPT 大纲",
    keepaliveMs: 30_000,
    push: () => {},
  });
  if (result.error) throw new Error(result.error);
  const markdown = stripFence(result.text);
  if (markdown === "") throw new Error("模型没有返回 PPT 大纲，请重试");

  const pages = countOutlinePages(markdown);
  let notice: string | undefined;
  if (pages > 0 && (pages < PPT_LIMITS.minPages || pages > PPT_LIMITS.maxPages)) {
    notice = `大纲有 ${pages} 页，超出 ${PPT_LIMITS.minPages}–${PPT_LIMITS.maxPages} 页建议范围；已按现有内容保存，可手动调整。`;
  }
  savePptOutlineFile(args.scenario, markdown);
  return { markdown, chars: countChars(markdown), generated: true, notice };
}
