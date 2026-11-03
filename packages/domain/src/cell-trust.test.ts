import { describe, expect, it } from "vitest";
import { tableDef } from "@scene/contract";
import { cellTrustClass, cellTrustOf, isVerifiableSource } from "./cell-trust.js";

describe("单元格颜色由来源决定（用户定调 2026-11-03）", () => {
  it("右栏有可验证链接/材料页码/用户输入 → 可验证（黑）", () => {
    expect(isVerifiableSource("https://jtyst.zj.gov.cn/art/2025/9/19/art_1.html")).toBe(true);
    expect(isVerifiableSource("招标文件.pdf:12")).toBe(true);
    expect(isVerifiableSource("用户输入（场景描述）")).toBe(true);
  });

  it("查不到资料、模型推理加行业通识 → 不可验证（蓝）", () => {
    expect(isVerifiableSource("推断：未见可定位来源，按行业通识判断")).toBe(false);
    expect(isVerifiableSource("行业通识：GB 7000.1")).toBe(false);
    expect(isVerifiableSource("")).toBe(false);
    expect(isVerifiableSource(null)).toBe(false);
  });

  it("有内容但没价值 → 红，且红色优先于蓝色", () => {
    const def = tableDef("表2-3");
    expect(cellTrustClass(cellTrustOf(def, { layer: "未知" }, "layer", "推断：xxx"))).toBe(
      "weak-value",
    );
    expect(cellTrustClass(cellTrustOf(def, { layer: "感知层" }, "layer", "推断：xxx"))).toBe(
      "low-trust",
    );
    expect(
      cellTrustClass(
        cellTrustOf(def, { layer: "感知层" }, "layer", "https://jtyst.zj.gov.cn/a.html"),
      ),
    ).toBeUndefined();
  });

  it("空格子不染色（没有文字可染）", () => {
    const def = tableDef("表2-3");
    expect(cellTrustClass(cellTrustOf(def, { layer: "" }, "layer", "推断：xxx"))).toBeUndefined();
  });
});
