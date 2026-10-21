/**
 * @scene/web — 入库回执测试（变更表 #210）
 *
 * 重点不是文案好不好看，而是**0 行的文件必须被点名、且不被重复计算**：
 * 这是「上传 3 个文件、列表只有 2 个」这种对不上账的情况唯一的出口。
 */

import { describe, expect, it } from "vitest";
import { buildIngestReceipt, fileResultLine, type FileIngestResult } from "./ingest-receipt.js";

const ok = (name: string, rows: number): FileIngestResult => ({ name, rows, failed: false });

describe("buildIngestReceipt — 0 行文件要点名", () => {
  it("三个文件里有一个 0 行：点它的名，且只点它", () => {
    const receipt = buildIngestReceipt(
      [ok("白皮书.docx", 145), ok("产品介绍.pptx", 0), ok("规格参数表.xlsx", 77)],
      { M1: 8, M2: 111 },
    );

    expect(receipt.emptyFiles).toEqual(["产品介绍.pptx"]);
    expect(receipt.emptyLine).toContain("1 个文件未产出可校验记录");
    expect(receipt.emptyLine).toContain("产品介绍.pptx");
    expect(receipt.emptyLine).not.toContain("白皮书.docx");
    expect(receipt.totalRows).toBe(222);
  });

  it("没有 0 行文件时不占一行（emptyLine 为 null）", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 3), ok("b.xlsx", 4)], {});
    expect(receipt.emptyFiles).toEqual([]);
    expect(receipt.emptyLine).toBeNull();
  });

  it("已报错的文件不进 0 行名单（同一件事只说一遍）", () => {
    const receipt = buildIngestReceipt(
      [ok("好文件.docx", 10), { name: "坏文件.pptx", rows: 0, failed: true }],
      {},
    );

    expect(receipt.emptyFiles).toEqual([]);
    expect(receipt.emptyLine).toBeNull();
    expect(receipt.failedCount).toBe(1);
    expect(receipt.doneLine).toContain("失败 1 个");
  });

  it("全部文件都是 0 行：照样点名两个（最坏情况也不能沉默）", () => {
    const receipt = buildIngestReceipt([ok("x.pptx", 0), ok("y.pptx", 0)], {});
    expect(receipt.emptyFiles).toEqual(["x.pptx", "y.pptx"]);
    expect(receipt.emptyLine).toContain("2 个文件未产出可校验记录");
    expect(receipt.totalRows).toBe(0);
  });
});

describe("buildIngestReceipt — 文案口径", () => {
  it("完成行按文件数报，并带上每表行数与失败数", () => {
    const receipt = buildIngestReceipt(
      [ok("白皮书.docx", 145), ok("规格参数表.xlsx", 77)],
      { M2: 81, M1: 8 },
    );
    expect(receipt.doneLine).toBe("【完成】2 个文件 · 共入库 222 行（规格书×81、产品清单×8）");
  });

  it("表号显示为中文名，O3 价格类别不再出现在回执里", () => {
    const receipt = buildIngestReceipt([ok("报价单.pdf", 2)], { M6: 1, O3: 1 });
    expect(receipt.doneLine).toContain("报价×1");
    expect(receipt.doneLine).not.toContain("O3");
  });

  it("没有每表计数时不出现空括号", () => {
    const receipt = buildIngestReceipt([ok("a.docx", 5)], {});
    expect(receipt.doneLine).toBe("【完成】1 个文件 · 共入库 5 行");
    expect(receipt.toast).toBe("解析完成：入库 5 行");
  });

  it("toast 同时提 0 行数与失败数", () => {
    const receipt = buildIngestReceipt(
      [ok("a.docx", 7), ok("b.pptx", 0), { name: "c.pdf", rows: 0, failed: true }],
      { M1: 7 },
    );
    expect(receipt.toast).toBe("解析完成：入库 7 行（产品清单×7），1 个文件 0 行 · 失败 1 个");
  });
});

describe("fileResultLine — 单文件进度行", () => {
  it("有行数就报行数", () => {
    expect(fileResultLine(ok("a.docx", 145))).toBe("　→ 入库 145 行");
  });

  it("0 行明确写成「未产出可校验记录」，不是空白也不是 0", () => {
    expect(fileResultLine(ok("a.pptx", 0))).toBe("　→ 0 行（未产出可校验记录）");
  });

  it("失败的文件不再补一行（错误行已经说过了）", () => {
    expect(fileResultLine({ name: "a.pdf", rows: 0, failed: true })).toBeNull();
  });
});
