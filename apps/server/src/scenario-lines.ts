/**
 * 一个场景"吃哪些产品线"的唯一口径（F2 上下文控制 + 失效反查 + 成本重算共用）
 *
 * 规矩（v3.0 起，变更表 #160，用户定调）：
 * **本场景私有库（可能还没有）+ 默认引用的通用库**。
 *
 * - **通用库**（`product_line.scenario_id IS NULL`，如「拓维产品」）是产品资料基础设施，
 *   上传一次全场景共用；用户在「本场景资料」里取消勾选 = 显式排除
 *   （`scenario_linked_line.excluded = 1`）。表里没有行 = 默认引用（存量场景无需回填）。
 * - **私有库**（`product_line.scenario_id = 本场景`）**按需创建**：新建场景不再自动建库，
 *   场景里第一次上传材料时才建；空私有库**可删**，删掉就回到"只用通用库"的状态。
 *   关系只存在 `product_line.scenario_id` 这一处（单一属主），所以删库不需要回头改场景。
 *
 * 为什么抽出来：这段语义原先只写在 `advance-stage` 里，失效反查（routes-ui）自己另写了
 * 一份简化版，于是**改通用库费率一个场景都标不上**（故障 #26）。三处（注入 / 标脏 / 重算）
 * 必须同一口径，否则数字与提示会各说各话。
 */

import { randomUUID } from "node:crypto";
import type { DbInstance } from "@scene/infra";
import type { ProductLine, Scenario } from "@scene/contract";

export interface ScenarioLineContext {
  /** 本场景私有库 id；**还没有私有库时为 null**（首次上传材料时按需创建） */
  ownLineId: string | null;
  /** 通用库（已排除用户显式取消的） */
  globalLines: ProductLine[];
  /** 本场景的资料来源：私有库（若有）在前，其后是通用库 */
  lineIds: string[];
  /** 这一行资料算"本场景"还是"主库：<名>" */
  scopeOf(lineId: string): string;
  /** 该行资料是否来自本场景私有库 */
  isOwn(lineId: string): boolean;
}

/**
 * 本场景的私有库（0 或 1 条）
 *
 * 关系存在 `product_line.scenario_id` 上；异常出现多条时取**最早创建**的一条（确定性），
 * 不去猜"哪条才是真的"——多条本身说明数据脏了，界面上还看得见，删掉多余的那条即可。
 */
export function ownLineOf(db: DbInstance, scenarioId: string): ProductLine | undefined {
  if (!scenarioId) return undefined;
  const lines = db.productLineRepo.list({
    where: "scenario_id = ?",
    params: [scenarioId],
    orderBy: "created_at ASC",
  });
  return lines[0];
}

/** 本场景私有库 id；没有则 null */
export function ownLineIdOf(db: DbInstance, scenarioId: string): string | null {
  return ownLineOf(db, scenarioId)?.id ?? null;
}

/**
 * 取本场景私有库；没有就**按需建一条**（幂等）
 *
 * 调用时机：用户在场景里第一次上传材料。别的地方（读路径）一律用 `ownLineOf`，
 * 不要顺手建库——否则"按需创建"又变回"到处都在建空库"。
 */
export function ensureOwnLine(
  db: DbInstance,
  scenario: Scenario,
): { line: ProductLine; created: boolean } {
  const existing = ownLineOf(db, scenario.id);
  /* created 必须如实：调用方要据此告诉用户"新建了一个库"还是"本来就有"，
     所以只有真走到 insert 这一条路才为 true（不能拿 created_at === updated_at 猜）。 */
  if (existing) return { line: existing, created: false };
  const lineName = `${scenario.name}·专属资料`;
  const taken = new Set(db.productLineRepo.list().map((l) => l.name));
  const name = taken.has(lineName) ? `${lineName}-${randomUUID().slice(0, 4)}` : lineName;
  return { line: db.productLineRepo.insert({ name, scenario_id: scenario.id }), created: true };
}

/** 解析场景的资料来源（调用方保证 scenario 存在） */
export function scenarioLineContext(db: DbInstance, scenario: Scenario): ScenarioLineContext {
  const ownLineId = ownLineIdOf(db, scenario.id);
  const excludedLineIds = new Set(
    db.scenarioLinkedLineRepo
      .list({ where: "scenario_id = ?", params: [scenario.id] })
      .filter((l) => Boolean(l.excluded))
      .map((l) => l.product_line_id),
  );
  const globalLines = db.productLineRepo
    .list({ where: "scenario_id IS NULL", orderBy: "created_at ASC" })
    .filter((l) => !excludedLineIds.has(l.id));
  const lineIds = [...new Set([...(ownLineId ? [ownLineId] : []), ...globalLines.map((l) => l.id)])];
  return {
    ownLineId,
    globalLines,
    lineIds,
    isOwn: (lineId) => Boolean(ownLineId) && lineId === ownLineId,
    scopeOf: (lineId) => {
      if (ownLineId && lineId === ownLineId) return "本场景";
      const global = globalLines.find((l) => l.id === lineId);
      // 场景级行的 product_line_id 为空（如场景认识草稿），归到"主库"一说即可
      return global ? `主库：${global.name}` : "主库";
    },
  };
}

/** 该产品线是不是通用库（`scenario_id` 为空 = 不挂任何场景，靠默认引用生效） */
export function isGlobalLibraryLine(line: ProductLine | undefined): boolean {
  return Boolean(line) && !line?.scenario_id;
}
