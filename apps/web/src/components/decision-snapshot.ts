import type { AdviceLevelApi } from "../api";

/**
 * 决策支撑快照（M5-T5.6 右栏联真）
 * 由 RealStagePanel 从真实 stagePanel 响应（rows/gates/advice）聚合而来，
 * 经 ProjectView 冒泡到 App，供右栏 DecisionPanel 渲染；演示模式不使用。
 */
export interface DecisionSnapshot {
  stage: number;
  stageLabel: string;
  /** 领域层三档建议（LLM 不参与判定，来自 gate 计算） */
  advice: AdviceLevelApi | null;
  gateTotal: number;
  gatePassed: number;
  /** 未通过/未检的质量关条目 */
  failedGates: { itemNo: string; title: string; detail: string; result: string }[];
  rowCount: number;
  /** source_type=用户确认 的行数 */
  userConfirmed: number;
  /** 资料待重算行数 */
  staleCount: number;
  /** 证据等级分布（A/B/C/D → 行数） */
  evidenceDist: Record<string, number>;
  /** 来源权威性分布（T1-T4 → 行数） */
  authorityDist: Record<string, number>;
}

/** 建议档位 → 徽标样式（与 AdviceCard 三档一致） */
export const ADVICE_BADGE: Record<AdviceLevelApi, string> = {
  建议通过: "success",
  建议有条件通过: "warning",
  建议不通过: "danger",
};
