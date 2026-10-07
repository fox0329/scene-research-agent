import { describe, expect, it } from "vitest";
import { proseChars } from "./md-metrics.js";

describe("Markdown 度量（精要口径）", () => {
  it("正文字数不计表格：表格是结构，正文才是流水账", () => {
    const md = "## 一、现状\n\n这是一句话。\n\n| 层次 | 组成 |\n|---|---|\n| 主链 | PLC |\n";
    expect(proseChars(md)).toBe("##一、现状这是一句话。".length);
  });

  it("全空 / 只有表格时正文为 0", () => {
    expect(proseChars("")).toBe(0);
    expect(proseChars("| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe(0);
  });
});
