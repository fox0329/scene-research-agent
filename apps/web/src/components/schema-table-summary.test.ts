import { describe, expect, it } from "vitest";
import { isLowTrustRow, tableSummaryText } from "./SchemaTable.js";

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

describe("低可信来源标蓝（用户定调 2026-11-03）", () => {
  it("权威性 T3/T4 或证据 C/D 算低可信", () => {
    expect(isLowTrustRow({ source_authority: "T4" })).toBe(true);
    expect(isLowTrustRow({ source_authority: "T3" })).toBe(true);
    expect(isLowTrustRow({ evidence_level: "C" })).toBe(true);
    expect(isLowTrustRow({ source_authority: "T1", evidence_level: "A" })).toBe(false);
  });

  it("来源里写明待核实/行业通识也算", () => {
    expect(isLowTrustRow({ source: "行业通识：GB 50055" })).toBe(true);
    expect(isLowTrustRow({ source: "推断：由场景定义推得" })).toBe(true);
    expect(isLowTrustRow({ source: "招标文件.pdf:12" })).toBe(false);
  });
});
