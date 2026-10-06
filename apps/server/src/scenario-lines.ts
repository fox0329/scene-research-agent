/**
 * 一个场景"吃哪些产品线"的唯一口径（F2 上下文控制 + 失效反查 + 成本重算共用）
 *
 * 规矩（v2.9 起，用户定调）：本场景专属库 + **默认引用的通用库**。
 * 通用库（`product_line.scenario_id IS NULL`，如「拓维产品」）是产品资料基础设施，
 * 上传一次全场景共用；用户在「本场景资料」里取消勾选 = 显式排除
 * （`scenario_linked_line.excluded = 1`）。表里没有行 = 默认引用（存量场景无需回填）。
 *
 * 为什么要抽出来：这段语义原先只写在 `advance-stage` 里，失效反查（routes-ui）
 * 自己另写了一份"只按场景的 product_line_id"的简化版，于是**改通用库费率一个场景都标不上**
 * （故障 #26）。三处（注入 / 标脏 / 重算）必须同一口径，否则数字与提示会各说各话。
 */

import type { DbInstance } from "@scene/infra";
import type { ProductLine, Scenario } from "@scene/contract";

export interface ScenarioLineContext {
  /** 本场景专属库 */
  ownLineId: string;
  /** 通用库（已排除用户显式取消的） */
  globalLines: ProductLine[];
  /** 本场景的资料来源：专属库在前，其后是通用库 */
  lineIds: string[];
  /** 这一行资料算"本场景"还是"主库：<名>" */
  scopeOf(lineId: string): string;
  /** 该行资料是否来自本场景专属库 */
  isOwn(lineId: string): boolean;
}

/** 解析场景的资料来源（调用方保证 scenario 存在） */
export function scenarioLineContext(db: DbInstance, scenario: Scenario): ScenarioLineContext {
  const ownLineId = scenario.product_line_id;
  const excludedLineIds = new Set(
    db.scenarioLinkedLineRepo
      .list({ where: "scenario_id = ?", params: [scenario.id] })
      .filter((l) => Boolean(l.excluded))
      .map((l) => l.product_line_id),
  );
  const globalLines = db.productLineRepo
    .list({ where: "scenario_id IS NULL" })
    .filter((l) => !excludedLineIds.has(l.id));
  const lineIds = [...new Set([ownLineId, ...globalLines.map((l) => l.id)])];
  return {
    ownLineId,
    globalLines,
    lineIds,
    isOwn: (lineId) => lineId === ownLineId,
    scopeOf: (lineId) => {
      if (lineId === ownLineId) return "本场景";
      const global = globalLines.find((l) => l.id === lineId);
      return `主库：${global?.name ?? lineId}`;
    },
  };
}

/** 该产品线是不是通用库（`scenario_id` 为空 = 不挂任何场景，靠默认引用生效） */
export function isGlobalLibraryLine(line: ProductLine | undefined): boolean {
  return Boolean(line) && !line?.scenario_id;
}
