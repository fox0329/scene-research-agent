/**
 * @scene/infra — 文档解析器测试
 *
 * 使用 Spike S3 生成的测试样本（scripts/spike/s3/sample.*）。
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, it, expect } from "vitest";
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

/**
 * 合成一个最小 PPTX（只放解析器真正会读的 `ppt/slides/slideN.xml`）。
 *
 * 表格用例需要精确控制 DrawingML 的写法——属性、合并格、多段落、实体转义——
 * 用二进制夹具反而说不清在测什么，所以在这里现搭 zip。`parseDocument` 收的是路径，
 * 因此落到临时目录。
 */
async function makePptx(slides: string[]): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  slides.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml));
  const path = join(tmpdir(), `doc-parser-${randomUUID()}.pptx`);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

/** 幻灯片骨架 */
const slideXml = (...shapes: string[]) =>
  `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:sld>`;

/** 一个文本框（`preserve` 用来造出 `<a:t xml:space="preserve">`） */
const tx = (text: string, preserve = false) =>
  `<p:sp><p:txBody><a:p><a:r><a:t${preserve ? ' xml:space="preserve"' : ""}>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

/** 一个表格单元格（`second` 用来造出多段落） */
const tc = (text = "", opts: { attr?: string; preserve?: boolean; second?: string } = {}) => {
  const attrs = [opts.attr, opts.preserve === true ? 'xml:space="preserve"' : ""].filter(Boolean).join(" ");
  const paragraph = (t: string) => `<a:p><a:r><a:t${attrs ? ` ${attrs}` : ""}>${t}</a:t></a:r></a:p>`;
  const body = paragraph(text) + (opts.second === undefined ? "" : paragraph(opts.second));
  return `<a:tc><a:txBody><a:bodyPr/>${body}</a:txBody><a:tcPr/></a:tc>`;
};
const tr = (...cells: string[]) => `<a:tr h="370840">${cells.join("")}</a:tr>`;
const tbl = (...rows: string[]) =>
  `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="100"/></a:tblGrid>${rows.join("")}</a:tbl>`;

describe("parseDocument — PPTX", () => {
  it("应提取 PPT 幻灯片文本", async () => {
    const result = await parseDocument(sample("sample.pptx"));

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("S3 Spike Test PPT");
    expect(result.text).toContain("Slide 1");
    expect(result.text).toContain("Conclusion slide");
    expect(result.metadata.pageCount).toBe(2);
  });

  it("夹具 PPT 本身没有表格，tables 为空数组", async () => {
    const result = await parseDocument(sample("sample.pptx"));
    expect(result.tables).toEqual([]);
  });

  it("抽出 DrawingML 表格：首行作表头、其余作数据行", async () => {
    const slide = slideXml(
      tx("关键规格"),
      tbl(tr(tc("参数项"), tc("数值")), tr(tc("典型功耗"), tc("6W")), tr(tc("工作温度"), tc("-25~60℃"))),
    );
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables).toEqual([
      {
        headers: ["参数项", "数值"],
        rows: [
          ["典型功耗", "6W"],
          ["工作温度", "-25~60℃"],
        ],
      },
    ]);
    // 表格内容也进纯文本，模型两条路都看得到
    expect(result.text).toContain("[Slide 1 表格]");
    expect(result.text).toContain("参数项\t数值");
  });

  it("`<a:t xml:space=preserve>` 的文字不能丢（旧写法只认无属性标签）", async () => {
    const result = await parseDocument(await makePptx([slideXml(tx("保留 空格", true), tx("普通文本"))]));

    expect(result.text).toContain("保留 空格");
    expect(result.text).toContain("普通文本");
  });

  it("单元格多段落用空格并起来（换行会被下游当成行分隔）", async () => {
    const slide = slideXml(tbl(tr(tc("项"), tc("值")), tr(tc("操作系统", { second: "云枢 OS" }), tc("在售"))));
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables[0]?.rows).toEqual([["操作系统 云枢 OS", "在售"]]);
    expect(result.tables[0]?.rows[0]?.[0]).not.toContain("\n");
  });

  it("XML 实体反转义，且 `&amp;lt;` 不被二次解码", async () => {
    const slide = slideXml(
      tbl(tr(tc("A&amp;B"), tc("&lt;阈值&gt;")), tr(tc("&amp;lt;"), tc("&quot;引号&quot;"))),
    );
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables[0]).toEqual({
      headers: ["A&B", "<阈值>"],
      rows: [["&lt;", '"引号"']],
    });
  });

  it("合并单元格的续格留空，列数不塌陷", async () => {
    const slide = slideXml(tbl(tr(tc("型号"), tc("状态")), tr(tc("YS-EC3200"), tc("", { attr: 'hMerge="1"' }))));
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables[0]?.headers).toHaveLength(2);
    expect(result.tables[0]?.rows).toEqual([["YS-EC3200", ""]]);
  });

  it("参差行按最宽行补空串，补成矩形", async () => {
    const slide = slideXml(tbl(tr(tc("甲"), tc("乙"), tc("丙")), tr(tc("1"))));
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables[0]?.rows).toEqual([["1", "", ""]]);
  });

  it("整张表一个字都没有的占位表不算表", async () => {
    const slide = slideXml(tbl(tr(tc(""), tc("")), tr(tc(""), tc(""))), tx("正文照旧"));
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables).toEqual([]);
    expect(result.text).toContain("正文照旧");
  });

  it("同一张幻灯片里的两张表分别抽出，不串行", async () => {
    const slide = slideXml(
      tbl(tr(tc("表一列"), tc("值")), tr(tc("a"), tc("1"))),
      tbl(tr(tc("表二列"), tc("值")), tr(tc("b"), tc("2"))),
    );
    const result = await parseDocument(await makePptx([slide]));

    expect(result.tables).toHaveLength(2);
    expect(result.tables[0]?.rows).toEqual([["a", "1"]]);
    expect(result.tables[1]?.rows).toEqual([["b", "2"]]);
  });

  it("幻灯片按数字排序：slide2 排在 slide10 之前（字典序会反过来）", async () => {
    const slides = Array.from({ length: 11 }, (_v, i) => slideXml(tx(`第${i + 1}页`)));
    const result = await parseDocument(await makePptx(slides));

    expect(result.metadata.pageCount).toBe(11);
    const order = [...result.text.matchAll(/\[Slide (\d+)\]/g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.text.indexOf("[Slide 2]")).toBeLessThan(result.text.indexOf("[Slide 10]"));
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