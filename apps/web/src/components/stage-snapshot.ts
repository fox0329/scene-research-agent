import type { ApiStageBrief } from "../api";

/**
 * 阶段快照（右栏产物面板的数据面）
 *
 * 由 `RealStagePanel` / `AnchorStepPanel`（联真）与演示面板从各自数据聚合，
 * 经 ProjectView 冒泡到 App，供右栏 `ArtifactRightPanel` 渲染。
 *
 * v2（变更表 #295）：右栏以「某个阶段的某个产物」为最小单元，快照因此带
 * `artifact`；`brief` 仍是信息来源与结论提醒的唯一数据源，不另造一套。
 * `summary`（整篇 Markdown）只用于交付物装配，不再进右栏。
 */

/** 右栏要点（服务端/领域层 `buildStageBrief` 的产出） */
export type StageBriefView = ApiStageBrief["brief"];

/** 产物类型：与后端 scope_type 一致 */
export type ArtifactType = "anchor" | "table" | "deliverable";

/**
 * 右栏当前产物（v2 最小单元）
 *
 * 右栏的信息来源、备注、会话都属于它；`block` 只用于内容过滤与展示，
 * 不参与会话唯一性（同一张表的多个子块共用一条会话）。
 */
export interface ArtifactView {
  /** 流程步 1–6 */
  step: number;
  type: ArtifactType;
  /** 表号 / 表1-1 / solution */
  id: string;
  block?: string | null;
  /** 用户可见的产物名（业务名，不露表号） */
  title: string;
  /** 产物内容版本（可选）：内容变了但对象引用没变时，右栏靠它重算「产物已更新」 */
  revision?: string;
}

export interface StageSnapshot {
  summaryLoading: boolean;
  /** 本步要点：来源地址 + 结论提醒（null=还没取到）；信息来源 / 备注页的数据源 */
  brief: StageBriefView | null;
  /** 当前右栏锚定的产物；缺省（演示/旧面板）时不渲染产物会话 */
  artifact?: ArtifactView;
  /** 重新生成阶段总结（全文与要点一起刷新；全文只用于交付物装配） */
  onRefreshSummary: () => void;
  /**
   * 补跑本步联网调研（历史步骤没跑过调研时用）
   *
   * 为什么放在快照里：右栏是独立组件，它要知道"能不能补、补完怎么刷新"；
   * 具体请求由面板实现，右栏只负责触发与显示状态。
   */
  onResearch?: () => Promise<{ saved: number }>;
}
