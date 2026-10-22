/**
 * 资料库「表格内新增行」的本地草稿口径
 *
 * 为什么要有草稿：新增行必须先能在表里逐格填写，不能在弹窗里输入一整段 JSON。
 * 但服务端要求必填列（M1 型号、M3 能力名……），空行不能直接落库；所以先把空白行
 * 留在本地，**填满这张表的最小必填集后才自动保存**。这样既没有额外弹窗，也不会
 * 在库里留下无法识别的空行。
 */

export interface DraftRow extends Record<string, unknown> {
  __draft: true;
  __draftId: string;
}

let draftSeq = 0;

/** 新建一行本地草稿：只填「服务端有诚实缺省值」的列，不替用户猜业务内容 */
export function makeDraftRow(code: string, productId = ""): DraftRow {
  const row: DraftRow = { __draft: true, __draftId: `draft-${Date.now()}-${++draftSeq}` };
  switch (code) {
    case "M1":
      row.status = "待确认";
      break;
    case "M2":
      if (productId) row.product_id = productId;
      row.param_class = "未分类";
      row.measured = "未提及";
      break;
    case "M4":
      row.type = "不做";
      break;
    case "M6":
      row.price_scope = "纯设备";
      break;
    default:
      break;
  }
  return row;
}

export function isDraftRow(row: Record<string, unknown>): row is DraftRow {
  return row.__draft === true && typeof row.__draftId === "string";
}

const has = (row: Record<string, unknown>, key: string): boolean =>
  String(row[key] ?? "").trim() !== "";

/**
 * 草稿是否已够「服务端最小必填集」。
 *
 * 不用契约里的全部 required：来源/证据这类列在右栏，不能把用户卡在表里；
 * 这里只要求**这张表没有它就无法落库**的键。M4「不做」另需来源+依据（服务端门禁）。
 */
export function draftReady(
  code: string,
  row: Record<string, unknown>,
  requiredKeys: readonly string[] = [],
): boolean {
  switch (code) {
    case "M1":
      return has(row, "model") && has(row, "name");
    case "M2":
      return has(row, "product_id") && has(row, "param_name") && has(row, "value");
    case "M3":
      return has(row, "name") && has(row, "description");
    case "M4": {
      const kind = String(row.type ?? "不做");
      return has(row, "description") && (kind === "限制" || (has(row, "source") && has(row, "reason")));
    }
    case "M6":
      return has(row, "model") && has(row, "config") && has(row, "unit_price");
    default:
      // O1–O6：按契约 payload 的必填列判断；没有传入时至少要求一个业务字段
      if (requiredKeys.length > 0) return requiredKeys.every((key) => has(row, key));
      return Object.entries(row).some(
        ([key, value]) =>
          !key.startsWith("__") && key !== "category" && String(value ?? "").trim() !== "",
      );
  }
}

/** 草稿 → 新增接口的 values：去掉本地标记，空值交给服务端缺省值 */
export function draftPayload(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("__") || key === "category") continue;
    if (String(value ?? "").trim() === "") continue;
    out[key] = value;
  }
  return out;
}
