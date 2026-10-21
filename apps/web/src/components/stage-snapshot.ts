import type { ApiStageBrief } from "../api";

/**
 * 阶段快照（右栏「阶段总结」的数据面）
 *
 * 由 `RealStagePanel` / `AnchorStepPanel`（联真）与演示面板从各自数据聚合，
 * 经 ProjectView 冒泡到 App，供右栏 `StageRightPanel` 渲染。
 *
 * v2.10（用户定调 2026-10-21）：「右栏的补充说明不需要，删除。保留阶段总结，
 * 阶段总结只列：调研信息来源的源地址，用户可以打开自己看；还有关于这个阶段的
 * 几个重点的结论性的提醒或建议」。于是右栏只剩「阶段总结」一个 Tab，数据面收敛为：
 *  - `brief`：要点（来源地址 + 结论提醒），由领域层 `buildStageBrief` 确定性推导
 *  - `summary`：整篇 Markdown，只留「查看全文」入口，正文不再贴
 *
 * 随之删除（右栏已无消费者）：
 *  - 补充说明条目（`supplements`）与其编辑入口（`onSupplementChange`）
 *  - 中栏 ↔ 右栏行联动（`activeRowId` / `activeRowOrigin` / `onRowFocus`）——
 *    联动的前提是右栏有同一 rowId 的条目，条目没了，联动也就没有对面
 *  - 完整度裸数字与 `rows`（完整度改由 `brief` 响应里的 `completeness` 承载，
 *    但右栏界面不显示它，故快照不再带）
 */

/** 右栏要点（服务端/领域层 `buildStageBrief` 的产出） */
export type StageBriefView = ApiStageBrief["brief"];

export interface StageSnapshot {
  summaryLoading: boolean;
  /** 本步要点：来源地址 + 结论提醒（null=还没取到）；右栏只显示这个，全文不再进界面 */
  brief: StageBriefView | null;
  /** 重新生成阶段总结（全文与要点一起刷新；全文只用于交付物装配） */
  onRefreshSummary: () => void;
}
