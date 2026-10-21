/**
 * 资料库入库门禁（纯函数，可单测）
 *
 * 两条用户定调的口径落在这里，**不交给模型**：
 *
 * ① 「不做」是重话，必须过两道门槛：**材料出处可定位**（`文件名:页码`）与
 *    **依据非空**（`boundary.reason`，为什么判不做）。缺一条就不入库——
 *    材料提取（ingest）与手工新增（路由）两条来源路径共用同一判定，避免一边严一边松。
 *
 * ② 价格只有一个家：结构化报价进 M6（`price_quote`），O3 只留**报价单文件级引用**
 *    `{file, note}`，单价/计价方式一律不落 O3。
 *
 * 为什么正则要"扩展名 + 冒号"或"冒号 + 数字"：来源串里文件名可能带空格、中文，
 * 但一定有可识别的扩展名或数字页码；只要求"有冒号"会让 `边界:未知` 这类糊弄串过关，
 * 等于门禁形同虚设。
 */

/** 文件名带扩展名 + 冒号 + 页码（`白皮书.pdf:12`、`报价单.docx:未知`） */
const FILE_EXT_PAGE_RE = /\.[A-Za-z0-9]{2,5}\s*[:：]\s*\S/u;
/** 冒号 + 数字页码（`边界说明:12`；没扩展名但页码可定位也算） */
const NUMERIC_PAGE_RE = /[:：]\s*\d+/u;

/** 取最后一个冒号（中英文冒号都认）的位置；没有返回 -1 */
function lastColonIndex(value: string): number {
  return Math.max(value.lastIndexOf(":"), value.lastIndexOf("："));
}

/**
 * 来源是否可定位（G-R0：`文件名:页码`）
 *
 * 判定口径：必须有文件名部分 + 页码部分，且整体命中"扩展名+冒号"或"冒号+数字"之一。
 * 空串、`边界`、`边界:未知`（无扩展名且页码非数字）都判不可定位。
 */
export function isLocatableSource(source: unknown): boolean {
  const text = String(source ?? "").trim();
  if (!text) return false;
  const colon = lastColonIndex(text);
  if (colon <= 0) return false;
  if (!text.slice(0, colon).trim()) return false;
  if (!text.slice(colon + 1).trim()) return false;
  return FILE_EXT_PAGE_RE.test(text) || NUMERIC_PAGE_RE.test(text);
}

/**
 * 边界（不做）行的入库门禁：返回错误文案，`null` = 通过。
 *
 * 只对 `boundary`（「不做」）生效；`limitation`（「限制」）是产品已知短板，
 * 依据写的是限制本身，不要求 `reason`（该表也没有这一列）。
 */
export function boundaryEvidenceError(source: unknown, reason: unknown): string | null {
  const src = String(source ?? "").trim();
  if (!src) {
    return "「不做」边界必须有材料出处：source 形如「文件名:页码」（如 白皮书.pdf:12）";
  }
  if (!isLocatableSource(src)) {
    return `「不做」边界来源「${src}」不可定位：需形如「文件名:页码」（带扩展名，或冒号后为数字页码）`;
  }
  if (!String(reason ?? "").trim()) {
    return "「不做」边界必须写「依据」（boundary.reason：为什么判不做），不能为空";
  }
  return null;
}

/**
 * O3 只允许文件级引用：把模型/用户给的字段收敛为 `{file, note}`。
 *
 * 返回 `null` = 没有文件引用（该行不落 O3——价格明细应进 M6，不能以"价格行"的名义留在 O3）。
 * 单价、币种、计价方式等字段**一律丢弃**，保证「一个价格事实只有一个家」。
 */
export function o3FileRefPayload(fields: Record<string, unknown>): {
  file: string;
  note?: string;
} | null {
  const file = String(fields["file"] ?? fields["file_name"] ?? "").trim();
  if (!file) return null;
  const note = String(fields["note"] ?? "").trim();
  return note ? { file, note } : { file };
}
