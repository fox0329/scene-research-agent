/**
 * 投资回报的**读数与计算**（公式在 `@scene/domain/roi.ts`，本文件只负责查表）
 *
 * 为什么是一个只读接口而不是写库：投资回报是**派生值**（契约 `COMPUTED_CARDS.roi`
 * 明确「派生值若让模型填，必然与表5-5/表6-1 不一致」）。每次读的时候按当前两张表算，
 * 用户改表6-1 的年收益、或重算表5-5 的投入，回收期立刻跟着变——没有中间状态要同步。
 *
 * 缺输入（表6-1 没填年收益 / 表5-5 没有汇总行）时**不给数字**，返回 `blocked` 说明缺什么。
 */

import { computeRoi, investmentFromCostRows, type RoiSummary } from "@scene/domain";
import type { DbInstance } from "@scene/infra";

export interface RoiReport extends RoiSummary {
  /** 表5-5 现有行数（0 = 还没生成成本估算） */
  costRows: number;
  /** 表6-1 现有行数（0 = 还没生成价值与指标） */
  valueRows: number;
}

/** 读场景的 表5-5 + 表6-1，算投资回报；场景不存在返回 undefined */
export function computeScenarioRoi(db: DbInstance, scenarioId: string): RoiReport | undefined {
  const scenario = db.scenarioRepo.getById(scenarioId);
  if (!scenario) return undefined;

  const cost = db.stageDataRepo
    .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, "表5-5"] })
    .map((r) => r.row as Record<string, unknown>);
  const values = db.stageDataRepo
    .list({ where: "scenario_id = ? AND table_code = ?", params: [scenarioId, "表6-1"] })
    .map((r) => r.row as Record<string, unknown>);

  return {
    ...computeRoi({ investment: investmentFromCostRows(cost), valueRows: values }),
    costRows: cost.length,
    valueRows: values.length,
  };
}
