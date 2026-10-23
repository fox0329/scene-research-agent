/**
 * 隐藏模型的"过程信息"：function calling 的参数 JSON。
 *
 * 有些供应商会把 tool_calls 的参数同时当正文吐出来（`{"instruction": ...}`），
 * 用户看到的就是一坨过程数据。这里做两层清洗：
 *  1. 移除带工具参数键的 JSON 对象（整段是 JSON 时直接返回空，气泡不渲染）；
 *  2. 从工具确认语处截断，去掉前面的残留。
 * 只认工具参数字段的键，普通业务 JSON 不受影响。
 */

const MARKERS = [
  "已改资料库",
  "已按建议修改表格",
  "【需要确认】",
  "已更新表1-1",
  "已新建产品线",
  "已删除 ",
  "已优化",
];

/** 工具参数里会出现的键；命中任意一个才认为是"过程 JSON" */
const TOOL_KEYS = new Set([
  "instruction",
  "section",
  "table",
  "fills",
  "add_rows",
  "delete_rows",
  "updates",
  "add",
  "delete",
  "rows",
  "op_id",
  "target",
  "name",
  "values",
  "match",
]);

function looksLikeToolJson(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((k) => TOOL_KEYS.has(k));
}

/** 删掉正文里的工具参数 JSON（括号配对、字符串转义感知） */
export function removeToolJson(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      out += text[i];
      i += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      out += text.slice(i);
      break;
    }
    const raw = text.slice(i, end + 1);
    try {
      if (looksLikeToolJson(JSON.parse(raw))) {
        i = end + 1;
        continue;
      }
    } catch {
      /* 不是 JSON，原样保留 */
    }
    out += raw;
    i = end + 1;
  }
  return out;
}

export function stripToolEcho(text: string): string {
  let next = removeToolJson(text);
  for (const marker of MARKERS) {
    const at = next.indexOf(marker);
    if (at > 0) {
      next = next.slice(at);
      break;
    }
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}
