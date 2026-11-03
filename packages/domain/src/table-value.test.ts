import { describe, expect, it } from "vitest";
import { tableDef } from "@scene/contract";
import { isValuableCell, tableValueScore, VALUE_RATIO_FLOOR } from "./table-value.js";

describe("格子有没有实际价值（用户定调 2026-11-03）", () => {
  it("空值、纯填充词、单字答案都不算价值", () => {
    for (const bad of ["", "  ", "未知", "不适用", "未提供", "待核实", "无", "N/A", "是", "否", "高", "低"]) {
      expect(isValuableCell(bad), bad).toBe(false);
    }
  });

  it("说清了一件事就算（≥5 字，或带数字型号的短表述）", () => {
    expect(isValuableCell("浮球与液位计分级触发")).toBe(true);
    expect(isValuableCell("机械密封寿命≥25000 小时")).toBe(true);
    expect(isValuableCell("CT15")).toBe(true);
    expect(isValuableCell(["一控二", "浮球液位"])).toBe(true);
  });

  it("表格评分只看中栏，占比低于底线就该降级重来", () => {
    const def = tableDef("表2-4")!;
    const thin = [{ interaction_type: "未知", from_to: "是", method: "否" }];
    expect(tableValueScore(def, thin).ratio).toBeLessThan(VALUE_RATIO_FLOOR);
    const good = [
      {
        interaction_type: "液位联动",
        from_to: "低浮球→1号泵",
        method: "浮球闭合直接启泵",
        key_params: "启泵液位 1.2m，停泵 0.8m",
      },
    ];
    expect(tableValueScore(def, good).ratio).toBeGreaterThanOrEqual(VALUE_RATIO_FLOOR);
  });
});
