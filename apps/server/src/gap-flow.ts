/**
 * @scene/server — 缺口流转闭环（MR2-T5，方案 6.4）
 *
 * completeness 缺口不再只是报告：userGaps → 澄清提醒（「该你拍板」，画像卡透出）；
 * agentGaps → 取证提示（复用既有研究链路，端点已有，透出表号供 UI 引导）。
 * 铁律：空单元格的出路只有取证/用户手填，不许填「行业通例（模型知识）」当来源。
 */

import type { DbInstance } from "@scene/infra";
import type { InfoStageId } from "@scene/contract";
import { runCheckPipeline, type PipelineFinding } from "./reflection-pipeline.js";
import { toPostcheckRows } from "./postcheck-pass.js";

export interface GapFlowResult {
  /** 该用户拍板的缺口（澄清提醒，落画像卡） */
  clarify_hints: { location: string; detail: string }[];
  /** 建议取证的表号（去重、保持首次出现序） */
  research_hints: string[];
}

/** 按 raw.owner 分流（completeness 路的发现才带 owner；其余路不参与流转） */
export function routeGaps(findings: readonly PipelineFinding[]): {
  userGaps: PipelineFinding[];
  agentGaps: PipelineFinding[];
  researchHints: string[];
} {
  const userGaps: PipelineFinding[] = [];
  const agentGaps: PipelineFinding[] = [];
  const researchHints: string[] = [];
  const seenTables = new Set<string>();

  for (const f of findings) {
    if (f.source !== "completeness") continue;
    const owner = (f.raw as { owner?: string }).owner;
    if (owner === "用户") userGaps.push(f);
    else if (owner === "智能体") {
      agentGaps.push(f);
      const table = f.location.split(":")[0] ?? "";
      if (table && !seenTables.has(table)) {
        seenTables.add(table);
        researchHints.push(table);
      }
    }
  }
  return { userGaps, agentGaps, researchHints };
}

/**
 * 全场景阶段快照下的缺口分流（轻量：确定性三路检查，不调模型）。
 * 挂在 GET requirements 上——画像卡打开即见「该你拍板」与「建议取证」。
 */
export function gapFlowHints(db: DbInstance, scenarioId: string): GapFlowResult {
  const project = db.scenarioRepo.getById(scenarioId);
  if (!project) return { clarify_hints: [], research_hints: [] };
  const stage = project.current_stage as InfoStageId;
  const rows = db.stageDataRepo.listByScenarioStage(scenarioId, stage);
  if (rows.length === 0) return { clarify_hints: [], research_hints: [] };

  const pipeline = runCheckPipeline({
    stage,
    postcheckRows: toPostcheckRows(
      rows.map((r) => ({
        tableCode: r.table_code,
        id: r.id,
        row: r.row as Record<string, unknown>,
        source: r.source ?? null,
        sourceType: r.source_type ?? null,
      })),
    ),
    rowsByTable: groupByTable(rows),
    entries: [],
    target: { text: rows.map((r) => JSON.stringify(r.row)).join("\n"), metrics: {} },
  });
  const { userGaps, agentGaps, researchHints } = routeGaps(pipeline.findings);
  void agentGaps;
  return {
    clarify_hints: userGaps.map((f) => ({ location: f.location, detail: f.detail })),
    research_hints: researchHints,
  };
}

function groupByTable(
  rows: { table_code: string; id: string; row: unknown }[],
): Record<string, { id: string; row: Record<string, unknown> }[]> {
  const out: Record<string, { id: string; row: Record<string, unknown> }[]> = {};
  for (const r of rows) {
    (out[r.table_code] ??= []).push({ id: r.id, row: r.row as Record<string, unknown> });
  }
  return out;
}
