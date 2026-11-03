/** 比对「换皮前 / 换皮后」两份素材被产品解析器解出来的结构是否一致。
 *  只要表数、行数、文本量一致，导入资料列表里的「页数 / 入库行数」就不会变，
 *  已有的截图与演示库来源引用继续成立。 */
import { parseDocument } from "../../../../packages/infra/dist/doc-parser.js";

const pairs = [
  ["白皮书", "/tmp/whitepaper-old.docx", "推广/素材/demo资料/云枢智控-产品与能力白皮书.docx"],
  ["产品介绍", "/tmp/deck-old.pptx", "推广/素材/demo资料/云枢智控-产品介绍.pptx"],
];
for (const [label, a, b] of pairs) {
  const ra = await parseDocument(a);
  const rb = await parseDocument(b);
  const s = (r) => ({
    tables: r.tables?.length ?? 0,
    rows: (r.tables ?? []).reduce((n, t) => n + t.rows.length, 0),
    text: (r.text ?? "").replace(/\s+/g, "").length,
  });
  const sa = s(ra), sb = s(rb);
  console.log(`\n── ${label}`);
  console.log(`   旧: 表 ${sa.tables}｜行 ${sa.rows}｜文本 ${sa.text} 字`);
  console.log(`   新: 表 ${sb.tables}｜行 ${sb.rows}｜文本 ${sb.text} 字`);
  console.log(`   结构一致: ${sa.tables === sb.tables && sa.rows === sb.rows ? "✅" : "❌"}`);
  if (sa.tables === sb.tables) {
    const ha = (ra.tables ?? []).map((t) => t.rows[0]?.join("|") ?? "");
    const hb = (rb.tables ?? []).map((t) => t.rows[0]?.join("|") ?? "");
    console.log(`   表头逐一相同: ${JSON.stringify(ha) === JSON.stringify(hb) ? "✅" : "❌"}`);
  }
}
