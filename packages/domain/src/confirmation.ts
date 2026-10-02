/**
 * confirmation — 确认机制（对应 04 §4.7）
 *
 * 解决的问题：阶段 1 的信息来源是「用户只给了场景名 + 材料 + 检索」，
 * 系统理解的场景未必是用户要的——必须有"确认"闭环，且**基准是用户原始诉求**，
 * 不能是系统起草的场景锚（拿它当基准等于自己验证自己）。
 *
 * 口径变更（2026-09-26，用户定调）：
 *  「用户只负责输入场景名称，智能体负责从业务角度说清楚场景的范围」
 *  「用户确认就默认可以了，表格用户自己可以修改，**不用显示待确认**」
 *
 * 因此本模块**不再产出逐项"待确认清单"**（那等于把智能体的活变成用户的填空题）：
 *  - 逐项清单（L1/L2/L3）与待确认计数已删除；表1-1 的确认是**一次整表确认**（不卡推进）
 *  - 保留**数据语义**的状态机：`来源标记` 决定一行能否被下游当依据
 *  - 保留**对照**能力（`alignmentWithBrief`）：把"智能体理解的范围"摆出来，用户看一眼改不改
 *
 * 铁律：**只有『用户确认』『用户补充』可被下游当依据**；其余引用时带"未确认"标记。
 */

import { TABLES_BY_CODE, type FixedRow } from "@scene/contract";
import { isEmptyValue, type InfoRow } from "./completeness.js";

export type { InfoRow } from "./completeness.js";

// ─── 状态机 ────────────────────────────────────────────────

/** 确认状态 */
export type ConfirmState = "系统推断" | "待确认" | "用户确认" | "用户修改" | "用户否决";

/** 用户可执行的动作 */
export type ConfirmAction = "确认" | "修改" | "否决";

const STATES: readonly ConfirmState[] = ["系统推断", "待确认", "用户确认", "用户修改", "用户否决"];

/** 推导一行的确认状态（显式 `confirm_state` 优先，否则由 `source_type` 推导） */
export function confirmStateOf(row: InfoRow): ConfirmState {
  const explicit = row["confirm_state"];
  if (typeof explicit === "string" && (STATES as readonly string[]).includes(explicit)) {
    return explicit as ConfirmState;
  }
  switch (row.source_type) {
    case "用户确认":
      return "用户确认";
    case "用户补充":
      return "用户修改";
    case "AI推断":
      return "待确认";
    default:
      return "系统推断";
  }
}

/** 该行能否被下游当依据（只有用户确认/用户补充可以） */
export function usableDownstream(row: InfoRow): boolean {
  const s = confirmStateOf(row);
  return s === "用户确认" || s === "用户修改";
}

/**
 * 应用一次确认动作（纯函数，返回新行）
 *
 * - 确认：标 `用户确认`（B 级证据）
 * - 修改：带 patch 覆盖内容并标 `用户补充`（A 级证据）
 * - 否决：标 `用户否决`（调用方负责从表中移除该行，并把否决记入知识避免下轮再生成）
 */
export function applyConfirmation(
  row: InfoRow,
  action: ConfirmAction,
  patch?: Readonly<Record<string, unknown>>,
): InfoRow {
  switch (action) {
    case "确认":
      return { ...row, ...patch, source_type: "用户确认", confirm_state: "用户确认" };
    case "修改":
      return { ...row, ...patch, source_type: "用户补充", confirm_state: "用户修改" };
    case "否决":
      return { ...row, source_type: null, confirm_state: "用户否决" };
  }
}

// ─── 表1-1 固定行 ──────────────────────────────────────────

/** 表1-1 的全部固定行（含选填项） */
export function anchorRows1_1(): readonly FixedRow[] {
  return TABLES_BY_CODE["表1-1"]?.fixedRows ?? [];
}

// ─── 对照式确认（「用户说过的」vs「系统理解的」） ───────────

/**
 * 对照结论
 *
 * 注：**「冲突」需要语义判断，纯函数判不了**——本模块只做可机器判定的三类区分，
 * 冲突项由对话确认处理（见 ALIGNMENT_CONFLICT_NOTE）。
 */
export type Alignment = "一致" | "系统补充" | "推断" | "待补充";

export const ALIGNMENT_CONFLICT_NOTE =
  "「与用户诉求冲突」需要语义判断，不在纯函数内假定；由对话确认环节标出并最先提问。";

export interface AlignmentItem {
  rowKey: string;
  label: string;
  content: string;
  alignment: Alignment;
  note?: string;
}

/**
 * 该行是否该进「对照表」
 *
 * 用户定调：**场景定义要求太细了，要抽象一点**（很多时候用户也说不准，
 * 更需要的是对行业的全面了解）。因此对照表只拿两类行出来：
 *   - **用户负责输入的行**（表1-1 的「场景名称」）永远列出——空着就提示这是他的活
 *   - **智能体写出内容的行**（覆盖什么 / 明确不含什么）只在确实写了时列出，
 *     写了就让用户看一眼（可改），没写的不打扰
 */
function shouldAlign(fixed: FixedRow, anchorRows: readonly InfoRow[]): boolean {
  if (fixed.owner === "用户") return true;
  const row = anchorRows.find((r) => String(r["item"] ?? "").trim() === fixed.label);
  return Boolean(row) && !isEmptyValue(String(row!["content"] ?? "").trim());
}

/**
 * 以**用户原始诉求**为基准，对表1-1 的各行做对照
 *
 * - `一致`：已由用户确认或补充（用户自己的话）
 * - `系统补充`：有来源且内容非空（来自材料/检索）
 * - `推断`：`source_type = AI推断`（智能体的理解——摆出来让用户看一眼，可直接改）
 * - `待补充`：内容为空或「未提供」
 *
 * 注意：`推断` **不是**"待用户表态"——产品不显示待确认；用户想改就地改，不想改就过。
 */
export function alignmentWithBrief(anchorRows: readonly InfoRow[]): readonly AlignmentItem[] {
  return anchorRows1_1()
    .filter((fixed) => shouldAlign(fixed, anchorRows))
    .map((fixed) => {
    const row = anchorRows.find((r) => String(r["item"] ?? "").trim() === fixed.label);
    const content = row ? String(row["content"] ?? "").trim() : "";
    if (!row || isEmptyValue(content)) {
      return { rowKey: fixed.key, label: fixed.label, content, alignment: "待补充" as const };
    }
    if (usableDownstream(row)) {
      return { rowKey: fixed.key, label: fixed.label, content, alignment: "一致" as const };
    }
    if (row.source_type === "AI推断") {
      return {
        rowKey: fixed.key,
        label: fixed.label,
        content,
        alignment: "推断" as const,
        note: "智能体的理解，可直接改",
      };
    }
      return {
        rowKey: fixed.key,
        label: fixed.label,
        content,
        alignment: "系统补充" as const,
        note: row.source ? `来源：${String(row.source)}` : undefined,
      };
    });
}

// ─── 待确认清单计数：已删除 ─────────────────────────────────
//
// 曾经这里统计"有内容但未经用户逐格确认"的行数（真机上曾算出 **49 项**），
// 并以「右栏待确认清单还有 N 项未处理」出现在缺口清单里。用户定调：
// 「不用显示待确认」+「用户确认就默认可以了」——把智能体产出的每一格都
// 拿去要用户签字，既不是用户能回答的问题，也不是产品该提的要求。
// 逐项确认概念整体删除；表1-1 只保留**一次整表确认**（且不阻断推进）。
