/**
 * 用**产品自己的 Word 生成器**把白皮书 Markdown 渲染成 .docx。
 *
 * 为什么调产品的渲染器而不是自己排版：用户要的就是「按产品要求的默认格式和模版」。
 * `packages/infra/src/docx-report.ts` 是《Word 输出格式规范》v0.3 的唯一落点
 * （A4 / 边距 2.5-2.5-3.2-2.5cm / 宋体 12pt 首行缩进 2 字符 行距 1.5 / 章节自动编号
 * 1-1.1-1.1.1 / 表头加粗居中 / 页眉文档名 / 页脚第 X 页 共 Y 页 / TOC 域 / 封面空 3 行）。
 * 自己再写一遍排版 = 造第二个轮子，且必然与产品跑偏。
 *
 * 只 import `docx-report.js` 而不是包入口——包入口会连带 better-sqlite3 原生模块。
 *
 * 用法：node build-whitepaper.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportMarkdownToDocx } from "../../../packages/infra/dist/docx-report.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "demo资料");

const md = readFileSync(join(dir, "云枢智控-产品与能力白皮书.md"), "utf8");
const buf = await reportMarkdownToDocx(md, {
  headerText: "云枢智控 产品与能力白皮书",
  // 稳定时间：同一天生成字节完全一致，便于「内容没变就不重写」
  createdAt: new Date("2026-10-15T00:00:00"),
});
const out = join(dir, "云枢智控-产品与能力白皮书.docx");
writeFileSync(out, buf);
console.log(`✅ 写出 ${out}（${buf.length} 字节）`);
