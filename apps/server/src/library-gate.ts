/**
 * 资料库入库门禁（纯函数，可单测）
 *
 * 用户定调的口径落在这里，**不交给模型**：
 *
 * 「不做」是重话，必须过两道门槛：**材料出处可定位**（`文件名:页码` 或 `文件名:章节号`）与
 * **依据非空**（`boundary.reason`，为什么判不做）。缺一条就不入库——
 * 材料提取（ingest）与手工新增（路由）两条来源路径共用同一判定，避免一边严一边松。
 *
 * 为什么定位符必须是具体值：来源串里文件名可能带空格、中文，但页码/章节号必须是
 * 可回查的具体位置；只要求"有冒号"会让 `边界:未知` 这类糊弄串过关，等于门禁形同虚设。
 */

/** 页码：具体数字，或页码范围（`12`、`12-14`、`12–14`） */
const PAGE_RE = /^\d+(?:\s*[-–—~]\s*\d+)?$/u;
/** 章节号：`A.1`、`8.2`、`A.1.2`（字母前缀可省） */
const SECTION_RE = /^(?:[A-Za-z]\.)?\d+(?:\.\d+)*$/u;
/**
 * 材料里常见的非页码定位符：`表格2`、`第3章`、`第 3 节`、`附件A`、`p.12`、`12页`、
 * `3.1 核心配置`（章节号带标题）。
 *
 * 为什么认：白皮书/规格书是 docx，没有稳定页码，模型只能引「表格 2」「8.1 节」；
 * 只认纯数字会把大量真实可回查的出处判成不可定位（实测 143/258 行），
 * 反过来逼模型编页码，比宽松更糟。判据是「能按这个定位符翻到原文那一处」。
 */
const ANCHOR_RE =
  /^(?:第\s*[0-9一二三四五六七八九十百]+\s*[章节页表]|(?:表格|附录|附件|图|表)\s*[A-Za-z0-9一二三四五六七八九十]+|[一二三四五六七八九十百]+[、.．]|p\.?\s*\d+|\d+(?:\.\d+)*(?:\s|$|[-–—~]|\s*[\u4e00-\u9fa5]))/u;

/**
 * 取**第一个**冒号（中英文都认）的位置；没有返回 -1。
 *
 * 原来的实现取最后一个冒号，把「文件名:5.1 OEE 不可测：估算值…」这类
 * 「定位符里本身带冒号」的来源切错，判成不可定位（实测 1 行误报）。
 * 文件名不含冒号（Windows 也不允许），所以第一个冒号就是文件名与定位符的分界。
 */
function firstColonIndex(value: string): number {
  const ascii = value.indexOf(":");
  const full = value.indexOf("：");
  if (ascii < 0) return full;
  if (full < 0) return ascii;
  return Math.min(ascii, full);
}

/**
 * 来源是否可定位（G-R0：`文件名:页码` / `文件名:章节号`）
 *
 * 判定口径（2026-10-21 收紧）：必须有文件名部分 + **具体定位符**。
 * 定位符只认两类：页码（`12`、`12-14`）或章节号（`A.1`、`8.2`）。
 * `未知`、`?`、`-` 一律判不可定位——「不知道第几页」不是可溯源，
 * 放行等于把 G-R0 的溯源铁律降级成"标了个来源字样"。
 */
export function isLocatableSource(source: unknown): boolean {
  const text = String(source ?? "").trim();
  if (!text) return false;
  const colon = firstColonIndex(text);
  if (colon <= 0) return false;
  if (!text.slice(0, colon).trim()) return false;
  const location = text.slice(colon + 1).trim();
  if (!location) return false;
  return PAGE_RE.test(location) || SECTION_RE.test(location) || ANCHOR_RE.test(location);
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
    return "「不做」边界必须有材料出处：source 形如「文件名:页码/章节号」（如 白皮书.pdf:12、标准.pdf:A.1）";
  }
  if (!isLocatableSource(src)) {
    return `「不做」边界来源「${src}」不可定位：需形如「文件名:页码/章节号」（页码为具体数字或范围，章节号如 A.1、8.2）`;
  }
  if (!String(reason ?? "").trim()) {
    return "「不做」边界必须写「依据」（boundary.reason：为什么判不做），不能为空";
  }
  return null;
}
