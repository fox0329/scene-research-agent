/**
 * 工具回显清洗（变更表 #347）
 *
 * 供应商/模型会把 function calling 的参数 JSON 复述进正文（`{"query": …}`、
 * `{"table": …}`），用户看到一坨过程数据。这里是与 web 端 `stripToolEcho`
 * 同一套规则的唯一真源：server 的会话流出口（agent-runtime 过滤器）与 web 的
 * 消息渲染都引用本模块，保证「流式所见 = 存档所得」（对齐 DSH 原则：
 * 流永远不携带耐久日志不包含的内容）。
 *
 * 只认工具参数里会出现的键；普通业务 JSON（如 {"price":100}）不受影响。
 */

/** 工具参数里会出现的键；JSON 顶层命中任意一个才认为是"过程 JSON" */
export const TOOL_ECHO_KEYS: ReadonlySet<string> = new Set([
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
  "query",
]);

/** 工具确认语；正文从确认语处截断，去掉前面的残留（web 端历史行为，保持一致） */
export const TOOL_ECHO_MARKERS: readonly string[] = [
  "已改资料库",
  "已按建议修改表格",
  "【需要确认】",
  "已更新表1-1",
  "已新建产品线",
  "已删除 ",
  "已优化",
];

/** 判定一个已解析对象是否为工具参数回显 */
export function looksLikeToolEchoJson(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((k) =>
    TOOL_ECHO_KEYS.has(k),
  );
}

/** 从 start 起扫描平衡的 JSON 对象（字符串感知），返回结束下标（不含），不完整返回 -1 */
export function jsonBalancedEnd(buf: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i += 1) {
    const ch = buf[i]!;
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
      if (depth === 0) return i + 1;
    }
  }
  return -1;
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
    const end = jsonBalancedEnd(text, i);
    if (end < 0) {
      out += text.slice(i);
      break;
    }
    const raw = text.slice(i, end);
    try {
      if (looksLikeToolEchoJson(JSON.parse(raw))) {
        i = end;
        continue;
      }
    } catch {
      /* 不是 JSON，原样保留 */
    }
    out += raw;
    i = end;
  }
  return out;
}

/** 两层清洗：去工具参数 JSON + 从确认语处截断 */
export function stripToolEcho(text: string): string {
  let next = removeToolJson(text);
  for (const marker of TOOL_ECHO_MARKERS) {
    const at = next.indexOf(marker);
    if (at > 0) {
      next = next.slice(at);
      break;
    }
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}
