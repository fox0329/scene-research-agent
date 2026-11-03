import { describe, expect, it } from "vitest";
import { tableDef } from "@scene/contract";
import { cellColorClass, tableSummaryText } from "./SchemaTable.js";

describe("表头上一行内容总结（用户定调 2026-11-03）", () => {
  it("只有内容总结才显示；没有就不显示（不拿表定义说明充当总结）", () => {
    expect(tableSummaryText("十类交互，七类有材料依据")).toBe("十类交互，七类有材料依据");
    expect(tableSummaryText(undefined)).toBe("");
    expect(tableSummaryText("   ")).toBe("");
  });

  it("去掉 markdown 记号，超 100 字截断成一行", () => {
    expect(tableSummaryText("**关键结论**：`交互`共十类")).toBe("关键结论：交互共十类");
    const long = tableSummaryText("一".repeat(150));
    expect(Array.from(long)).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("单元格颜色按「需不需要调研 + 有没有来源」判定（用户定调 2026-11-03）", () => {
  it("不需要调研的列（技术实现）一律黑，哪怕来源是推断", () => {
    const def = tableDef("表2-3");
    expect(
      cellColorClass("表2-3", def, { layer: "感知层" }, "layer", "推断：本步未见可定位来源"),
    ).toBeUndefined();
    expect(
      cellColorClass("表1-1", tableDef("表1-1"), { content: "园区照明" }, "content", ""),
    ).toBeUndefined();
  });

  it("需要调研的列：有链接黑、没来源蓝", () => {
    const def = tableDef("表3-1");
    const url = "https://jtyst.zj.gov.cn/art/2025/9/19/art_1.html";
    expect(cellColorClass("表3-1", def, { gross_margin: "40%–60%" }, "gross_margin", url)).toBeUndefined();
    expect(
      cellColorClass("表3-1", def, { gross_margin: "40%–60%" }, "gross_margin", "推断：x"),
    ).toBe("low-trust");
  });

  it("填了没价值 → 红，红色优先", () => {
    expect(
      cellColorClass("表3-1", tableDef("表3-1"), { gross_margin: "未知" }, "gross_margin", "推断：x"),
    ).toBe("weak-value");
    expect(
      cellColorClass(
        "表3-1",
        tableDef("表3-1"),
        { gross_margin: "未知" },
        "gross_margin",
        "https://jtyst.zj.gov.cn/a.html",
      ),
    ).toBe("weak-value");
  });

  it("短名词与序号不算没价值（不能被判成红）", () => {
    expect(
      cellColorClass("表3-8", tableDef("表3-8"), { gap: "数据采集" }, "gap", "推断：x"),
    ).toBe("low-trust");
    expect(cellColorClass("表3-8", tableDef("表3-8"), { rank: "3" }, "rank", "推断：x")).toBeUndefined();
  });
});
