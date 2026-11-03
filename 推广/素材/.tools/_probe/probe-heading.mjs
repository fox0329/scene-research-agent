/** 探「手写章号剥离」的覆盖边界：剥不掉的写法会和 Word 自动编号叠成「1 A. 现状」。 */
import { writeFileSync } from "node:fs";
import { reportMarkdownToDocx } from "../../../../packages/infra/dist/docx-report.js";

const cases = ["## 一、现状", "## 1.1 现状", "## 1、现状", "## （二）方案", "## (1) 方案",
  "## A. 现场调研", "## A.1 认证范围", "## 第一章 现状", "## 1) 现状", "### A.1 认证"];
const md = "# 封面标题\n\n" + cases.map((h) => `${h}\n\n正文一行。\n`).join("\n");
writeFileSync("/tmp/probe-heading.docx", await reportMarkdownToDocx(md));
writeFileSync("/tmp/probe-heading.json", JSON.stringify(cases));
console.log("已写出 /tmp/probe-heading.docx");
