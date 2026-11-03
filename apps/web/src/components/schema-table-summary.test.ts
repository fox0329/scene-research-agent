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

describe("单元格颜色按右栏来源判定（用户定调 2026-11-03）", () => {
  it("有可验证链接 → 黑；推断来源 → 蓝；填了没价值 → 红（红优先）", () => {
    const def = tableDef("表2-3");
    const url = "https://jtyst.zj.gov.cn/art/2025/9/19/art_1.html";
    const inferred = "推断：本步未见可定位来源，按场景逻辑与行业通识判断";
    expect(cellColorClass(def, { layer: "感知层" }, "layer", url)).toBeUndefined();
    expect(cellColorClass(def, { layer: "感知层" }, "layer", inferred)).toBe("low-trust");
    expect(cellColorClass(def, { layer: "未知" }, "layer", inferred)).toBe("weak-value");
    expect(cellColorClass(def, { layer: "未知" }, "layer", url)).toBe("weak-value");
  });

  it("短名词与序号不算没价值（不能被判成红）", () => {
    const def = tableDef("表3-8");
    expect(cellColorClass(def, { gap_name: "数据采集" }, "gap_name", "推断：x")).toBe("low-trust");
    expect(cellColorClass(def, { rank: "3" }, "rank", "推断：x")).toBe("low-trust");
  });
});
