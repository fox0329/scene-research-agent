import type { SourceType } from "@scene/contract";
import type { ApiAnchorRow, ApiCompleteness, ApiStageRow } from "../api";
import type { AnchorSummary } from "./definition-progress";

/**
 * 阶段快照（右栏双 Tab 的数据面）
 *
 * 由 `RealStagePanel` 从真实响应聚合（rows + completeness + summary + 注册表），
 * 经 ProjectView 冒泡到 App，供右栏 `StageRightPanel` 渲染。
 *
 * 与旧 `DecisionSnapshot` 的区别：**不再有建议档位与质量关**——产品只产出信息，
 * 右栏只做两件事：① 显示中栏表格的补充说明类信息 ② 显示阶段总结文档。
 *
 * v1.19 又删掉了**确认清单**（`checklist`）：用户定调「用户确认就默认可以了」
 * 「表格用户自己可以修改，不用显示待确认」——逐项表态既不是用户能回答的问题，
 * 也不是产品该提的要求；确认收敛为表1-1 上的一次整表确认。
 */

/** 补充说明列（右栏 Tab ①）：中栏表格放不下的说明类信息 */
export interface SupplementRow {
  id: string;
  row: Record<string, unknown>;
  /** 该行的来源标记（AI提取 / AI推断 / 用户确认 / 用户补充） */
  sourceType?: string | null;
  source?: string | null;
  evidenceLevel?: string | null;
  authority?: string | null;
}

export interface SupplementTable {
  tableCode: string;
  tableName: string;
  columns: { key: string; label: string }[];
  rows: SupplementRow[];
}

export interface StageSnapshot {
  stage: number;
  stageLabel: string;
  /**
   * 右栏页头标题（v1.5 流程化）
   *
   * 阶段号已不再是用户的导航单位（导航是「第 n/8 步」），因此面板可以给出
   * 自己的标题；缺省时右栏退回「阶段 n · label」。
   */
  title?: string;
  /** 本阶段全部行（供补充列与统计） */
  rows: ApiStageRow[];
  completeness: ApiCompleteness | null;
  /** 阶段总结文档（Markdown；null=尚未生成） */
  summary: string | null;
  summaryLoading: boolean;
  /** 中栏当前显示的表（补充列只显示这张表的） */
  activeTable: string | null;
  /** 右栏 Tab ①：当前表的补充说明列 */
  supplements: SupplementTable[];
  /**
   * 场景锚（表1-1）当前内容
   *
   * 可选：v1.20 起第 2–8 步中栏不再显示表1-1（用户定调「上一步的信息不用在这一步显示」），
   * 右栏也不消费它；只有第 1 步的锚面板还会带。
   */
  anchor?: ApiAnchorRow[];
  /** 表1-1 折叠态摘要口径（中栏折叠行与右栏页脚同源；缺省由右栏按 anchor 现算） */
  anchorSummary?: AnchorSummary;
  /** 重新生成阶段总结 */
  onRefreshSummary: () => void;
  /**
   * 表5-5 成本重算入口（只有这一步确实有成本表时才有）
   *
   * 为什么放在右栏而不是中栏：用户定调 v1.20「中栏只有信息，没有动作」。
   */
  costRecompute?: {
    running: boolean;
    /** 上一次重算的结果（缺单价 / 仍标待确认 / 改了哪些），null = 还没跑过 */
    note: string | null;
    onRun: () => void;
  };
  /** 编辑补充列单元格 */
  onSupplementChange: (rowId: string, cell: string, value: string) => void;
}

/**
 * 把接口返回的 `source_type`（string）收窄为契约枚举
 *
 * 接口层刻意用宽松类型（后端可能返回历史值），进入纯逻辑前必须收窄——
 * 否则「自称用户确认」这类脏值会被当成合法来源标记。
 */
export function asSourceType(v: unknown): SourceType | null {
  return v === "AI提取" || v === "AI推断" || v === "用户确认" || v === "用户补充" ? v : null;
}
