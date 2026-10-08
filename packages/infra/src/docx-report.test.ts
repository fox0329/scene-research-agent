/**
 * @scene/infra — 报告 Markdown → Word（.docx）测试
 *
 * 覆盖：
 * - 必需 OOXML 部件齐全（少一个 Word 就打不开）
 * - 封面（48 半磅标题）、TOC 域、Heading1/2 大纲样式
 * - 章节自动编号（word/numbering.xml 多级列表 + Heading1/2/3 挂 numPr）与手写章号剥离
 * - A4 页面与 3.2cm 左边距
 * - Markdown 表格 → Word 表格（分隔行丢弃、首行 tblHeader、表后补空段落）
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
  "word/numbering.xml",
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

/** styles.xml 里某个 `<w:style>` 的切片（样式不嵌套，取到下一个 `</w:style>` 即可） */
function styleXmlOf(stylesXml: string, styleId: string): string {
  const start = stylesXml.indexOf(`w:styleId="${styleId}"`);
  if (start === -1) return "";
  const end = stylesXml.indexOf("</w:style>", start);
  return stylesXml.slice(start, end);
}

/** `</w:tbl>` 后面紧跟空段落的次数 */
function countTableBlankLine(xml: string): number {
  return (xml.match(/<\/w:tbl><w:p\/>/g) ?? []).length;
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

    expect(paragraphsWithStyle(doc, "Heading1").map(textOf)).toContain("现状");
    expect(paragraphsWithStyle(doc, "Heading2").map(textOf)).toContain("场景在业务中的位置");

    // 编号挂在 styles.xml 的 Heading 样式上（numPr），document.xml 里不重复写
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

  it("每个表格后面紧跟一个空段落（表格是最后一个块时也补）", async () => {
    const markdown = `# 表格空行测试

## 一、现状

| 序号 | 名称 |
| --- | --- |
| 1 | A |

紧跟表格的正文段

| 序号 | 名称 |
| --- | --- |
| 1 | B |
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    expect(countTag(doc, "w:tbl")).toBe(2);
    // 每个 `</w:tbl>` 后面正好一个空段落
    expect(countTableBlankLine(doc)).toBe(2);
    // 表格 → 空段落 → 正文段：正文不贴着表格
    expect(doc).toContain("</w:tbl><w:p/><w:p>");
    // Markdown 里表格后的空行本身不产生段落，不许再叠一个空段
    expect(doc).not.toContain("</w:tbl><w:p/><w:p/>");
    // 末尾的表格也补空段落，body 仍以 sectPr 收尾
    expect(doc).toMatch(/<\/w:tbl><w:p\/><w:sectPr>/);
  });

  it("章节编号走 Word 多级列表：numbering.xml 是 1 / 1.1 / 1.1.1，Heading1/2/3 挂 numId=1", async () => {
    const parts = await partsOf(await reportMarkdownToDocx(SAMPLE));
    const numbering = parts["word/numbering.xml"] ?? "";
    expect(numbering).toContain('w:numFmt w:val="decimal"');
    expect(numbering).toContain('<w:lvlText w:val="%1"/>');
    expect(numbering).toContain('<w:lvlText w:val="%1.%2"/>');
    expect(numbering).toContain('<w:lvlText w:val="%1.%2.%3"/>');
    expect(numbering).toContain('<w:multiLevelType w:val="multilevel"/>');
    expect(numbering).toContain('<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>');
    expect((numbering.match(/<w:start w:val="1"\/>/g) ?? []).length).toBe(3);
    expect((numbering.match(/w:ind w:left="0" w:hanging="0"/g) ?? []).length).toBe(3);

    const styles = parts["word/styles.xml"] ?? "";
    const levels: ReadonlyArray<[string, number]> = [
      ["Heading1", 0],
      ["Heading2", 1],
      ["Heading3", 2],
    ];
    for (const [styleId, ilvl] of levels) {
      const style = styleXmlOf(styles, styleId);
      expect(style).not.toBe("");
      expect(style).toContain(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`);
    }
    // Heading4 不挂编号
    expect(styleXmlOf(styles, "Heading4")).not.toContain("<w:numId");

    // 部件接得上：Content_Types 声明 + document.xml.rels 关系（Word 才能读到）
    expect(parts["[Content_Types].xml"]).toContain('PartName="/word/numbering.xml"');
    const rels = parts["word/_rels/document.xml.rels"] ?? "";
    expect(rels).toContain("http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering");
    expect(rels).toContain('Target="numbering.xml"');
  });

  it("标题行首的手写章号剥掉，改由 Word 自动编号", async () => {
    const markdown = `# 1.2 智慧会议室 解决方案

## 一、现状

### 3.2 场景边界

## （二）方案

#### 十一、深层要点

## 四、
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    expect(paragraphsWithStyle(doc, "Heading1").map(textOf)).toEqual(["现状", "方案", "四、"]);
    expect(paragraphsWithStyle(doc, "Heading2").map(textOf)).toEqual(["场景边界"]);
    expect(paragraphsWithStyle(doc, "Heading3").map(textOf)).toEqual(["深层要点"]);
    // 封面 `#` 标题不剥：报告名里可能有别的数字
    expect(doc).toContain('<w:t xml:space="preserve">1.2 智慧会议室 解决方案</w:t>');
  });

  it("阿拉伯与括号式章号的各写法都能剥掉", async () => {
    const markdown = `# 编号写法

## 1. 甲

## 1.1 乙

## 1.1.1 丙

## 1、丁

## 1.1、 戊

## (1) 己

### 7.2 庚
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    expect(paragraphsWithStyle(doc, "Heading1").map(textOf)).toEqual(["甲", "乙", "丙", "丁", "戊", "己"]);
    expect(paragraphsWithStyle(doc, "Heading2").map(textOf)).toEqual(["庚"]);
  });

  it("只剥行首编号：没有编号分隔符的数字开头不动", async () => {
    const markdown = `# 数字测试

## 2026 年规划

## 10 个要点

## 一般来说

## 十一五期间的存量
`;
    const parts = await partsOf(await reportMarkdownToDocx(markdown));
    const doc = parts["word/document.xml"] ?? "";
    // `2026`/`10` 后面没有 `.`/`、`，「一般来说」「十一五」不是章号 → 原样保留
    expect(paragraphsWithStyle(doc, "Heading1").map(textOf)).toEqual([
      "2026 年规划",
      "10 个要点",
      "一般来说",
      "十一五期间的存量",
    ]);
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
    // 章节自动编号部件必须在包里
    expect(names).toContain("word/numbering.xml");

    const doc = parts["word/document.xml"] ?? "";
    const markdownTables = countMarkdownTables(markdown);
    expect(markdownTables).toBe(6);
    expect(countTag(doc, "w:tbl")).toBeGreaterThanOrEqual(6);
    expect(countTag(doc, "w:tbl")).toBe(markdownTables);
    // 每张表后面都跟了一个空段落
    expect(countTableBlankLine(doc)).toBe(markdownTables);

    const chapters = markdown
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    expect(chapters.length).toBeGreaterThanOrEqual(5);
    const h1Texts = paragraphsWithStyle(doc, "Heading1").map(textOf);
    const docText = textOf(doc);
    // 章标题里的手写章号（「一、」「二、」…）已剥掉，交给 Word 自动编号
    expect(h1Texts.length).toBe(chapters.length);
    for (const text of h1Texts) {
      expect(text).not.toMatch(/^[一二三四五六七八九十]{1,3}[、.．]/);
      expect(text).not.toMatch(/^\d+(?:\.\d+)*[.、]\s/);
    }
    for (const [index, chapter] of chapters.entries()) {
      const stripped = chapter.replace(/^[一二三四五六七八九十]{1,3}[、.．]\s*/, "").trim();
      expect(stripped).not.toBe("");
      expect(docText).toContain(stripped);
      expect(h1Texts[index]).toBe(stripped);
    }
    // `---` 分章线只丢弃，不进正文（表格分隔行也一并丢弃）
    expect(doc).not.toContain("---");
  });
});
