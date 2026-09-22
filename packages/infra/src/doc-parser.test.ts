/**
 * @scene/infra — 文档解析器测试
 *
 * 使用 Spike S3 生成的测试样本（scripts/spike/s3/sample.*）。
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseDocument } from "./doc-parser.js";

/** spike 样本文件目录 */
const SAMPLE_DIR = resolve(
  import.meta.dirname,
  "../../../scripts/spike/s3",
);

const sample = (name: string) => resolve(SAMPLE_DIR, name);

// ── PDF 解析 ───────────────────────────────────────────────

describe("parseDocument — PDF", () => {
  it("应提取 PDF 文本内容", async () => {
    const result = await parseDocument(sample("sample.pdf"));

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("S3 Spike Test PDF");
    expect(result.text).toContain("quick brown fox");
    expect(result.metadata.pageCount).toBe(1);
  });

  it("PDF 表格应为空数组（由 LLM 后处理）", async () => {
    const result = await parseDocument(sample("sample.pdf"));
    expect(result.tables).toEqual([]);
  });
});

// ── Word 解析 ──────────────────────────────────────────────

describe("parseDocument — DOCX", () => {
  it("应提取 Word 纯文本", async () => {
    const result = await parseDocument(sample("sample.docx"));

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("S3 Spike Test Word");
    expect(result.text).toContain("mammoth");
  });

  it("应从 Word 中提取表格结构", async () => {
    const result = await parseDocument(sample("sample.docx"));

    expect(result.tables.length).toBeGreaterThanOrEqual(1);

    const table = result.tables[0]!;
    expect(table.headers).toEqual(["Header A", "Header B", "Header C"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["Row1-A", "Row1-B", "Row1-C"]);
    expect(table.rows[1]).toEqual(["Row2-A", "Row2-B", "Row2-C"]);
  });
});

// ── Excel 解析 ─────────────────────────────────────────────

describe("parseDocument — XLSX", () => {
  it("应提取 Excel 文本和所有 Sheet", async () => {
    const result = await parseDocument(sample("sample.xlsx"));

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("产品矩阵");
    expect(result.metadata.sheetCount).toBe(2);
  });

  it("应从 Excel 中提取表格结构", async () => {
    const result = await parseDocument(sample("sample.xlsx"));

    expect(result.tables.length).toBeGreaterThanOrEqual(2);

    // 第一个 sheet：产品矩阵
    const sheet1 = result.tables[0]!;
    expect(sheet1.headers).toEqual(["产品", "单价(万)", "适用场景"]);
    expect(sheet1.rows.length).toBeGreaterThanOrEqual(3);
    expect(sheet1.rows[0]).toEqual(["场景通", "15", "场景落地分析"]);

    // 第二个 sheet
    const sheet2 = result.tables[1]!;
    expect(sheet2.headers).toEqual(["Key", "Value", "Note"]);
    expect(sheet2.rows.length).toBeGreaterThanOrEqual(2);
  });
});

// ── PPT 解析 ──────────────────────────────────────────────

describe("parseDocument — PPTX", () => {
  it("应提取 PPT 幻灯片文本", async () => {
    const result = await parseDocument(sample("sample.pptx"));

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("S3 Spike Test PPT");
    expect(result.text).toContain("Slide 1");
    expect(result.text).toContain("Conclusion slide");
    expect(result.metadata.pageCount).toBe(2);
  });

  it("PPT 表格目前应为空数组（TODO M2+）", async () => {
    const result = await parseDocument(sample("sample.pptx"));
    expect(result.tables).toEqual([]);
  });
});

// ── 错误处理 ──────────────────────────────────────────────

describe("parseDocument — 错误处理", () => {
  it("不支持的格式应抛出明确错误", async () => {
    await expect(parseDocument("/tmp/test.txt")).rejects.toThrow(
      '不支持的文件格式 ".txt"',
    );
  });

  it("不存在的文件应抛出错误", async () => {
    await expect(
      parseDocument("/nonexistent/path/file.pdf"),
    ).rejects.toThrow();
  });

  it("空路径应抛出明确错误", async () => {
    await expect(parseDocument("")).rejects.toThrow("filePath 必须是非空字符串");
  });
});