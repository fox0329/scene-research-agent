/**
 * 有些供应商会把 function calling 的参数同时当正文吐出来（实测 DeepSeek 偶发），
 * 气泡里就会先出现一段 `{"table": ...}` 再接工具确认语。这里从确认语处截断，
 * 只影响"确实带工具结果"的回复，不碰普通 JSON 问答。
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

export function stripToolEcho(text: string): string {
  for (const marker of MARKERS) {
    const at = text.indexOf(marker);
    if (at > 0) return text.slice(at);
  }
  return text;
}
