import { describe, expect, it } from "vitest";
import { isLowTrustCell, tableSummaryText } from "./SchemaTable.js";

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

describe("格级低可信标蓝（用户定调 2026-11-03）", () => {
  it("只有被点名的那一格标蓝，同行其他格子不蓝", () => {
    const row = { __low_trust: ["method"], interaction_type: "液位触发", method: "浮球启泵" };
    expect(isLowTrustCell(row, "method")).toBe(true);
    expect(isLowTrustCell(row, "interaction_type")).toBe(false);
  });

  it("没有标记的行一个格子都不蓝（不再按整行 T3/T4 染色）", () => {
    expect(isLowTrustCell({ source_authority: "T4", evidence_level: "C" }, "method")).toBe(false);
    expect(isLowTrustCell({}, "method")).toBe(false);
  });
});
