/**
 * @scene/server — 阶段总结文档服务
 *
 * 职责：为一个场景的某个阶段**生成并落库**右栏总结文档（六段骨架）。
 *
 * 设计（对应 04 §五）：
 *  - **确定性生成**：行数据 + 完整度报告 + 注册表 → Markdown，不需要 LLM
 *  - 阶段口径 8 阶段（0-7）；兼容旧数据把 `stage = 8` 视为阶段 7（交付物）
 *  - 交付阶段（无信息表）也生成一份说明，而不是留空
 */

import {
  ANCHOR_TABLE_CODE,
  STAGE_DEFS,
  flowStep,
  tablesOfStage,
  type InfoStageId,
  type Scenario,
  type StageId,
} from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import {
  anchorFixedRows,
  buildStageBrief,
  buildStageSummary,
  checkStageCompleteness,
  type InfoRow,
  type StageBrief,
  type StageBriefSource,
  type StageCompleteness,
} from "@scene/domain";
import { readAnchorRows, readBrief } from "./scenario-anchor.js";
import { ownLineOf } from "./scenario-lines.js";

/**
 * 阶段编号归一：旧编号 8（交付物）合并为 7
 *
 * StageId 已收窄为 0-7，但**老数据/老调用仍可能带 8**——按数值比较保留这层兼容。
 */
export function normalizeStage(stage: StageId): InfoStageId {
  return ((stage as number) === 8 ? 7 : stage) as InfoStageId;
}

/**
 * 读各表的行（按注册表的表号）
 *
 * @param tableCodes 只读这些表（缺省 = 本阶段全部表）。右栏按**当前步骤**传本步表集——
 *   阶段 1 横跨第 1、2 两步，不限定表集就会在第 2 步读到第 1 步的表1-1。
 */
export function readStageRowsByTable(
  db: DbInstance,
  scenarioId: string,
  stage: InfoStageId,
  tableCodes?: readonly string[],
): Record<string, InfoRow[]> {
  const codes = tableCodes ?? tablesOfStage(stage).map((t) => t.code);
  const out: Record<string, InfoRow[]> = {};
  for (const code of codes) {
    const rows = db.stageDataRepo
      .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, code] })
      .map((r) => r.row as InfoRow);
    out[code] = code === ANCHOR_TABLE_CODE ? keepAnchorRows(rows) : rows;
  }
  // 场景锚（表1-1）在**阶段级**（交付物装配）总结里始终带上：它是全链唯一场景定义；
  // 步骤级总结不兜这个底——第 2 步不该再讲一遍第 1 步的场景定义
  if (tableCodes === undefined && !out[ANCHOR_TABLE_CODE]) {
    out[ANCHOR_TABLE_CODE] = keepAnchorRows(
      readAnchorRows(db, scenarioId) as unknown as InfoRow[],
    );
  }
  return out;
}

/** 步骤级总结的覆盖范围（表集 + 范围标记） */
function stepScope(step: number): { tableCodes: readonly string[] } {
  return { tableCodes: flowStep(step).tables };
}

/**
 * 只保留注册表里定义过的锚行
 *
 * 存量库可能还躺着旧 12 项制的残项（表定义收敛后它们既不渲染、也不该出现在总结里），
 * 这是迁移脚本执行前的兜底——用户投诉过的"无效信息"不能再从总结里冒出来。
 */
function keepAnchorRows(rows: readonly InfoRow[]): InfoRow[] {
  const labels = new Set(anchorFixedRows().map((r) => r.label));
  return rows.filter((r) => labels.has(String(r["item"] ?? "").trim()));
}

export interface StageSummaryResult {
  markdown: string;
  completeness: StageCompleteness;
  stage: InfoStageId;
  /** 覆盖范围：`step` = 只讲这一步（右栏）；`stage` = 阶段级归纳（交付物装配） */
  scope: "step" | "stage";
}

/** 生成选项：传 `step` 即按**当前步骤**出总结（右栏用） */
export interface StageSummaryOptions {
  step?: number;
  /**
   * `brief`：右栏要点视图（只给来源地址 + 结论提醒），不生成整篇 Markdown
   *
   * 路由据此分流到 `getStageBrief`；`generateStageSummary` 本身仍只产整篇文档。
   */
  view?: "brief";
}

/** 要点视图结果（右栏「阶段总结」） */
export interface StageBriefResult {
  brief: StageBrief;
  completeness: StageCompleteness;
  stage: InfoStageId;
  /** 覆盖范围：`step` = 只讲这一步（右栏）；`stage` = 阶段级 */
  scope: "step" | "stage";
}

/**
 * 生成（并落库）阶段总结文档
 *
 * @param stage 原始阶段编号（可传旧编号 8）
 */
export function generateStageSummary(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
  options: StageSummaryOptions = {},
): StageSummaryResult {
  const id = normalizeStage(stage);
  const step = options.step;
  const tableCodes = step === undefined ? undefined : stepScope(step).tableCodes;
  const rowsByTable = readStageRowsByTable(db, scenario.id, id, tableCodes);
  const completeness = checkStageCompleteness({
    stage: id,
    rowsByTable,
    ...(tableCodes ? { tableCodes } : {}),
  });
  // v3.0：私有库按需创建，可能还没有 → 名字留空，不给模型编一个库名
  const productLine = ownLineOf(db, scenario.id);
  const markdown = buildStageSummary({
    stage: id,
    scenarioName: scenario.name,
    productLineName: productLine?.name,
    rowsByTable,
    completeness,
    ...(tableCodes ? { tableCodes } : {}),
    ...(step === undefined ? {} : { step }),
    // 只讲本步：不带用户诉求全文、不带上下游衔接（用户定调"不要整理整个过程"）
    scope: step === undefined ? "stage" : "step",
    // 诉求基准只在阶段级（交付物装配）出现
    ...(step === undefined ? { briefRawText: readBrief(db, scenario.id)?.raw_text } : {}),
  });
  // 步骤级总结是**即时推导**（确定性、毫秒级），不落库：库里那份是阶段级的，
  // 交付物装配要用它，两者混在一张表里会互相覆盖
  if (step === undefined) db.stageSummaryRepo.upsert(scenario.id, id, markdown);
  return { markdown, completeness, stage: id, scope: step === undefined ? "stage" : "step" };
}

/** 右栏来源列表上限（与领域层 buildStageBrief 同一口径：右栏窄，超过用户也读不完） */
const BRIEF_SOURCES_MAX = 20;
/** 调研来源标签截断长度（与行内来源一致，~24 字） */
const RESEARCH_LABEL_MAX = 24;

/** 调研标题截成可读标签；标题为空时退回 URL，链接仍然可点开 */
function researchLabel(title: string, url: string): string {
  const text = String(title ?? "").trim() || url;
  return Array.from(text).slice(0, RESEARCH_LABEL_MAX).join("");
}

/**
 * 把本步联网调研来源**前置合并**进右栏来源
 *
 * 调研先于分析：本步真跑过检索时，这些链接是第一手来源，排在行内来源之前；
 * 按 URL 去重（行内表也引用了同一链接时只留一条），总数仍 ≤20。
 *
 * 只收 `status === '有效'` 的记录——「检索失败」记录是给右栏说明「为什么没有链接」
 * 用的，不是来源，不能混进可点开的列表。
 */
function mergeResearchSources(
  db: DbInstance,
  scenarioId: string,
  step: number | undefined,
  sources: readonly StageBriefSource[],
): StageBriefSource[] {
  if (step === undefined || typeof db.researchRepo?.listByStep !== "function") return [...sources];
  let rows: Array<{ status: string; url: string; title: string }> = [];
  try {
    rows = db.researchRepo.listByStep(scenarioId, step);
  } catch {
    // 调研表不存在（极老库）等异常不能拖垮右栏
    return [...sources];
  }

  const out: StageBriefSource[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const url = String(row.url ?? "").trim();
    if (row.status !== "有效" || url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push({ label: researchLabel(row.title, url), url });
    if (out.length >= BRIEF_SOURCES_MAX) return out;
  }
  for (const source of sources) {
    const key = source.url !== "" ? source.url : `file:${source.file ?? source.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= BRIEF_SOURCES_MAX) break;
  }
  return out;
}

/**
 * 右栏要点视图（来源地址 + 结论提醒）
 *
 * 与整篇总结同一套表集口径（传 `step` 就只讲这一步），但**不写库、不产 Markdown**：
 * 内容全部由 `buildStageBrief` 从真实行确定性推导，毫秒级，可随每次进入面板重算。
 */
export function getStageBrief(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
  step?: number,
): StageBriefResult {
  const id = normalizeStage(stage);
  const tableCodes = step === undefined ? undefined : stepScope(step).tableCodes;
  const rowsByTable = readStageRowsByTable(db, scenario.id, id, tableCodes);
  const completeness = stageCompletenessOf(db, scenario.id, stage, step);
  const brief = buildStageBrief({
    stage: id,
    scenarioName: scenario.name,
    rowsByTable,
    completeness,
    ...(tableCodes ? { tableCodes } : {}),
    ...(step === undefined ? {} : { step }),
    scope: step === undefined ? "stage" : "step",
  });
  // 调研来源排最前（先调研、后分析；行内来源是分析结论自带的引用）
  const merged: StageBrief = {
    ...brief,
    sources: mergeResearchSources(db, scenario.id, step, brief.sources),
  };
  return { brief: merged, completeness, stage: id, scope: step === undefined ? "stage" : "step" };
}

/** 读已落库的总结；没有则即时生成（保证右栏永远有内容） */
export function getOrGenerateStageSummary(
  db: DbInstance,
  scenario: Scenario,
  stage: StageId,
  options: StageSummaryOptions = {},
): StageSummaryResult & { cached: boolean } {
  const id = normalizeStage(stage);
  // 步骤级：不读缓存（缓存存的是阶段级那份），每次按本步表集即时推导
  if (options.step !== undefined) {
    return { ...generateStageSummary(db, scenario, id, options), cached: false };
  }
  const existing = db.stageSummaryRepo.get(scenario.id, id);
  if (existing) {
    // 缓存命中也要给出最新完整度（缺口可能因编辑而变化）
    const rowsByTable = readStageRowsByTable(db, scenario.id, id);
    const completeness = checkStageCompleteness({ stage: id, rowsByTable });
    return { markdown: existing.content, completeness, stage: id, scope: "stage", cached: true };
  }
  return { ...generateStageSummary(db, scenario, id), cached: false };
}

/**
 * 阶段面板用：只给完整度（不做 LLM、不写库）
 *
 * @param step 传了就按**本步表集**算（右栏"只针对当前步骤"）；缺省整阶段
 */
export function stageCompletenessOf(
  db: DbInstance,
  scenarioId: string,
  stage: StageId,
  step?: number,
): StageCompleteness {
  const id = normalizeStage(stage);
  const tableCodes = step === undefined ? undefined : stepScope(step).tableCodes;
  const rowsByTable = readStageRowsByTable(db, scenarioId, id, tableCodes);
  return checkStageCompleteness({ stage: id, rowsByTable, ...(tableCodes ? { tableCodes } : {}) });
}

/**
 * 收集交付物所需的阶段总结（阶段 0-6）
 *
 * 交付物的内部报告正文就是这些总结的装配——不再有手写章节与结论。
 */
export function collectStageSummaries(
  db: DbInstance,
  scenario: Scenario,
): { stage: number; title: string; markdown: string }[] {
  const out: { stage: number; title: string; markdown: string }[] = [];
  for (const def of STAGE_DEFS) {
    if (def.id === 5) continue; // 交付物阶段本身不是总结内容
    const r = generateStageSummary(db, scenario, def.id);
    out.push({ stage: def.id, title: def.name, markdown: r.markdown });
  }
  return out;
}
