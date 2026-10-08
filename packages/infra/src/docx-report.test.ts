/**
 * @scene/infra — 报告 Markdown → Word（.docx）测试
 *
 * 覆盖：
 * - 必需 OOXML 部件齐全（少一个 Word 就打不开）
 * - 封面（48 半磅标题）、TOC 域、Heading1/2 大纲样式、标题不挂自动编号
 * - A4 页面与 3.2cm 左边距
 * - Markdown 表格 → Word 表格（分隔行丢弃、首行 tblHeader）
 * - settings.updateFields（打开即刷新目录与页码域）
 * - 文本 XML 转义
 * - 真实报告（exports/ 下的定稿）转出的部件、表数量与章标题齐全
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { reportMarkdownToDocx } from "./docx-report.js";

// ─── 测试数据 ────────────────────────────────────────────────

const SAMPLE = `# 智慧会议室 解决方案

> **场景**：智慧会议室（企业/园区内部会议室）
> **日期**：2026-10-07

---

## 一、现状

### 场景在业务中的位置

会议室是企业里少数"人人都用、却没有明确责任人"的空间，含 **加粗** 与 ① 与「引号」（括号）。

| 层次 | 现有构成 |
| --- | --- |
| 交互与显示 | 会议平板 |
| 采集与感知 | 摄像机 |

- 列表项一
- 列表项二
`;

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/styles.xml",
  "word/settings.xml",
  "word/_rels/document.xml.rels",
  "word/footer1.xml",
  "docProps/core.xml",
  "docProps/app.xml",
];

// ─── 工具 ────────────────────────────────────────────────────

async function partsOf(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    parts[name] = await entry.async("string");
  }
  return parts;
}

/** `<w:p>` 段落切片（document.xml 里没有嵌套 w:p，可以按起始标签切） */
function paragraphsOf(xml: string): string[] {
  return xml
    .split("<w:p>")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</w:p>") + "</w:p>".length));
}

function textOf(xml: string): string {
  // `<w:t>` 或 `<w:t xml:space=…>`；不能写成 `<w:t[^>]*>`——那会连 `<w:tblPr>`/`<w:tr>` 一起匹配
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1] ?? "").join("");
}

function countTag(xml: string, tag: string): number {
  return (xml.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
}

function paragraphsWithStyle(xml: string, styleId: string): string[] {
  return paragraphsOf(xml).filter((para) => para.includes(`<w:pStyle w:val="${styleId}"/>`));
}

/** 连续 `|` 行的组数 = Markdown 里的表格张数 */
function countMarkdownTables(markdown: string): number {
  let count = 0;
  let inTable = false;
  for (const line of markdown.split("\n")) {
    const isRow = line.trim().startsWith("|");
    if (isRow && !inTable) count += 1;
    inTable = isRow;
  }
  return count;
}

/** 优先 cwd（vitest 从仓库根跑），退回相对本文件的 ../../../exports */
function resolveExportFile(name: string): string | null {
  const candidates = [
    join(process.cwd(), "exports", name),
    fileURLToPath(new URL(`../../../exports/${name}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── 贯通样例 ────────────────────────────────────────────────

describe("reportMarkdownToDocx — 基本形态", () => {
  it("打包了 Word 打开所必需的 OOXML 部件", async () => {
    const buffer = await reportMarkdownToDocx(SAMPLE, { headerText: "智慧会议室 解决方案" });
    const names = Object.keys(await partsOf(buffer));
    for (const part of [...REQUIRED_PARTS, "word/header1.xml", "word/_rels/header1.xml.rels"]) {
      expect(names).toContain(part);
    }
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("封面标题 48 半磅（24pt），插入 TOC 域，`##`/`###` 映射 Heading1/Heading2", async () => {
    const parts = await partsOf(await reportMarkdownToDocx(SAMPLE, { headerText: "智慧会议室 解决方案" }));
    const doc = parts["word/document.xml"] ?? "";

    const coverIndex = doc.indexOf("智慧会议室 解决方案");
    expect(coverIndex).toBeGreaterThan(-1);
    expect(doc.slice(Math.max(0, coverIndex - 600), coverIndex + 120)).toContain('w:sz w:val="48"');

    // 变更表 #134：封面 = 第一页顶部空 3 行后写报告名；老报告的 `> 场景 / 日期` 两行不再渲染
    const bodyStart = doc.indexOf("<w:body>") + "<w:body>".length;
    // 正文起点 → 标题文字之间，正好是 3 个空段落再接标题段落本身
    expect(doc.slice(bodyStart, coverIndex)).toMatch(/^(<w:p\/>){3}<w:p>/);
    expect(doc).not.toContain("企业/园区内部会议室");
    expect(doc).not.toContain("2026-10-07");
    expect(doc).toContain("目  录");
    expect(doc).toContain('TOC \\o "1-3"');
    expect(doc).toContain('w:fldCharType="begin"');
    expect(doc).toContain('w:fldCharType="separate"');
    expect(doc).toContain('w:fldCharType="end"');
    expect(doc).toContain('<w:br w:type="page"/>');

    expect(paragraphsWithStyle(doc, "Heading1").map(textOf)).toContain("一、现状");
    expect(paragraphsWithStyle(doc, "Heading2").map(textOf)).toContain("场景在业务中的位置");

    // 标题自带「一、现状」，不许再挂自动编号
    expect(doc).not.toContain("<w:numPr>");
    expect(parts["word/styles.xml"]).toContain('w:outlineLvl w:val="0"');
    expect(parts["word/styles.xml"]).toContain('w:line="578"');
    // 行内加粗
    expect(doc).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">加粗</w:t>');
    // 列表项
    expect(textOf(doc)).toContain("• 列表项一");
  });

  it("页面为 A4，左边距 3.2cm（1814 twip）", async () => {
    const parts = await partsOf(await reportMarkdownToDocx(SAMPLE));
    const doc = parts["word/document.xml"] ?? "";
    expect(doc).toMatch(/<w:pgSz w:w="11906" w:h="16838"\/>/);
    expect(doc).toMatch(/w:left="181[0-9]"/);
    expect(doc).toMatch(/w:top="1418"/);
    expect(doc).toMatch(/w:right="1418"/);
    expect(doc).toMatch(/w:bottom="1418"/);
  });

  it("Markdown 表格转 Word 表格：分隔行不算行，首行带 tblHeader", async () => {
    const markdown = `# 表格测试

## 一、现状

| 序号 | 名称 |
| --- | --- |
| 1 | 交互与显示 |
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    expect(countTag(doc, "w:tbl")).toBe(1);
    expect(countTag(doc, "w:tr")).toBe(2);
    expect(countTag(doc, "w:tc")).toBe(4);
    expect(doc).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    expect(doc).toContain('w:tblStyle w:val="TableGrid"');
    expect(doc).toContain('<w:tblW w:w="0" w:type="auto"/>');
    // 表头行加粗 + 居中；单元格 10.5pt = 21 半磅
    expect(doc).toContain('<w:b/><w:sz w:val="21"/><w:szCs w:val="21"/>');
    const headerRow = doc.slice(doc.indexOf("<w:tr>"), doc.indexOf("</w:tr>"));
    expect(headerRow).toContain('w:jc w:val="center"');
  });

  it("settings.xml 打开文档时自动刷新目录与页码域，页脚用 PAGE/NUMPAGES", async () => {
    const parts = await partsOf(await reportMarkdownToDocx(SAMPLE));
    expect(parts["word/settings.xml"]).toContain('<w:updateFields w:val="true"/>');
    expect(parts["word/footer1.xml"]).toContain("> PAGE <");
    expect(parts["word/footer1.xml"]).toContain("> NUMPAGES <");
    expect(parts["word/footer1.xml"]).toContain("第 ");
    expect(parts["word/footer1.xml"]).toContain(" 页 共 ");
  });

  it("文本里的 & < > 一律 XML 转义", async () => {
    const markdown = `# 转义测试

## 一、现状

A & B < C > D
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    expect(doc).toContain("A &amp; B &lt; C &gt; D");
    expect(doc).not.toContain("A & B < C > D");
  });

  it("同一份输入 + 同一个 createdAt → 字节完全一致（调用方按 sha256 跳过重复落盘）", async () => {
    const createdAt = new Date("2026-10-07T03:00:00Z");
    const first = await reportMarkdownToDocx(SAMPLE, { headerText: "智慧会议室 解决方案", createdAt });
    // 跨过 ZIP 的 DOS 时间戳粒度（2 秒）：zip 条目时间若取「当前时间」这里必然不一致
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await reportMarkdownToDocx(SAMPLE, { headerText: "智慧会议室 解决方案", createdAt });
    expect(first.equals(second)).toBe(true);
  });
});

// ─── 真实报告 ────────────────────────────────────────────────

const REAL_EXPORT = "智慧会议室 对外汇报材料 2026-10-07.md";
const realPath = resolveExportFile(REAL_EXPORT);
// 定稿不在工作区时跳过（比如换了 worktree），不许因为缺文件让测试红
const realIt = realPath === null ? it.skip : it;

describe("reportMarkdownToDocx — 真实报告（exports/ 定稿）", () => {
  realIt("对外汇报材料：部件齐全、6 张表齐全、每个章标题都在", async () => {
    const markdown = readFileSync(String(realPath), "utf8");
    const parts = await partsOf(await reportMarkdownToDocx(markdown, { headerText: "智慧会议室 解决方案" }));
    const names = Object.keys(parts);
    for (const part of [...REQUIRED_PARTS, "word/header1.xml"]) {
      expect(names).toContain(part);
    }

    const doc = parts["word/document.xml"] ?? "";
    const markdownTables = countMarkdownTables(markdown);
    expect(markdownTables).toBe(6);
    expect(countTag(doc, "w:tbl")).toBeGreaterThanOrEqual(6);
    expect(countTag(doc, "w:tbl")).toBe(markdownTables);

    const chapters = markdown
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    expect(chapters.length).toBeGreaterThanOrEqual(5);
    const h1Texts = paragraphsWithStyle(doc, "Heading1").map(textOf);
    const docText = textOf(doc);
    for (const chapter of chapters) {
      expect(docText).toContain(chapter);
      expect(h1Texts).toContain(chapter);
    }
    // `---` 分章线只丢弃，不进正文（表格分隔行也一并丢弃）
    expect(doc).not.toContain("---");
  });
});
