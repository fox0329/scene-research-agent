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
    expect(
      cellTrustClass(cellTrustOf("表2-3", def, { note: "未知" }, "note", "推断：xxx")),
    ).toBe("weak-value");
  });

  it("不需要调研的列（场景定义、技术实现）一律黑，哪怕来源是推断", () => {
    const def = tableDef("表2-3");
    /* 分层架构是技术实现，不该因为有"推断"来源就标蓝 */
    expect(
      cellTrustClass(cellTrustOf("表2-3", def, { layer: "感知层" }, "layer", "推断：xxx")),
    ).toBeUndefined();
    /* 表1-1 场景概述属定义 */
    expect(
      cellTrustClass(cellTrustOf("表1-1", tableDef("表1-1"), { content: "园区照明" }, "content", "")),
    ).toBeUndefined();
  });

  it("需要调研的列没来源 → 蓝；有来源 → 黑", () => {
    const def = tableDef("表3-1");
    expect(
      cellTrustClass(cellTrustOf("表3-1", def, { gross_margin: "40%–60%" }, "gross_margin", "推断：x")),
    ).toBe("low-trust");
    expect(
      cellTrustClass(
        cellTrustOf("表3-1", def, { gross_margin: "40%–60%" }, "gross_margin", "https://jtyst.zj.gov.cn/a.html"),
      ),
    ).toBeUndefined();
  });

  it("空格子不染色（没有文字可染）", () => {
    expect(
      cellTrustClass(cellTrustOf("表2-3", tableDef("表2-3"), { layer: "" }, "layer", "推断：xxx")),
    ).toBeUndefined();
  });
});
