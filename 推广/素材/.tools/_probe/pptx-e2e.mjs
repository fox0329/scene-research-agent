/** 端到端：拿真实原生表格的 pptx，跑产品解析器看抽不抽得出来。 */
import { parseDocument } from "../../../../packages/infra/dist/doc-parser.js";
const r = await parseDocument("/tmp/native-table.pptx");
console.log(`表格 ${r.tables.length} 张｜文本 ${r.text.replace(/\s+/g, "").length} 字｜pageCount ${r.metadata.pageCount}`);
for (const [i, t] of r.tables.entries()) {
  console.log(`\n  表 ${i + 1}：${t.headers.join(" | ")}`);
  for (const row of t.rows) console.log(`        ${row.join(" | ")}`);
}
const order = [...r.text.matchAll(/\[Slide (\d+)\]/g)].map((m) => Number(m[1]));
console.log(`\n  幻灯片顺序：${order.join(" → ")}`);
console.log(`  单元格文字是否进了纯文本：${r.text.includes("6 TOPS") ? "是" : "否"}`);
