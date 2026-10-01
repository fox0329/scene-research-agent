import type { SourceType } from "@scene/contract";
import type { ApiAnchorRow, ApiCompleteness, ApiStageRow } from "../api";
import type { AnchorSummary } from "./definition-progress";
import { clipText, stripMetaNotes } from "./text-display";

/**
 * 阶段快照（v1.4 右栏双 Tab 的数据面）
 *
 * 由 `RealStagePanel` 从真实响应聚合（rows + completeness + summary + 注册表），
 * 经 ProjectView 冒泡到 App，供右栏 `StageRightPanel` 渲染。
 *
 * 与旧 `DecisionSnapshot` 的区别：**不再有建议档位与质量关**——产品只产出信息，
 * 右栏只做两件事：① 显示中栏表格的补充说明类信息 ② 显示阶段总结文档。
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

/** 确认清单项（三层：L1 场景本体 / L2 环节与角色 / L3 事实抽查） */
export interface ChecklistViewItem {
  layer: "L1" | "L2" | "L3";
  tableCode: string;
  rowKey: string;
  label: string;
  state: string;
  /**
   * 该项对应的**原始内容**（可选）
   *
   * 右栏只显示截断后的一行（完整内容看中栏表格）——不塞这个字段时右栏就不显示内容，
   * 避免"确认清单把整段内容再抄一遍"。
   */
  content?: string;
}

/** 右栏确认清单的目标字数上限（约 6 行首屏；完整内容看中栏） */
export const CHECKLIST_CLIP = 40;

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
  /** 右栏 Tab ①：确认清单（L1 只列「需要用户表态的项」，行数按返回数组，不假设） */
  checklist: ChecklistViewItem[];
  /** 场景锚（表1-1）当前内容，供确认清单与编辑 */
  anchor: ApiAnchorRow[];
  /** 表1-1 折叠态摘要口径（中栏折叠行与右栏页脚同源；缺省由右栏按 anchor 现算） */
  anchorSummary?: AnchorSummary;
  /** 重新生成阶段总结 */
  onRefreshSummary: () => void;
  /** 编辑补充列单元格 */
  onSupplementChange: (rowId: string, cell: string, value: string) => void;
  /** 确认/修改/否决一个锚行 */
  onAnchorAction: (item: string, action: "确认" | "修改", content?: string) => void;
}

/** 确认状态 → 徽标文案与色调 */
export const CONFIRM_STATE_BADGE: Record<string, { text: string; tone: string }> = {
  用户确认: { text: "已确认", tone: "ok" },
  用户修改: { text: "已补充", tone: "ok" },
  待确认: { text: "待确认", tone: "warn" },
  系统推断: { text: "待确认", tone: "warn" },
  用户否决: { text: "已否决", tone: "muted" },
};

/**
 * 把接口返回的 `source_type`（string）收窄为契约枚举
 *
 * 接口层刻意用宽松类型（后端可能返回历史值），进入纯逻辑前必须收窄——
 * 否则「自称用户确认」这类脏值会被当成合法来源标记。
 */
export function asSourceType(v: unknown): SourceType | null {
  return v === "AI提取" || v === "AI推断" || v === "用户确认" || v === "用户补充" ? v : null;
}

/**
 * 确认清单项 → 一行内容（L1 取表1-1 锚行内容；L2 取表1-2 该环节的参与程度/角色）
 *
 * 只给右栏看，所以这里就**按上限截断并剥掉元说明**——右栏不再重复整段内容。
 * 认不出对应行时返回空串（调用方显示「—」）。
 */
export function checklistContent(
  tableCode: string,
  rowKey: string,
  anchor: readonly ApiAnchorRow[],
  stageRows: readonly ApiStageRow[] = [],
): string {
  if (tableCode === "表1-1") {
    const row = anchor.find((a) => a.item === rowKey);
    return stripMetaNotes(String(row?.content ?? ""));
  }
  if (tableCode === "表1-2") {
    const [link, field] = rowKey.split(" · ");
    const key = field === "我方角色" ? "our_role" : "can_touch";
    const row = stageRows.find(
      (r) => r.table_code === "表1-2" && String(r.row["link"] ?? "").trim() === String(link).trim(),
    );
    return stripMetaNotes(String(row?.row[key] ?? ""));
  }
  return "";
}

/** 一行内容 → 展示文本（空 → 占位符；超长 → 截断 + …） */
export function checklistContentText(tableCode: string, rowKey: string, raw: string): string {
  const text = clipText(raw, CHECKLIST_CLIP);
  if (text) return text;
  return tableCode === "表1-2" ? "见中栏表1-2" : "—";
}
