/**
 * confirmation — 确认机制（对应 04 §4.7）
 *
 * 解决的问题：阶段 1 的信息来源是「用户只给了场景名 + 材料 + 检索」，
 * 系统理解的场景未必是用户要的——必须有"确认"闭环，且**基准是用户原始诉求**，
 * 不能是系统起草的场景锚（拿它当基准等于自己验证自己）。
 *
 * 确认对象分三层（不逐格校对 8 张表）：
 *  L1 场景本体：表1-1 的 6 个必确认行
 *  L2 结构判断：表1-2 每个业务环节的 can_touch 与 our_role
 *  L3 事实与枚举：其余表抽查 + 右栏待确认清单
 *
 * 状态机：系统推断 → 待确认 → 用户确认 / 用户修改 / 用户否决
 * 铁律：**只有『用户确认』『用户补充』可被下游当依据**；其余引用时带"未确认"标记。
 */

import { TABLES_BY_CODE, middleColumns, type FixedRow } from "@scene/contract";
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

// ─── 确认清单 ──────────────────────────────────────────────

export interface ChecklistItem {
  layer: "L1" | "L2" | "L3";
  tableCode: string;
  /** 行标识（L1 为固定行 key；L2 为环节名；L3 为聚合项） */
  rowKey: string;
  label: string;
  state: ConfirmState;
}

export interface ConfirmationChecklist {
  /** 必须确认项数 */
  required: number;
  /** 已确认项数（用户确认 / 用户修改） */
  confirmed: number;
  /** 待处理项数 */
  pending: number;
  items: readonly ChecklistItem[];
  allDone: boolean;
}

/** 表1-1 的 L1 必确认固定行 */
export function l1Rows(): readonly FixedRow[] {
  return (TABLES_BY_CODE["表1-1"]?.fixedRows ?? []).filter((r) => r.confirmRequired);
}

/**
 * 组装确认清单（右栏 Tab ① 顶部常驻）
 *
 * @param input.anchorRows 表1-1 的行（键 `item` = 项名，`content` = 内容）
 * @param input.linkRows 表1-2 的行（键 `link` = 业务环节）
 * @param input.pendingCount 右栏待确认清单条数
 */
export function buildChecklist(input: {
  anchorRows?: readonly InfoRow[];
  linkRows?: readonly InfoRow[];
  pendingCount?: number;
}): ConfirmationChecklist {
  const items: ChecklistItem[] = [];
  const anchorRows = input.anchorRows ?? [];
  const linkRows = input.linkRows ?? [];

  // L1：场景本体 6 项
  for (const fixed of l1Rows()) {
    const row = anchorRows.find((r) => String(r["item"] ?? "").trim() === fixed.label);
    const state: ConfirmState = !row || isEmptyValue(row["content"]) ? "系统推断" : confirmStateOf(row);
    items.push({
      layer: "L1",
      tableCode: "表1-1",
      rowKey: fixed.key,
      label: fixed.label,
      state,
    });
  }

  // L2：环节的能否参与 + 我方角色
  for (const row of linkRows) {
    const link = String(row["link"] ?? "").trim() || "(未命名环节)";
    items.push({
      layer: "L2",
      tableCode: "表1-2",
      rowKey: `${link} · 能否参与`,
      label: `${link}——我方可参与程度`,
      state: confirmStateOf(row),
    });
    items.push({
      layer: "L2",
      tableCode: "表1-2",
      rowKey: `${link} · 我方角色`,
      label: `${link}——我方角色`,
      state: confirmStateOf(row),
    });
  }

  // L3：待确认清单（聚合一项）
  const pendingCount = input.pendingCount ?? 0;
  if (pendingCount > 0) {
    items.push({
      layer: "L3",
      tableCode: "",
      rowKey: "pending-list",
      label: `待确认清单 ${pendingCount} 项`,
      state: "待确认",
    });
  }

  const confirmed = items.filter((i) => i.state === "用户确认" || i.state === "用户修改").length;
  return {
    required: items.length,
    confirmed,
    pending: items.length - confirmed,
    items,
    allDone: items.length > 0 && confirmed === items.length,
  };
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
 * 以**用户原始诉求**为基准，对表1-1 的 L1 六项做对照
 *
 * - `一致`：已由用户确认或补充
 * - `系统补充`：有来源且内容非空（来自材料/检索，用户没说过）
 * - `推断`：`source_type = AI推断`（用户没说，系统猜的 → 必须确认）
 * - `待补充`：内容为空或「未提供」
 */
export function alignmentWithBrief(anchorRows: readonly InfoRow[]): readonly AlignmentItem[] {
  return l1Rows().map((fixed) => {
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
        note: "系统推断，需用户确认",
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

// ─── 待确认清单计数（供完整度检查使用） ─────────────────────

const META_KEYS = new Set(["source", "source_type", "confirm_state"]);

/**
 * 该表的「结构键」列——只有它被填不算"有内容"
 *
 * 规则取自注册表，避免把"行标签已填、数据还空着"的行误算成待确认：
 *  - 分组维度（`groupBy`）
 *  - 第一个中栏列（行的标识，如 表1-2 的 `link`、M1 的 `model`）
 *  - 「项/内容」纵向表的 `item`
 */
function structuralKeys(code: string): ReadonlySet<string> {
  const t = TABLES_BY_CODE[code];
  const keys = new Set<string>();
  if (!t) return keys;
  if (t.groupBy) keys.add(t.groupBy);
  const first = middleColumns(t)[0];
  if (first) keys.add(first.key);
  if (t.fixedRows) keys.add("item");
  return keys;
}

/** 统计"有内容但尚未确认"的行数——即待确认清单条数 */
export function pendingConfirmationCount(
  rowsByTable: Readonly<Record<string, readonly InfoRow[] | undefined>>,
): number {
  let n = 0;
  for (const [code, rows] of Object.entries(rowsByTable)) {
    const structural = structuralKeys(code);
    for (const row of rows ?? []) {
      const hasContent = Object.entries(row).some(
        ([k, v]) => !META_KEYS.has(k) && !structural.has(k) && !isEmptyValue(v),
      );
      if (hasContent && !usableDownstream(row)) n += 1;
    }
  }
  return n;
}
