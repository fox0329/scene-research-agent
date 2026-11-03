import { describe, expect, it } from "vitest";
import { isLowTrustRow, tableSummaryText } from "./SchemaTable.js";

describe("表头上一行总结（用户定调 2026-11-03）", () => {
  it("有模型摘要就用摘要，没有退回表定义 purpose", () => {
    expect(tableSummaryText("十类交互，七类有材料", "客户侧要素怎么交互")).toBe("十类交互，七类有材料");
    expect(tableSummaryText(undefined, "客户侧要素怎么交互")).toBe("客户侧要素怎么交互");
    expect(tableSummaryText("   ", "兜底的用途说明")).toBe("兜底的用途说明");
  });

  it("去掉 markdown 记号，超 100 字截断成一行", () => {
    expect(tableSummaryText(undefined, "**场景锚**——`用户给场景名称`")).toBe(
      "场景锚——用户给场景名称",
    );
    const long = tableSummaryText(undefined, "一".repeat(150));
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
