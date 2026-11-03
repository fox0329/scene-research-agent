/**
 * @scene/server — refine-output 单次重写（MR2-T3，方案 6.3/6.5）
 *
 * 管线必改清单 → **单次** DSH 重写（token 熔断：每场景每日调用上限）→ 重写后复查
 * （decideRound 第 2 轮）→ 输出行级差分。差分**不落库**：两道关卡的第二道（用户确认
 * 应用/忽略）由 T4 差分预览 UI 走既有 stage-data PATCH。
 */

import type { DshClient, InfoStageId, StageData } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { randomUUID } from "node:crypto";
import {
  decideRound,
  evaluateEntries,
  excludeDismissed,
  type AnchorTarget,
  type AnchorViolation,
} from "@scene/domain";
import { runCheckPipeline, type PipelineFinding } from "./reflection-pipeline.js";
import { listRequirements } from "./requirement-profile.js";
import { makeSourceLookup, toPostcheckRows } from "./postcheck-pass.js";

const DEFAULT_DAILY_CALL_LIMIT = 20;
/** 重写输入只给必改项相关行（G-0.3：上下文只给必要的） */
const REWRITE_ROW_LIMIT = 20;

export interface RefineDeps {
  db: DbInstance;
  dshClient: DshClient;
  dailyCallLimit?: number;
  now?: () => Date;
}

export interface CellDiff {
  tableCode: string;
  rowId: string;
  cell: string;
  oldValue: string;
  newValue: string;
  /** 触发本次修改的画像条目（回链） */
  entryId?: string;
}

export interface RefineOutcome {
  skipped: boolean;
  reason?: "clean" | "over-limit" | "no-rows";
  /** 管线全量发现（UI 展示用） */
  findings: PipelineFinding[];
  /** 建议差分（未落库，等用户确认） */
  diffs: CellDiff[];
  /** 重写后复查仍违反的锚点（如实报告，不触发第三轮） */
  remaining: AnchorViolation[];
}

export interface RefineCommand {
  refine(input: { scenarioId: string; stage: InfoStageId; tableCodes?: string[] }): Promise<RefineOutcome>;
}

export function createRefineCommand(deps: RefineDeps): RefineCommand {
  const dailyLimit = deps.dailyCallLimit ?? DEFAULT_DAILY_CALL_LIMIT;
  const now = deps.now ?? (() => new Date());
  const callDates = new Map<string, string>();
  const callCounts = new Map<string, number>();

  function isOverLimit(scenarioId: string): boolean {
    const today = now().toISOString().slice(0, 10);
    if (callDates.get(scenarioId) !== today) {
      callDates.set(scenarioId, today);
      callCounts.set(scenarioId, 0);
    }
    return (callCounts.get(scenarioId) ?? 0) >= dailyLimit;
  }

  /** 行 → 产物代入物：中栏文本拼接 + 表行数作为基础度量（页数/字数由调用方按导出口径折算后经 entries 锚点用） */
  function targetOf(rows: StageData[]): AnchorTarget {
    const text = rows
      .map((r) => JSON.stringify(r.row))
      .join("\n");
    return { text, metrics: { 行数: rows.length } };
  }

  return {
    async refine({ scenarioId, stage, tableCodes }) {
      const empty: RefineOutcome = { skipped: true, findings: [], diffs: [], remaining: [] };
      const rows = deps.db.stageDataRepo.listByScenarioStage(scenarioId, stage as never);
      const scoped = tableCodes ? rows.filter((r) => tableCodes.includes(r.table_code)) : rows;
      if (scoped.length === 0) return { ...empty, reason: "no-rows" };

      const entries = listRequirements(deps.db, scenarioId);
      const target = targetOf(scoped);
      const pipeline = runCheckPipeline({
        stage,
        postcheckRows: toPostcheckRows(
          scoped.map((r) => ({
            tableCode: r.table_code,
            id: r.id,
            row: r.row as Record<string, unknown>,
            source: r.source ?? null,
            sourceType: r.source_type ?? null,
          })),
        ),
        rowsByTable: groupByTable(scoped),
        entries,
        target,
        // 来源核查走材料库真查（假查会把所有带出处的行误判「出处查不到」硬伤）
        lookup: makeSourceLookup(deps.db),
        ...(tableCodes !== undefined ? { tableCodes } : {}),
      });

      const mandatory = pipeline.findings.filter((f) => f.level === "mandatory");
      if (mandatory.length === 0) return { ...empty, reason: "clean", findings: pipeline.findings };
      if (isOverLimit(scenarioId)) return { ...empty, reason: "over-limit", findings: pipeline.findings };
      callCounts.set(scenarioId, (callCounts.get(scenarioId) ?? 0) + 1);

      const diffs = await rewriteOnce(deps.dshClient, scoped, mandatory, target);
      // 重写后复查（第 2 轮）：锚点按「假定差分全部应用」的文本比对，仍违反的如实报告
      const afterText = applyDiffsToText(target.text, scoped, diffs);
      const remaining = evaluateEntries(
        excludeDismissed([...entries], new Set()),
        { text: afterText, metrics: target.metrics },
      );
      return {
        skipped: false,
        findings: pipeline.findings,
        diffs,
        remaining: decideRound(2, remaining).action === "stop" ? remaining : [],
      };
    },
  };
}

function groupByTable(rows: StageData[]): Record<string, { id: string; row: Record<string, unknown> }[]> {
  const out: Record<string, { id: string; row: Record<string, unknown> }[]> = {};
  for (const r of rows) {
    (out[r.table_code] ??= []).push({ id: r.id, row: r.row as Record<string, unknown> });
  }
  return out;
}

const REWRITE_SYSTEM = `你是产出物修订器。按必改清单重写表格行的中栏内容。
输入：行的现状（JSON）+ 必改清单。输出 JSON 数组：
[{"rowId":"行id","cell":"要改的列名","newValue":"改后的内容"}]
规则：只改必改清单涉及的格子；一格一句话、结论先行、来源写右栏不进中栏；没把握的格子不动。没有可改的就输出 []。`;

async function rewriteOnce(
  dshClient: DshClient,
  rows: StageData[],
  mandatory: PipelineFinding[],
  target: AnchorTarget,
): Promise<CellDiff[]> {
  const scopedRows = rows.slice(0, REWRITE_ROW_LIMIT);
  const user = [
    "【行现状】",
    ...scopedRows.map((r) => `${r.table_code} ${r.id}: ${JSON.stringify(r.row)}`),
    "",
    "【必改清单】",
    ...mandatory.map((f) => `${f.location} ${f.detail}`),
    "",
    `【锚点度量】${JSON.stringify(target.metrics)}`,
  ].join("\n");
  try {
    const session = await dshClient.createSession({ title: "反思重写" });
    let out = "";
    for await (const ev of dshClient.prompt(session, {
      system: REWRITE_SYSTEM,
      user,
      outputContract: { type: "json_array" },
    })) {
      const e = ev as { type: string; text?: string };
      if (e.type === "text" && e.text) out += e.text;
    }
    await dshClient.cancel(session);
    return parseDiffs(out, scopedRows);
  } catch {
    return []; // 重写失败返回空差分：宁可漏改不可误改，不阻断
  }
}

function parseDiffs(raw: string, rows: StageData[]): CellDiff[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: CellDiff[] = [];
  for (const item of parsed) {
    const o = item as Record<string, unknown>;
    const rowId = typeof o.rowId === "string" ? o.rowId : "";
    const cell = typeof o.cell === "string" ? o.cell : "";
    const newValue = typeof o.newValue === "string" ? o.newValue : "";
    const row = byId.get(rowId);
    if (!rowId || !cell || !newValue || !row) continue;
    const oldValue = String((row.row as Record<string, unknown>)[cell] ?? "");
    if (newValue === oldValue) continue;
    out.push({ tableCode: row.table_code, rowId, cell, oldValue, newValue });
  }
  return out;
}

/** 假定差分全部应用后的文本（复查用，不落库） */
function applyDiffsToText(baseText: string, rows: StageData[], diffs: CellDiff[]): string {
  if (diffs.length === 0) return baseText;
  const diffByRow = new Map<string, CellDiff[]>();
  for (const d of diffs) {
    diffByRow.set(d.rowId, [...(diffByRow.get(d.rowId) ?? []), d]);
  }
  return rows
    .map((r) => {
      const rowDiffs = diffByRow.get(r.id);
      if (!rowDiffs) return JSON.stringify(r.row);
      const nextRow = { ...(r.row as Record<string, unknown>) };
      for (const d of rowDiffs) nextRow[d.cell] = d.newValue;
      return JSON.stringify(nextRow);
    })
    .join("\n");
}

/** 防止 randomUUID 被树摇掉：差分 id 预留给 T4 应用确认时的回执关联 */
export const REFINE_DIFF_ID_PREFIX = "rd-";
export function newDiffId(): string {
  return `${REFINE_DIFF_ID_PREFIX}${randomUUID()}`;
}
