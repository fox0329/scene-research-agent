/**
 * @scene/domain — 对话消息内文件路径提取测试
 */

import { describe, it, expect } from "vitest";
import {
  extractImportablePaths,
  expandHomePath,
  IMPORTABLE_EXTS,
} from "./chat-import.js";

describe("extractImportablePaths", () => {
  it("提取多个路径（空格/中文逗号分隔），保持顺序去重", () => {
    expect(
      extractImportablePaths("导入 ~/docs/规格书.pdf，再看一下 /tmp/报价.xlsx 和 ~/docs/规格书.pdf"),
    ).toEqual(["~/docs/规格书.pdf", "/tmp/报价.xlsx"]);
  });

  it("引号包裹可识别（中英文引号、括号）；含空格的路径不识别（按空白切分）", () => {
    expect(extractImportablePaths("请导入「/Users/a/白皮书.PDF」优先")).toEqual([
      "/Users/a/白皮书.PDF",
    ]);
    expect(extractImportablePaths('导入 "/tmp/a.pdf"')).toEqual(["/tmp/a.pdf"]);
    expect(extractImportablePaths("含空格 /tmp/a b.pdf 不识别")).toEqual([]);
  });

  it("非支持扩展名与网址不识别", () => {
    expect(extractImportablePaths("看 /tmp/readme.md 和 https://x.com/a.pdf")).toEqual([]);
    expect(extractImportablePaths("协议相对 //evil.com/a.pdf 也不要")).toEqual([]);
  });

  it("去尾标点；无路径文本返回空", () => {
    expect(extractImportablePaths("帮我导入 /tmp/a.pdf。")).toEqual(["/tmp/a.pdf"]);
    expect(extractImportablePaths("今天天气不错")).toEqual([]);
    expect(extractImportablePaths("~/docs/")).toEqual([]);
  });
});

describe("expandHomePath", () => {
  it("~ 与 ~/ 前缀展开；其余原样", () => {
    expect(expandHomePath("~", "/Users/u")).toBe("/Users/u");
    expect(expandHomePath("~/a.pdf", "/Users/u")).toBe("/Users/u/a.pdf");
    expect(expandHomePath("/tmp/a.pdf", "/Users/u")).toBe("/tmp/a.pdf");
  });
});

describe("IMPORTABLE_EXTS", () => {
  it("与 ingest 口径一致（4 类）", () => {
    expect([...IMPORTABLE_EXTS]).toEqual([".pdf", ".docx", ".xlsx", ".pptx"]);
  });
});
