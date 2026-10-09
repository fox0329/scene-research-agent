import type { ApiCompleteness, ApiStageRow } from "../api";

/**
 * 阶段快照（右栏双 Tab 的数据面）
 *
 * 由 `RealStagePanel` 从真实响应聚合（rows + summary + 注册表），
 * 经 ProjectView 冒泡到 App，供右栏 `StageRightPanel` 渲染。
 *
 * 与旧 `DecisionSnapshot` 的区别：**不再有建议档位与质量关**——产品只产出信息，
 * 右栏只做两件事：① 显示中栏表格的补充说明类信息 ② 显示阶段总结文档。
 *
 * v1.19 又删掉了**确认清单**（`checklist`）：用户定调「用户确认就默认可以了」
 * 「表格用户自己可以修改，不用显示待确认」——逐项表态既不是用户能回答的问题，
 * 也不是产品该提的要求；确认收敛为表1-1 上的一次整表确认。
 *
 * 变更表 #150 行联动：中栏表格的「当前行」与右栏 Tab① 的条目按**同一个 rowId** 双向高亮，
 * 于是快照多带三样：当前行 id、上一次联动的发起方、以及上报入口。发起方是防抖的关键——
 * 只有"对方"才需要在必要时滚动，发起方自己不动（否则 A 滚 B、B 又滚回 A，两边来回抖）。
 *
 * 变更表 #149 清理（全仓 0 读取的死字段）：
 *  - `title` / `stage` / `stageLabel`：只为右栏页头生成「第 n/7 步 · 步骤名」，
 *    而页头与流程轴节点、中栏表头重复，已整块删除
 *  - `anchor` / `anchorSummary`：第 2–7 步右栏不消费表1-1
 *  - `SupplementRow` 的来源四字段：来源/证据等级本来就是补充说明列，另存一份没人读
 */

/** 补充说明列（右栏 Tab ①）：中栏表格放不下的说明类信息 */
export interface SupplementRow {
  id: string;
  row: Record<string, unknown>;
}

export interface SupplementTable {
  tableCode: string;
  tableName: string;
  columns: { key: string; label: string }[];
  rows: SupplementRow[];
}

/** 行联动的发起方：`mid`=中栏表格行，`right`=右栏条目内控件 */
export type RowLinkOrigin = "mid" | "right";

export interface StageSnapshot {
  /** 本阶段全部行（供补充列与统计） */
  rows: ApiStageRow[];
  completeness: ApiCompleteness | null;
  /** 阶段总结文档（Markdown；null=尚未生成） */
  summary: string | null;
  summaryLoading: boolean;
  /** 中栏当前显示的表（补充列只显示这张表的） */
  activeTable: string | null;
  /**
   * 中栏当前行（rowId）：中栏表格行与右栏 Tab① 条目按它同源高亮；
   * null = 没有当前行（换表/换块后清空，也用于第 1 步、交付物步这些没有对应关系的步）
   */
  activeRowId: string | null;
  /** 上一次行联动的发起方：中栏发起的才去滚右栏，右栏发起的才去滚中栏 */
  activeRowOrigin: RowLinkOrigin | null;
  /** 右栏 Tab①：当前表的补充说明列 */
  supplements: SupplementTable[];
  /** 重新生成阶段总结 */
  onRefreshSummary: () => void;
  /** 编辑补充列单元格 */
  onSupplementChange: (rowId: string, cell: string, value: string) => void;
  /** 中栏行被点/聚焦、或右栏条目内控件被点/聚焦：上报这一行与发起方 */
  onRowFocus: (rowId: string, origin: RowLinkOrigin) => void;
}
