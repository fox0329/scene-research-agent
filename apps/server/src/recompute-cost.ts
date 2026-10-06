/**
 * 表5-5 成本估算**确定性重算的落库**（公式在 `@scene/domain`，本文件只负责读写）
 *
 * 计算值的溯源写在行的 `source` 列（右栏）：`系统计算：「项」表5-3 人天(N) × M6「项」单价(R)`；
 * `source_type` 不动（四种取值受库级 CHECK 约束，且"谁写进库的"没变）。
 *
 * 什么时候跑：
 * 1. 阶段 4（方案与实现）生成收尾——模型写完表5-5 后立刻按公式校正一遍，
 *    免得"模型心里的 1500"与"M6 里的 1000"各说各话（不删行，只改数与补齐）；
 * 2. 用户点「按 M6 费率重算」——改完内部费率不必整步重跑（重跑一次要几分钟且结果会变）。
 *
 * 边界：
 * - 表5-5 还没生成 → 不硬造表，如实返回 `tableRows: 0`；
 * - 数据没变 → 不动库、不标下游（避免无谓的"待重算"提示）；
 * - 数字变了 → 按 `TABLE_DEPENDENCIES`（表5-5 → 阶段 5、6）标下游待重算（故障 #26 的闭环）。
 */

import { getAffectedStages, recomputeCostRows, type CostRateItem } from "@scene/domain";
import type { StageId, TableCode } from "@scene/contract";
import type { DbInstance } from "@scene/infra";
import { scenarioLineContext } from "./scenario-lines.js";

export interface CostRecomputeReport {
  /** 表5-5 现有行数（0 = 这一场景还没生成成本表） */
  tableRows: number;
  /** 数值被改写的行数 */
  changedRows: number;
  /** 按表5-3 补出来的行数（原先漏项） */
  addedRows: number;
  /** M6 没有可用单价（无该行或单价 ≤ 0）的项 */
  missingRates: string[];
  /** 用上了、但 M6 仍标「待确认」的单价项（报价前须确认来源） */
  pendingRates: string[];
  /** 应有却没有的汇总行 */
  missingTotals: string[];
  /** 人工块里模型自造的行（既不属表5-3、M6 也认不出）→ 不补行，避免重复计费 */
  unmatchedLabor: string[];
  /** 重算后的各子块合计（元） */
  totals: { hardware: number; labor: number; operation: number; total: number };
  /** 因数字变化而被标「待重算」的下游阶段 */
  markedStages: StageId[];
}

/**
 * 重算一个场景的表5-5（金额、汇总）；找不到场景返回 undefined
 *
 * 人天来自表5-3（分析结论），单价来自 M6（本场景专属库 + 通用库，本场景优先）。
 */
export function recomputeScenarioCost(
  db: DbInstance,
  scenarioId: string,
): CostRecomputeReport | undefined {
  const scenario = db.scenarioRepo.getById(scenarioId);
  if (!scenario) return undefined;
  const context = scenarioLineContext(db, scenario);
  const inLines = `(${context.lineIds.map(() => "?").join(",")})`;

  const plans = db.stageDataRepo
    .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, "表5-3"] })
    .map((row) => ({
      item: String((row.row as Record<string, unknown>)["item"] ?? ""),
      man_days: Number((row.row as Record<string, unknown>)["man_days"] ?? 0),
    }))
    .filter((plan) => plan.item !== "");

  const rates: CostRateItem[] = db.costRateRepo
    .list({ where: `product_line_id IN ${inLines}`, params: context.lineIds })
    .map((rate) => ({
      item: String(rate.item ?? ""),
      rate: Number(rate.rate ?? 0),
      unit: rate.unit ?? null,
      data_source: rate.data_source ?? null,
      scope: context.isOwn(rate.product_line_id) ? "own" : "library",
    }));

  const costRows = db.stageDataRepo.list({
    where: "scenario_id = ? AND table_code = ?",
    params: [scenarioId, "表5-5"],
  });
  if (costRows.length === 0) {
    return {
      tableRows: 0,
      changedRows: 0,
      addedRows: 0,
      missingRates: [],
      pendingRates: [],
      missingTotals: [],
      unmatchedLabor: [],
      totals: { hardware: 0, labor: 0, operation: 0, total: 0 },
      markedStages: [],
    };
  }

  const result = recomputeCostRows({
    rows: costRows.map((row) => row.row as Record<string, unknown>),
    plans,
    rates,
  });

  /** 逐行比对：只有真变了才写库（避免 updated_at 空刷） */
  const mutated = result.rows
    .map((row, index) => ({ row, existing: costRows[index]! }))
    .filter(({ row, existing }) => JSON.stringify(row) !== JSON.stringify(existing.row));

  db.db.transaction(() => {
    for (const { row, existing } of mutated) {
      /* 只改数与出处：`source_type` 是"谁写进库的"（四种受 SQLite CHECK 约束），
         计算值写进右栏 `source` 列——那是溯源字段该待的地方。
         （若将来要让「系统计算」成为一等来源类型，得重建 stage_data 放宽 CHECK，见变更表 #103） */
      db.stageDataRepo.update(existing.id, { row });
    }
    for (const row of result.added) {
      db.stageDataRepo.insert({
        scenario_id: scenarioId,
        stage: 4 as StageId,
        table_code: "表5-5" as TableCode,
        row,
        is_stale: false,
        source: String(row["source"] ?? ""),
        source_authority: "T3",
        evidence_level: "B",
      });
    }
  })();

  const touched = mutated.length + result.added.length;
  const markedStages = touched > 0 ? getAffectedStages("表5-5") : [];
  if (markedStages.length > 0) {
    db.stageDataRepo.markStale(scenarioId, markedStages, true);
  }

  return {
    tableRows: costRows.length,
    changedRows: mutated.length,
    addedRows: result.added.length,
    missingRates: result.missingRates,
    pendingRates: result.pendingRates,
    missingTotals: result.missingTotals,
    unmatchedLabor: result.unmatchedLabor,
    totals: result.totals,
    markedStages,
  };
}
